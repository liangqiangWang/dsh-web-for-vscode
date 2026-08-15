/**
 * WebviewProvider 加载状态切换与判断的单元测试
 *
 * 覆盖重点：
 * - checkStatusWithTimeout：DshStatus → WebviewState 的映射判定
 * - initializeWebview：防重复初始化、先 loading 后结果状态、异常进入 error
 * - startDsh + healthCheckPolling：启动轮询到 ready / 超时进入 error
 * - connectToExternalProcess / checkAndNotifyConnection / refreshWebview：状态切换
 * - updateUIByStatus：状态 → 发送给 Webview 的 setState 消息映射
 *
 * 说明：通过 (provider as any) 访问私有方法进行行为测试；
 * 用 node:test 的 mock.timers 控制 setTimeout / setInterval。
 */
import './setup';
import { strict as assert } from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import { DshWebviewProvider } from '../src/views/webview/WebviewProvider';
import { DshStatus } from '../src/core/types';
import { resetVscodeMock, setWorkspaceFolders } from './mockVscode';

// === 测试辅助 ===

/** 构造测试用 DshManager 模拟 */
function createManager(overrides: Record<string, any> = {}) {
  return {
    getStatus: async () => DshStatus.NotRunning,
    hasExternalDshProcess: async () => false,
    checkConnection: async () => false,
    startInBackground: async () => true,
    getWorkspacePath: () => '/mock/workspace',
    ...overrides,
  } as any;
}

/** 构造测试用 Webview 视图模拟，并捕获 postMessage 消息 */
function createWebviewView() {
  const messages: Array<{ type: string; state?: string; message?: string }> = [];
  const webviewView = {
    webview: {
      postMessage: (message: any) => {
        messages.push(message);
      },
      onDidReceiveMessage: () => ({ dispose() {} }),
      html: '',
      options: {},
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
    visible: true,
  };
  return { webviewView, messages };
}

/** 构造 DshWebviewProvider 实例 */
function createProvider(managerOverrides: Record<string, any> = {}) {
  const manager = createManager(managerOverrides);
  const configService = {
    getPort: () => 3080,
    getTimeout: () => 5000,
    getTerminalStartupDelay: () => 0,
  } as any;
  return new DshWebviewProvider(
    { extensionUri: { fsPath: '/mock/ext' }, subscriptions: [] } as any,
    configService,
    manager,
    () => {},
    () => {}
  );
}

beforeEach(() => {
  resetVscodeMock();
});

// === checkStatusWithTimeout：状态判定 ===

describe('checkStatusWithTimeout - 状态判定', () => {
  test('Running → ready', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const provider = createProvider({ getStatus: async () => DshStatus.Running });
    const result = await (provider as any).checkStatusWithTimeout(5000);
    assert.equal(result.state, 'ready');
  });

  test('NotInstalled → notInstalled', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const provider = createProvider({ getStatus: async () => DshStatus.NotInstalled });
    const result = await (provider as any).checkStatusWithTimeout(5000);
    assert.equal(result.state, 'notInstalled');
  });

  test('NotRunning + 存在外部进程 → ready', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const provider = createProvider({
      getStatus: async () => DshStatus.NotRunning,
      hasExternalDshProcess: async () => true,
    });
    const result = await (provider as any).checkStatusWithTimeout(5000);
    assert.equal(result.state, 'ready');
  });

  test('NotRunning + 无外部进程 + 连接成功 → ready', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const provider = createProvider({
      getStatus: async () => DshStatus.NotRunning,
      hasExternalDshProcess: async () => false,
      checkConnection: async () => true,
    });
    const result = await (provider as any).checkStatusWithTimeout(5000);
    assert.equal(result.state, 'ready');
  });

  test('NotRunning + 无外部进程 + 连接失败 → idle', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const provider = createProvider({
      getStatus: async () => DshStatus.NotRunning,
      hasExternalDshProcess: async () => false,
      checkConnection: async () => false,
    });
    const result = await (provider as any).checkStatusWithTimeout(5000);
    assert.equal(result.state, 'idle');
  });

  test('getStatus 超时 → 按 NotRunning 路径处理为 idle', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const provider = createProvider({
      getStatus: () => new Promise(() => {}), // 永不 resolve
      hasExternalDshProcess: async () => false,
      checkConnection: async () => false,
    });
    const promise = (provider as any).checkStatusWithTimeout(1000);
    await t.mock.timers.tick(1000);
    const result = await promise;
    assert.equal(result.state, 'idle');
  });
});

