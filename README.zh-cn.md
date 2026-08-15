# DeepSeek Harness Web Integration

[![VSCode](https://img.shields.io/badge/VSCode-Extension-blue)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-4.x-blue)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

**语言 / Languages:** [English](README.md) | **简体中文**

一款可以在侧边栏使用 DeepSeek Harness (DSH) Web 功能的 VSCode 扩展。

![主视图](https://raw.githubusercontent.com/liangqiangWang/dsh-web-for-vscode/master/screenshot/main_web_view.png)

## 特性

- 🌐 **多语言支持**：支持简体中文、英语、日语、韩语，自动跟随 VSCode 界面语言
- 🖥️ **侧边栏集成**：在 VSCode 侧边栏显示 DSH Web 界面
- 🚀 **快速启动**：通过单个命令直接从 VSCode 启动 DSH
- ⚙️ **可配置**：自定义端口和语言设置
- 🔄 **进程管理**：支持重启和停止 DSH 进程

## 界面预览

### 启动视图

点击"启动 DSH"按钮，直接从侧边栏启动 DSH：

![启动视图](https://raw.githubusercontent.com/liangqiangWang/dsh-web-for-vscode/master/screenshot/start_view.png)

### 侧边栏视图

在 VSCode 侧边栏中直接使用 DSH：

![侧边栏视图](https://raw.githubusercontent.com/liangqiangWang/dsh-web-for-vscode/master/screenshot/side_view.png)

### 工具栏菜单

通过面板工具栏刷新连接、在编辑器/浏览器中打开、查看帮助及管理 DSH 进程：

![菜单视图](https://raw.githubusercontent.com/liangqiangWang/dsh-web-for-vscode/master/screenshot/menu_view.png)

## 安装

### 前置要求

1. Node.js >= 22.19.0（可通过 `node --version` 验证）。扩展启动 DSH 前会自动检查。

2. 从 VSCode 市场安装此扩展（搜索 "DeepSeek Harness Web Integration"）

3. （可选，推荐，启动更快）全局安装 DeepSeek Harness (DSH)。若未检测到 `dsh` 命令，扩展会自动改用 `npx -y @deepseek-ai/dsh web` 方式启动（首次运行可能需要下载包）：
   ```bash
   npm install -g @deepseek-ai/dsh
   ```

## 使用

### 启动 DSH

1. 打开 VSCode 侧边栏的 DSH-Web 面板
2. 点击"启动 DSH"按钮
3. 等待服务启动完成
4. 开始使用

### 连接外部 DSH 进程

如果你已经在终端或其他地方启动了 DSH 服务，可以让插件直接连接到该进程：

1. 打开 VSCode 设置（`Ctrl+,` / `Cmd+,`）
2. 搜索 `dsh-web.port`，将端口号修改为外部进程正在使用的端口
3. 重新打开侧边栏的 DSH-Web 面板

### 进程管理

在侧边栏顶部工具栏：
- **刷新连接**：刷新 DSH Web 页面
- **更多操作**：
  - 在编辑器中打开
  - 在浏览器中打开
  - 查看帮助
  - **进程管理**：
    - 重启进程
    - 停止进程

## 配置

你可以在 VSCode 设置中配置此扩展：

| 设置 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `dsh-web.port` | number | `3080` | DSH 服务器端口 |
| `dsh-web.timeout` | number | `5000` | 连接超时时间（毫秒） |
| `dsh-web.language` | string | `auto` | 界面语言（`auto`/`zh-cn`/`en`/`ja`/`ko`） |
| `dsh-web.preferNpx` | boolean | `false` | 优先使用 `npx -y @deepseek-ai/dsh web` 方式启动，而不使用全局安装的 `dsh` 命令。启用后启动失败不会回退到 `dsh` 命令方式 |

### 语言切换

扩展支持以下语言：
- **自动（auto）**：跟随 VSCode 界面语言
- **简体中文（zh-cn）**
- **英语（en）**
- **日语（ja）**
- **韩语（ko）**

你可以通过以下方式切换语言：
1. 在设置中修改 `dsh-web.language` 配置
2. 通过侧边栏工具栏的"更多操作"菜单 → "切换语言"

## 许可证

MIT
