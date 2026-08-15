# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 提供项目指导。

## 项目概述

VSCode 扩展，用于集成 DeepSeek Harness (DSH) AI 助手。在侧边栏提供 DSH Web 界面，支持启动/连接 DSH 服务。

**多语言支持**：支持中文（简体）、英文、日语、韩语，自动跟随 VSCode 界面语言，可手动配置切换。

## 快速开始

```bash
npm install
npm run compile    # 开发模式
npm run watch      # 监听模式
npm run package    # 生产打包
```

## 项目架构

**分层架构**：
- **核心层**：`DshManager.ts`（进程管理）、`DshClient.ts`（HTTP 客户端）、`EventManager.ts`（事件系统）
- **视图层**：`WebviewProvider.ts`（侧边栏 Webview）
- **命令层**：`commands/`（各种命令处理器）
- **服务层**：`ConfigurationService.ts`（配置管理）
- **国际化层**：`l10n/`（多语言支持）

**关键流程**：
1. `extension.ts` 激活 → 创建 `DshManager` → 注册 `WebviewProvider` → 注册命令
2. `DshManager` 检查安装 → 启动进程 → HTTP 通信 → 触发事件更新 UI

## 核心设计原则

### 后台终端架构

项目使用**后台终端**管理 DSH 进程，通过 iframe 嵌入 Web 界面：

| 终端类型 | 名称 | 可见性 | 命令 | 生命周期 |
|---------|------|--------|------|---------|
| **后台终端** | `dsh-daemon` | 隐藏 | `dsh web --port 3080` 或 `npx -y @deepseek-ai/dsh web --port 3080`（兜底） | 启动 → VSCode 关闭 |

**关键特性**：
- 后台进程持续运行，Webview 始终可访问
- VSCode 关闭时自动清理后台终端
- DSH Web UI 通过 iframe 嵌入，无需 TUI 终端

**实现代码**：
```typescript
// 创建后台终端（隐藏）
const terminal = vscode.window.createTerminal({
  name: BACKGROUND_TERMINAL_NAME,
  cwd: workspacePath,
  // 不指定 location = 隐藏
  env: { DSH_CALLER: 'vscode' }
});
terminal.sendText(command); // dsh web --port 3080 或 npx -y @deepseek-ai/dsh web --port 3080
```

### 启动模式决策（dsh / npx）

`DshManager.resolveStartupMode()` 在 `startInBackground()` 创建终端前决策启动方式：

```
Node 环境检查（node 存在且 >= 22.19.0，失败则禁止启动并报错）
  ├─ preferNpx=true  → 直接使用 npx（不检测 dsh，启动失败不回退）
  └─ preferNpx=false → dsh 已安装 → dsh 命令启动
                       dsh 未安装 → npx 兜底启动（提示 message.usingNpxStartup）
```

**关键点**：
- **Node 检查**：`checkNodeEnvironment()` 执行 `node --version`（回退 where/which），结果缓存 5 分钟（`getStatus()` 首屏也会调用）；版本不足报 `message.nodeNotInstalled` / `message.nodeVersionTooLow`
- **npx 命令必须带 `-y`**：后台隐藏终端无法响应 npx 的交互式安装确认，不加会卡住直到超时
- **npx 启动超时为 120s**（`NPX_START_TIMEOUT`）：首次运行需下载包，远超 dsh 直接启动的 15s
- **getStatus() 联动**：dsh 未安装但 Node 合格时返回 `NotRunning`（而非 `NotInstalled`），让 Webview 显示启动按钮以触发 npx 兜底；Node 不合格才返回 `NotInstalled`，原因经 `getNotInstalledReason()` 展示
- **真实启动链路**是 Webview `startDsh` 消息 → `WebviewProvider.startDsh()` → `startInBackground()`；`startOrAttach()` 目前无调用方，仅保持逻辑一致

### 事件驱动架构

使用 `EventManager` 进行组件间通信，避免直接依赖：
- `ProcessStateChanged` - 进程状态变化
- `ConnectionChanged` - 连接状态变化
- `ProcessError` - 错误事件

### 多语言架构（i18n）

使用自定义 `L10n` 单例类实现国际化，支持扩展端和 Webview 端的多语言：

**语言检测优先级**：
1. 用户配置（`dsh-web.language`）
2. VSCode 界面语言（`vscode.env.language`）
3. 默认英文回退

