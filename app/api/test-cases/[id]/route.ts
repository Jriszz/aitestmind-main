import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCurrentUser, getCurrentWorkspace } from '@/lib/auth';
import { safeJsonParse, safeJsonStringify } from '@/lib/json-utils';
import { logger, OperationType } from '@/lib/logger';
import { normalizeAndValidateTags } from '@/lib/tag-validator';

const ALLOWED_PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3'] as const);
function normalizePriority(input: any): 'P0' | 'P1' | 'P2' | 'P3' {
  if (input == null || input === '') {
    return 'P2';
  }
  if (typeof input !== 'string' || !ALLOWED_PRIORITIES.has(input as any)) {
    throw new Error(`Invalid priority: ${String(input)}`);
  }
  return input as any;
}

// 已移至 lib/tag-validator.ts（决策 11：标签枚举校验）

// 清理节点中的执行结果（后端保护层）
function cleanExecutionFromFlowConfig(flowConfig: any): any {
  if (!flowConfig || !flowConfig.nodes) {
    return flowConfig;
  }
  
  return {
    ...flowConfig,
    nodes: flowConfig.nodes.map((node: any) => {
      if (node.data && 'execution' in node.data) {
        const { execution, ...cleanData } = node.data;
        return { ...node, data: cleanData };
      }
      return node;
    }),
  };
}

// 清理步骤配置中的执行结果
function cleanExecutionFromConfig(config: any): any {
  if (!config) {
    return config;
  }
  
  if ('execution' in config) {
    const { execution, ...cleanConfig } = config;
    return cleanConfig;
  }
  
  return config;
}

/**
 * 启发式检测用户编辑了什么（user_edit 反馈自动采集）
 *
 * 对比新旧 flowConfig 的关键字段，推断 category：
 *   - assertions 变了 → assertion_wrong
 *   - params 变了 → param_constraint_missed
 *   - variableRefs 变了 → wrong_variable_ref
 *   - 节点增删 → other
 *
 * 只捕获"AI 生成的用例被用户改了"这个信号。
 * 不保证 100% 准确（毕竟只是启发式），人工评审时筛选。
 */
function detectUserEditDiff(oldFlow: any, newFlow: any): {
  category: string;
  summary: string;
  detail?: string;
  apiId?: string;
  stepNodeId?: string;
  targetField?: string;
} | null {
  if (!oldFlow?.nodes || !newFlow?.nodes) return null;

  // 构建节点映射（按 id）
  const oldNodes = new Map(oldFlow.nodes.map((n: any) => [n.id, n]));
  const newNodes = new Map(newFlow.nodes.map((n: any) => [n.id, n]));

  // 1. 检查节点增删（粗粒度，category=other）
  if (oldNodes.size !== newNodes.size) {
    return {
      category: 'other',
      summary: `用户修改了节点数量（${oldNodes.size} → ${newNodes.size}）`,
      detail: '节点增删可能涉及流程调整，需人工确认',
    };
  }

  // 2. 逐节点对比关键字段
  for (const [nodeId, newNode] of newNodes) {
    const oldNode = oldNodes.get(nodeId);
    if (!oldNode) continue; // 新增节点已在上面捕获

    const oldData = oldNode.data || {};
    const newData = newNode.data || {};

    // 2.1 断言变化
    const oldAssertions = JSON.stringify(oldData.assertions || []);
    const newAssertions = JSON.stringify(newData.assertions || []);
    if (oldAssertions !== newAssertions) {
      return {
        category: 'assertion_wrong',
        summary: `用户修改了节点「${newData.label || nodeId}」的断言`,
        detail: `旧断言: ${oldAssertions.slice(0, 200)}\n新断言: ${newAssertions.slice(0, 200)}`,
        apiId: newData.apiId,
        stepNodeId: nodeId,
        targetField: 'assertions',
      };
    }

    // 2.2 参数变化（params）
    const oldParams = JSON.stringify(oldData.params || {});
    const newParams = JSON.stringify(newData.params || {});
    if (oldParams !== newParams) {
      return {
        category: 'param_constraint_missed',
        summary: `用户修改了节点「${newData.label || nodeId}」的参数`,
        detail: `旧参数: ${oldParams.slice(0, 200)}\n新参数: ${newParams.slice(0, 200)}`,
        apiId: newData.apiId,
        stepNodeId: nodeId,
      };
    }

    // 2.3 变量引用变化
    const oldVarRefs = JSON.stringify(oldData.variableRefs || []);
    const newVarRefs = JSON.stringify(newData.variableRefs || []);
    if (oldVarRefs !== newVarRefs) {
      return {
        category: 'wrong_variable_ref',
        summary: `用户修改了节点「${newData.label || nodeId}」的变量引用`,
        detail: `旧引用: ${oldVarRefs.slice(0, 200)}\n新引用: ${newVarRefs.slice(0, 200)}`,
        apiId: newData.apiId,
        stepNodeId: nodeId,
      };
    }
  }

  // 没检测到关键字段变化（可能只改了描述/位置等非关键字段）
  return null;
}