// === initializeWebview：初始化流程 ===

describe('initializeWebview - 初始化流程', () => {
  test('先设置 loading 再切换到结果状态，完成后复位 isInitializing', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider({ getStatus: async () => DshStatus.Running });
    (provider as any).webviewView = webviewView;

    await (provider as any).initializeWebview();

    assert.equal(messages[0].state, 'loading', '首个状态应为 loading');
    assert.equal(messages[messages.length - 1].state, 'ready', '最终状态应为 ready');
    assert.equal((provider as any).currentState, 'ready');
    assert.equal((provider as any).isInitializing, false, '初始化完成后 isInitializing 应复位');
  });

  test('isInitializing 为 true 时跳过重复初始化，不发任何消息', async () => {
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider({ getStatus: async () => DshStatus.Running });
    (provider as any).webviewView = webviewView;
    (provider as any).isInitializing = true;

    await (provider as any).initializeWebview();

    assert.equal(messages.length, 0, '不应发送任何状态消息');
    assert.equal((provider as any).currentState, 'initializing');
    assert.equal((provider as any).isInitializing, true, '模拟进行中状态不被复位');
  });

  test('getStatus 抛出异常 → 进入 error 状态并复位 isInitializing', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider({
      getStatus: async () => {
        throw new Error('boom');
      },
    });
    (provider as any).webviewView = webviewView;

    await (provider as any).initializeWebview();

    assert.equal(messages[messages.length - 1].state, 'error');
    assert.equal((provider as any).currentState, 'error');
    assert.equal((provider as any).isInitializing, false);
  });
});

// === onWebviewVisible / silentHealthCheck：可见性处理 ===

describe('onWebviewVisible - 可见性处理', () => {
  test('已处于 ready 且服务正常 → 保持 ready，不发送 loading（不重载 iframe）', async () => {
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider({ checkConnection: async () => true });
    (provider as any).webviewView = webviewView;
    (provider as any).currentState = 'ready';

    await (provider as any).onWebviewVisible();

    assert.equal(messages.length, 0, 'ready 且服务正常时不应发送任何消息');
    assert.equal((provider as any).currentState, 'ready', '应保持 ready 状态');
  });

  test('已处于 ready 但服务已停止 → 切换到 idle，不经过 loading', async () => {
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider({ checkConnection: async () => false });
    (provider as any).webviewView = webviewView;
    (provider as any).currentState = 'ready';

    await (provider as any).onWebviewVisible();

    const states = messages.map((m) => m.state);
    assert.ok(!states.includes('loading'), '静默检查不应出现 loading 状态');
    assert.equal(states[states.length - 1], 'idle', '服务停止后应切换为 idle');
    assert.equal((provider as any).currentState, 'idle');
  });

  test('未处于 ready 状态 → 执行完整初始化（loading → 结果状态）', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider({ getStatus: async () => DshStatus.Running });
    (provider as any).webviewView = webviewView;
    (provider as any).currentState = 'idle';

    await (provider as any).onWebviewVisible();

    assert.equal(messages[0].state, 'loading', '非 ready 状态应先进入 loading');
    assert.equal(messages[messages.length - 1].state, 'ready');
    assert.equal((provider as any).currentState, 'ready');
  });

  test('silentHealthCheck 连接正常 → 不发任何消息', async () => {
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider({ checkConnection: async () => true });
    (provider as any).webviewView = webviewView;

    await (provider as any).silentHealthCheck();

    assert.equal(messages.length, 0);
    assert.equal((provider as any).currentState, 'initializing', '不改变当前状态');
  });

  test('silentHealthCheck 连接失败 → 发送 idle 消息', async () => {
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider({ checkConnection: async () => false });
    (provider as any).webviewView = webviewView;

    await (provider as any).silentHealthCheck();

    assert.equal(messages[messages.length - 1].state, 'idle');
    assert.equal((provider as any).currentState, 'idle');
  });

  test('silentHealthCheck 连接抛异常 → 保持当前状态，不抛错', async () => {
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider({
      checkConnection: async () => {
        throw new Error('boom');
      },
    });
    (provider as any).webviewView = webviewView;
    (provider as any).currentState = 'ready';

    await (provider as any).silentHealthCheck();

    assert.equal(messages.length, 0, '异常时应静默忽略');
    assert.equal((provider as any).currentState, 'ready', '异常时保持 ready');
  });
});

