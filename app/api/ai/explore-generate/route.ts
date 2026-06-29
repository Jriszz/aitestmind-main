import { NextRequest } from 'next/server';
import { loadAIClient, type AIMessage } from '@/lib/ai-client';
import { getSystemPrompt } from '@/lib/ai-prompts/system-prompt';
import {
  AI_TOOLS,
  getApiDetail,
  smartSearchDeleteApi,
  assembleAndCreateTestCases,
  hierarchicalSearchApis,
} from '@/lib/ai-tools';
import { prisma } from '@/lib/prisma';
import { caseToData } from '@/lib/functional-case-utils';

export const dynamic = 'force-dynamic';

/**
 * AI 探索 · 生成阶段（SSE）
 * POST /api/ai/explore-generate
 *   body: { scenarios: Scenario[] }   —— 用户在场景清单里选定的场景
 *
 * 复用 smart-generate 的 Function Calling + assemble 引擎：
 *   - 把"选定场景清单"构造成定向指令（每个场景 → 一条同名用例）
 *   - 透传 fingerprintByName，让生成的用例落库时带上 sourceFingerprint（隐形去重/累积）
 *
 * 与 smart-generate 同引擎、不同入口提示词：这里 AI 不再自由发挥场景，
 * 而是忠实把"已审定的场景"组装成用例（设计阶段已在 explore-plan 完成）。
 */

type StreamMessage = { type: string; content: string; data?: any };

/**
 * 决策可见化（Level 1）：把 Agent 内部的关键决策点显式推给前端，让用户实时看见
 * "AI 搜了什么 / 选了哪个接口 / 有没有配 cleanup / 最终打算装成什么"。
 *
 * 设计要点：
 * - 与现有 tool_call 消息并存（tool_call 服务于进度条；decision 服务于复盘视图）。
 * - search/select/cleanup 阶段 caseTitle 未知（AI 还没决定装成哪条用例），先标 null；
 *   到 assemble 时按 plan 里的 testCases[].name 拆成多条 decision，前端再聚合。
 * - assemble 在调用 assembleAndCreateTestCases 之前推 —— 即使后端组装失败，用户也能
 *   看见 AI 当时编排意图，便于排错。
 */
type DecisionKind = 'search_api' | 'select_api' | 'cleanup_search' | 'assemble';

function pushDecision(
  controller: ReadableStreamDefaultController,
  args: {
    kind: DecisionKind;
    title: string; // 一句话给人看的标题
    chunkIdx: number;
    caseTitle?: string | null;
    detail: any;
  }
) {
  const { kind, title, chunkIdx, caseTitle = null, detail } = args;
  sendSSE(controller, {
    type: 'decision',
    content: title,
    data: { kind, chunkIdx, caseTitle, detail },
  });
}

const SCENARIO_TYPE_TAG: Record<string, string> = {
  normal: '正常场景',
  param: '参数校验',
  business: '业务语义',
  e2e: 'E2E流程',
  permission: '权限校验',
  state: '状态流转',
};

function buildScenarioTags(scenario: any): string[] {
  const tags = ['AI探索', '待编排'];
  const typeTag = SCENARIO_TYPE_TAG[scenario?.type];
  if (typeTag) tags.push(typeTag);

  if (scenario?.sourceField === 'fundConsistency') tags.push('资金对账');
  if (scenario?.sourceField === 'sideEffect' || scenario?.sourceField === 'dbAsserts') {
    tags.push('落库验证');
  }

  return Array.from(new Set(tags));
}

