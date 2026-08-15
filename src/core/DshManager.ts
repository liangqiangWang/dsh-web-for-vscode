import * as vscode from 'vscode';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

import { DshClient } from './DshClient';
import { DshConfig, DshStatus } from './types';
import { isWindows } from '../utils/platformUtils';
import { ConfigurationService } from '../services/configuration';
import {
  CHECK_COMMANDS,
  INSTALL_COMMANDS,
  START_ARGS,
  BACKGROUND_TERMINAL_NAME,
  WINDOWS_COMMANDS,
  REQUIRED_NODE_VERSION,
  NPX_PACKAGE,
  NPX_START_TIMEOUT
} from '../common/constants';
import { getEventManager } from './EventManager';
import { l10n } from '../l10n';

const execAsync = promisify(exec);

/**
 * 安装状态缓存
 */
interface InstallationCache {
  isInstalled: boolean | null;
  timestamp: number;
}

/**
 * 启动方式：dsh 全局命令 / npx 兜底
 */
type StartupMode = 'dsh' | 'npx';

/**
 * Node 环境检查结果
 */
interface NodeEnvCheck {
  ok: boolean;
  version?: string;
  reason?: 'not-found' | 'too-low';
}

/**
 * Node 环境检查缓存
 */
interface NodeEnvCache {
  result: NodeEnvCheck | null;
  timestamp: number;
}

/**
 * DSH 核心管理器
 * 负责 dsh 进程的启动、停止和监控
 */
export class DshManager {
  private client: DshClient;
  private config: DshConfig;
  private baseUrl: string;
  private configService: ConfigurationService;
  private eventManager = getEventManager();
  private context: vscode.ExtensionContext;
  private backgroundTerminal?: vscode.Terminal;

  // 安装状态缓存
  private installationCache: InstallationCache = {
    isInstalled: null,
    timestamp: 0
  };
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

  // Node 环境检查缓存（getStatus 首屏也会调用，避免重复执行拖慢）
  private nodeEnvCache: NodeEnvCache = {
    result: null,
    timestamp: 0
  };

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.configService = ConfigurationService.getInstance();
    this.config = this.loadConfig();
    this.baseUrl = `http://127.0.0.1:${this.config.defaultPort}`;
    this.client = new DshClient(this.config.defaultPort, this.config);

