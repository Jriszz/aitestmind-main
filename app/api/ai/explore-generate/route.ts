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

function sendSSE(controller: ReadableStreamDefaultController, message: StreamMessage) {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`));
}

export async function POST(request: NextRequest) {
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const { scenarios } = await request.json();

        const { getCurrentUser } = await import('@/lib/auth');
        const currentUser = await getCurrentUser(request);
        const currentUserId = currentUser?.user?.id ?? null;

        if (!Array.isArray(scenarios) || scenarios.length === 0) {
          sendSSE(controller, { type: 'error', content: '请至少选择一个场景' });
          controller.close();
          return;
        }

        // 用例名 → 来源指纹（服务端注入，AI 无需感知）
        const fingerprintByName: Record<string, string> = {};
        for (const s of scenarios) {
          if (s.title && s.fingerprint) fingerprintByName[s.title] = s.fingerprint;
        }

        const client = await loadAIClient();
        const systemPrompt = getSystemPrompt('api');

        // 全部已创建用例（跨批累计）
        const createdTestCases: any[] = [];

        // 跑单批场景：一个独立的 Function Calling 循环
        const runChunk = async (
          chunkScenarios: any[],
          chunkIdx: number,
          totalChunks: number
        ) => {
          const prefix = totalChunks > 1 ? `（第 ${chunkIdx + 1}/${totalChunks} 批）` : '';
          sendSSE(controller, {
            type: 'thinking',
            content: `正在按选定场景组装测试用例${prefix}...`,
          });

          const directive =
            '以下是已经审定的测试场景清单。请严格按此清单生成测试用例：\n' +
            '- 每个场景生成且仅生成一条测试用例，用例名称必须与场景 title 完全一致（用于来源追溯）。\n' +
            '- 用 get_api_detail 获取涉及接口的参数/响应结构，按场景 steps 与 rationale 组装。\n' +
            '- 会创建数据的正常场景用 smart_search_delete_api 加后置清理。\n' +
            '- 最后调用 assemble_and_create_test_cases 一次性创建。\n\n' +
            '场景清单：\n' +
            JSON.stringify(
              chunkScenarios.map((s: any) => ({
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
          const maxIterations = 15;

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
                  } else if (functionName === 'get_api_detail') {
                    functionResult = await getApiDetail(functionArgs.apiId);
                  } else if (functionName === 'smart_search_delete_api') {
                    functionResult = await smartSearchDeleteApi(functionArgs);
                  } else if (functionName === 'assemble_and_create_test_cases') {
                    functionResult = await assembleAndCreateTestCases({
                      ...functionArgs,
                      userId: currentUserId,
                      fingerprintByName, // 关键：注入来源指纹
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

        // 场景多时分批生成（每批 ≤CHUNK 个场景），避免一次喂太多 token 截断；进度连续
        const CHUNK = 8;
        const chunks: any[][] = [];
        for (let i = 0; i < scenarios.length; i += CHUNK) {
          chunks.push(scenarios.slice(i, i + CHUNK));
        }
        for (let i = 0; i < chunks.length; i++) {
          await runChunk(chunks[i], i, chunks.length);
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
