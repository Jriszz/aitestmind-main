import { NextRequest, NextResponse } from 'next/server';
import { parseSwaggerDocument } from '@/lib/swagger-parser';

export const dynamic = 'force-dynamic';
// swagger-parser 依赖 Node API，强制 Node 运行时
export const runtime = 'nodejs';

// 在线拉取的限制
const FETCH_TIMEOUT_MS = 15000;
const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * 判断主机是否为内网/本地地址（SSRF 防护）
 */
function isPrivateHost(hostname: string): boolean {
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

/**
 * 从在线 URL 拉取文档内容（带 SSRF 防护、超时、大小限制）
 */
async function fetchDocument(url: string): Promise<string> {
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

  try {
    const resp = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: { Accept: 'application/json, application/yaml, text/yaml, text/plain, */*' },
    });

    if (!resp.ok) {
      throw new Error(`拉取失败：HTTP ${resp.status}`);
    }

    // 大小限制
    const contentLength = resp.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_DOC_BYTES) {
      throw new Error('文档过大（超过 10MB）');
    }

    const text = await resp.text();
    if (text.length > MAX_DOC_BYTES) {
      throw new Error('文档过大（超过 10MB）');
    }
    return text;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('拉取超时，请检查链接是否可访问');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 导入 Swagger/OpenAPI 文档
 * POST /api/api-library/import-swagger
 *
 * 请求体（二选一）：
 *   { content: string }  - 直接粘贴/上传的文档文本（JSON 或 YAML）
 *   { url: string }      - 在线文档链接（服务端拉取，绕开浏览器 CORS）
 *
 * 响应：
 *   { success: true, apis: CapturedApi[], info: { title, version, count, truncated } }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { content, url, sourceName } = body as { content?: string; url?: string; sourceName?: string };

    if (!content && !url) {
      return NextResponse.json(
        { success: false, error: '请提供文档内容（content）或在线链接（url）' },
        { status: 400 }
      );
    }

    let docText: string;
    if (url) {
      docText = await fetchDocument(url.trim());
    } else {
      docText = content!.trim();
      if (!docText) {
        return NextResponse.json({ success: false, error: '文档内容为空' }, { status: 400 });
      }
    }

    const result = await parseSwaggerDocument(docText);

    if (result.apis.length === 0) {
      return NextResponse.json(
        { success: false, error: '未从文档中解析出任何接口，请确认文档包含 paths 定义' },
        { status: 400 }
      );
    }

    // 补全语义溯源：sourceDoc（URL 或上传文件名）+ 导入时间
    const sourceDoc = url ? url.trim() : sourceName || `${result.info.title}.json`;
    const importedAt = new Date().toISOString();
    for (const api of result.apis) {
      if (api.businessSemantics) {
        api.businessSemantics.provenance = {
          ...api.businessSemantics.provenance,
          sourceDoc,
          importedAt,
        };
      }
    }

    return NextResponse.json({
      success: true,
      apis: result.apis,
      info: result.info,
    });
  } catch (error: any) {
    console.error('Swagger 导入失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '导入失败' },
      { status: 500 }
    );
  }
}
