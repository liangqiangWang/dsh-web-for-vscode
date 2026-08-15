/**
 * 命令注册入口
 */

import * as vscode from 'vscode';

/**
 * 注册所有命令
 */
export function registerAllCommands(
  _context: vscode.ExtensionContext,
  _manager: unknown
): void {
  // appendCode 命令已移除（dsh 无等价 API）
}
