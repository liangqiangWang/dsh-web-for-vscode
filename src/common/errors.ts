/**
 * 自定义错误类
 */

/**
 * DSH 启动超时错误
 */
export class DshTimeoutError extends Error {
  constructor(timeout: number) {
    super(`DSH start timeout after ${timeout}ms`);
    this.name = 'DshTimeoutError';
  }
}

/**
 * 工作区错误
 */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(`Workspace error: ${message}`);
    this.name = 'WorkspaceError';
  }
}
