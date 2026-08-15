import * as vscode from 'vscode';
import { DshManager } from './core/DshManager';
import { registerAllCommands } from './commands';
import { registerWebviewCommands } from './commands/webviewCommands';
import { DshWebviewProvider } from './views/webview/WebviewProvider';
import { ConfigurationService } from './services/configuration';
import { l10n } from './l10n';

// 保存 DshManager 实例引用，用于 deactivate 清理
let dshManager: DshManager;

/**
 * 插件激活函数
 */
export function activate(context: vscode.ExtensionContext): void {
  console.log('DSH Integration extension is now active!');

  // 初始化 L10n（同步加载语言包）
  l10n.setContext(context);
  console.log('L10n initialized with language:', l10n.getLanguage());

  // 初始化配置服务
  const configService = ConfigurationService.getInstance();

  // 监听配置变化
  const configDisposable = configService.onDidChangeConfiguration(async (event) => {
    if (event.affectsConfiguration('dsh-web.port') ||
        event.affectsConfiguration('dsh-web.timeout') ||
        event.affectsConfiguration('dsh-web.preferNpx')) {
      console.log('DSH configuration changed');
    }

    if (event.affectsConfiguration('dsh-web.language')) {
      console.log('DSH language changed, reloading L10n');
      await l10n.reload();
      vscode.commands.executeCommand('dsh-web.refreshWebview');
    }
  });
  context.subscriptions.push(configDisposable);

  // 创建核心管理器
  const manager = new DshManager(context);
  dshManager = manager;

  // 回调占位变量
  let onOpenInBrowser: () => void = () => undefined;
  let onToggleSidebar: () => void = () => undefined;

  // 创建 webview provider
  const webviewProvider = new DshWebviewProvider(
    context,
    configService,
    manager,
    () => onOpenInBrowser(),
    () => onToggleSidebar()
  );

  // 设置实际回调
  onOpenInBrowser = () => webviewProvider.openInBrowser();
  onToggleSidebar = () => webviewProvider.toggleSidebar();

  // 注册 webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dshWebview', webviewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // 注册所有命令
  registerAllCommands(context, manager);

  // 注册 webview 相关命令
  registerWebviewCommands(context, webviewProvider, manager);

  console.log('DSH Integration commands registered');
}

/**
 * 插件停用函数
 */
export async function deactivate(): Promise<void> {
  console.log('DSH Integration extension is now deactivated!');

  if (dshManager) {
    const configService = ConfigurationService.getInstance();
    const shouldKill = configService.getKillOnExit();

    if (shouldKill) {
      await dshManager.cleanup();
      console.log('DSH process terminated on exit');
    } else {
      console.log('DSH process left running (killOnExit = false)');
    }
  }
}
