import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { prisma } from '@/lib/prisma';
import { getCurrentUser, getCurrentWorkspace } from '@/lib/auth';
import { fetchDocument } from '@/lib/swagger-fetch';
import { parseSwaggerDocument } from '@/lib/swagger-parser';
import { saveCapturedApis, type ApiInput } from '@/lib/api-save';
import { parameterizePath } from '@/lib/path-parameterization';
import type { CapturedApi } from '@/types/har';

export const dynamic = 'force-dynamic';
// swagger-parser 依赖 Node API
export const runtime = 'nodejs';

/**
 * 一键重新同步 Swagger 数据源
 * POST /api/swagger-sources/[id]/sync
 *
 * 资产管理总线 Step 2 核心：
 * 1. 拉文档（带 ETag 304 + 内容 hash 双重判重）
 * 2. parseSwaggerDocument → CapturedApi[]
 * 3. 自动决策 isDuplicate：
 *    - false → 走 create 分支
 *    - true  → 走 _overwrite=true 分支（决策 4 字段级合并 + 决策 5 语义双层）
 * 4. 全程不弹对话；语义评审延后到 ApiEditDialog
 *
 * 红线：复用 saveCapturedApis（lib/api-save.ts），保证合并逻辑只有一份实现
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const startedAt = Date.now();

  try {
    const currentUser = await getCurrentUser(request);
    if (!currentUser) {
      return NextResponse.json({ success: false, error: '未登录' }, { status: 401 });
    }
    const userId = currentUser.user.id;

    const ws = await getCurrentWorkspace(request);
    if (!ws) {
      return NextResponse.json(
        { success: false, error: '未登录或无可用工作区' },
        { status: 401 }
      );
    }

    // 1. 加载源（按工作区收敛）
    const source = await prisma.swaggerSource.findFirst({
      where: { id, workspaceId: ws.workspaceId },
    });
    if (!source) {
      return NextResponse.json(
        { success: false, error: '数据源不存在' },
        { status: 404 }
      );
    }

    // 2. 解析 authHeaders
    let authHeaders: Record<string, string> | undefined;
    if (source.authHeaders) {
      try {
        const parsed = JSON.parse(source.authHeaders);
        if (parsed && typeof parsed === 'object') {
          authHeaders = parsed;
        }
      } catch {
        // 忽略坏的 authHeaders 配置，按无认证拉取
      }
    }

    // 3. 拉取文档（304 直接跳过）
    let fetchResult: Awaited<ReturnType<typeof fetchDocument>>;
    try {
      fetchResult = await fetchDocument(source.url, {
        authHeaders,
        etag: source.lastEtag,
      });
    } catch (err: any) {
      const message = err?.message || '拉取失败';
      await prisma.swaggerSource.update({
        where: { id },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: 'failed',
          lastSyncMessage: `拉取失败：${message}`,
          updatedBy: userId,
        },
      });
      return NextResponse.json(
        { success: false, error: message },
        { status: 502 }
      );
    }

    // 304 未变更 → 直接更新 lastSyncAt，跳过解析
    if (fetchResult.notModified) {
      await prisma.swaggerSource.update({
        where: { id },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: 'skipped',
          lastSyncMessage: '内容未变更（304 Not Modified）',
          updatedBy: userId,
        },
      });
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: '内容未变更（304 Not Modified）',
        created: 0,
        updated: 0,
        failed: 0,
        durationMs: Date.now() - startedAt,
      });
    }

    // 4. 计算内容 hash，与上次比对（处理上游不返回 ETag 的场景）
    const contentHash = createHash('sha256').update(fetchResult.text).digest('hex');
    if (source.lastHash && source.lastHash === contentHash) {
      await prisma.swaggerSource.update({
        where: { id },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: 'skipped',
          lastSyncMessage: '内容未变更（hash 一致）',
          // 仍然把上游 ETag 记下来，下次走 304
          lastEtag: fetchResult.etag ?? source.lastEtag,
          updatedBy: userId,
        },
      });
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: '内容未变更（hash 一致）',
        created: 0,
        updated: 0,
        failed: 0,
        durationMs: Date.now() - startedAt,
      });
    }

    // 5. 解析文档
    let parseResult: Awaited<ReturnType<typeof parseSwaggerDocument>>;
    try {
      parseResult = await parseSwaggerDocument(fetchResult.text);
    } catch (err: any) {
      const message = err?.message || '解析失败';
      await prisma.swaggerSource.update({
        where: { id },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: 'failed',
          lastSyncMessage: `解析失败：${message}`,
          lastEtag: fetchResult.etag ?? source.lastEtag,
          lastHash: contentHash,
          updatedBy: userId,
        },
      });
      return NextResponse.json(
        { success: false, error: message },
        { status: 400 }
      );
    }

    if (parseResult.apis.length === 0) {
      await prisma.swaggerSource.update({
        where: { id },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: 'failed',
          lastSyncMessage: '文档中未解析出任何接口',
          lastEtag: fetchResult.etag ?? source.lastEtag,
          lastHash: contentHash,
          updatedBy: userId,
        },
      });
      return NextResponse.json(
        { success: false, error: '文档中未解析出任何接口' },
        { status: 400 }
      );
    }

    // 6. 给每个 api 补默认四层分类 + 来源溯源
    const importedAt = new Date().toISOString();
    const enrichedApis: CapturedApi[] = parseResult.apis.map((api) => {
      const enriched: any = { ...api };
      // 默认分类（仅在 api 自己没声明时填充）
      if (source.defaultPlatform && !enriched.platform) enriched.platform = source.defaultPlatform;
      if (source.defaultComponent && !enriched.component) enriched.component = source.defaultComponent;
      if (source.defaultFeature && !enriched.feature) enriched.feature = source.defaultFeature;
      // 业务语义溯源
      if (enriched.businessSemantics) {
        enriched.businessSemantics.provenance = {
          ...enriched.businessSemantics.provenance,
          sourceDoc: source.url,
          importedAt,
        };
      }
      return enriched;
    });

    // 7. 内联 check-duplicates 逻辑（按工作区收敛 — 决策 4/10 红线）
    //    这里不走 HTTP 调用，直接查 DB，避免 SSR 自调用的鉴权传递问题
    const inputApis: ApiInput[] = await Promise.all(
      enrichedApis.map(async (api) => {
        const apiPath = api.path || '';
        const pathForParam = api.method?.toUpperCase() === 'GET' ? apiPath.split('?')[0] : apiPath;
        const paramResult = parameterizePath(pathForParam);
        const normalizedPath = paramResult.parameterizedPath;
        const normalizedMethod = api.method.toUpperCase();

        // 工作区收敛 + 排除占位 API
        const whereForDup: any = {
          workspaceId: ws.workspaceId,
          method: normalizedMethod,
          name: { not: '_CLASSIFICATION_PLACEHOLDER_' },
        };
        if (normalizedMethod === 'GET') {
          whereForDup.OR = [
            { path: normalizedPath },
            { path: { startsWith: normalizedPath + '?' } },
          ];
        } else {
          whereForDup.path = normalizedPath;
        }

        const existing = await prisma.api.findFirst({
          where: whereForDup,
          select: { id: true, name: true },
        });

        // saveCapturedApis 期望的 ApiInput 形态
        const apiInput: ApiInput = {
          ...(api as any),
          // 重命名为接口默认值，让 saveCapturedApis 不再需要"再去查一次重"
          name: (api as any).name || existing?.name || `${normalizedMethod} ${normalizedPath}`,
          importSource: 'swagger',
        };
        if (existing) {
          // 命中已有 → 标记 _overwrite，让 saveCapturedApis 走字段级合并
          apiInput.id = existing.id;
          (apiInput as any)._overwrite = true;
        }
        return apiInput;
      })
    );

    // 8. 调用统一的 saveCapturedApis（决策 4/5 合并逻辑唯一入口）
    const saveResult = await saveCapturedApis(inputApis, {
      workspaceId: ws.workspaceId,
      userId,
    });

    // 9. 写回源的同步状态
    const failedCount = saveResult.failedApis.length;
    const totalCount = inputApis.length;
    const status = failedCount === 0 ? 'success' : failedCount === totalCount ? 'failed' : 'partial';
    const summary = `${parseResult.info.title}：新增 ${saveResult.createdCount} / 更新 ${saveResult.updatedCount}${failedCount > 0 ? ` / 失败 ${failedCount}` : ''}`;

    await prisma.swaggerSource.update({
      where: { id },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: status,
        lastSyncMessage: summary,
        lastEtag: fetchResult.etag ?? source.lastEtag,
        lastHash: contentHash,
        // 累计计数：新增 + 已有的（更新不增加 totalApiCount）
        totalApiCount: { increment: saveResult.createdCount },
        lastImportedCount: saveResult.createdCount + saveResult.updatedCount,
        updatedBy: userId,
      },
    });

    return NextResponse.json({
      success: failedCount < totalCount,
      created: saveResult.createdCount,
      updated: saveResult.updatedCount,
      failed: failedCount,
      failedDetails: saveResult.failedApis,
      message: summary,
      durationMs: Date.now() - startedAt,
    });
  } catch (error: any) {
    console.error('Swagger 同步失败:', error);
    // 兜底写一次失败状态（前面分支若未写）
    try {
      await prisma.swaggerSource.update({
        where: { id },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: 'failed',
          lastSyncMessage: error?.message || '同步失败',
        },
      });
    } catch {
      /* 写状态失败也不影响主响应 */
    }
    return NextResponse.json(
      { success: false, error: error.message || '同步失败' },
      { status: 500 }
    );
  }
}
