import { NextRequest } from 'next/server';
import { loadAIClient, type AIMessage } from '@/lib/ai-client';
import { getExploreGeneratePrompt } from '@/lib/ai-prompts/explore-generate-prompt';
import {
  AI_TOOLS,
  getApiDetail,
  smartSearchDeleteApi,
  assembleAndCreateTestCases,
  hierarchicalSearchApis,
  queryApiFeedback,
} from '@/lib/ai-tools';
import { prisma } from '@/lib/prisma';
import { caseToData } from '@/lib/functional-case-utils';
import { fingerprintFunctionalCase } from '@/lib/semantics-fingerprint';
import { SCENARIO_TYPE_MAP } from '@/lib/constants/tags';

export const dynamic = 'force-dynamic';

/**
 * AI 探索 · 生成阶段（SSE）
 * POST /api/ai/explore-generate
 *   body 二选一：
 *     { scenarios: Scenario[] }              —— 场景路径（接口已知，来自 explore-plan）
 *     { functionalCases: FunctionalCase[] }  —— 功能用例路径（接口未知，来自文档/链路）
 *
 * 设计要点（与 smart-generate 同 Function Calling 引擎、不同入口提示词）：
 *   - 用 explore-generate-prompt.ts 的"组装器型" system prompt 替代 UNIFIED_SYSTEM_PROMPT
 *     的"设计师型"——避免 AI 自由发挥改 title / 合并条目，破坏 title→指纹追溯映射。
 *   - 透传 fingerprintByName / functionalCaseIdByName，让生成的用例落库时带追溯字段。
 *   - 服务端按"用例名集合 == 输入 title 集合"做等值校验，缺失/多余各推 warning SSE。
 *   - 功能用例落库 status 不预先打 generated，避免下游失败留下孤儿态；仅在 TestCase
 *     真正落库后回填阶段才推到 generated（呼应 DESIGN_DECISIONS 决策 10 状态机一致性）。
 */

type StreamMessage = { type: string; content: string; data?: any };

/**
 * 决策可见化（Level 1）：把 Agent 内部的关键决策点显式推给前端，让用户实时看见
 * "AI 搜了什么 / 选了哪个接口 / 有没有配 cleanup / 最终打算装成什么 / 失败时编排了啥"。
 */
type DecisionKind =
  | 'search_api'
  | 'select_api'
  | 'cleanup_search'
  | 'assemble'
  | 'assemble_failed';

