import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { loadAIClient, type AIMessage } from '@/lib/ai-client';
import { EXPLORE_PLAN_SYSTEM_PROMPT, EXPLORE_PLAN_TOOL } from '@/lib/ai-prompts/explore-prompt';
import { getApiDetail } from '@/lib/ai-tools';
import { getCurrentWorkspace } from '@/lib/auth';
import {
  resolveEffectiveSemantics,
  enumerateSemanticItems,
} from '@/lib/semantics-fingerprint';

export const dynamic = 'force-dynamic';

/**
 * 健壮解析 AI 返回的 tool arguments。
 * 某些 OpenAI 兼容网关（如本项目用的 Claude 网关）会在 arguments 前面附带垃圾，
 * 例如返回 `{}{"scenarios":[...]}` —— 直接 JSON.parse 会在 position 2 报错。
 * 这里用括号配平扫描，提取第一个“配平且能解析”的完整 JSON 对象。
 */
function parseLooseJsonObject(raw: string): any {
  if (!raw) return null;
  // 先试直接解析（正常网关走这条）
  try {
    return JSON.parse(raw);
  } catch {
    /* 落到下面的扫描 */
  }
  // 从每个 '{' 起点尝试做括号配平，找到第一个能解析成功的完整对象
  for (let start = raw.indexOf('{'); start !== -1; start = raw.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = raw.slice(start, i + 1);
          try {
            const obj = JSON.parse(candidate);
            // 只接受“像那么回事”的对象（含 scenarios），跳过开头的空 `{}`
            if (obj && typeof obj === 'object' && 'scenarios' in obj) return obj;
          } catch {
            /* 这个候选不行，继续找下一个 '{' */
          }
          break;
        }
      }
    }
  }
  return null;
}

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
    // 资产管理总线 Step 1：解析当前工作区，AI 探索仅在当前工作区内进行
    const ws = await getCurrentWorkspace(request);
    if (!ws) {
      return NextResponse.json({ success: false, error: '未登录或无可用工作区' }, { status: 401 });
    }
    const workspaceId = ws.workspaceId;

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
        details.push(await getApiDetail(id, workspaceId));
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
    //    工作区收敛：避免别工作区同 id 的接口数据被错误带入（虽然 id 是 cuid 几乎不可能撞，但保留兜底）
    const apiRaw = await prisma.api.findMany({
      where: { id: { in: apiIds }, workspaceId },
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
    //    工作区收敛：只看当前工作区下的已生成用例
    const generated = await prisma.testCase.findMany({
      where: {
        workspaceId,
        sourceFingerprint: { not: null },
        steps: { some: { apiId: { in: apiIds } } },
      } as any,
      select: { sourceFingerprint: true } as any,
    });
    const generatedFps = new Set(
      (generated as any[]).map((g) => g.sourceFingerprint as string)
    );

    // 4. 调 AI 自主设计场景清单
    //    按 ≤BATCH 个接口分批跑——单批做小，避免一次喂太多导致 AI 输出过长 / 超时。
    //    接口间场景本就独立，拆细不损质量，反而每次调用更快更稳。
    const client = await loadAIClient();
    const BATCH = 2;
    let failedCount = 0; // 设计失败（超时/异常）的接口数，用于回传前端，避免"静默返回空"

    const runBatch = async (batch: typeof details): Promise<any[]> => {
      const userPayload = {
        apis: batch.map((d) => ({
          id: d.id,
          name: d.name,
          method: d.method,
          path: d.path,
          paramConstraints: (d as any).paramConstraints ?? null,
          businessSemantics: (d as any).businessSemantics ?? null,
          // 设计场景只需"请求形状"，responseBody 往往很大且非必需 —— 省 token、降超时风险
          requestBody: d.requestBody ?? null,
          requestQuery: d.requestQuery ?? null,
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
        const parsed = parseLooseJsonObject(call.function.arguments);
        return parsed?.scenarios ?? [];
      } catch (e: any) {
        // 单批失败不影响其他批，但要记账，回传给前端提示（不静默吞掉）
        failedCount += batch.length;
        console.error(`explore-plan 单批失败（${batch.length} 个接口）:`, e?.message || e);
        return [];
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
        failedCount, // 设计失败（多为 AI 超时）的接口数，前端据此提示而非静默
        totalApis: details.length,
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
