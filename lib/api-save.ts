/**
 * API 批量保存核心逻辑（含字段级合并 + 业务语义双层存储）
 *
 * 资产管理总线 Step 2：把 save 路由的 POST handler 核心抽出，
 * 让 SwaggerSource 同步路由复用——保证决策 4（字段级合并）和决策 5（语义双层）的合并逻辑只有一份实现。
 *
 * 调用方：
 * - app/api/api-library/save/route.ts （HTTP POST 入口，薄壳）
 * - app/api/swagger-sources/[id]/sync/route.ts （SwaggerSource 一键同步）
 */

import { prisma } from '@/lib/prisma';
import type { CapturedApi, ApiBusinessSemantics } from '@/types/har';
import { safeJsonStringify } from '@/lib/json-utils';
import { parameterizePath } from '@/lib/path-parameterization';
import { filterHeadersByWhitelist } from '@/lib/header-filter';
import { mergeApiData } from '@/lib/api-merge';

/** 调用方传入的 API 输入（CapturedApi 加上保存时的辅助字段） */
export type ApiInput = CapturedApi & {
  id?: string;
  name: string;
  description?: string;
  categoryId?: string;
  tagIds?: string[];
  platform?: string;
  component?: string;
  feature?: string;
  subFeature?: string;
  importSource?: string;
  paramConstraints?: any;
  /** 标识为覆盖更新而非新建（需配合 id） */
  _overwrite?: boolean;
};

export interface SaveCapturedApisOptions {
  /** 当前工作区 id（必填，所有写入和合并均按此收敛） */
  workspaceId: string;
  /** 当前用户 id（用于 createdBy/updatedBy；可空） */
  userId?: string | null;
}

export interface SaveCapturedApisResult {
  savedApis: any[];
  failedApis: Array<{ api: string; error: string }>;
  /** 创建（新增）的接口数量（_overwrite=false 或无 id 的成功项） */
  createdCount: number;
  /** 更新（合并）的接口数量（_overwrite=true 且命中已有的成功项） */
  updatedCount: number;
}

/**
 * 合并业务语义（覆盖/同步场景）—— 文档为主、平台可调
 * - 保留已有 override 与首次导入信息（importedAt）
 * - baseline 采纳本次文档新值
 * - 记录 lastSyncedAt
 *
 * 决策 5 红线：本函数仅写入 baseline，不动 override；status 保留旧值，
 * 不会把"confirmed/draft"自动改回。语义评审走独立路径。
 */
function computeMergedSemantics(
  existingJson: string | null | undefined,
  incoming: ApiBusinessSemantics | undefined
): string | undefined {
  let existing: ApiBusinessSemantics | null = null;
  if (existingJson) {
    try {
      existing = JSON.parse(existingJson);
    } catch {
      existing = null;
    }
  }

  if (!incoming || !incoming.baseline) {
    return existingJson || undefined;
  }

  const now = new Date().toISOString();
  const merged: ApiBusinessSemantics = {
    baseline: incoming.baseline,
    override: existing?.override,
    provenance: {
      ...(existing?.provenance ?? {}),
      ...incoming.provenance,
      importedAt: existing?.provenance?.importedAt ?? incoming.provenance?.importedAt,
      lastSyncedAt: now,
    },
    status: existing?.status ?? incoming.status ?? 'draft',
  };

  return safeJsonStringify(merged) || undefined;
}

/**
 * 批量保存 API（创建或字段级合并），按工作区收敛。
 *
 * 行为契约：
 * - 逐 api 独立处理（Promise.allSettled），单条失败不影响其他
 * - _overwrite=true 走字段级合并 + 语义 diff 写入；否则 create
 * - 写入前必须调用方先 check-duplicates，本函数不再判重
 *   （查重逻辑分散到 check-duplicates 路由，本函数职责单一）
 * - 工作区收敛：合并 findFirst 必带 workspaceId（决策 10 红线）
 */