**双层翻译机制**：
- **扩展端**：TypeScript 代码中使用 `l10n.t('key')`
- **Webview 端**：JavaScript 代码中使用 `t('key')`（通过注入的语言包）

**文件结构**：
```
src/l10n/
├── l10n.ts              # L10n 单例类
└── index.ts             # 导出

src/resources/l10n/      # 运行时语言包（源代码）
├── bundle.json          # 英文（默认）
├── bundle.zh-cn.json    # 简体中文
├── bundle.ja.json       # 日语
└── bundle.ko.json       # 韩语

dist/resources/l10n/     # 编译后的语言包（开发模式）
└── (同上，由 CopyWebpackPlugin 复制)

package.nls.*.json        # 扩展元数据翻译
```

**语言包路径解析**：
- **开发模式**：webpack 将语言包复制到 `dist/resources/l10n/`，但 `extensionUri.fsPath` 指向源代码目录
  - 解决方案：`loadBundleSync()` 同时尝试 `dist/` 和源代码目录两个路径
- **生产模式**：打包后文件在源代码目录，正常工作

**关键实现**：
```typescript
// 扩展端使用
import { l10n } from './l10n';
const message = l10n.t('status.initializing');

// Webview 端语言包注入
const bundleJson = JSON.stringify(l10n.getBundle());
webview.html = `
  <script>
    window.L10N_BUNDLE = ${bundleJson};
    function t(key, ...args) {
      // 翻译逻辑
    }
  </script>
`;
```

**语言切换**：
- 用户修改配置后自动重新加载语言包
- 触发 Webview 刷新以应用新语言
- 无需重启 VSCode

**菜单翻译 vs 运行时翻译**：

| 类型 | 文件 | 控制方式 | 何时生效 |
|------|------|----------|---------|
| **菜单/命令标题** | `package.nls.*.json` | VSCode 显示语言设置 | 重新加载窗口 |
| **运行时文案** | `bundle.*.json` | 扩展配置 `dsh-web.language` | 修改配置后立即生效 |

**切换语言功能**：
- 菜单方式：点击侧边栏的"更多操作"（...）→ "切换语言"
- 命令面板：`Ctrl+Shift+P` → 搜索 "Change Language"
- 快捷命令：`Ctrl+Shift+P` → "DSH: Debug Language Status"（调试语言状态）

## Windows 平台关键注意事项

### 跨 Shell 兼容性

**问题**：Windows 用户可能使用 **PowerShell、cmd、Git Bash、WSL** 等不同默认终端

**解决方案**：实现跨平台命令回退机制

#### 1. 安装检测（多方法回退）

```typescript
// 方法1a: where 命令（PowerShell/cmd）
await execAsync('where dsh', { timeout: 2000 });

// 方法1b: which 命令（Git Bash/WSL）
await execAsync('which dsh', { timeout: 2000, shell: true });

// 方法2: npm 全局包检查
await execAsync('npm list -g @deepseek-ai/dsh --depth=0');

// 方法3: 文件路径验证
const prefix = await execAsync('npm config get prefix');
const paths = [
  path.join(prefix, 'dsh.cmd'),
  path.join(prefix, 'dsh'),
  path.join(prefix, 'node_modules', '.bin', 'dsh.cmd')
];
// 检查文件是否存在
```

#### 2. 进程终止（跨 Shell 三层保险）

```typescript
// 按优先级尝试不同方法
const methods = [
  {
    name: 'taskkill (cmd)',
    command: `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /F /PID %a`
  },
  {
    name: 'taskkill (PowerShell)',
    command: `powershell -Command "Stop-Process -Id $pid -Force"`
  },
  {
    name: 'bash/netstat',
    command: `pid=$(netstat -aon | findstr :${port} | awk '{print $5}' | head -1); taskkill //F //PID $pid`
  }
];