    // 监听终端关闭事件
    const closeDisposable = vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal.name === BACKGROUND_TERMINAL_NAME) {
        this.log('Background terminal closed');
        this.backgroundTerminal = undefined;

        this.eventManager.emitProcessStateChanged({
          status: DshStatus.NotRunning,
          timestamp: Date.now()
        });

        this.eventManager.emitConnectionChanged({
          connected: false,
          timestamp: Date.now()
        });
      }
    });

    context.subscriptions.push(closeDisposable);
  }

  /**
   * 启动或连接到 dsh 进程
   * 启动方式由 resolveStartupMode 决定：preferNpx 或 dsh 命令检测 + npx 兜底
   */
  async startOrAttach(): Promise<void> {
    const mode = await this.resolveStartupMode();

    if (mode === null) {
      const nodeCheck = await this.checkNodeEnvironment();
      this.emitNodeEnvironmentError(nodeCheck);
      return;
    }

    const isRunning = await this.checkDshRunning();

    if (!isRunning) {
      await this.startInBackground();
    }
  }

  /**
   * 在后台启动一个 dsh 进程（不显示终端）
   */
  public async startInBackground(): Promise<boolean> {
    const workspacePath = this.getWorkspacePath();
    if (!workspacePath) {
      const message = l10n.t('message.noWorkspace');
      this.log(`无法启动 DSH: ${message}`);
      this.eventManager.emitProcessError(message);
      return false;
    }

    try {
      this.log(`========== 开始后台启动流程 ==========`);
      this.log(`工作区路径: ${workspacePath}`);
      this.log(`平台: ${process.platform}`);

      // 检查后台终端是否已存在
      const existingBackground = vscode.window.terminals.find(
        terminal => terminal.name === BACKGROUND_TERMINAL_NAME
      );

      if (existingBackground) {
        const isRunning = await this.checkConnection();
        if (isRunning) {
          this.log('Background terminal already exists and process is running');
          this.backgroundTerminal = existingBackground;
          return true;
        } else {
          this.log('Existing terminal found but process is not running, disposing it');
          existingBackground.dispose();
        }
      }

      // 决策启动方式：Node 环境检查 + preferNpx / dsh 安装检测
      const preferNpx = this.configService.getPreferNpx();
      const mode = await this.resolveStartupMode();

      if (mode === null) {
        const nodeCheck = await this.checkNodeEnvironment();
        this.log(`Node 环境检查未通过: ${nodeCheck.reason} (${nodeCheck.version || 'N/A'})`);
        this.emitNodeEnvironmentError(nodeCheck);
        return false;
      }

      this.log(`启动方式: ${mode}${preferNpx ? ' (preferNpx 已启用，失败不回退)' : ''}`);

      if (mode === 'npx' && !preferNpx) {
        // dsh 命令未找到，走 npx 兜底，提示用户
        vscode.window.showInformationMessage(l10n.t('message.usingNpxStartup'));
      }

      // 创建后台终端
      const terminal = this.createBackgroundTerminal(workspacePath);

      // 构建启动命令
      let command: string;

      if (isWindows()) {
        command = await this.getWindowsStartupCommand(mode);
      } else {
        command = this.buildStartCommand(mode);
      }

      this.log(`启动命令: ${command}`);

      terminal.sendText(command);
      this.log('命令已发送到终端');

      // 等待服务就绪（npx 首次运行可能需要下载包，超时更长）
      const startTimeout = mode === 'npx' ? NPX_START_TIMEOUT : 15000;
      const isReady = await this.waitForReadyExtended(startTimeout);

      if (!isReady) {
        this.log('DSH 启动超时');

        if (isWindows()) {
          this.log('========== Windows 启动失败诊断 ==========');
          await this.diagnoseWindowsStartup();
        }

        this.eventManager.emitProcessError(l10n.t('message.startTimeout'));

        await this.checkProcessHealth();

        return false;
      }

      await new Promise(resolve => setTimeout(resolve, 2000));

      const finalCheck = await this.checkConnection();

      if (!finalCheck) {
        this.log('DSH 连接检查失败');
        await this.checkProcessHealth();
        this.eventManager.emitProcessError(l10n.t('message.startFailed'));
        return false;
      }

      this.log('DSH 后台启动成功');

      this.startProcessMonitoring();

      this.eventManager.emitProcessStateChanged({
        status: DshStatus.Running,
        timestamp: Date.now()
      });

      this.eventManager.emitConnectionChanged({
        connected: true,
        timestamp: Date.now()
      });

      return true;
    } catch (error) {
      this.log(`DSH 后台启动失败: ${error}`);
      this.eventManager.emitProcessError(l10n.t('message.startFailed', String(error)));
      return false;
    }
  }

  /**
   * 等待 dsh 就绪（扩展版，支持自定义超时）
   */
  private async waitForReadyExtended(timeoutMs: number): Promise<boolean> {
    const maxRetries = Math.ceil(timeoutMs / this.config.retryInterval);
    const retryInterval = this.config.retryInterval;

    this.log(`等待 DSH 就绪（最长 ${timeoutMs}ms，重试间隔 ${retryInterval}ms）`);

    for (let i = 0; i < maxRetries; i++) {
      const isReady = await this.client.checkAppReady();
      if (isReady) {
        this.log(`DSH 就绪（第 ${i + 1} 次检查）`);
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, retryInterval));
    }

    this.log(`DSH 未在 ${timeoutMs}ms 内就绪`);
    return false;
  }

  /**
   * 获取 Windows 启动命令
   * 命令通过 terminal.sendText 发送（shell 字符串），npx.cmd 无 spawn 问题
   */
  private async getWindowsStartupCommand(mode: StartupMode): Promise<string> {
    this.log('准备 Windows 启动命令...');
    return this.buildStartCommand(mode);
  }

  /**
   * 按启动方式构建启动命令
   * dsh: dsh web --port N
   * npx: npx -y @deepseek-ai/dsh web --port N（-y 跳过交互确认，后台终端无法响应提示）
   */
  private buildStartCommand(mode: StartupMode): string {
    if (mode === 'npx') {
      return `npx -y ${NPX_PACKAGE} ${START_ARGS.MODE} ${START_ARGS.PORT} ${this.config.defaultPort}`;
    }
    return `dsh ${START_ARGS.MODE} ${START_ARGS.PORT} ${this.config.defaultPort}`;
  }

  /**
   * 决策启动方式
   * 返回 null 表示 Node 环境不合格，禁止启动
   *
   * preferNpx=true  → 仅做 Node 检查，直接使用 npx（不检测 dsh，失败不回退）
   * preferNpx=false → dsh 已安装走 dsh；未安装走 npx 兜底
   */
  private async resolveStartupMode(): Promise<StartupMode | null> {
    this.log('========== 启动方式决策 ==========');

    // 两种方式都依赖 Node 运行时，统一前置检查
    const nodeCheck = await this.checkNodeEnvironment();
    if (!nodeCheck.ok) {
      this.log(`Node 环境检查未通过: ${nodeCheck.reason} (${nodeCheck.version || 'N/A'})`);
      return null;
    }
    this.log(`Node 环境检查通过: ${nodeCheck.version}`);

    const preferNpx = this.configService.getPreferNpx();
    if (preferNpx) {
      this.log('preferNpx 已启用，使用 npx 方式启动');
      return 'npx';
    }

    const isInstalled = await this.checkDshInstalled();
    if (isInstalled) {
      this.log('检测到 dsh 命令，使用 dsh 方式启动');
      return 'dsh';
    }

    this.log('未检测到 dsh 命令，使用 npx 方式兜底启动');
    return 'npx';
  }

  /**
   * 检查 Node 环境：node 是否存在、版本是否 >= REQUIRED_NODE_VERSION
   * 结果缓存 5 分钟（getStatus 首屏也会调用）
   */
  private async checkNodeEnvironment(): Promise<NodeEnvCheck> {
    const now = Date.now();
    if (this.nodeEnvCache.result !== null &&
        (now - this.nodeEnvCache.timestamp) < this.CACHE_DURATION) {
      return this.nodeEnvCache.result;
    }

    this.log(`开始检查 Node 环境（要求 >= ${REQUIRED_NODE_VERSION}）...`);

    const result = await this.checkNodeEnvironmentUncached();
    this.log(`Node 环境检查结果: ok=${result.ok}, version=${result.version || 'N/A'}, reason=${result.reason || '-'}`);

    this.nodeEnvCache = {
      result,
      timestamp: now
    };

    return result;
  }

  /**
   * Node 环境检查（不带缓存）
   * node --version 失败时回退 where/which 检测 node 是否存在
   */
  private async checkNodeEnvironmentUncached(): Promise<NodeEnvCheck> {
    // 方法1: node --version（通常 node 在 PATH 中即可成功）
    let versionOutput: string | undefined;
    try {
      const { stdout } = await execAsync('node --version', { timeout: 5000 });
      versionOutput = stdout.trim();
      this.log(`[Node检查] node --version 输出: ${versionOutput}`);
    } catch (error) {
      this.log(`[Node检查] node --version 失败: ${error}`);
    }

    // 方法2: where/which 回退（Git Bash/WSL 等 shell 差异）
    if (!versionOutput) {
      const fallbackCommand = isWindows() ? 'where node' : 'which node';
      try {
        await execAsync(fallbackCommand, { timeout: 5000, shell: true as any });
        this.log(`[Node检查] 通过 ${fallbackCommand} 找到 node，但无法获取版本`);
        return { ok: false, reason: 'not-found' };
      } catch {
        this.log(`[Node检查] ${fallbackCommand} 也未找到 node`);
        return { ok: false, reason: 'not-found' };
      }
    }

    // 解析版本号（如 v22.19.0）
    const match = versionOutput.match(/v?(\d+)\.(\d+)\.(\d+)/);
    if (!match) {
      this.log(`[Node检查] 无法解析版本号: ${versionOutput}`);
      return { ok: false, reason: 'not-found' };
    }

    const version = match[0].replace(/^v/, '');
    const required = REQUIRED_NODE_VERSION.split('.').map(Number);
    const current = [Number(match[1]), Number(match[2]), Number(match[3])];

    for (let i = 0; i < required.length; i++) {
      if (current[i] > required[i]) {
        return { ok: true, version };
      }
      if (current[i] < required[i]) {
        return { ok: false, version, reason: 'too-low' };
      }
    }

    return { ok: true, version };
  }

  /**
   * 发送 Node 环境错误事件（Webview 显示 error 状态）
   */
  private emitNodeEnvironmentError(nodeCheck: NodeEnvCheck): void {
    const message = nodeCheck.reason === 'too-low' && nodeCheck.version
      ? l10n.t('message.nodeVersionTooLow', nodeCheck.version)
      : l10n.t('message.nodeNotInstalled');
    this.log(`Node 环境错误: ${message}`);
    this.eventManager.emitProcessError(message);
  }

  /**
   * Windows 启动失败诊断
   */
  private async diagnoseWindowsStartup(): Promise<void> {
    this.log('========== Windows 启动失败诊断 ==========');

    try {
      // 1. 检查 dsh 命令是否在 PATH 中
      this.log('步骤 1: 检查 dsh 命令是否在 PATH 中');
      try {
        const { stdout } = await execAsync('where dsh', { timeout: 2000 });
        this.log(`✅ 找到 dsh: ${stdout.trim()}`);
      } catch (error) {
        this.log('❌ dsh 不在 PATH 中');

        try {
          const { stdout: npmPrefix } = await execAsync('npm config get prefix', { timeout: 2000 });
          const possiblePaths = [
            path.join(npmPrefix.trim(), 'dsh.cmd'),
            path.join(npmPrefix.trim(), 'node_modules', '.bin', 'dsh.cmd'),
            path.join(npmPrefix.trim(), 'node_modules', '.bin', 'dsh'),
          ];

          for (const exePath of possiblePaths) {
            if (fs.existsSync(exePath)) {
              this.log(`✅ 通过文件路径找到: ${exePath}`);
            } else {
              this.log(`❌ 路径不存在: ${exePath}`);
            }
          }
        } catch (npmError) {
          this.log(`❌ npm 检查失败: ${npmError}`);
        }
      }

      // 2. 尝试执行 dsh --version
      this.log('步骤 2: 测试 dsh 是否可执行');
      try {
        const { stdout, stderr } = await execAsync('dsh --version', {
          timeout: 5000,
          shell: true as any
        });
        this.log(`✅ dsh 执行成功，版本: ${stdout.trim()}`);
        if (stderr) {
          this.log(`  stderr: ${stderr}`);
        }
      } catch (error: any) {
        this.log(`❌ dsh 执行失败: ${error.message}`);
        if (error.stderr) {
          this.log(`  stderr: ${error.stderr}`);
        }
      }

      // 3. 检查端口占用
      this.log('步骤 3: 检查端口占用');
      const port = this.config.defaultPort;
      try {
        const { stdout } = await execAsync(`netstat -aon | findstr :${port}`, { timeout: 2000 });
        if (stdout.trim()) {
          this.log(`⚠️ 端口 ${port} 被占用:\n${stdout}`);
          this.log('尝试终止占用端口的进程...');
          await this.killProcessByPortCrossPlatform(port);
        } else {
          this.log(`✅ 端口 ${port} 未被占用`);
        }
      } catch (error) {
        this.log(`✅ 端口 ${port} 未被占用（检查失败）`);
      }

      // 4. 检查后台终端状态
      this.log('步骤 4: 检查后台终端状态');
      const allTerminals = vscode.window.terminals;
      this.log(`当前终端列表 (${allTerminals.length} 个):`);
      for (const t of allTerminals) {
        this.log(`  - ${t.name}`);
      }

      if (this.backgroundTerminal) {
        this.log('✅ 后台终端引用存在');
      } else {
        this.log('❌ 后台终端引用不存在');
      }

      // 5. 检查 node 进程
      this.log('步骤 5: 检查 node 进程');
      try {
        const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH', {
          timeout: 2000
        });
        const nodeProcesses = stdout.trim().split('\n').filter((line: string) => line.includes('node.exe'));
        this.log(`找到 ${nodeProcesses.length} 个 node 进程`);
        for (const proc of nodeProcesses) {
          this.log(`  ${proc}`);
        }
      } catch (error) {
        this.log('❌ 检查 node 进程失败');
      }

    } catch (error) {
      this.log(`诊断过程中出错: ${error}`);
    }

    this.log('========== Windows 诊断完成 ==========');
  }

  /**
   * 检查进程健康状态
   */
  private async checkProcessHealth(): Promise<void> {
    this.log('========== 检查进程健康状态 ==========');

    try {
      const port = this.config.defaultPort;

      if (process.platform === 'win32') {
        try {
          const { stdout } = await execAsync(`netstat -aon | findstr :${port}`, { timeout: 2000 });
          if (stdout.trim()) {
            this.log(`端口 ${port} 被占用:\n${stdout}`);
          } else {
            this.log(`端口 ${port} 未被占用`);
          }
        } catch (error) {
          this.log(`端口 ${port} 未被占用`);
        }
      } else {
        try {
          const { stdout } = await execAsync(`lsof -i :${port}`, { timeout: 2000 });
          if (stdout.trim()) {
            this.log(`端口 ${port} 被占用:\n${stdout}`);

            const lines = stdout.trim().split('\n');
            if (lines.length > 0) {
              const firstLine = lines[0];
              const parts = firstLine.trim().split(/\s+/);
              if (parts.length >= 2) {
                const pid = parts[1];
                this.log(`进程 PID: ${pid}`);

                try {
                  const { stdout: psOutput } = await execAsync(`ps -p ${pid} -o comm=`, { timeout: 2000 });
                  this.log(`进程命令: ${psOutput.trim()}`);
                } catch (psError) {
                  this.log(`进程 ${pid} 不存在或已退出`);
                }
              }
            }
          } else {
            this.log(`端口 ${port} 未被占用`);
          }
        } catch (error) {
          this.log(`端口 ${port} 未被占用`);
        }
      }

      if (this.backgroundTerminal) {
        this.log('后台终端存在');
      } else {
        this.log('后台终端不存在');
      }

    } catch (error) {
      this.log(`进程健康检查失败: ${error}`);
    }

    this.log('========== 进程健康检查完成 ==========');
  }

  /**
   * 启动进程监控
   */
  private processMonitorTimer?: NodeJS.Timeout;

  private startProcessMonitoring(): void {
    if (this.processMonitorTimer) {
      clearInterval(this.processMonitorTimer);
    }

    this.processMonitorTimer = setInterval(async () => {
      try {
        const isHealthy = await this.checkConnection(2000);

        if (!isHealthy && this.backgroundTerminal) {
          this.log('⚠️ 进程健康检查失败，可能已崩溃');

          const terminalExists = vscode.window.terminals.some(
            t => t.name === BACKGROUND_TERMINAL_NAME
          );

          if (!terminalExists) {
            this.log('后台终端已关闭，进程可能已崩溃');
            this.backgroundTerminal = undefined;

            this.eventManager.emitProcessStateChanged({
              status: DshStatus.NotRunning,
              timestamp: Date.now()
            });

            this.eventManager.emitConnectionChanged({
              connected: false,
              timestamp: Date.now()
            });

            this.stopProcessMonitoring();
          }
        }
      } catch (error) {
        this.log(`进程监控检查失败: ${error}`);
      }
    }, 10000);

    this.log('已启动进程监控（每 10 秒）');
  }

  /**
   * 停止进程监控
   */
  private stopProcessMonitoring(): void {
    if (this.processMonitorTimer) {
      clearInterval(this.processMonitorTimer);
      this.processMonitorTimer = undefined;
      this.log('已停止进程监控');
    }
  }

  /**
   * 检查 dsh 是否已安装（增强版，使用双重检测）
   */
  private async checkDshInstalled(): Promise<boolean> {
    const now = Date.now();
    if (this.installationCache.isInstalled !== null &&
        (now - this.installationCache.timestamp) < this.CACHE_DURATION) {
      this.log(`使用缓存的安装状态: ${this.installationCache.isInstalled}`);
      return this.installationCache.isInstalled;
    }

    this.log('开始检查 DSH 安装状态...');

    const maxRetries = isWindows() ? 3 : 1;
    let isInstalled = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      this.log(`安装检查尝试 ${attempt}/${maxRetries}`);

      let inPath = false;
      let commandPath: string | undefined;

      try {
        if (isWindows()) {
          const result = await this.checkWindowsInstallation();
          inPath = result.found;
          commandPath = result.path;
        } else {
          const command = CHECK_COMMANDS.UNIX;
          await execAsync(command, { timeout: 2000 });
          inPath = true;
          this.log('DSH 命令在 PATH 中找到');
        }
      } catch (error) {
        this.log(`DSH 命令不在 PATH 中: ${error}`);
      }

      let canExecute = false;
      if (inPath) {
        canExecute = await this.verifyDshExecutable(commandPath);
      }

      isInstalled = inPath && canExecute;

      if (isInstalled || attempt === maxRetries) {
        break;
      }

      this.log(`安装检查失败，等待 1 秒后重试...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    this.installationCache = {
      isInstalled,
      timestamp: now
    };

    this.log(`DSH 安装状态最终结果: ${isInstalled}`);

    return isInstalled;
  }

  /**
   * Windows 专用安装检测
   */
  private async checkWindowsInstallation(): Promise<{ found: boolean; path?: string }> {
    this.log('开始 Windows 安装检查（跨 shell 兼容）');

    // 方法1a: where 命令
    try {
      const { stdout } = await execAsync('where dsh', { timeout: 5000 });
      const path = stdout.trim().split('\n')[0];
      this.log(`✅ [方法1a] 通过 where 找到: ${path}`);
      return { found: true, path };
    } catch (error: any) {
      this.log(`❌ [方法1a] where 失败`);
    }

    // 方法1b: which 命令（Git Bash/WSL）
    try {
      const { stdout } = await execAsync('which dsh', { timeout: 5000, shell: true as any });
      const path = stdout.trim().split('\n')[0];
      this.log(`✅ [方法1b] 通过 which 找到: ${path}`);
      return { found: true, path };
    } catch (error: any) {
      this.log(`❌ [方法1b] which 失败`);
    }

    // 方法2: 检查 npm 全局包
    try {
      const { stdout } = await execAsync(WINDOWS_COMMANDS.NPM_CHECK_GLOBAL, {
        timeout: 5000,
        shell: true as any
      });

      if (stdout.includes('@deepseek-ai/dsh')) {
        this.log(`✅ [方法2] 通过 npm 全局包找到`);

        try {
          const { stdout: npmPrefix } = await execAsync(WINDOWS_COMMANDS.NPM_GET_PREFIX, {
            timeout: 2000,
            shell: true as any
          });
          const fullPath = path.join(npmPrefix.trim(), 'dsh.cmd');
          this.log(`[方法2] 推断路径: ${fullPath}`);
          return { found: true, path: fullPath };
        } catch {
          return { found: true };
        }
      }
    } catch (error: any) {
      this.log(`❌ [方法2] npm 检查失败`);
    }

    // 方法3: 直接检查 npm bin 路径
    try {
      const { stdout: npmBinPath } = await execAsync(WINDOWS_COMMANDS.NPM_GET_PREFIX, {
        timeout: 5000,
        shell: true as any
      });

      const possiblePaths = [
        path.join(npmBinPath.trim(), 'dsh.cmd'),
        path.join(npmBinPath.trim(), 'dsh'),
        path.join(npmBinPath.trim(), 'node_modules', '.bin', 'dsh.cmd'),
        path.join(npmBinPath.trim(), 'node_modules', '.bin', 'dsh'),
      ];

      for (const exePath of possiblePaths) {
        if (fs.existsSync(exePath)) {
          this.log(`✅ [方法3] 通过文件路径找到: ${exePath}`);
          return { found: true, path: exePath };
        }
      }
    } catch (error: any) {
      this.log(`❌ [方法3] npm 路径检查失败`);
    }

    this.log('❌ Windows 安装检查: 未找到');
    return { found: false };
  }

  /**
   * 验证 dsh 是否可以实际执行
   */
  private verifyDshExecutable(commandPath?: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        this.log('验证 DSH 可执行性');

        const command = commandPath || 'dsh';
        this.log(`执行命令: ${command}`);

        const proc = spawn(command, ['--version'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: !!commandPath,
        });

        let timedOut = false;

        const timeoutMs = isWindows() ? 10000 : 5000;

        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
          this.log(`❌ 验证超时（${timeoutMs}ms）`);
          resolve(false);
        }, timeoutMs);

        proc.on('error', (error: Error) => {
          clearTimeout(timer);
          this.log(`❌ 验证失败: ${error.message}`);
          resolve(false);
        });

        proc.on('close', (code: number | null) => {
          clearTimeout(timer);
          if (!timedOut) {
            const success = code === 0;
            this.log(`${success ? '✅' : '❌'} 验证结果: ${success ? '成功' : '失败'} (退出码: ${code})`);
            resolve(success);
          }
        });

      } catch (error: any) {
        this.log(`❌ 验证异常: ${error.message}`);
        resolve(false);
      }
    });
  }

  /**
   * 日志输出
   */
  private log(message: string): void {
    console.log(`[DshManager] ${message}`);
  }

  /**
   * 安装 dsh
   */
  private async installDsh(): Promise<void> {
    try {
      const terminal = vscode.window.createTerminal('Install DSH');
      terminal.show();
      const command = isWindows() ? INSTALL_COMMANDS.WINDOWS : INSTALL_COMMANDS.UNIX;
      terminal.sendText(command);
      vscode.window.showInformationMessage(l10n.t('message.installingComplete'));
    } catch (error) {
      vscode.window.showErrorMessage(l10n.t('message.installFailed', error));
    }
  }

  /**
   * 检查 dsh 是否正在运行
   */
  private async checkDshRunning(): Promise<boolean> {
    return await this.checkConnection();
  }

  /**
   * 检查是否有外部 dsh 进程在运行
   */
  async hasExternalDshProcess(): Promise<boolean> {
    const portHealthy = await this.checkConnection(2000);
    if (!portHealthy) {
      return false;
    }

    const hasBackgroundTerminal = vscode.window.terminals.some(
      terminal => terminal.name === BACKGROUND_TERMINAL_NAME
    );

    return !hasBackgroundTerminal;
  }

  /**
   * 检查 DSH 连接状态
   */
  public async checkConnection(timeout?: number): Promise<boolean> {
    return await this.client.checkHealth(timeout);
  }

  /**
   * 等待 dsh 就绪
   */
  private async waitForReady(): Promise<boolean> {
    const maxRetries = this.config.maxRetries;
    const retryInterval = this.config.retryInterval;

    for (let i = 0; i < maxRetries; i++) {
      const isReady = await this.client.checkAppReady();
      if (isReady) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, retryInterval));
    }

    return false;
  }

  /**
   * 获取工作区路径
   */
  public getWorkspacePath(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    return workspaceFolders && workspaceFolders.length > 0
      ? workspaceFolders[0].uri.fsPath
      : undefined;
  }

  /**
   * 加载配置
   */
  private loadConfig(): DshConfig {
    const port = this.configService.getPort();
    const timeout = this.configService.getTimeout();
    const terminalStartupDelay = this.configService.getTerminalStartupDelay();

    return {
      defaultPort: port,
      healthCheckTimeout: timeout,
      maxRetries: 10,
      retryInterval: 500,
      terminalStartupDelay
    };
  }

  /**
   * 获取当前状态
   *
   * dsh 未安装但 Node 环境合格时返回 NotRunning（而非 NotInstalled），
   * 这样 Webview 显示启动按钮，用户点击后可触发 npx 兜底启动。
   * Node 环境不合格时返回 NotInstalled，原因通过 getNotInstalledReason() 获取。
   */
  async getStatus(): Promise<DshStatus> {
    const preferNpx = this.configService.getPreferNpx();

    if (preferNpx) {
      // 首选 npx：只检查 Node 环境，不检查 dsh 安装
      const nodeCheck = await this.checkNodeEnvironment();
      if (!nodeCheck.ok) {
        return DshStatus.NotInstalled;
      }
    } else {
      const isInstalled = await this.checkDshInstalled();
      if (!isInstalled) {
        const nodeCheck = await this.checkNodeEnvironment();
        if (!nodeCheck.ok) {
          return DshStatus.NotInstalled;
        }
        // Node 合格，可用 npx 兜底启动
        return DshStatus.NotRunning;
      }
    }

    const isRunning = await this.checkDshRunning();
    if (isRunning) {
      return DshStatus.Running;
    }

    return DshStatus.NotRunning;
  }

  /**
   * 获取 NotInstalled 状态的具体原因文案（用于 Webview 展示）
   */
  async getNotInstalledReason(): Promise<string> {
    const nodeCheck = await this.checkNodeEnvironment();
    if (!nodeCheck.ok) {
      return nodeCheck.reason === 'too-low' && nodeCheck.version
        ? l10n.t('message.nodeVersionTooLow', nodeCheck.version)
        : l10n.t('message.nodeNotInstalled');
    }
    return l10n.t('message.pleaseInstall');
  }

  /**
   * 重新加载配置
   */
  reloadConfig(): void {
    this.config = this.loadConfig();
    this.baseUrl = `http://127.0.0.1:${this.config.defaultPort}`;
    this.client = new DshClient(this.config.defaultPort, this.config);
  }

  /**
   * 创建后台终端（不显示给用户）
   */
  private createBackgroundTerminal(workspacePath: string): vscode.Terminal {
    const terminal = vscode.window.createTerminal({
      name: BACKGROUND_TERMINAL_NAME,
      cwd: workspacePath,
      iconPath: vscode.Uri.joinPath(
        this.context.extensionUri,
        'resources',
        'icons',
        'dsh.svg'
      ),
      env: {
        DSH_CALLER: 'vscode',
      },
    });

    this.backgroundTerminal = terminal;
    this.log('Background terminal created');
    return terminal;
  }

  /**
   * 跨平台终止占用指定端口的进程
   */
  private async killProcessByPortCrossPlatform(port: number): Promise<boolean> {
    this.log(`========== 开始终止端口 ${port} 的进程 ==========`);

    if (!isWindows()) {
      try {
        try {
          const listCommand = `lsof -i :${port}`;
          const { stdout } = await execAsync(listCommand, { timeout: 2000 });
          this.log(`[Unix] 端口 ${port} 占用情况:\n${stdout}`);
        } catch (listError) {
          this.log(`[Unix] 端口 ${port} 未被占用`);
        }

        const command = `lsof -ti:${port} | xargs kill -9`;
        const { stdout } = await execAsync(command, { timeout: 5000 });

        if (stdout.trim()) {
          this.log(`[Unix] ✅ 已终止进程 PID: ${stdout.trim()}`);
        } else {
          this.log(`[Unix] ⚠️ 没有找到占用端口 ${port} 的进程`);
        }

        await new Promise(resolve => setTimeout(resolve, 500));
        try {
          await execAsync(`lsof -i :${port}`, { timeout: 2000 });
          this.log(`[Unix] ⚠️ 端口 ${port} 仍被占用，可能终止失败`);
          return false;
        } catch (verifyError) {
          this.log(`[Unix] ✅ 端口 ${port} 已释放`);
          return true;
        }
      } catch (error) {
        this.log(`[Unix] ⚠️ 进程终止失败: ${error}`);
        return false;
      }
    }

    const methods = [
      {
        name: 'taskkill (cmd)',
        command: `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /F /PID %a`,
        shell: false
      },
      {
        name: 'taskkill (PowerShell)',
        command: `powershell -Command "$pids = (Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess; if ($pids) { Stop-Process -Id $pids -Force -ErrorAction SilentlyContinue }"`,
        shell: true as any
      },
      {
        name: 'bash/netstat',
        command: `pid=$(netstat -aon | findstr :${port} | awk '{print $5}' | head -1 | cut -d: -f2); if [ -n "$pid" ]; then taskkill //F //PID $pid 2>/dev/null; fi`,
        shell: true as any
      }
    ];

    for (const method of methods) {
      try {
        this.log(`[Windows] 尝试方法: ${method.name}`);
        await execAsync(method.command, { timeout: 5000, shell: method.shell });
        this.log(`✅ 通过 ${method.name} 终止进程`);

        await new Promise(resolve => setTimeout(resolve, 500));
        try {
          const { stdout } = await execAsync(`netstat -aon | findstr :${port}`, { timeout: 2000 });
          if (stdout.trim()) {
            this.log(`⚠️ 端口 ${port} 仍被占用:\n${stdout}`);
          } else {
            this.log(`✅ 端口 ${port} 已释放`);
            return true;
          }
        } catch (verifyError) {
          this.log(`✅ 端口 ${port} 已释放`);
          return true;
        }
      } catch (error: any) {
        this.log(`⚠️ ${method.name} 失败: ${error.message || error}`);
      }
    }

    this.log(`[Windows] ⚠️ 所有方法都失败了`);
    return false;
  }

  /**
   * 查找所有 dsh 进程
   */
  private async findAllDshProcesses(): Promise<number[]> {
    this.log('========== 查找所有 dsh 进程 ==========');
    const pids: number[] = [];

    try {
      if (isWindows()) {
        // 检查 dsh.exe 进程
        try {
          const { stdout } = await execAsync(
            'tasklist /FI "IMAGENAME eq dsh.exe" /FO CSV /NH',
            { timeout: 5000 }
          );

          const lines = stdout.trim().split('\n');
          for (const line of lines) {
            const match = line.match(/^"dsh\.exe","(\d+)"/);
            if (match) {
              const pid = parseInt(match[1], 10);
              if (!pids.includes(pid)) {
                pids.push(pid);
              }
            }
          }
        } catch (error) {
          // dsh.exe 可能不存在（通过 node 运行）
        }

        // 检查 node.exe 进程（可能是 dsh.cmd 调用的）
        const { stdout: nodeStdout } = await execAsync(
          'tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH',
          { timeout: 5000 }
        );

        const nodeLines = nodeStdout.trim().split('\n');
        for (const line of nodeLines) {
          const match = line.match(/^"node\.exe","(\d+)"/);
          if (match) {
            const pid = parseInt(match[1], 10);
            try {
              const { stdout: cmdLine } = await execAsync(
                `wmic process where ProcessId=${pid} get CommandLine /NOHDR`,
                { timeout: 2000 }
              );
              if (cmdLine.toLowerCase().includes('dsh')) {
                if (!pids.includes(pid)) {
                  pids.push(pid);
                }
              }
            } catch (cmdError) {
              // 忽略无法检查命令行的进程
            }
          }
        }
      } else {
        const { stdout } = await execAsync(
          'ps aux | grep -E "[d]sh|[n]ode.*dsh" | awk \'{print $2}\'',
          { timeout: 5000 }
        );

        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          const pid = parseInt(line.trim(), 10);
          if (!isNaN(pid) && !pids.includes(pid)) {
            pids.push(pid);
          }
        }
      }

      this.log(`找到 ${pids.length} 个 dsh 进程: ${pids.join(', ') || '无'}`);
    } catch (error) {
      this.log(`查找进程失败: ${error}`);
    }

    return pids;
  }

  /**
   * 终止指定 PID 的进程
   */
  private async killProcessByPid(pid: number): Promise<boolean> {
    try {
      if (isWindows()) {
        await execAsync(`taskkill /F /PID ${pid}`, { timeout: 5000 });
        this.log(`✅ 已终止进程 ${pid}`);
        return true;
      } else {
        await execAsync(`kill -9 ${pid}`, { timeout: 5000 });
        this.log(`✅ 已终止进程 ${pid}`);
        return true;
      }
    } catch (error) {
      this.log(`⚠️ 终止进程 ${pid} 失败: ${error}`);
      return false;
    }
  }

  /**
   * 终止所有 dsh 进程（强力清除）
   */
  public async killAllDshProcesses(): Promise<number> {
    this.log('========== 开始终止所有 dsh 进程 ==========');

    const pids = await this.findAllDshProcesses();

    if (pids.length === 0) {
      this.log('没有找到运行中的 dsh 进程');
      return 0;
    }

    let killedCount = 0;
    for (const pid of pids) {
      const success = await this.killProcessByPid(pid);
      if (success) {
        killedCount++;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    const remainingPids = await this.findAllDshProcesses();
    if (remainingPids.length > 0) {
      this.log(`⚠️ 仍有 ${remainingPids.length} 个进程未被终止: ${remainingPids.join(', ')}`);

      for (const pid of remainingPids) {
        const success = await this.killProcessByPid(pid);
        if (success) {
          killedCount++;
        }
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    this.log(`========== 终止完成，共终止 ${killedCount} 个进程 ==========`);
    return killedCount;
  }

  /**
   * 清理资源（扩展停用时调用）
   */
  public async cleanup(): Promise<void> {
    this.log('========== 开始清理资源（扩展停用） ==========');

    this.stopProcessMonitoring();

    try {
      const terminal = this.backgroundTerminal;

      if (terminal) {
        this.log('清理后台终端（扩展停用）');

        try {
          terminal.sendText('\x03');
          terminal.sendText('exit');
        } catch (error) {
          this.log(`⚠️ 发送命令失败: ${error}`);
        }

        await new Promise(resolve => setTimeout(resolve, 2000));

        try {
          terminal.sendText('exit');
          await new Promise(resolve => setTimeout(resolve, 500));
          terminal.dispose();
          this.log('✅ 后台终端已清理');
        } catch (error) {
          this.log(`⚠️ 清理终端失败: ${error}`);
        }
        this.backgroundTerminal = undefined;
      }

      this.log('使用系统命令确保所有 dsh 进程被终止');
      const port = this.config.defaultPort;

      await this.killProcessByPortCrossPlatform(port);
      await this.killAllDshProcesses();

      this.log('✅ 清理完成');
    } catch (error) {
      this.log(`⚠️ 清理过程中出错: ${error}`);
    }

    this.log('========== 清理完成 ==========');
  }

  /**
   * 杀掉 DSH 进程
   */
  async killProcess(emitEvent = true, forceAll = true): Promise<void> {
    this.log('========== 开始终止 DSH 进程 ==========');

    this.stopProcessMonitoring();

    try {
      const terminal = this.backgroundTerminal;

      if (terminal) {
        this.log('步骤 1: 尝试优雅关闭（通过终端）');
        try {
          terminal.sendText('\x03');
          terminal.sendText('exit');
          this.log('✅ 已发送 Ctrl+C + exit 到终端');
        } catch (error) {
          this.log(`⚠️ 发送命令失败: ${error}`);
        }

        await new Promise(resolve => setTimeout(resolve, 2000));

        try {
          terminal.sendText('exit');
          await new Promise(resolve => setTimeout(resolve, 500));
          terminal.dispose();
          this.log('✅ 后台终端已销毁');
        } catch (error) {
          this.log(`⚠️ 销毁终端失败: ${error}`);
        }
        this.backgroundTerminal = undefined;
      }

      this.log('步骤 2: 终止占用端口的进程');
      const port = this.config.defaultPort;
      const portKilled = await this.killProcessByPortCrossPlatform(port);
      if (!portKilled) {
        this.log('⚠️ 端口终止方法失败（可能进程已不存在）');
      }

      if (forceAll) {
        this.log('步骤 3: 强制终止所有 dsh 进程（保底）');
        const allKilled = await this.killAllDshProcesses();
        this.log(`✅ 保底方法终止了 ${allKilled} 个进程`);
      }

      this.log('✅ 所有终止步骤已完成');

      if (emitEvent) {
        this.eventManager.emitProcessStateChanged({
          status: DshStatus.NotRunning,
          timestamp: Date.now()
        });

        this.eventManager.emitConnectionChanged({
          connected: false,
          timestamp: Date.now()
        });
      }
    } catch (error: any) {
      this.log(`❌ 进程终止错误: ${error.message}`);

      try {
        if (forceAll) {
          this.log('尝试保底终止方法...');
          await this.killAllDshProcesses();
        }
      } catch (fallbackError) {
        this.log(`保底方法也失败了: ${fallbackError}`);
      }

      if (emitEvent) {
        this.eventManager.emitProcessStateChanged({
          status: DshStatus.NotRunning,
          timestamp: Date.now()
        });

        this.eventManager.emitConnectionChanged({
          connected: false,
          timestamp: Date.now()
        });
      }
    }

    this.log('========== 进程终止流程完成 ==========');
  }

  /**
   * 重启 DSH 进程
   */
  async restartProcess(): Promise<void> {
    try {
      this.eventManager.emitProcessStateChanged({
        status: DshStatus.Restarting,
        timestamp: Date.now()
      });

      await this.killProcess(false);

      await new Promise(resolve => setTimeout(resolve, 1000));

      const success = await this.startInBackground();
      if (!success) {
        throw new Error('后台启动失败');
      }
    } catch (error) {
      this.eventManager.emitProcessStateChanged({
        status: DshStatus.Error,
        timestamp: Date.now(),
        error: String(error)
      });
      this.eventManager.emitProcessError(l10n.t('message.restartFailed', error));
      vscode.window.showErrorMessage(l10n.t('message.restartFailed', error));
    }
  }
}
