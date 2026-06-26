import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { loadAIClient, type AIMessage } from '@/lib/ai-client';
import { EXPLORE_PLAN_SYSTEM_PROMPT, EXPLORE_PLAN_TOOL } from '@/lib/ai-prompts/explore-prompt';
import { getApiDetail } from '@/lib/ai-tools';
import {
  resolveEffectiveSemantics,
  enumerateSemanticItems,
} from '@/lib/semantics-fingerprint';

export const dynamic = 'force-dynamic';

/**
 * AI 探索 · 场景设计阶段
 * POST /api/ai/explore-plan   body: { apiIds: string[], includeGenerated?: boolean }
 *
 * 输入范围（接口集合），AI 自主读取 paramConstraints + businessSemantics，
 * 产出"打算覆盖的场景清单"（不生成用例、不落库）。每个场景按其来源语义项算指纹，
 * 隐形过滤掉该范围内已生成过（sourceFingerprint 命中）的场景——除非 includeGenerated。
 */
export async function POST(request: NextRequest) {
  try {
    const { apiIds, includeGenerated = false } = await request.json();

    if (!Array.isArray(apiIds) || apiIds.length === 0) {
      return NextResponse.json(
        { success: false, error: '请至少选择一个 API' },
        { status: 400 }
      );
    }

    // 1. 拉取范围内各接口详情（含 paramConstraints / businessSemantics）
    const details: Awaited<ReturnType<typeof getApiDetail>>[] = [];
    for (const id of apiIds) {
      try {
        details.push(await getApiDetail(id));
      } catch {
        // 单个接口取不到不致命，跳过
      }
    }
    if (details.length === 0) {
      return NextResponse.json(
        { success: false, error: '选中的 API 均不可用' },
        { status: 404 }
      );
    }

    // 2. 为每个接口枚举"语义项 → 指纹"，建立 (apiId, sourceField, sourceKey) → fingerprint 映射
    //    指纹在服务端计算，AI 无法伪造，保证去重可信
    const apiRaw = await prisma.api.findMany({
      where: { id: { in: apiIds } },
      select: { id: true, businessSemantics: true } as any,
    });
    const fingerprintIndex = new Map<string, string>(); // key: apiId|field|sourceKey
    for (const a of apiRaw as any[]) {
      const eff = resolveEffectiveSemantics(a.businessSemantics);
      for (const item of enumerateSemanticItems(a.id, eff)) {
        // item.semanticKey 形如 fundConsistency.守恒 / dbAsserts.<desc> / sideEffect / description
        const [field, ...rest] = item.semanticKey.split('.');
        const sourceKey = rest.join('.') || null;
        fingerprintIndex.set(`${a.id}|${field}|${sourceKey ?? ''}`, item.fingerprint);
      }
    }

    // 3. 查该范围内已生成过的指纹（用于隐形去重）
    const generated = await prisma.testCase.findMany({
      where: {
        sourceFingerprint: { not: null },
        steps: { some: { apiId: { in: apiIds } } },
      } as any,
      select: { sourceFingerprint: true } as any,
    });
    const generatedFps = new Set(
      (generated as any[]).map((g) => g.sourceFingerprint as string)
    );

    // 4. 调 AI 自主设计场景清单
    //    范围大时按 ≤BATCH 个接口分批跑，避免一次喂太多导致 token 截断 / 设计质量下降，
    //    再合并各批结果。用户感知是"对这个范围设计"，分批对其透明。
    const client = await loadAIClient();
    const BATCH = 6;

    const runBatch = async (batch: typeof details): Promise<any[]> => {
      const userPayload = {
        apis: batch.map((d) => ({
          id: d.id,
          name: d.name,
          method: d.method,
          path: d.path,
          paramConstraints: (d as any).paramConstraints ?? null,
          businessSemantics: (d as any).businessSemantics ?? null,
          requestBody: d.requestBody ?? null,
          requestQuery: d.requestQuery ?? null,
          responseBody: d.responseBody ?? null,
        })),
      };
      const messages: AIMessage[] = [
        { role: 'system', content: EXPLORE_PLAN_SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            '请对以下接口自主探索并设计测试场景清单，调用 submit_exploration_plan 提交：\n\n' +
            JSON.stringify(userPayload, null, 2),
        },
      ];
      try {
        const response = await client.chat(messages, [EXPLORE_PLAN_TOOL]);
        const call = response.toolCalls?.find(
          (tc) => tc.function.name === 'submit_exploration_plan'
        );
        if (!call) return [];
        return JSON.parse(call.function.arguments)?.scenarios ?? [];
      } catch (e) {
        console.error('explore-plan 单批失败，跳过该批:', e);
        return []; // 单批失败不影响其他批
      }
    };

    // 切批
    const batches: (typeof details)[] = [];
    for (let i = 0; i < details.length; i += BATCH) {
      batches.push(details.slice(i, i + BATCH));
    }

    // 串行跑各批（避免并发打爆 AI 限流），合并场景
    let scenarios: any[] = [];
    for (const batch of batches) {
      scenarios = scenarios.concat(await runBatch(batch));
    }

    // 6. 为每个场景附指纹（服务端映射），标记是否已生成
    const enriched = scenarios.map((s: any) => {
      const apiId = Array.isArray(s.apiIds) && s.apiIds.length > 0 ? s.apiIds[0] : null;
      const fp =
        apiId && s.sourceField
          ? fingerprintIndex.get(`${apiId}|${s.sourceField}|${s.sourceKey ?? ''}`) ?? null
          : null;
      return {
        ...s,
        fingerprint: fp,
        alreadyGenerated: fp ? generatedFps.has(fp) : false,
      };
    });

    // 7. 隐形去重：默认隐藏已生成的场景
    const visible = includeGenerated
      ? enriched
      : enriched.filter((s: any) => !s.alreadyGenerated);

    return NextResponse.json({
      success: true,
      data: {
        scenarios: visible,
        total: enriched.length,
        hidden: enriched.length - visible.length, // 被去重隐藏的数量
      },
    });
  } catch (error: any) {
    console.error('探索场景设计失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '场景设计失败' },
      { status: 500 }
    );
  }
}