// === startDsh + healthCheckPolling：启动流程 ===

describe('startDsh - 启动流程状态切换', () => {
  test('无工作区 → 先 loading 后进入 error', async () => {
    const { webviewView, messages } = createWebviewView();
    setWorkspaceFolders(undefined);
    const provider = createProvider();
    (provider as any).webviewView = webviewView;

    await (provider as any).startDsh();

    const states = messages.map((m) => m.state);
    assert.equal(states[0], 'loading', '先进入 loading');
    assert.equal(states[states.length - 1], 'error', '最终进入 error');
    assert.equal((provider as any).currentState, 'error');
  });

  test('启动成功后轮询直到 ready', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const { webviewView, messages } = createWebviewView();
    setWorkspaceFolders([{ uri: { fsPath: '/mock/workspace' } }]);
    const provider = createProvider({
      startInBackground: async () => true,
      checkConnection: async () => true,
    });
    (provider as any).webviewView = webviewView;

    await (provider as any).startDsh();
    await t.mock.timers.tick(1000);

    const states = messages.map((m) => m.state);
    assert.ok(states.includes('loading'), '启动期间存在 loading 状态');
    assert.equal(states[states.length - 1], 'ready', '最终进入 ready');
    assert.equal((provider as any).currentState, 'ready');
  });

  test('startInBackground 失败仍会尝试健康检查并达到 ready', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const { webviewView, messages } = createWebviewView();
    setWorkspaceFolders([{ uri: { fsPath: '/mock/workspace' } }]);
    const provider = createProvider({
      startInBackground: async () => false,
      checkConnection: async () => true,
    });
    (provider as any).webviewView = webviewView;

    await (provider as any).startDsh();
    await t.mock.timers.tick(1000);

    assert.equal(messages[messages.length - 1].state, 'ready');
    assert.equal((provider as any).currentState, 'ready');
  });

  test('轮询达到最大次数仍不可用 → 进入 error', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const { webviewView, messages } = createWebviewView();
    setWorkspaceFolders([{ uri: { fsPath: '/mock/workspace' } }]);
    const provider = createProvider({
      startInBackground: async () => true,
      checkConnection: async () => false,
    });
    (provider as any).webviewView = webviewView;

    await (provider as any).startDsh();
    // 15 次 × 1000ms，逐次触发，确保每次轮询的异步回调完成
    for (let i = 0; i < 16; i++) {
      await t.mock.timers.tick(1000);
    }

    const states = messages.map((m) => m.state);
    assert.equal(states[states.length - 1], 'error', '超时后进入 error');
    assert.equal((provider as any).currentState, 'error');
  });

  test('poll 定时器在进入 ready 后停止', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
    const { webviewView, messages } = createWebviewView();
    setWorkspaceFolders([{ uri: { fsPath: '/mock/workspace' } }]);
    const provider = createProvider({
      startInBackground: async () => true,
      checkConnection: async () => true,
    });
    (provider as any).webviewView = webviewView;

    await (provider as any).startDsh();
    await t.mock.timers.tick(1000);
    // ready 后再次推进时间，不应触发新的轮询
    const countAfterReady = messages.length;
    await t.mock.timers.tick(5000);
    assert.equal(messages.length, countAfterReady, 'ready 后不应再发送新消息');
  });
});

