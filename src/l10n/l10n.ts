import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 语言包类型定义
 */
export interface Bundle {
  [key: string]: string | Bundle;
}

/**
 * 默认英文语言包（作为回退）
 */
const DEFAULT_BUNDLE: Bundle = {
  status: {
    initializing: "Initializing...",
    checkingStatus: "Checking DeekSeek Harness status...",
    starting: "Starting DeekSeek Harness...",
    waiting: "Waiting for DeekSeek Harness to be ready...",
    ready: "Ready",
    notInstalled: "DeekSeek Harness Not Installed",
    notRunning: "DeekSeek Harness is not running",
    error: "Error",
    restarting: "Restarting DeekSeek Harness...",
    loading: "Loading...",
    refreshing: "Refreshing...",
    disconnected: "Connection lost"
  },
  button: {
    start: "Start DSH",
    help: "View Help",
    starting: "Starting...",
    confirm: "Confirm"
  },
  message: {
    noActiveEditor: "No active editor",
    pleaseSelectCode: "Please select code first",
    killConfirm: "Are you sure you want to kill the DSH process?",
    killFailed: "Failed to kill process: {0}",
    restartConfirm: "Are you sure you want to restart the DSH process?",
    restartFailed: "Failed to restart process: {0}",
    refreshFailed: "Refresh failed: {0}",
    noWorkspace: "Please open a workspace (folder) before starting DSH",
    startTimeout: "Start timeout, please check manually",
    startFailed: "Start failed, please check logs",
    initFailed: "Initialization failed: {0}",
    serviceNotRunning: "DSH service is not currently running",
    pleaseInstall: "Please install the DSH CLI tool first",
    dshNotInstalled: "DSH is not installed. Do you want to install it?",
    install: "Install",
    cancel: "Cancel",
    dshStartTimeout: "DSH start timeout",
    failedToStart: "Failed to start DSH",
    installingComplete: "Installing DSH. Please restart VSCode after installation completes.",
    installFailed: "Failed to install DSH: {0}",
    pleaseOpenWorkspace: "Please open a workspace first",
    unknownState: "Unknown DSH state",
    connecting: "Connecting to DSH...",
    connected: "Connected to DSH",
    killInProgress: "Terminating DSH process...",
    killAllConfirm: "Are you sure you want to force kill all DSH processes? This will terminate all running DSH instances.",
    processesKilled: "Terminated {0} DSH process(es)",
    restartInProgress: "Restarting DSH process...",
    nodeNotInstalled: "Node.js (>= 22.19.0) is required to start DSH, but no Node.js installation was detected. Please install Node.js and restart VSCode.",
    nodeVersionTooLow: "Node.js version {0} is too old. DSH requires Node.js >= 22.19.0. Please upgrade Node.js and restart VSCode.",
    usingNpxStartup: "DSH command not detected. Starting via npx (@deepseek-ai/dsh); the first run may need to download the package, please wait..."
  },
  description: {
    currentStatus: "Current Status",
    notInstalledDesc: "Please install the DSH CLI tool first",
    notRunningDesc: "DSH service is not currently running"
  },
  help: {
    title: "DeepSeek Harness Help",
    unableToLoad: "Unable to load help documentation",
    helpFileNotFound: "Help documentation file does not exist or cannot be read. Please reinstall the extension."
  },
  log: {
    webviewCreated: "Webview Provider created"
  },
  config: {
    port: "DSH server port",
    timeout: "Connection timeout (ms)",
    language: "Extension language",
    languageAuto: "Follow VSCode language",
    languageZhCn: "Simplified Chinese",
    languageEn: "English",
    languageJa: "Japanese",
    languageKo: "Korean"
  }
};

/**
 * L10n 国际化单例类
 */
class L10n {
  private static instance: L10n;
  private bundle: Bundle = DEFAULT_BUNDLE;
  private currentLanguage = 'en';
  private context?: vscode.ExtensionContext;

  private constructor() {
    this.currentLanguage = this.detectLanguage();
  }

  /**
   * 获取 L10n 单例实例
   */
  static getInstance(): L10n {
    if (!L10n.instance) {
      L10n.instance = new L10n();
    }
    return L10n.instance;
  }

  /**
   * 设置扩展上下文（必须在 activate 中调用）
   */
  setContext(context: vscode.ExtensionContext): void {
    this.context = context;
    // 重新检测语言（确保使用最新的配置）
    const newLanguage = this.detectLanguage();
    if (newLanguage !== this.currentLanguage) {
      console.log(`[L10n] Language changed from ${this.currentLanguage} to ${newLanguage}`);
      this.currentLanguage = newLanguage;
    }
    // 同步加载语言包
    this.loadBundleSync();
  }

