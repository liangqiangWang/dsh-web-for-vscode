import fetch from 'node-fetch';
import { DshConfig } from './types';
import { API_ENDPOINTS } from '../common/constants';

/**
 * DSH HTTP 客户端
 * 负责与 dsh 服务进行通信
 */
export class DshClient {
  private port: number;
  private baseUrl: string;
  private config: DshConfig;

  constructor(port: number, config: DshConfig) {
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.config = config;
  }

  /**
   * 检查 dsh 服务健康状态
   * 利用 dsh webserver 的 SPA fallback：GET / 返回 200 + HTML
   * @param timeout 超时时间（毫秒）
   * @returns 服务是否健康
   */
  async checkHealth(timeout?: number): Promise<boolean> {
    const checkTimeout = timeout || this.config.healthCheckTimeout;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let completed = false;

    const timeoutPromise = new Promise<boolean>((resolve) => {
      timeoutHandle = setTimeout(() => {
        if (!completed) {
          console.log(`[DshClient] 健康检查超时（${checkTimeout}ms）`);
          resolve(false);
        }
      }, checkTimeout);
    });

    const fetchPromise = (async () => {
      try {
        const url = `${this.baseUrl}${API_ENDPOINTS.HEALTH}`;
        console.log(`[DshClient] 开始健康检查: ${url}, 超时: ${checkTimeout}ms`);

        const response = await fetch(url, {
          method: 'GET'
        });

        if (!completed) {
          completed = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);

          const success = response.status === 200;
          console.log(`[DshClient] 健康检查结果: ${success}, 状态码: ${response.status}`);
          return success;
        }

        return false;
      } catch (error) {
        if (!completed) {
          completed = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);

          console.log(`[DshClient] 健康检查失败: ${error}`);
          return false;
        }
        return false;
      }
    })();

    // 使用 Promise.race 实现超时
    return Promise.race([fetchPromise, timeoutPromise]);
  }

  /**
   * 检查 dsh 应用是否就绪
   * @returns 应用是否就绪
   */
  async checkAppReady(): Promise<boolean> {
    return await this.checkHealth();
  }
}