// 依次尝试，直到成功
for (const method of methods) {
  try {
    await execAsync(method.command, { timeout: 5000 });
    return true;
  } catch {
    continue; // 尝试下一个方法
  }
}
```

### 关键陷阱和解决方案

#### 陷阱 1：spawn .cmd 文件需要 shell: true

错误：
```typescript
spawn('dsh.cmd', ['--version'], {}); // spawn EINVAL
```

正确：
```typescript
spawn('dsh.cmd', ['--version'], { shell: true });
```

#### 陷阱 2：时序竞争 - onDidCloseTerminal 清空引用

错误：
```typescript
this.backgroundTerminal.sendText('exit');
// 触发 onDidCloseTerminal → this.backgroundTerminal = undefined
if (this.backgroundTerminal) {  // false，跳过清理
  this.backgroundTerminal.dispose();
}
```

正确：
```typescript
const terminal = this.backgroundTerminal;  // 保存到本地变量
terminal.sendText('exit');
// onDidCloseTerminal 不会影响本地变量
terminal.dispose();
this.backgroundTerminal = undefined;
```

#### 陷阱 3：terminal.dispose() 不保证进程终止

正确（三层保险）：
```typescript
// 1. 优雅关闭
terminal.sendText('\x03');  // Ctrl+C
terminal.sendText('exit');
await sleep(2000);

// 2. 强制终止
terminal.dispose();

// 3. 系统命令确保
await execAsync('taskkill /F /PID <pid>');
```

## Webview 初始化核心要点

### 关键字段（WebviewProvider）

- `isInitialized` - 避免重复初始化
- `initializationLock` - 防止并发初始化
- `initializationVersion` - 丢弃过期的状态更新
- `visibilityChangeTimer` - 防抖处理（300ms）

### 关键边界场景

#### 1. 重载窗口（Cmd+R）
```typescript
// HTML 被清空但 isInitialized 仍为 true
const isHtmlEmpty = !webviewView.webview.html;
if (isHtmlEmpty && this.isInitialized) {
  this.isInitialized = false;  // 重置
}
```

#### 2. 状态持久化
```javascript
// 可以持久化：ready
// 不持久化（临时）：loading, error, notInstalled, restarting

function isStateValid(savedState) {
  const invalidStates = ['error', 'notInstalled', 'loading', 'restarting'];
  if (invalidStates.includes(savedState.state)) {
    return false; // 临时状态，不恢复
  }
  return Date.now() - savedState.timestamp < STATE_EXPIRY_MS;
}
```

## 最佳实践

### 应该做的

1. **使用本地变量保存引用** - 避免事件监听器时序竞争
   ```typescript
   const terminal = this.backgroundTerminal;  // 保存引用
   ```

2. **多层检测机制** - 不依赖单一检测方法
   ```typescript
   try { method1 } catch { try { method2 } catch { method3 } }
   ```

3. **添加详细日志** - 使用分隔符和步骤标记
   ```typescript
   this.log('========== 开始 xxx ==========');
   this.log('[步骤1] ...');
   ```

4. **跨 Shell 兼容** - 提供多种命令回退
   ```typescript
   // PowerShell、cmd、bash 都要支持
   ```

5. **清理资源** - 在 deactivate() 中清理
   ```typescript
   export async function deactivate() {
     await dshManager.cleanup();
   }
   ```

6. **多语言支持** - 所有用户可见文本使用翻译函数
   ```typescript
   // 正确
   vscode.window.showInformationMessage(l10n.t('message.starting'));
   this.setState('error', l10n.t('status.notRunning'));

   // 错误
   vscode.window.showInformationMessage('正在启动...');
   this.setState('error', 'DSH 未启动');
   ```

### 不应该做的

1. **不要假设环境变量** - Node.js 的 PATH 可能与终端不同
2. **不要使用 detached 进程** - 会成为僵尸进程
3. **不要假设 terminal.dispose() 终止进程** - 需要系统命令确保
4. **不要持久化临时状态** - loading/error/notInstalled 不应持久化
5. **不要忽略 Windows 特殊性** - .cmd 文件需要 shell: true
6. **不要硬编码用户可见文本** - 所有文案必须使用 l10n.t() 翻译
7. **不要在 bundle.*.json 中创建重复的键** - JSON 重复键会导致解析问题

## 调试技巧

### 查看日志
1. 打开输出面板：`Ctrl+Shift+P` → "Output: Show Output Views"
2. 查找关键标记：`========== 开始 xxx ==========`
3. 验证所有步骤日志是否完整

### 多语言调试

1. **查看 Debug Console**：
   - 打开 Debug Console 面板：`Cmd+Shift+Y` 或 View → Run
   - 查找以 `[L10n]` 开头的日志

2. **检查语言检测**：
   ```
   [L10n] detectLanguage - userLanguage from config: "zh-cn"
   [L10n] detectLanguage - using user config: zh-cn
   [L10n] Detected language: zh-cn
   ```

3. **验证语言包加载**：
   ```
   [L10n] Trying to load bundle for language: zh-cn
   [L10n] Trying path: /path/to/dist/resources/l10n/bundle.zh-cn.json
   [L10n] File exists: true
   [L10n] ✓ Loaded bundle for language zh-cn, size: 4020
   [L10n] Sample translation: 正在初始化...
   ```

4. **验证语言包注入**（Webview 控制台）：
   ```
   === 脚本开始执行 ===
   语言包注入成功，语言: zh-cn
   ```

5. **测试语言切换**：
   - 修改 `dsh-web.language` 配置
   - 查看日志确认语言重新加载
   - 刷新 Webview 验证新语言

6. **使用调试命令**：
   - `Ctrl+Shift+P` → "DSH: Debug Language Status"
   - 查看弹窗中的语言状态信息

7. **常见问题排查**：
   | 问题 | 原因 | 解决方案 |
   |------|------|---------|
   | 显示英文 | 配置是 `auto`，VSCode 是英文 | 修改 `dsh-web.language` 为具体语言 |
   | 显示英文 | `File exists: false` | 检查 `dist/resources/l10n/` 是否存在文件 |
   | 显示键名 | 翻译键不存在 | 检查 bundle.*.json 文件 |

## 常见问题

### Q: 为什么菜单标题是英文，但 Webview 内容是中文？
**A**: 这是正常行为。菜单翻译由 VSCode 显示语言控制，Webview 内容由扩展配置控制。

### Q: 修改配置后为什么没有立即生效？
**A**: 请检查：
1. 是否重新加载了窗口（`Cmd+Shift+P` → "Reload Window"）
2. Debug Console 中是否显示 `File exists: true`
3. 语言包文件是否在 `dist/resources/l10n/` 目录中

### Q: 如何添加新语言？
**A**: 步骤：
1. 创建 `src/resources/l10n/bundle.{langId}.json`
2. 创建 `package.nls.{langId}.json`
3. 在 `package.json` 的 `localizations` 中添加配置
4. 在 `package.json` 的 `dsh-web.language` 枚举中添加语言选项
5. 运行 `npm run compile`

### Q: 开发模式下为什么找不到语言包？
**A**: 开发模式下，webpack 将文件编译到 `dist/` 目录，但 `extensionUri.fsPath` 仍指向源代码目录。代码会自动尝试两个路径，如果都找不到会使用硬编码的 DEFAULT_BUNDLE（英文）。

### 验证进程终止（Windows）
```powershell
# 检查端口占用
netstat -ano | findstr :3080
# 应该无输出

