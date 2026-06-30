import { NextRequest, NextResponse } from 'next/server';
import { parseSwaggerDocument } from '@/lib/swagger-parser';
import { fetchDocument } from '@/lib/swagger-fetch';

export const dynamic = 'force-dynamic';
// swagger-parser 依赖 Node API，强制 Node 运行时
export const runtime = 'nodejs';

/**
 * 导入 Swagger/OpenAPI 文档（一次性）
 * POST /api/api-library/import-swagger
 *
 * 请求体（二选一）：
 *   { content: string }  - 直接粘贴/上传的文档文本（JSON 或 YAML）
 *   { url: string }      - 在线文档链接（服务端拉取，绕开浏览器 CORS）
 *
 * 响应：
 *   { success: true, apis: CapturedApi[], info: { title, version, count, truncated } }
 *
 * 注意：本路由仅做"一次性导入"——拉取/解析后由前端继续走 check-duplicates → save 链路。
 * 想要"持久化的、可重新同步的"文档源，请使用 /api/swagger-sources/* 系列路由（资产管理总线 Step 2）。
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
      const fetchResult = await fetchDocument(url.trim());
      docText = fetchResult.text;
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