function pushDecision(
  controller: ReadableStreamDefaultController,
  args: {
    kind: DecisionKind;
    title: string;
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

/**
 * 构造场景标签（决策 11：单层池，可空）
 * - 场景标签：从 SCENARIO_TYPE_MAP 选
 * - 业务域标签：根据 sourceField 选
 * - 来源（"AI探索"）不进 tag——归 AssetLineage 管（决策 10）
 * - 状态（"待编排"）不进 tag——归 lifecycle 管
 */
function buildScenarioTags(scenario: any): string[] {
  const tags: string[] = [];

  const scenarioTag = SCENARIO_TYPE_MAP[scenario?.type];
  if (scenarioTag) tags.push(scenarioTag);

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

        const { getCurrentUser, getCurrentWorkspace } = await import('@/lib/auth');
        const currentUser = await getCurrentUser(request);
        const currentUserId = currentUser?.user?.id ?? null;
        // 资产管理总线 Step 1：解析当前工作区，AI 探索/落库都按此过滤
        const ws = await getCurrentWorkspace(request);
        if (!ws) {
          sendSSE(controller, { type: 'error', content: '未登录或无可用工作区' });
          controller.close();
          return;
        }
        const workspaceId: string = ws.workspaceId;

        // 两种入参二选一
        const fromFunctional = Array.isArray(functionalCases) && functionalCases.length > 0;
        const items: any[] = fromFunctional ? functionalCases : scenarios;

        if (!Array.isArray(items) || items.length === 0) {
          sendSSE(controller, { type: 'error', content: '请至少选择一个场景或功能用例' });
          controller.close();
          return;
        }

        // 用例名 → 指纹 / 工作流标签（服务端注入，AI 无需感知）
        const fingerprintByName: Record<string, string> = {};
        const extraTagsByName: Record<string, string[]> = {};
        for (const s of items) {
          if (!s.title) continue;
          extraTagsByName[s.title] = buildScenarioTags(s);
          if (!fromFunctional) {
            // 场景路径：指纹由 explore-plan 服务端计算并透传（接口语义指纹族）
            if (s.fingerprint) fingerprintByName[s.title] = s.fingerprint;
          } else {
            // 功能用例路径：当前函数计算稳定指纹（功能用例指纹族），与场景路径共享
            // fingerprintByName 通道注入到 TestCase.sourceFingerprint，让 explore-plan
            // 的隐形去重在两条链路上对齐。
            fingerprintByName[s.title] = fingerprintFunctionalCase({
              // 资产管理总线 Step 1 兼容：指纹仍传 null，避免回填后旧用例 sourceFingerprint
              // 失配导致"已生成"误判（破坏功能用例去重链路的连续性）；
              // 工作区收敛通过 explore-plan 查询的 where 实现，而非指纹本身。
              workspaceId: null,
              module: s.module ?? null,
              feature: s.feature ?? null,
              title: s.title,
              apiHints: Array.isArray(s.apiHints) ? s.apiHints : [],
            });
          }
        }

        // 功能用例链路"先落库后追溯"：仅建立 title → fc.id 映射，**不预先打 generated**。
        // 状态推迟到全部批次跑完、且该 title 确有 TestCase 产出时再更新（见末尾回填段）。
        // 旧设计在此处提前写 generated，失败时留下 status=generated && generatedCaseIds=[]
        // 的孤儿态污染前端列表，故撤销。
        const functionalCaseIdByName: Record<string, string> = {};
        if (fromFunctional) {
          for (const fc of items) {
            if (!fc.title) continue;
            const fp = fingerprintByName[fc.title];
            try {
              if (fc.id) {
                // 已有 id：复用并补指纹（如果原记录还没存）
                // 工作区收敛：避免别工作区同 id 数据被错误命中
                const row = await (prisma as any).interfaceFunctionalCase.findFirst({
                  where: { id: fc.id, workspaceId },
                  select: { sourceFingerprint: true },
                });
                if (row && !row.sourceFingerprint && fp) {
                  await (prisma as any).interfaceFunctionalCase.update({
                    where: { id: fc.id },
                    data: { sourceFingerprint: fp },
                  });
                }
                functionalCaseIdByName[fc.title] = fc.id;
              } else {
                // 无 id：先按 sourceFingerprint 去重，再回退到 (module, title) 软键
                // 工作区收敛：不同工作区相同模块+标题应视为不同功能用例
                let existing:
                  | { id: string; sourceFingerprint: string | null }
                  | null = null;
                if (fp) {
                  existing = await (prisma as any).interfaceFunctionalCase.findFirst({
                    where: { sourceFingerprint: fp, workspaceId },
                    select: { id: true, sourceFingerprint: true },
                  });
                }
                if (!existing) {
                  existing = await (prisma as any).interfaceFunctionalCase.findFirst({
                    where: { module: fc.module || null, title: fc.title, workspaceId },
                    select: { id: true, sourceFingerprint: true },
                  });
                  // 命中软键但无指纹的旧数据，回填指纹
                  if (existing && fp && !existing.sourceFingerprint) {
                    await (prisma as any).interfaceFunctionalCase.update({
                      where: { id: existing.id },
                      data: { sourceFingerprint: fp },
                    });
                  }
                }
                if (existing) {
                  functionalCaseIdByName[fc.title] = existing.id;
                } else {
                  const row = await (prisma as any).interfaceFunctionalCase.create({
                    data: {
                      ...caseToData({ ...fc, sourceFingerprint: fp }),
                      ...(currentUserId && { createdBy: currentUserId, updatedBy: currentUserId }),
                      workspaceId,
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
        const systemPrompt = getExploreGeneratePrompt(
          fromFunctional ? 'functional-case' : 'scenario'
        );

        // 全部已创建用例（跨批累计）
        const createdTestCases: any[] = [];
        // 失败批次清单（partial recovery：单批失败不影响其他批）
        const failedChunks: Array<{ chunkIdx: number; error: string; titles: string[] }> = [];

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

          // 进入本批前快照已创建数量，结束后切片得到 thisChunkCreated
          const createdSnapshot = createdTestCases.length;

          // user message 只承载清单数据 + 一句"按 system 规则处理"。
          // 角色定位、preconditions 分类、UI 措辞过滤等规则全部下沉到 system prompt，
          // 让 prompt cache 在多批之间命中。
          const directive = fromFunctional
            ? '以下是已审定的接口功能测试用例清单。请严格按 system 中的"组装器"规则处理本批，' +
              '为每条产出一条且仅一条可执行测试用例（用例 name 必须与 title 完全一致），最后一次性调用 assemble_and_create_test_cases。\n\n' +
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
            : '以下是已审定的测试场景清单。请严格按 system 中的"组装器"规则处理本批，' +
              '为每条产出一条且仅一条可执行测试用例（用例 name 必须与 title 完全一致），最后一次性调用 assemble_and_create_test_cases。\n\n' +
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
                    functionResult = await hierarchicalSearchApis({ ...functionArgs, workspaceId });
                    const hits = Array.isArray(functionResult) ? functionResult : [];
                    const keywords: Record<string, any> = {};
                    for (const k of [
                      'platform',
                      'component',
                      'feature',
                      'apiName',
                      'method',
                      'userQuery',
                    ] as const) {
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
                    functionResult = await getApiDetail(functionArgs.apiId, workspaceId);
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
                  } else if (functionName === 'query_api_feedback') {
                    functionResult = await queryApiFeedback({ ...functionArgs, workspaceId });
                    sendSSE(controller, {
                      type: 'tool_call',
                      content: 'success',
                      data: {
                        tool: functionName,
                        args: functionArgs,
                        result: functionResult,
                        duration: Date.now() - startTime,
                        status: 'success',
                        summary: functionResult.count > 0
                          ? `命中 ${functionResult.count} 条避坑反馈`
                          : `无历史反馈`,
                      },
                    });

                  } else if (functionName === 'smart_search_delete_api') {
                    functionResult = await smartSearchDeleteApi({ ...functionArgs, workspaceId });
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
                    const plan = functionArgs?.orchestrationPlan;
                    const testCases = Array.isArray(plan?.testCases) ? plan.testCases : [];
                    for (const tc of testCases) {
                      const nodes = Array.isArray(tc?.nodes) ? tc.nodes : [];
                      const apiNodeIds: string[] = nodes
                        .filter((n: any) => n?.type === 'api')
                        .map((n: any) => n?.apiId)
                        .filter(Boolean);
                      const hasPreNodes = nodes.some(
                        (n: any) =>
                          typeof n?.id === 'string' && n.id.startsWith('step_pre_')
                      );
                      const hasCleanup = nodes.some((n: any) => n?.isCleanup === true);
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
                    try {
                      functionResult = await assembleAndCreateTestCases({
                        ...functionArgs,
                        userId: currentUserId,
                        workspaceId,
                        fingerprintByName,
                        extraTagsByName,
                        functionalCaseIdByName,
                        onProgress: (progress) => {
                          sendSSE(controller, {
                            type: 'tool_call',
                            content: 'progress',
                            data: {
                              tool: functionName,
                              progress: {
                                step: progress.step,
                                totalSteps: progress.totalSteps,
                                percentage: Math.round(
                                  (progress.step / progress.totalSteps) * 100
                                ),
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
                    } catch (assembleErr: any) {
                      // 落库失败：决策流补一条 assemble_failed，把"AI 当时想装什么"和
                      // "为什么没成"在前端能对齐展示，而不只是一条孤零零的 tool_call:error。
                      pushDecision(controller, {
                        kind: 'assemble_failed',
                        chunkIdx,
                        title: `❌ 编排落库失败：${assembleErr?.message ?? '未知错误'}`,
                        detail: {
                          error: assembleErr?.message ?? String(assembleErr),
                          plannedCaseNames: testCases.map((tc: any) => tc?.name).filter(Boolean),
                        },
                      });
                      throw assembleErr; // 让外层 try/catch 拿到，沉到 functionResult 给 LLM 看
                    }
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

          // 迭代上限触发但本批没产生任何用例 → 沉默关闭会让前端看不到原因，主动报警告
          const thisChunkCreated = createdTestCases.slice(createdSnapshot);
          if (iterationCount >= maxIterations && thisChunkCreated.length === 0) {
            sendSSE(controller, {
              type: 'warning',
              content: `${prefix}达到 ${maxIterations} 轮迭代上限但未完成组装`,
              data: { chunkIdx, reason: 'max_iterations' },
            });
          }

          // 服务端集合等值校验：用例名集合 == 输入 title 集合
          // 任一侧多/少都推 warning。缺失的 title 在回填段不会被打 status: generated。
          const expectedTitles = new Set(
            chunkItems.map((x: any) => x.title).filter(Boolean) as string[]
          );
          const actualTitles = new Set(thisChunkCreated.map((c: any) => c.name));
          const missing = [...expectedTitles].filter((t) => !actualTitles.has(t));
          const extra = [...actualTitles].filter((t) => !expectedTitles.has(t));
          if (missing.length > 0) {
            sendSSE(controller, {
              type: 'warning',
              content: `${prefix}输入 ${expectedTitles.size} 条，实际生成 ${actualTitles.size} 条，缺失 ${missing.length} 条`,
              data: { chunkIdx, reason: 'missing', missing },
            });
          }
          if (extra.length > 0) {
            sendSSE(controller, {
              type: 'warning',
              content: `${prefix}AI 多生成了 ${extra.length} 条非清单内用例`,
              data: { chunkIdx, reason: 'extra', extra },
            });
          }
        };

        // 多时分批生成（每批 ≤CHUNK 个），避免一次喂太多 token 截断
        const CHUNK = fromFunctional ? 4 : 8;
        const chunks: any[][] = [];
        for (let i = 0; i < items.length; i += CHUNK) {
          chunks.push(items.slice(i, i + CHUNK));
        }
        // partial recovery：单批失败不影响后续批；汇总到 failedChunks 传给前端
        for (let i = 0; i < chunks.length; i++) {
          try {
            await runChunk(chunks[i], i, chunks.length);
          } catch (e: any) {
            const msg = e?.message ?? String(e);
            failedChunks.push({
              chunkIdx: i,
              error: msg,
              titles: chunks[i].map((x: any) => x.title).filter(Boolean),
            });
            sendSSE(controller, {
              type: 'warning',
              content: `第 ${i + 1}/${chunks.length} 批失败：${msg}`,
              data: { chunkIdx: i, reason: 'chunk_error' },
            });
            console.error(`[explore-generate] chunk ${i} failed:`, e);
          }
        }

        // 功能用例链路：回填正向追溯，仅对"该 title 在 createdTestCases 中确实出现"的 fc
        // 推进 status=generated；其余保留原状态（draft/reviewed/...）。
        // 这是孤儿态修复的核心：失败/缺失的功能用例永远走不到这里。
        if (fromFunctional && createdTestCases.length > 0) {
          const idsByTitle = new Map<string, string[]>();
          for (const tc of createdTestCases) {
            const arr = idsByTitle.get(tc.name) ?? [];
            arr.push(tc.id);
            idsByTitle.set(tc.name, arr);
          }
          for (const [title, fcId] of Object.entries(functionalCaseIdByName)) {
            const newIds = idsByTitle.get(title);
            if (!newIds || newIds.length === 0) continue; // 关键守卫：没产出就不动状态
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
                data: {
                  generatedCaseIds: JSON.stringify(merged),
                  status: 'generated',
                  ...(currentUserId && { updatedBy: currentUserId }),
                },
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
            failedChunks,
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