  /**
   * 同步加载语言包（用于初始化时）
   */
  private loadBundleSync(): void {
    if (!this.context) {
      console.warn('L10n: context not set, using default bundle');
      this.bundle = DEFAULT_BUNDLE;
      return;
    }

    try {
      // 尝试读取语言包文件（同步方式）

      const lang = this.currentLanguage === 'en' ? 'bundle' : `bundle.${this.currentLanguage}`;

      // 在开发模式下，文件可能在 dist 目录，需要尝试多个路径
      const possiblePaths = [
        // 路径1: dist 目录（开发模式）
        path.join(this.context.extensionUri.fsPath, 'dist', 'resources', 'l10n', `${lang}.json`),
        // 路径2: 源代码目录（生产模式）
        path.join(this.context.extensionUri.fsPath, 'resources', 'l10n', `${lang}.json`)
      ];

      let bundleLoaded = false;
      for (const bundlePath of possiblePaths) {
        if (fs.existsSync(bundlePath)) {
          const bundleData = fs.readFileSync(bundlePath, 'utf8');
          this.bundle = JSON.parse(bundleData);
          console.log(`[L10n] Loaded bundle for language ${this.currentLanguage}`);
          bundleLoaded = true;
          break;
        }
      }

      if (!bundleLoaded) {
        // 文件不存在，尝试加载默认英文
        for (const bundlePath of possiblePaths) {
          const defaultPath = bundlePath.replace(`${lang}.json`, 'bundle.json');
          if (fs.existsSync(defaultPath)) {
            const bundleData = fs.readFileSync(defaultPath, 'utf8');
            this.bundle = JSON.parse(bundleData);
            console.log('[L10n] Fell back to default bundle (en)');
            bundleLoaded = true;
            break;
          }
        }
      }

      if (!bundleLoaded) {
        // 默认文件也不存在，使用硬编码的默认语言包
        this.bundle = DEFAULT_BUNDLE;
        console.warn('[L10n] No bundle files found, using hardcoded DEFAULT_BUNDLE');
      }
    } catch (error) {
      console.error('[L10n] Failed to load bundle:', error);
      this.bundle = DEFAULT_BUNDLE;
    }
  }

  /**
   * 检测当前语言
   * 优先级：用户配置 > VSCode 界面语言 > 默认英文
   */
  private detectLanguage(): string {
    // 1. 检查用户配置
    const config = vscode.workspace.getConfiguration('dsh-web');
    const userLanguage = config.get<string>('language');

    if (userLanguage && userLanguage !== 'auto') {
      return userLanguage;
    }

    // 2. 使用 VSCode 界面语言
    const vscodeLang = vscode.env.language;

    // 3. 映射 VSCode 语言代码到我们的语言代码
    const languageMap: { [key: string]: string } = {
      'zh-cn': 'zh-cn',
      'zh-tw': 'zh-cn',
      'ja': 'ja',
      'ko': 'ko',
      'en': 'en',
      'en-us': 'en',
      'en-gb': 'en'
    };

    return languageMap[vscodeLang] || 'en';
  }

  /**
   * 加载语言包
   */
  private async loadBundle(): Promise<void> {
    if (!this.context) {
      console.warn('L10n: context not set, using default bundle');
      this.bundle = DEFAULT_BUNDLE;
      return;
    }

    try {
      // 尝试加载指定语言的语言包
      const bundlePath = vscode.Uri.joinPath(
        this.context.extensionUri,
        'resources',
        'l10n',
        `bundle.${this.currentLanguage}.json`
      );

      const bundleData = await vscode.workspace.fs.readFile(bundlePath);
      this.bundle = JSON.parse(Buffer.from(bundleData).toString('utf8'));
    } catch (error) {
      // 回退到英文默认语言包
      try {
        const defaultPath = vscode.Uri.joinPath(
          this.context.extensionUri,
          'resources',
          'l10n',
          'bundle.json'
        );

        const bundleData = await vscode.workspace.fs.readFile(defaultPath);
        this.bundle = JSON.parse(Buffer.from(bundleData).toString('utf8'));
      } catch (fallbackError) {
        console.error('L10n: failed to load default bundle', fallbackError);
        // 使用硬编码的默认语言包
        this.bundle = DEFAULT_BUNDLE;
      }
    }
  }

  /**
   * 重新加载语言包（用于语言切换）
   */
  async reload(): Promise<void> {
    const newLanguage = this.detectLanguage();
    if (newLanguage !== this.currentLanguage) {
      this.currentLanguage = newLanguage;
      await this.loadBundle();
    }
  }

  /**
   * 翻译函数
   * @param key 翻译键，支持点号分隔的嵌套键（如 'status.initializing'）
   * @param args 参数，用于替换占位符 {0}, {1}, ...
   * @returns 翻译后的文本
   */
  t(key: string, ...args: any[]): string {
    const keys = key.split('.');
    let value: any = this.bundle;

    for (const k of keys) {
      value = value?.[k];
    }

    if (typeof value !== 'string') {
      // 键不存在时返回键本身
      console.warn(`L10n: key "${key}" not found`);
      return key;
    }

    // 替换占位符 {0}, {1}, ...
    return value.replace(/\{(\d+)\}/g, (_, index) => args[index] ?? '');
  }

  /**
   * 获取完整的语言包对象
   */
  getBundle(): Bundle {
    return this.bundle;
  }

  /**
   * 获取当前语言代码
   */
  getLanguage(): string {
    return this.currentLanguage;
  }
}

// 导出单例实例
export const l10n = L10n.getInstance();
