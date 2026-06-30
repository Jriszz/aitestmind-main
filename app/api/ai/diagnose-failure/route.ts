import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { loadAIClient, type AIMessage } from '@/lib/ai-client';
import { DIAGNOSE_SYSTEM_PROMPT, DIAGNOSE_CATEGORIES, type DiagnoseCategory } from '@/lib/ai-prompts/diagnose-prompt';
import { getApiDetail } from '@/lib/ai-tools';

export const dynamic = 'force-dynamic';

/**
 * AI 失败归因路由（SSE）
 * POST /api/ai/diagnose-failure
 *   body: { caseExecutionId: string }
 *
 * 设计要点：
 *   1. 拉执行快照 + 关联接口当前真相 → 喂 AI → 返回结构化归因
 *   2. category 必须落在 DIAGNOSE_CATEGORIES 枚举上（服务端强校验）
 *   3. 直接落 TestCaseFeedback，status = "open"（待人工评审）
 *   4. 评审通过 → "acknowledged" → 才会被 query_api_feedback 返回给生成端
 */

type StreamMessage = { type: string; content: string; data?: any };

function sendSSE(controller: ReadableStreamDefaultController, message: StreamMessage) {
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`));
}

// submit_diagnosis 工具定义（AI 用这个提交归因结论）
const SUBMIT_DIAGNOSIS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'submit_diagnosis',
    description: '提交失败归因结论（仅调用一次）',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: DIAGNOSE_CATEGORIES,
          description: '根因分类，必须从枚举中选一个',
        },
        targetField: {
          type: 'string',
          description: '涉及的字段路径，如 response.returnCode / body.adjustmentType（可空）',
        },
        summary: {
          type: 'string',
          description: '一句话归因，≤50 字，给评审人 1 秒看懂',
        },
        detail: {
          type: 'string',
          description: '详细推理：用例怎么写的 → 接口实际怎么响应 → 为什么不匹配',
        },
        suggestion: {
          type: 'string',
          description: '未来生成类似用例时应该怎么写（可空）',
        },
      },
      required: ['category', 'summary', 'detail'],
    },
  },
};

// get_api_detail 工具（复用 ai-tools 里的接口详情查询）
const GET_API_DETAIL_TOOL = {
  type: 'function' as const,
  function: {
    name: 'get_api_detail',
    description: '查询接口的当前真相（path/字段/paramConstraints/businessSemantics），用于对比快照',
    parameters: {
      type: 'object',
      properties: {
        apiId: { type: 'string', description: '接口 ID' },
      },
      required: ['apiId'],
    },
  },
};

export async function POST(request: NextRequest) {
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const body = await request.json();
        const { caseExecutionId } = body;

        if (!caseExecutionId) {
          sendSSE(controller, { type: 'error', content: '缺少 caseExecutionId' });
          controller.close();
          return;
        }

        // 解析工作区 + 当前用户
        const { getCurrentUser, getCurrentWorkspace } = await import('@/lib/auth');
        const currentUser = await getCurrentUser(request);
        const currentUserId = currentUser?.user?.id ?? null;
        const ws = await getCurrentWorkspace(request);
        if (!ws) {
          sendSSE(controller, { type: 'error', content: '未登录或无可用工作区' });
          controller.close();
          return;
        }
        const workspaceId: string = ws.workspaceId;

        // 1. 拉执行详情（完整快照）
        const execution = await prisma.testCaseExecution.findUnique({
          where: { id: caseExecutionId },
          include: {
            stepExecutions: {
              orderBy: { order: 'asc' },
            },
          },
        });

        if (!execution) {
          sendSSE(controller, { type: 'error', content: '执行记录不存在' });
          controller.close();
          return;
        }

        if (execution.status !== 'failed') {
          sendSSE(controller, { type: 'error', content: '该用例未失败，无需归因' });
          controller.close();
          return;
        }

        // 2. 解析 testCaseSnapshot
        let testCaseSnapshot: any = {};
        try {
          testCaseSnapshot = JSON.parse(execution.testCaseSnapshot);
        } catch (e) {
          console.error('testCaseSnapshot 解析失败:', e);
        }

        // 3. 找到失败的步骤（第一个 failed 的）
        const failedStep = execution.stepExecutions.find((s) => s.status === 'failed');
        if (!failedStep) {
          sendSSE(controller, { type: 'error', content: '未找到失败步骤' });
          controller.close();
          return;
        }

        // 4. 解析失败步骤的 nodeSnapshot（拿 apiId）
        let nodeSnapshot: any = {};
        try {
          nodeSnapshot = JSON.parse(failedStep.nodeSnapshot);
        } catch (e) {
          console.error('nodeSnapshot 解析失败:', e);
        }

        const apiIdOfFailedStep = nodeSnapshot?.data?.apiId || failedStep.nodeSnapshot; // 兜底

        // 5. 构建证据快照（保存完整上下文，审计 + 未来接口变更也能追溯）
        const evidence = {
          caseExecutionId,
          testCaseId: execution.testCaseId,
          testCaseName: execution.testCaseName,
          failedStepNodeId: failedStep.nodeId,
          failedStepName: failedStep.nodeName,
          request: {
            url: failedStep.requestUrl,
            method: failedStep.requestMethod,
            headers: failedStep.requestHeaders,
            body: failedStep.requestBody,
            params: failedStep.requestParams,
          },
          response: {
            status: failedStep.responseStatus,
            headers: failedStep.responseHeaders,
            body: failedStep.responseBody,
            time: failedStep.responseTime,
          },
          assertionResults: failedStep.assertionResults,
          errorMessage: failedStep.errorMessage || execution.errorMessage,
        };

        // 6. 构建 user message（输入数据）
        const userMessage = `
## 执行详情

**用例名**：${execution.testCaseName}
**失败步骤**：${failedStep.nodeName} (nodeId: ${failedStep.nodeId})
**错误消息**：${evidence.errorMessage || '无'}

### 请求信息
- URL: ${failedStep.requestUrl}
- Method: ${failedStep.requestMethod}
- Body: ${failedStep.requestBody || '无'}
- Params: ${failedStep.requestParams || '无'}

### 响应信息
- Status: ${failedStep.responseStatus}
- Body: ${failedStep.responseBody || '无'}
- Time: ${failedStep.responseTime}ms

### 断言结果
${failedStep.assertionResults || '无断言'}

### 用例快照（节点配置）
\`\`\`json
${JSON.stringify(nodeSnapshot, null, 2)}
\`\`\`

---

**任务**：根据上述信息，判断根因，调用 get_api_detail 拿接口当前真相对比，然后调 submit_diagnosis 提交结论。
`.trim();

        // 7. 初始化 AI 对话
        const aiClient = await loadAIClient();
        const messages: AIMessage[] = [
          { role: 'system', content: DIAGNOSE_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ];

        const tools = [GET_API_DETAIL_TOOL, SUBMIT_DIAGNOSIS_TOOL];

        let diagnosis: any = null;
        let iteration = 0;
        const MAX_ITERATIONS = 5;

        sendSSE(controller, { type: 'thinking', content: '正在分析失败原因...' });

        // 8. Function Calling 循环
        while (iteration < MAX_ITERATIONS) {
          iteration++;

          const response = await aiClient.chat(messages, tools);

          // 推送 AI 思考过程（如果有）
          if (response.reasoningContent) {
            sendSSE(controller, { type: 'reasoning', content: response.reasoningContent });
          }

          // 推送 AI 文字内容（如果有）
          if (response.content) {
            sendSSE(controller, { type: 'content', content: response.content });
          }

          // 记录 assistant 消息
          messages.push({
            role: 'assistant',
            content: response.content,
            tool_calls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
          });

          // 如果没有工具调用，结束
          if (!response.toolCalls || response.toolCalls.length === 0) {
            sendSSE(controller, { type: 'error', content: 'AI 未调用工具，分析中断' });
            break;
          }

          // 处理工具调用
          for (const toolCall of response.toolCalls) {
            const toolName = toolCall.function.name;
            let argsObj: any = {};
            try {
              argsObj = JSON.parse(toolCall.function.arguments);
            } catch (e) {
              console.error('工具参数解析失败:', e);
            }

            let functionResult: any = null;

            // get_api_detail
            if (toolName === 'get_api_detail') {
              sendSSE(controller, { type: 'tool', content: `查询接口详情: ${argsObj.apiId}` });
              try {
                functionResult = await getApiDetail(argsObj.apiId, workspaceId);
              } catch (e: any) {
                functionResult = { error: e.message };
              }
            }

            // submit_diagnosis（终止条件）
            if (toolName === 'submit_diagnosis') {
              sendSSE(controller, { type: 'tool', content: '提交归因结论' });

              // 校验 category 枚举
              if (!DIAGNOSE_CATEGORIES.includes(argsObj.category as DiagnoseCategory)) {
                sendSSE(controller, {
                  type: 'error',
                  content: `非法 category: ${argsObj.category}，必须从 ${DIAGNOSE_CATEGORIES.join(', ')} 中选`,
                });
                controller.close();
                return;
              }

              diagnosis = {
                category: argsObj.category,
                targetField: argsObj.targetField || null,
                summary: argsObj.summary,
                detail: argsObj.detail,
                suggestion: argsObj.suggestion || null,
              };

              functionResult = { success: true, message: '归因已提交' };
              // 跳出工具循环，直接落库
              break;
            }

            // 回喂工具结果
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(functionResult),
            });
          }

          // 如果已经拿到 diagnosis，跳出迭代
          if (diagnosis) break;
        }

        // 9. 检查是否拿到结论
        if (!diagnosis) {
          sendSSE(controller, { type: 'error', content: 'AI 未能给出归因结论' });
          controller.close();
          return;
        }

        // 10. 落 TestCaseFeedback
        const feedback = await prisma.testCaseFeedback.create({
          data: {
            source: 'execution_failure',
            caseExecutionId,
            testCaseId: execution.testCaseId,
            apiId: apiIdOfFailedStep,
            stepNodeId: failedStep.nodeId,
            category: diagnosis.category,
            targetField: diagnosis.targetField,
            summary: diagnosis.summary,
            detail: diagnosis.detail,
            suggestion: diagnosis.suggestion,
            evidence: JSON.stringify(evidence),
            status: 'open', // 待人工评审
            workspaceId,
            createdBy: currentUserId,
          },
        });

        // 11. 推送最终结果
        sendSSE(controller, {
          type: 'diagnosis',
          content: '归因完成',
          data: {
            feedbackId: feedback.id,
            category: diagnosis.category,
            summary: diagnosis.summary,
            detail: diagnosis.detail,
            suggestion: diagnosis.suggestion,
          },
        });

        controller.close();
      } catch (error: any) {
        console.error('❌ diagnose-failure 失败:', error);
        sendSSE(controller, { type: 'error', content: error.message || '归因失败' });
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
