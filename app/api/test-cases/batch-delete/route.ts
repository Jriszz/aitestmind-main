import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logger, OperationType } from '@/lib/logger';
import { getCurrentWorkspace } from '@/lib/auth';

// POST /api/test-cases/batch-delete - 批量删除测试用例
export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    // 资产管理总线 Step 1：批量删除限定当前工作区
    const ws = await getCurrentWorkspace(request);
    if (!ws) {
      return NextResponse.json({ success: false, error: '未登录或无可用工作区' }, { status: 401 });
    }

    const body = await request.json();
    const { ids } = body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid request: ids must be a non-empty array',
        },
        { status: 400 }
      );
    }

    // 记录请求
    logger.apiRequest('POST', '/api/test-cases/batch-delete', OperationType.DELETE, { count: ids.length });

    // 工作区收敛：先按 workspace 收敛 id 列表，避免越权删除别工作区数据
    const allowed = await prisma.testCase.findMany({
      where: { id: { in: ids }, workspaceId: ws.workspaceId },
      select: { id: true },
    });
    const allowedIds = allowed.map((r) => r.id);

    if (allowedIds.length === 0) {
      return NextResponse.json({ success: true, data: { deletedCount: 0 } });
    }

    // 首先删除所有相关的步骤
    logger.db(OperationType.DELETE, 'TestStep', 'deleteMany', { testCaseIds: allowedIds });
    await prisma.testStep.deleteMany({
      where: {
        testCaseId: {
          in: allowedIds,
        },
      },
    });

    // 然后删除测试用例
    logger.db(OperationType.DELETE, 'TestCase', 'deleteMany', { ids: allowedIds });
    const result = await prisma.testCase.deleteMany({
      where: {
        id: {
          in: allowedIds,
        },
      },
    });

    const duration = Date.now() - startTime;
    logger.apiResponse('POST', '/api/test-cases/batch-delete', OperationType.DELETE, 200, duration);
    logger.success(OperationType.DELETE, `批量删除 ${result.count} 个测试用例`);

    return NextResponse.json({
      success: true,
      data: {
        deletedCount: result.count,
      },
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.apiResponse('POST', '/api/test-cases/batch-delete', OperationType.DELETE, 500, duration);
    logger.error(OperationType.DELETE, '批量删除测试用例失败', error as Error);
    
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to batch delete test cases',
      },
      { status: 500 }
    );
  }
}