function sendSSE(controller: ReadableStreamDefaultController, message: StreamMessage) {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`));
}

export async function POST(request: NextRequest) {
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const body = await request.json();
        const scenarios = body?.scenarios;
        const functionalCases = body?.functionalCases;

        const { getCurrentUser } = await import('@/lib/auth');
        const currentUser = await getCurrentUser(request);
        const currentUserId = currentUser?.user?.id ?? null;

        // 两种入参二选一：场景清单（按 API 范围探索）或功能用例（从需求文档）
        const fromFunctional = Array.isArray(functionalCases) && functionalCases.length > 0;
        const items: any[] = fromFunctional ? functionalCases : scenarios;

        if (!Array.isArray(items) || items.length === 0) {
          sendSSE(controller, { type: 'error', content: '请至少选择一个场景或功能用例' });
          controller.close();
          return;
        }

        // 用例名 → 来源指纹 / 工作流标签（服务端注入，AI 无需感知）
        const fingerprintByName: Record<string, string> = {};
        const extraTagsByName: Record<string, string[]> = {};
        for (const s of items) {
          if (!s.title) continue;
          if (!fromFunctional && s.fingerprint) fingerprintByName[s.title] = s.fingerprint;
          extraTagsByName[s.title] = buildScenarioTags(s);
        }

        // 方案 A：功能用例链路"先落库再生成"。
        // 探索生成 = 人工评审后沉淀为正式用例：选中即落库（没 id 建、有 id 标记），
        // 再让 TestCase 落库时带上 sourceFunctionalCaseId（反向追溯），生成后回填 generatedCaseIds（正向）。
        const functionalCaseIdByName: Record<string, string> = {}; // 用例名 → 功能用例 id
        if (fromFunctional) {
          for (const fc of items) {
            if (!fc.title) continue;
            try {
              if (fc.id) {
                // 已有 → 确保存在并标记 generated（内容以库为准，不覆盖）
                await (prisma as any).interfaceFunctionalCase.update({
                  where: { id: fc.id },
                  data: { status: 'generated', ...(currentUserId && { updatedBy: currentUserId }) },
                });
                functionalCaseIdByName[fc.title] = fc.id;
              } else {
                // 内存草稿 → 去重落库：同 (module, title) 已存在则复用并标记 generated，否则建档。
                // 防止"先保存到库再探索生成"或重复点击在用例层产生重复用例。
                const moduleVal = fc.module || null;
                const titleVal = fc.title || '未命名用例';
                const existing = await (prisma as any).interfaceFunctionalCase.findFirst({
                  where: { module: moduleVal, title: titleVal },
                  select: { id: true },
                });
                if (existing) {
                  await (prisma as any).interfaceFunctionalCase.update({
                    where: { id: existing.id },
                    data: { status: 'generated', ...(currentUserId && { updatedBy: currentUserId }) },
                  });
                  functionalCaseIdByName[fc.title] = existing.id;
                } else {
                  const row = await (prisma as any).interfaceFunctionalCase.create({
                    data: {
                      ...caseToData({ ...fc, status: 'generated' }),
                      ...(currentUserId && { createdBy: currentUserId, updatedBy: currentUserId }),
                    },
                  });
                  functionalCaseIdByName[fc.title] = row.id;
                }
              }
            } catch (e) {
              console.error('功能用例落库失败（跳过该条追溯）:', e);
            }
          }
        }

        const client = await loadAIClient();
        const systemPrompt = getSystemPrompt('api');

        // 全部已创建用例（跨批累计）
        const createdTestCases: any[] = [];

        // 跑单批：一个独立的 Function Calling 循环
        const runChunk = async (
          chunkItems: any[],
          chunkIdx: number,
          totalChunks: number
        ) => {
          const prefix = totalChunks > 1 ? `（第 ${chunkIdx + 1}/${totalChunks} 批）` : '';
          sendSSE(controller, {
            type: 'thinking',
            content: fromFunctional
              ? `正在探索接口并按功能用例组装${prefix}...`
              : `正在按选定场景组装测试用例${prefix}...`,
          });

          const directive = fromFunctional
            ? // 从需求文档来的功能用例：AI 需先检索接口，再把业务步骤映射成可执行用例
              '以下是已审定的接口功能测试用例（业务语言描述，未绑定具体接口）。请为每条生成一条可执行测试用例：\n' +
              '- 用例名称必须与功能用例 title 完全一致（用于来源追溯）。\n' +
              '- 先用 hierarchical_search_apis 按 apiHints / 步骤动作检索 API 仓库，找到每步对应的真实接口；找不到的步骤可跳过并在用例描述中说明。\n' +
              '- 用 get_api_detail 获取接口参数/响应结构，把 steps 的 action/input/expected 映射成接口节点与断言。\n' +
              '- preconditions 处理规则（重要）：\n' +
              '  · 认证类前置（如"用户已登录""持有 token""已认证"）→ **不生成节点**。平台已通过认证 Token 配置全局注入 Authorization，所有请求自动带认证头。\n' +
              '  · 数据类前置（如"超管租户已存在""账户有 USD 余额""产品已上架"）→ **生成前置节点**：用 hierarchical_search_apis 搜对应"创建/查询/置态"接口；搜到则生成节点（id 用 step_pre_<n>，如 step_pre_1），放在主业务节点之前；搜不到则在用例 description 标注"前置 X 需人工准备"，不臆造接口。\n' +
              '  · 环境类前置（如"系统时间为工作日""配置项 X 已开启"）→ 不生成节点，记入 description 让人审核。\n' +
              '  · 前置节点产生的关键标识（新建实体的 id/编码等）必须用 variableRefs 在主节点中引用（例如 body.tenantId ← step_pre_1.response.data.id），不要硬编码刚刚创建的值。\n' +
              '  · "造数式前置"（POST/PUT 创建实体）必须配套 cleanup 节点删除/复原（用 smart_search_delete_api 找删除接口，节点 isCleanup: true）；只读式前置（GET 查询）无需 cleanup。\n' +
              '- 把 postconditions 映射成"后置查询 + 断言"节点；把 cleanup 映射成后置清理节点（会造数/改状态的用例用 smart_search_delete_api 找删除接口）。\n' +
              '- 不要写 SQL；dbAsserts/落库类校验请转化为通过查询接口可验证的接口层断言。\n' +
              '- 若用例残留前端措辞（点击/页面显示/提示文案/列表展示/页面跳转），按接口契约视角处理：断言只断接口响应能验证的字段/状态，纯 UI 动作（跳转/刷新/置灰/Toast）不生成节点，直接忽略。\n' +
              '- 最后调用 assemble_and_create_test_cases 一次性创建。\n\n' +
              '功能用例清单：\n' +
              JSON.stringify(
                chunkItems.map((c: any) => ({
                  title: c.title,
                  type: c.type,
                  objective: c.objective,
                  preconditions: c.preconditions,
                  steps: c.steps,
                  postconditions: c.postconditions,
                  cleanup: c.cleanup,
                  expectedResults: c.expectedResults,
                  businessRules: c.businessRules,
                  apiHints: c.apiHints,
                })),
                null,
                2
              )
            : // 按 API 范围探索来的场景：接口已知，直接组装
              '以下是已经审定的测试场景清单。请严格按此清单生成测试用例：\n' +
              '- 每个场景生成且仅生成一条测试用例，用例名称必须与场景 title 完全一致（用于来源追溯）。\n' +
              '- 用 get_api_detail 获取涉及接口的参数/响应结构，按场景 steps 与 rationale 组装。\n' +
              '- 会创建数据的正常场景用 smart_search_delete_api 加后置清理。\n' +
              '- 最后调用 assemble_and_create_test_cases 一次性创建。\n\n' +
              '场景清单：\n' +
              JSON.stringify(
                chunkItems.map((s: any) => ({
                  title: s.title,
                  type: s.type,
                  apiIds: s.apiIds,
                  rationale: s.rationale,
                  steps: s.steps,
                })),
                null,
                2
              );

          const messages: AIMessage[] = [{ role: 'user', content: directive }];
          let continueLoop = true;
          let iterationCount = 0;
          // 功能用例链路需要先检索接口再组装，迭代多给一些
          const maxIterations = fromFunctional ? 20 : 15;

          while (continueLoop && iterationCount < maxIterations) {
            iterationCount++;
            const response = await client.chat(
              [{ role: 'system', content: systemPrompt }, ...messages],
              AI_TOOLS
            );

            if (response.toolCalls && response.toolCalls.length > 0) {
              if (response.content) {
                const creating = response.toolCalls.some(
                  (tc) => tc.function.name === 'assemble_and_create_test_cases'
                );
                sendSSE(controller, {
                  type: creating ? 'content' : 'thinking',
                  content: response.content,
                });
              }

              messages.push({
                role: 'assistant',
                content: response.content || null,
                tool_calls: response.toolCalls,
                reasoning_content: response.reasoningContent,
              });

              for (const toolCall of response.toolCalls) {
                const functionName = toolCall.function.name;
                let functionResult: any;
                const startTime = Date.now();

                try {
                  const functionArgs = JSON.parse(toolCall.function.arguments);

                  if (functionName === 'hierarchical_search_apis') {
                    functionResult = await hierarchicalSearchApis(functionArgs);
                    // 推 search_api 决策：搜索关键词 + 命中数 + 前 5 候选
                    // 命中 0 是 Agent 3 最常出错的地方（AI 会跳过该步骤或臆造接口），前端高亮提示
                    const hits = Array.isArray(functionResult) ? functionResult : [];
                    const keywords: Record<string, any> = {};
                    for (const k of ['platform', 'component', 'feature', 'apiName', 'method', 'userQuery'] as const) {
                      if (functionArgs?.[k]) keywords[k] = functionArgs[k];
                    }
                    const kwSummary =
                      Object.values(keywords).filter(Boolean).join(' / ') || '(无关键词)';
                    pushDecision(controller, {
                      kind: 'search_api',
                      chunkIdx,
                      title:
                        hits.length === 0
                          ? `⚠️ 未找到匹配接口：${kwSummary}`
                          : `搜接口「${kwSummary}」→ 命中 ${hits.length} 个`,
                      detail: {
                        keywords,
                        hitCount: hits.length,
                        isEmpty: hits.length === 0,
                        candidates: hits.slice(0, 5).map((a: any) => ({
                          id: a.id,
                          name: a.name,
                          method: a.method,
                          path: a.path,
                          platform: a.platform,
                          component: a.component,
                          feature: a.feature,
                        })),
                      },
                    });
                  } else if (functionName === 'get_api_detail') {
                    functionResult = await getApiDetail(functionArgs.apiId);
                    // 推 select_api 决策：AI 选定了哪个 API，是否有结构化约束/语义可用
                    const hasConstraints = !!(functionResult as any)?.paramConstraints;
                    const hasSemantics = !!(functionResult as any)?.businessSemantics;
                    pushDecision(controller, {
                      kind: 'select_api',
                      chunkIdx,
                      title: `选定接口：${functionResult.name} [${functionResult.method}]`,
                      detail: {
                        apiId: functionResult.id,
                        apiName: functionResult.name,
                        method: functionResult.method,
                        path: functionResult.path,
                        hasConstraints,
                        hasSemantics,
                      },
                    });
                  } else if (functionName === 'smart_search_delete_api') {
                    functionResult = await smartSearchDeleteApi(functionArgs);
                    // 推 cleanup_search 决策：是否找到清理接口
                    pushDecision(controller, {
                      kind: 'cleanup_search',
                      chunkIdx,
                      title: functionResult?.needCleanup
                        ? `已找到清理接口：${functionResult.deleteApi?.name}`
                        : `跳过清理：${functionResult?.reason || '无需清理'}`,
                      detail: {
                        createApiId: functionArgs?.createApiId,
                        needCleanup: !!functionResult?.needCleanup,
                        deleteApi: functionResult?.deleteApi,
                        reason: functionResult?.reason,
                      },
                    });
                  } else if (functionName === 'assemble_and_create_test_cases') {
                    // 推 assemble 决策：在落库前先把每条用例的编排概览推给前端
                    // 这样即便组装失败，用户也能看到 AI 当时打算装什么
                    const plan = functionArgs?.orchestrationPlan;
                    const testCases = Array.isArray(plan?.testCases) ? plan.testCases : [];
                    for (const tc of testCases) {
                      const nodes = Array.isArray(tc?.nodes) ? tc.nodes : [];
                      const apiNodeIds: string[] = nodes
                        .filter((n: any) => n?.type === 'api')
                        .map((n: any) => n?.apiId)
                        .filter(Boolean);
                      const hasPreNodes = nodes.some((n: any) =>
                        typeof n?.id === 'string' && n.id.startsWith('step_pre_')
                      );
                      const hasCleanup = nodes.some((n: any) => n?.isCleanup === true);
                      // assertionCounts: 节点 id → 该节点断言条数（让用户能一眼看出有没有断言遗漏）
                      const assertionCounts: Record<string, number> = {};
                      for (const n of nodes) {
                        if (n?.type === 'api' && typeof n.id === 'string') {
                          assertionCounts[n.id] = Array.isArray(n.assertions)
                            ? n.assertions.length
                            : 0;
                        }
                      }
                      pushDecision(controller, {
                        kind: 'assemble',
                        chunkIdx,
                        caseTitle: tc?.name ?? null,
                        title: `编排用例「${tc?.name || '未命名'}」：${nodes.length} 个节点${
                          hasCleanup ? '，含清理' : ''
                        }${hasPreNodes ? '，含前置' : ''}`,
                        detail: {
                          name: tc?.name,
                          nodeCount: nodes.length,
                          apiNodeIds,
                          hasPreNodes,
                          hasCleanup,
                          assertionCounts,
                        },
                      });
                    }
                    functionResult = await assembleAndCreateTestCases({
                      ...functionArgs,
                      userId: currentUserId,
                      fingerprintByName, // 注入来源指纹
                      extraTagsByName, // 注入 AI探索 / 待编排 / 类型标签
                      functionalCaseIdByName, // 注入来源功能用例 id（反向追溯）
                      onProgress: (progress) => {
                        sendSSE(controller, {
                          type: 'tool_call',
                          content: 'progress',
                          data: {
                            tool: functionName,
                            progress: {
                              step: progress.step,
                              totalSteps: progress.totalSteps,
                              percentage: Math.round((progress.step / progress.totalSteps) * 100),
                              message: `${prefix}${progress.message}`,
                              detail: progress.detail,
                            },
                            status: 'running',
                          },
                        });
                      },
                    });
                    createdTestCases.push(...functionResult.created);
                    sendSSE(controller, {
                      type: 'tool_call',
                      content: 'success',
                      data: {
                        tool: functionName,
                        result: functionResult,
                        duration: Date.now() - startTime,
                        status: 'success',
                        summary: functionResult.message,
                      },
                    });
                  } else {
                    functionResult = { error: '未知的工具' };
                  }
                } catch (error: any) {
                  functionResult = { error: error.message };
                  sendSSE(controller, {
                    type: 'tool_call',
                    content: 'error',
                    data: { tool: functionName, error: error.message, status: 'error' },
                  });
                }

                messages.push({
                  role: 'tool',
                  content: JSON.stringify(functionResult),
                  tool_call_id: toolCall.id,
                });
              }
            } else {
              if (response.content) {
                sendSSE(controller, { type: 'content', content: response.content });
              }
              continueLoop = false;
            }
          }
        };

        // 多时分批生成（每批 ≤CHUNK 个），避免一次喂太多 token 截断；进度连续
        // 功能用例每条要先检索接口、上下文更重，批量做小一点
        const CHUNK = fromFunctional ? 4 : 8;
        const chunks: any[][] = [];
        for (let i = 0; i < items.length; i += CHUNK) {
          chunks.push(items.slice(i, i + CHUNK));
        }
        for (let i = 0; i < chunks.length; i++) {
          await runChunk(chunks[i], i, chunks.length);
        }

        // 功能用例链路：回填正向追溯（功能用例.generatedCaseIds += 派生出的 TestCase id），并标记 generated
        if (fromFunctional && createdTestCases.length > 0) {
          // 按用例名聚合本次新建的 TestCase id
          const idsByTitle = new Map<string, string[]>();
          for (const tc of createdTestCases) {
            const arr = idsByTitle.get(tc.name) ?? [];
            arr.push(tc.id);
            idsByTitle.set(tc.name, arr);
          }
          for (const [title, fcId] of Object.entries(functionalCaseIdByName)) {
            const newIds = idsByTitle.get(title);
            if (!newIds || newIds.length === 0) continue;
            try {
              const existing = await (prisma as any).interfaceFunctionalCase.findUnique({
                where: { id: fcId },
                select: { generatedCaseIds: true },
              });
              let prev: string[] = [];
              try {
                prev = existing?.generatedCaseIds ? JSON.parse(existing.generatedCaseIds) : [];
              } catch {
                prev = [];
              }
              const merged = Array.from(new Set([...prev, ...newIds]));
              await (prisma as any).interfaceFunctionalCase.update({
                where: { id: fcId },
                data: { generatedCaseIds: JSON.stringify(merged), status: 'generated' },
              });
            } catch (e) {
              console.error('回填 generatedCaseIds 失败:', e);
            }
          }
        }

        // 全部批次完成，发送统一总结
        sendSSE(controller, {
          type: 'summary',
          content: '执行完成',
          data: {
            testCasesCreated: createdTestCases.length,
            testCases: createdTestCases.map((tc) => ({ id: tc.id, name: tc.name })),
          },
        });
        controller.close();
      } catch (error: any) {
        console.error('❌ 探索生成失败:', error);
        sendSSE(controller, { type: 'error', content: error.message || '生成失败' });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