export async function saveCapturedApis(
  apis: ApiInput[],
  options: SaveCapturedApisOptions
): Promise<SaveCapturedApisResult> {
  const { workspaceId, userId } = options;

  if (!apis || apis.length === 0) {
    return { savedApis: [], failedApis: [], createdCount: 0, updatedCount: 0 };
  }

  // 平台请求头白名单
  const platformSettings = await prisma.platformSettings.findFirst({
    orderBy: { updatedAt: 'desc' },
  });
  const allowedHeaders = platformSettings?.allowedHeaders || null;

  // 用 Promise.allSettled 让单条失败不连坐
  const results = await Promise.allSettled(
    apis.map(async (api) => {
      // 提取域名
      let domain: string | null = null;
      try {
        const urlObj = new URL(api.url);
        domain = urlObj.hostname;
      } catch {
        /* URL 不可解析时 domain 留空 */
      }

      // 自动参数化路径（GET 仅按 pathname 判重/存储）
      const rawPath = api.path || '';
      const pathForParam = api.method.toUpperCase() === 'GET' ? rawPath.split('?')[0] : rawPath;
      const paramResult = parameterizePath(pathForParam);
      const finalPath = paramResult.parameterizedPath;

      if (paramResult.isParameterized && api.path !== finalPath) {
        console.log(`🔧 [保存时参数化] ${api.path} → ${finalPath}`);
      }

      // 白名单过滤请求头
      const filteredHeaders = filterHeadersByWhitelist(api.headers || {}, allowedHeaders);
      if (allowedHeaders && Object.keys(api.headers || {}).length !== Object.keys(filteredHeaders).length) {
        console.log(
          `🔍 [Headers过滤] ${api.name}: ${Object.keys(api.headers || {}).length} → ${Object.keys(filteredHeaders).length} 个请求头`
        );
      }

      // 准备 API 数据（与原 save 路由一致）
      const apiData = {
        name: api.name,
        description: api.description || null,
        method: api.method,
        url: api.url,
        path: finalPath,
        domain,

        categoryId: api.categoryId || null,

        platform: (api as any).platform || null,
        component: (api as any).component || null,
        feature: (api as any).feature || null,
        subFeature: (api as any).subFeature || null,

        importSource: (api as any).importSource || 'har',

        schema: (api as any).paramConstraints
          ? safeJsonStringify((api as any).paramConstraints)
          : undefined,

        businessSemantics: (api as any).businessSemantics
          ? safeJsonStringify((api as any).businessSemantics)
          : undefined,

        requestHeaders: safeJsonStringify(filteredHeaders),
        requestQuery: safeJsonStringify(api.queryParams),
        requestBody: safeJsonStringify(api.requestBody),
        requestMimeType:
          (api as any).requestMimeType ||
          (filteredHeaders as any)['Content-Type'] ||
          (filteredHeaders as any)['content-type'] ||
          null,

        responseStatus: api.status || null,
        responseHeaders: safeJsonStringify((api as any).responseHeaders),
        responseBody: safeJsonStringify(api.responseBody),
        responseMimeType: api.mimeType || null,

        responseTime: Math.round(api.time) || null,
        responseSize: api.size || null,

        resourceType: api.resourceType || null,
        startedDateTime: api.startedDateTime || null,

        rawHarEntry: safeJsonStringify(api) || undefined,
      };

      // 创建 vs 合并
      let savedApi: any;
      let isUpdate = false;

      if ((api as any)._overwrite && api.id) {
        isUpdate = true;
        console.log(
          `🔄 [合并模式] 更新API: ${api.id} - ${api.name} | 分类: ${apiData.platform}/${apiData.component}/${apiData.feature}/${apiData.subFeature || '-'}`
        );

        try {
          // 工作区收敛：避免客户端拼了别工作区的 id 来覆盖（决策 10 红线）
          const existing = await prisma.api.findFirst({
            where: { id: api.id, workspaceId },
          });

          if (!existing) {
            // id 不在当前工作区 → 安全失败模式：转为新建（落到当前工作区）
            console.log(`⚠️ [越权防护] id=${api.id} 不在当前工作区，转为新建`);
            isUpdate = false;
            savedApi = await prisma.api.create({
              data: { ...apiData, workspaceId, ...(userId && { createdBy: userId, updatedBy: userId }) },
            });
          } else {
            const mergedData = mergeApiData(existing as any, apiData as any);

            // 业务语义按"文档为主、平台可调"治理（决策 5）
            const semanticsValue = computeMergedSemantics(
              (existing as any)?.businessSemantics,
              (api as any).businessSemantics
            );

            savedApi = await prisma.api.update({
              where: { id: api.id },
              data: {
                ...mergedData,
                ...(semanticsValue !== undefined && { businessSemantics: semanticsValue }),
                ...(userId && { updatedBy: userId }),
              } as any,
            });
            console.log(`✅ [合并成功] API已更新: ${savedApi.id} - ${savedApi.name} | 来源: ${savedApi.importSource}`);
          }
        } catch (updateError: any) {
          console.error(`❌ [合并失败] API: ${api.id} - ${api.name}`, updateError.message);
          throw new Error(`更新API失败 (${api.name}): ${updateError.message}`);
        }
      } else {
        console.log(`➕ [创建模式] 创建新API: ${api.name}`);
        savedApi = await prisma.api.create({
          data: { ...apiData, workspaceId, ...(userId && { createdBy: userId, updatedBy: userId }) },
        });
        console.log(`✅ [创建成功] API已创建: ${savedApi.id} - ${savedApi.name}`);
      }

      // 关联标签（SQLite 不支持 skipDuplicates，循环创建）
      if (api.tagIds && api.tagIds.length > 0) {
        for (const tagId of api.tagIds) {
          try {
            await prisma.apiTag.create({
              data: { apiId: savedApi.id, tagId },
            });
          } catch {
            // 忽略已存在的关联
          }
        }
      }

      return { savedApi, isUpdate };
    })
  );

  const savedApis: any[] = [];
  let createdCount = 0;
  let updatedCount = 0;
  const failedApis: Array<{ api: string; error: string }> = [];

  results.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      savedApis.push(result.value.savedApi);
      if (result.value.isUpdate) updatedCount++;
      else createdCount++;
    } else {
      failedApis.push({
        api: apis[idx].name,
        error: result.reason?.message || '未知错误',
      });
    }
  });

  console.log(`📊 [批量保存结果] 创建: ${createdCount}, 更新: ${updatedCount}, 失败: ${failedApis.length}`);
  if (failedApis.length > 0) {
    console.error('❌ [失败详情]', failedApis);
  }

  return { savedApis, failedApis, createdCount, updatedCount };
}