# 检查进程
tasklist | findstr node.exe
```

### 关键日志位置
- **初始化**：`[DshManager] 开始初始化 DSH`
- **语言检测**：`[L10n] detectLanguage - userLanguage from config: "zh-cn"`
- **语言加载路径**：`[L10n] Trying path: /path/to/bundle.zh-cn.json`
- **语言加载结果**：`[L10n] ✓ Loaded bundle for language zh-cn, size: 4020`
- **进程终止**：`========== 开始终止 DSH 进程 ==========`
- **跨 shell 尝试**：`[步骤4] 尝试方法: taskkill (cmd)`

**日志输出位置**：
- **Output 面板**：扩展自定义日志（如 Webview Provider 日志）
- **Debug Console**：`[L10n]` 开头的语言相关日志、`console.log` 输出
- **开发者工具**：Webview 端 JavaScript 日志（Help → Toggle Developer Tools）

## 相关文件

**核心实现**：
- [DshManager.ts](src/core/DshManager.ts) - 进程管理、终端创建、跨 shell 兼容
- [DshClient.ts](src/core/DshClient.ts) - HTTP 客户端、健康检查
- [WebviewProvider.ts](src/views/webview/WebviewProvider.ts) - UI 状态管理、webview 生命周期
- [extension.ts](src/extension.ts) - 扩展激活/停用、清理逻辑
- [l10n/l10n.ts](src/l10n/l10n.ts) - 国际化单例类

**配置**：
- [constants.ts](src/common/constants.ts) - 常量定义、跨 shell 命令
- [webpack.config.js](webpack.config.js) - CopyWebpackPlugin 配置（复制语言包到 dist）

**语言包**：
- [resources/l10n/](src/resources/l10n/) - 运行时翻译文件
- [package.nls.*.json](package.nls.*) - 扩展元数据翻译
