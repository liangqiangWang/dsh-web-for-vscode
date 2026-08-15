/**
 * DeepSeek Harness (dsh) 插件常量定义
 */

// 配置键（新版本）
export const CONFIG_KEYS = {
  PORT: 'dsh-web.port',
  TIMEOUT: 'dsh-web.timeout',
  KILL_ON_EXIT: 'dsh-web.killOnExit',
  LANGUAGE: 'dsh-web.language',
  TERMINAL_STARTUP_DELAY: 'dsh-web.terminalStartupDelay',
  PREFER_NPX: 'dsh-web.preferNpx',
} as const;

// 旧版本配置键（用于迁移）
// 否则会导致两个插件端口相同、页面互相串用的问题。
export const LEGACY_CONFIG_KEYS = {
  PORT: '',
  TIMEOUT: '',
  KILL_ON_EXIT: '',
  LANGUAGE: '',
  TERMINAL_STARTUP_DELAY: '',
} as const;

// 默认配置值
export const DEFAULT_CONFIG = {
  PORT: 3080,
  TIMEOUT: 5000,
  KILL_ON_EXIT: true,
  TERMINAL_STARTUP_DELAY: 0,
  PREFER_NPX: false,
} as const;

// 终端名称
export const TERMINAL_NAME = 'dsh-web';
export const BACKGROUND_TERMINAL_NAME = 'dsh-daemon';

// HTTP 端点
export const API_ENDPOINTS = {
  HEALTH: '/',
} as const;

// 安装命令
export const INSTALL_COMMANDS = {
  WINDOWS: 'npm install -g @deepseek-ai/dsh',
  UNIX: 'npm install -g @deepseek-ai/dsh',
} as const;

// 检测命令
export const CHECK_COMMANDS = {
  WINDOWS: 'where dsh',
  UNIX: 'which dsh',
} as const;

// 启动参数
export const START_ARGS = {
  MODE: 'web',
  PORT: '--port',
} as const;

// Node 环境要求
export const REQUIRED_NODE_VERSION = '22.19.0';

// npx 启动相关
export const NPX_PACKAGE = '@deepseek-ai/dsh';
// npx 首次运行可能需要下载包，等待时间远超 dsh 直接启动
export const NPX_START_TIMEOUT = 120000;

// Windows 特定命令
export const WINDOWS_COMMANDS = {
  // 方法1：使用 taskkill（跨 shell 兼容，PowerShell/cmd/bash 都支持）
  KILL_PROCESS_BY_PORT_TASKKILL: (port: number) =>
    `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /F /PID %a`,
  // 方法2：使用 PowerShell 查找并终止进程（仅 PowerShell）
  KILL_PROCESS_BY_PORT_POWERSHELL: (port: number) =>
    `powershell -Command "try { $pid = (Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess; if ($pid) { Stop-Process -Id $pid -Force } } catch {}"`,
  // 方法3：使用 Git Bash/WSL bash 语法
  KILL_PROCESS_BY_PORT_BASH: (port: number) =>
    `pid=$(lsof -ti:${port} 2>/dev/null || netstat -aon | findstr :${port} | awk '{print $5}' | head -1); if [ -n "$pid" ]; then taskkill //F //PID $pid 2>/dev/null || kill -9 $pid 2>/dev/null; fi`,
  // 检查 npm 全局包
  NPM_CHECK_GLOBAL: 'npm list -g @deepseek-ai/dsh --depth=0',
  // 获取 npm 前缀路径
  NPM_GET_PREFIX: 'npm config get prefix',
} as const;