// GET /api/test-cases/[id] - 获取单个测试用例
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const startTime = Date.now();
  const { id } = await params;
  
  try {
    logger.apiRequest('GET', `/api/test-cases/${id}`, OperationType.READ, { id });
    // 资产管理总线 Step 1：跨工作区直接 404
    const ws = await getCurrentWorkspace(request);
    if (!ws) {
      return NextResponse.json({ success: false, error: '未登录或无可用工作区' }, { status: 401 });
    }
    logger.db(OperationType.READ, 'TestCase', 'findFirst', { id, workspaceId: ws.workspaceId });

    const testCase = await prisma.testCase.findFirst({
      where: { id, workspaceId: ws.workspaceId },
      include: {
        steps: {
          orderBy: {
            order: 'asc',
          },
        },
        createdByUser: { select: { id: true, loginName: true } },
        updatedByUser: { select: { id: true, loginName: true } },
      },
    });

    if (!testCase) {
      const duration = Date.now() - startTime;
      logger.apiResponse('GET', `/api/test-cases/${id}`, OperationType.READ, 404, duration);
      logger.warn(OperationType.READ, `测试用例不存在: ${id}`);
      
      return NextResponse.json(
        {
          success: false,
          error: 'Test case not found',
        },
        { status: 404 }
      );
    }

    // 解析 JSON 字符串字段（数据库中是 TEXT 类型）
    const parsedTestCase = {
      ...testCase,
      flowConfig: safeJsonParse(testCase.flowConfig),
      tags: safeJsonParse(testCase.tags),
      steps: testCase.steps.map((step: any) => ({
        ...step,
        config: safeJsonParse(step.config),
      })),
    };

    const duration = Date.now() - startTime;
    logger.apiResponse('GET', `/api/test-cases/${id}`, OperationType.READ, 200, duration);
    logger.success(OperationType.READ, `获取测试用例详情: ${testCase.name}`, {
      stepsCount: testCase.steps.length
    });

    return NextResponse.json({
      success: true,
      data: parsedTestCase,
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.apiResponse('GET', `/api/test-cases/${id}`, OperationType.READ, 500, duration);
    logger.error(OperationType.READ, '获取测试用例详情失败', error as Error);
    
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch test case',
      },
      { status: 500 }
    );
  }
}