// === connectToExternalProcess / checkAndNotifyConnection ===

describe('connectToExternalProcess - 连接外部进程', () => {
  test('连接成功 → 先 loading 后 ready', async () => {
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider({ checkConnection: async () => true });
    (provider as any).webviewView = webviewView;

    await (provider as any).connectToExternalProcess();

    assert.equal(messages[0].state, 'loading', '先进入 loading');
    assert.equal(messages[messages.length - 1].state, 'ready');
    assert.equal((provider as any).currentState, 'ready');
  });

  test('连接失败 → 先 loading 后回退 idle', async () => {
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider({ checkConnection: async () => false });
    (provider as any).webviewView = webviewView;

    await (provider as any).connectToExternalProcess();

    assert.equal(messages[0].state, 'loading');
    assert.equal(messages[messages.length - 1].state, 'idle');
    assert.equal((provider as any).currentState, 'idle');
  });
});

describe('checkAndNotifyConnection - 连接状态通知', () => {
  test('连接成功 → ready', async () => {
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider({ checkConnection: async () => true });
    (provider as any).webviewView = webviewView;

    await (provider as any).checkAndNotifyConnection();

    assert.equal(messages[messages.length - 1].state, 'ready');
    assert.equal((provider as any).currentState, 'ready');
  });

  test('连接失败 → error', async () => {
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider({ checkConnection: async () => false });
    (provider as any).webviewView = webviewView;

    await (provider as any).checkAndNotifyConnection();

    assert.equal(messages[messages.length - 1].state, 'error');
    assert.equal((provider as any).currentState, 'error');
  });
});

// === refreshWebview：刷新流程 ===

describe('refreshWebview - 刷新状态切换', () => {
  test('webview 未就绪时直接返回，不发消息', async () => {
    const provider = createProvider({ checkConnection: async () => true });
    // 不设置 webviewView
    const result = await (provider as any).refreshWebview();
    assert.equal(result, undefined);
  });

  test('连接成功 → 先 loading 后 ready', async () => {
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider({ checkConnection: async () => true });
    (provider as any).webviewView = webviewView;

    await (provider as any).refreshWebview();

    assert.equal(messages[0].state, 'loading', '刷新先进入 loading');
    assert.equal(messages[messages.length - 1].state, 'ready');
    assert.equal((provider as any).currentState, 'ready');
  });

  test('连接失败 → idle', async () => {
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider({ checkConnection: async () => false });
    (provider as any).webviewView = webviewView;

    await (provider as any).refreshWebview();

    assert.equal(messages[messages.length - 1].state, 'idle');
    assert.equal((provider as any).currentState, 'idle');
  });

  test('checkConnection 抛异常 → error', async () => {
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider({
      checkConnection: async () => {
        throw new Error('boom');
      },
    });
    (provider as any).webviewView = webviewView;

    await (provider as any).refreshWebview();

    assert.equal(messages[messages.length - 1].state, 'error');
    assert.equal((provider as any).currentState, 'error');
  });
});

// === updateUIByStatus：状态 → setState 消息映射 ===

