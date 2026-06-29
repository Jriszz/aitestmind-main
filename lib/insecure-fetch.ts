import http from 'node:http';
import https from 'node:https';

export interface InsecureRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** 字符串 body（已序列化）。不传则不发送 body */
  body?: string;
}

export interface InsecureResponse {
  status: number;
  statusText: string;
  ok: boolean;
  text: string;
  /** 所有 Set-Cookie 响应头（原始字符串数组） */
  setCookieHeaders: string[];
  headers: Record<string, string>;
}

/**
 * 用 node:http/https 发请求，支持跳过 TLS 证书校验（rejectUnauthorized:false）。
 *
 * 为什么不用全局 fetch：Node 全局 fetch 要跳过证书校验需要 undici dispatcher，
 * 而 undici 未作为可解析依赖暴露；改 NODE_TLS_REJECT_UNAUTHORIZED 是进程级全局、
 * 会污染并发请求。用内置 https.Agent({rejectUnauthorized:false}) 可把"不校验"
 * 精确限定在本次请求，零依赖、无副作用。
 *
 * 对齐执行器侧 httpx.AsyncClient(verify=False) 的行为，仅用于内网/自签名证书的
 * 平台登录测试，不要用于对外可信请求。
 */
export function insecureRequest(
  urlStr: string,
  options: InsecureRequestOptions = {}
): Promise<InsecureResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error(`无效的 URL: ${urlStr}`));
      return;
    }

    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const req = transport.request(
      url,
      {
        method: options.method || 'GET',
        headers: options.headers,
        // 仅 https 时跳过证书校验；http 无影响
        ...(isHttps ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const status = res.statusCode || 0;
          // 收集普通响应头（小写键），Set-Cookie 单独处理
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (k.toLowerCase() === 'set-cookie') continue;
            headers[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
          }
          const rawSetCookie = res.headers['set-cookie'];
          const setCookieHeaders = Array.isArray(rawSetCookie)
            ? rawSetCookie
            : rawSetCookie
              ? [rawSetCookie]
              : [];

          resolve({
            status,
            statusText: res.statusMessage || '',
            ok: status >= 200 && status < 300,
            text: Buffer.concat(chunks).toString('utf-8'),
            setCookieHeaders,
            headers,
          });
        });
      }
    );

    req.on('error', reject);

    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}