// PUT /api/test-cases/[id] - 更新测试用例
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const startTime = Date.now();
  const { id } = await params;
  
  try {
    const currentUser = await getCurrentUser(request);
    const userId = currentUser?.user?.id ?? null;
    // 资产管理总线 Step 1：跨工作区直接 404
    const ws = await getCurrentWorkspace(request);
    if (!ws) {
      return NextResponse.json({ success: false, error: '未登录或无可用工作区' }, { status: 401 });
    }

    const body = await request.json();
    delete body.workspaceId; // 不允许客户端跨工作区移动
    const { name, description, status, category, tags, priority, flowConfig, steps } = body;

    logger.apiRequest('PUT', `/api/test-cases/${id}`, OperationType.UPDATE, {
      name,
      status,
      stepsCount: steps?.length
    });

    // 先读取当前用例，避免前端未传 priority 时被默认覆盖成 P2
    // 工作区收敛：跨工作区资源视为不存在
    logger.db(OperationType.READ, 'TestCase', 'findFirst', { id, workspaceId: ws.workspaceId });
    const existingTestCase = await prisma.testCase.findFirst({
      where: { id, workspaceId: ws.workspaceId },
      select: {
        priority: true,
        flowConfig: true,
        sourceFingerprint: true,
        sourceFunctionalCaseId: true,
      },
    });

    if (!existingTestCase) {
      return NextResponse.json(
        {
          success: false,
          error: 'Test case not found',
        },
        { status: 404 }
      );
    }

    // 清理 flowConfig 中的执行结果（后端保护层）
    const cleanedFlowConfig = cleanExecutionFromFlowConfig(flowConfig);

    // 标签枚举校验（决策 11）
    const tagResult = normalizeAndValidateTags(tags, status);
    if (tagResult.error) {
      return NextResponse.json(
        { success: false, error: `标签校验失败: ${tagResult.error}` },
        { status: 400 }
      );
    }
    const normalizedPriority =
      priority == null || priority === ''
        ? existingTestCase.priority
        : normalizePriority(priority);

    // 使用事务确保删除和更新操作的原子性
    logger.db(OperationType.UPDATE, 'TestCase', 'transaction', { id, name, stepsCount: steps?.length });
    const testCase = await prisma.$transaction(async (tx) => {
      // 删除旧的步骤
      logger.db(OperationType.DELETE, 'TestStep', 'deleteMany', { testCaseId: id });
      await tx.testStep.deleteMany({
        where: { testCaseId: id },
      });

      // 更新测试用例和创建新的步骤
      return await tx.testCase.update({
        where: { id },
        data: {
          name,
          description,
          status,
          priority: normalizedPriority,
          category: category || null,
          tags: safeJsonStringify(tagResult.tags),
          flowConfig: safeJsonStringify(cleanedFlowConfig),
          ...(userId && { updatedBy: userId }),
          steps: {
            create: steps?.map((step: any, index: number) => ({
              name: step.name,
              description: step.description,
              order: step.order ?? index,
              nodeId: step.nodeId,
              apiId: step.apiId,
              type: step.type || 'api',
              config: safeJsonStringify(cleanExecutionFromConfig(step.config)),
              positionX: step.positionX || 0,
              positionY: step.positionY || 0,
            })) || [],
          },
        },
        include: {
          steps: {
            orderBy: {
              order: 'asc',
            },
          },
        },
      });
    });

    // ============== AI 反馈闭环：user_edit 自动反馈 ==============
    // 仅对 AI 生成的用例（有 sourceFingerprint 或 sourceFunctionalCaseId）触发
    // 启发式推断：对比新旧 flowConfig 的关键字段差异，按 diff 类型打 category
    // 不打扰用户、不阻塞主流程，失败不影响保存
    try {
      const isAiGenerated = !!(existingTestCase.sourceFingerprint || existingTestCase.sourceFunctionalCaseId);
      if (isAiGenerated && existingTestCase.flowConfig) {
        const oldFlow = safeJsonParse(existingTestCase.flowConfig);
        const editDiff = detectUserEditDiff(oldFlow, cleanedFlowConfig);
        if (editDiff) {
          await (prisma as any).testCaseFeedback.create({
            data: {
              source: 'user_edit',
              testCaseId: id,
              apiId: editDiff.apiId || null,
              stepNodeId: editDiff.stepNodeId || null,
              category: editDiff.category,
              targetField: editDiff.targetField || null,
              summary: editDiff.summary,
              detail: editDiff.detail || null,
              status: 'open', // 不打扰用户，静默攒料；等评审
              workspaceId: ws.workspaceId,
              createdBy: userId,
            },
          });
          logger.info('user_edit feedback recorded', { testCaseId: id, category: editDiff.category });
        }
      }
    } catch (feedbackErr: any) {
      // 反馈失败不影响用例保存主流程
      console.warn('user_edit feedback failed:', feedbackErr?.message);
    }

    const duration = Date.now() - startTime;
    logger.apiResponse('PUT', `/api/test-cases/${id}`, OperationType.UPDATE, 200, duration);
    logger.success(OperationType.UPDATE, `更新测试用例成功: ${testCase.name}`, {
      stepsCount: testCase.steps.length
    });

    return NextResponse.json({
      success: true,
      data: testCase,
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.apiResponse('PUT', `/api/test-cases/${id}`, OperationType.UPDATE, 500, duration);
    logger.error(OperationType.UPDATE, '更新测试用例失败', error as Error);
    
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to update test case',
      },
      { status: 500 }
    );
  }
}

// DELETE /api/test-cases/[id] - 删除测试用例
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const startTime = Date.now();
  const { id } = await params;
  
  try {
    logger.apiRequest('DELETE', `/api/test-cases/${id}`, OperationType.DELETE, { id });
    // 资产管理总线 Step 1：跨工作区直接 404
    const ws = await getCurrentWorkspace(request);
    if (!ws) {
      return NextResponse.json({ success: false, error: '未登录或无可用工作区' }, { status: 401 });
    }
    const existingCase = await prisma.testCase.findFirst({
      where: { id, workspaceId: ws.workspaceId },
      select: { id: true },
    });
    if (!existingCase) {
      return NextResponse.json({ success: false, error: 'Test case not found' }, { status: 404 });
    }
    logger.db(OperationType.DELETE, 'TestCase', 'delete', { id });

    await prisma.testCase.delete({
      where: { id },
    });

    const duration = Date.now() - startTime;
    logger.apiResponse('DELETE', `/api/test-cases/${id}`, OperationType.DELETE, 200, duration);
    logger.success(OperationType.DELETE, `删除测试用例成功: ${id}`);

    return NextResponse.json({
      success: true,
      message: 'Test case deleted successfully',
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.apiResponse('DELETE', `/api/test-cases/${id}`, OperationType.DELETE, 500, duration);
    logger.error(OperationType.DELETE, '删除测试用例失败', error as Error);
    
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to delete test case',
      },
      { status: 500 }
    );
  }
}