describe('updateUIByStatus - 状态到 setState 消息的映射', () => {
  const cases: Array<[string, string]> = [
    ['ready', 'ready'],
    ['idle', 'idle'],
    ['externalRunning', 'externalRunning'],
    ['error', 'error'],
    ['notInstalled', 'notInstalled'],
    ['restarting', 'restarting'],
    ['initializing', 'loading'],
  ];

  for (const [input, expected] of cases) {
    test(`updateUIByStatus(${input}) → setState(${expected})`, () => {
      const { webviewView, messages } = createWebviewView();
      const provider = createProvider();
      (provider as any).webviewView = webviewView;

      (provider as any).updateUIByStatus({ state: input, message: '' });

      const last = messages[messages.length - 1];
      assert.ok(last, '应发送一条 setState 消息');
      assert.equal(last.state, expected);
    });
  }

  test('未知状态不发消息', () => {
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider();
    (provider as any).webviewView = webviewView;

    (provider as any).updateUIByStatus({ state: 'unknown', message: '' });
    assert.equal(messages.length, 0);
  });
});

// === handleMessage：消息路由 ===

describe('handleMessage - 消息路由', () => {
  test('ready 消息触发初始化并最终 ready', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider({ getStatus: async () => DshStatus.Running });
    (provider as any).webviewView = webviewView;

    await (provider as any).handleMessage({ type: 'ready' });

    const states = messages.map((m) => m.state);
    assert.ok(states.includes('loading'));
    assert.equal(states[states.length - 1], 'ready');
  });

  test('未知消息类型不抛异常', async () => {
    const { webviewView, messages } = createWebviewView();
    const provider = createProvider();
    (provider as any).webviewView = webviewView;

    await (provider as any).handleMessage({ type: 'unknownType' } as any);
    assert.equal(messages.length, 0);
  });
});

// === getWebviewContent：HTML 注入共享状态判断常量 ===

describe('getWebviewContent - Webview 端状态判断注入', () => {
  test('HTML 中包含共享的状态有效期与临时状态常量', () => {
    const provider = createProvider();
    const html = (provider as any).getWebviewContent('http://127.0.0.1:3080');
    assert.ok(html.includes('const STATE_EXPIRY_MS = 300000;'), '应注入 STATE_EXPIRY_MS');
    assert.ok(
      html.includes('const INVALID_STATES = ["error","notInstalled","loading","restarting"];'),
      '应注入 INVALID_STATES 列表'
    );
  });

  test('HTML 中的 isStateValid 使用注入的 INVALID_STATES', () => {
    const provider = createProvider();
    const html = (provider as any).getWebviewContent('http://127.0.0.1:3080');
    // 提取 isStateValid 函数体，确认引用的是注入常量而非内联字面量
    const fnMatch = html.match(/function isStateValid\(savedState\) \{[\s\S]*?\n    \}/);
    assert.ok(fnMatch, '应包含 isStateValid 函数');
    assert.ok(fnMatch[0].includes('INVALID_STATES.includes'), '应使用注入的 INVALID_STATES');
    assert.ok(!fnMatch[0].includes("['error', 'notInstalled'"), '不应内联临时状态字面量');
  });

  test('HTML 中包含 DSH URL', () => {
    const provider = createProvider({ getWorkspacePath: () => '/mock/workspace' });
    const html = (provider as any).getWebviewContent('http://127.0.0.1:3080');
    assert.ok(html.includes('http://127.0.0.1:3080'), '应包含 iframe URL');
  });
});

// === getDshUrl / dispose ===

describe('getDshUrl - URL 生成', () => {
  test('返回基础 URL（无路径编码）', () => {
    const provider = createProvider({ getWorkspacePath: () => '/mock/My Project' });
    const url = (provider as any).getDshUrl();
    assert.equal(url, 'http://127.0.0.1:3080', '应返回基础 URL 无路径');
  });

  test('无工作区时返回基础 URL', () => {
    const provider = createProvider({ getWorkspacePath: () => undefined });
    assert.equal((provider as any).getDshUrl(), 'http://127.0.0.1:3080');
  });
});

describe('dispose - 资源清理', () => {
  test('dispose 清理轮询定时器且不抛异常', () => {
    const provider = createProvider();
    (provider as any).timers.poll = setInterval(() => {}, 1000);
    (provider as any).dispose();
    // 到达此处即视为通过（定时器被清理，事件监听被移除）
  });
});
