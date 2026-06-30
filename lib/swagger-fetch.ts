/**
 * Swagger 在线文档拉取（带 SSRF 防护、超时、大小限制、ETag 判重）
 *
 * 资产管理总线 Step 2：把 import-swagger 路由内嵌的 SSRF/fetchDocument 抽出，
 * 让 SwaggerSource 同步路由复用。SSRF 防护**只能有一份实现**（决策 2 红线）。
 */

// 限制
export const FETCH_TIMEOUT_MS = 15000;
export const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * 判断主机是否为内网/本地地址（SSRF 防护）
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }

  // IPv4 内网段
  // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [parseInt(ipv4[1], 10), parseInt(ipv4[2], 10)];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }

  // IPv6 唯一本地地址 fc00::/7
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
    return true;
  }

  return false;
}

export interface FetchDocumentOptions {
  /** 附加请求头（如 Authorization）。会在 SSRF 校验后透传给上游 */
  authHeaders?: Record<string, string>;
  /** 上次拉取的 ETag。如果上游返回 304 → notModified=true，不下载内容 */
  etag?: string | null;
}

export interface FetchDocumentResult {
  /** 文档文本（notModified=true 时为空字符串） */
  text: string;
  /** 上游返回的新 ETag（可能为 null） */
  etag: string | null;
  /** 上游返回的 Last-Modified（可能为 null，与 etag 二选一） */
  lastModified: string | null;
  /** 是否 304 未变更（仅在传入 etag 时可能返回 true） */
  notModified: boolean;
}

/**
 * 从在线 URL 拉取 Swagger 文档内容
 * 复用要点：
 * - SSRF 防护可通过 SWAGGER_IMPORT_ALLOW_INTERNAL=true 关闭（仅自部署内网信任场景）
 * - 支持 ETag 条件请求，未变更直接返回 notModified=true
 * - 超时 + 大小限制
 */
export async function fetchDocument(
  url: string,
  options: FetchDocumentOptions = {}
): Promise<FetchDocumentResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('无效的 URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http/https 链接');
  }

  // SSRF 防护：除非显式允许，拒绝内网/本地地址
  const allowInternal = process.env.SWAGGER_IMPORT_ALLOW_INTERNAL === 'true';
  if (!allowInternal && isPrivateHost(parsed.hostname)) {
    throw new Error(
      '出于安全考虑，默认禁止拉取内网/本地地址。如确需访问内网文档，请将文档内容直接粘贴或上传文件。'
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  // 构建请求头
  const headers: Record<string, string> = {
    Accept: 'application/json, application/yaml, text/yaml, text/plain, */*',
    ...(options.authHeaders ?? {}),
  };
  if (options.etag) {
    headers['If-None-Match'] = options.etag;
  }

  try {
    const resp = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers,
    });

    // 304 未变更
    if (resp.status === 304) {
      return {
        text: '',
        etag: options.etag ?? null,
        lastModified: null,
        notModified: true,
      };
    }

    if (!resp.ok) {
      throw new Error(`拉取失败：HTTP ${resp.status}`);
    }

    // 大小限制（先看 content-length，再实际下载后再确认一次）
    const contentLength = resp.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_DOC_BYTES) {
      throw new Error('文档过大（超过 10MB）');
    }

    const text = await resp.text();
    if (text.length > MAX_DOC_BYTES) {
      throw new Error('文档过大（超过 10MB）');
    }

    return {
      text,
      etag: resp.headers.get('etag'),
      lastModified: resp.headers.get('last-modified'),
      notModified: false,
    };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('拉取超时，请检查链接是否可访问');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
