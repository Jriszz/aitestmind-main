import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCurrentUser, getCurrentWorkspace } from '@/lib/auth';
import { DIAGNOSE_CATEGORIES } from '@/lib/ai-prompts/diagnose-prompt';

/**
 * 反馈 CRUD 路由
 *   GET  /api/feedback           列表（按状态/category/apiId 筛选）
 *   POST /api/feedback           创建（用户主动吐槽 或 step-level 快反馈）
 *
 * 详细的「状态切换」走 /api/feedback/[id] 的 PATCH
 */

const ALLOWED_STATUS = ['open', 'acknowledged', 'fixed', 'wontfix'] as const;
const ALLOWED_SOURCE = ['execution_failure', 'user_edit', 'ai_self_critic', 'user_comment'] as const;

// GET /api/feedback - 列表
export async function GET(request: NextRequest) {
  try {
    const ws = await getCurrentWorkspace(request);
    if (!ws) {
      return NextResponse.json({ success: false, error: '未登录或无可用工作区' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status'); // 不传 = 全部
    const category = searchParams.get('category');
    const apiId = searchParams.get('apiId');
    const testCaseId = searchParams.get('testCaseId');
    const stepNodeId = searchParams.get('stepNodeId');
    const source = searchParams.get('source');
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = Math.min(parseInt(searchParams.get('pageSize') || '20'), 100);

    const where: any = {
      workspaceId: ws.workspaceId,
    };
    if (status && ALLOWED_STATUS.includes(status as any)) where.status = status;
    if (category && DIAGNOSE_CATEGORIES.includes(category as any)) where.category = category;
    if (apiId) where.apiId = apiId;
    if (testCaseId) where.testCaseId = testCaseId;
    if (stepNodeId) where.stepNodeId = stepNodeId;
    if (source && ALLOWED_SOURCE.includes(source as any)) where.source = source;

    const [total, items] = await Promise.all([
      prisma.testCaseFeedback.count({ where }),
      prisma.testCaseFeedback.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    // 富化：关联 testCase 名 + api 名（懒查，省 join 复杂度）
    const testCaseIds = Array.from(new Set(items.map((i) => i.testCaseId).filter(Boolean) as string[]));
    const apiIds = Array.from(new Set(items.map((i) => i.apiId).filter(Boolean) as string[]));
    const [tcs, apis] = await Promise.all([
      testCaseIds.length
        ? prisma.testCase.findMany({
            where: { id: { in: testCaseIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      apiIds.length
        ? prisma.api.findMany({
            where: { id: { in: apiIds } },
            select: { id: true, name: true, method: true, path: true },
          })
        : Promise.resolve([]),
    ]);
    const tcMap = new Map(tcs.map((t) => [t.id, t]));
    const apiMap = new Map(apis.map((a) => [a.id, a]));

    const enriched = items.map((i) => ({
      ...i,
      testCase: i.testCaseId ? tcMap.get(i.testCaseId) ?? null : null,
      api: i.apiId ? apiMap.get(i.apiId) ?? null : null,
    }));

    return NextResponse.json({
      success: true,
      data: { items: enriched, total, page, pageSize },
    });
  } catch (error: any) {
    console.error('GET /api/feedback failed:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// POST /api/feedback - 创建（用户主动吐槽 / 断言旁的快反馈）
export async function POST(request: NextRequest) {
  try {
    const ws = await getCurrentWorkspace(request);
    if (!ws) {
      return NextResponse.json({ success: false, error: '未登录或无可用工作区' }, { status: 401 });
    }
    const currentUser = await getCurrentUser(request);
    const currentUserId = currentUser?.user?.id ?? null;

    const body = await request.json();
    const {
      source = 'user_comment',
      caseExecutionId,
      testCaseId,
      apiId,
      stepNodeId,
      category,
      targetField,
      summary,
      detail,
      suggestion,
      evidence,
    } = body;

    // 必填校验
    if (!summary || typeof summary !== 'string') {
      return NextResponse.json({ success: false, error: 'summary 必填' }, { status: 400 });
    }
    if (!DIAGNOSE_CATEGORIES.includes(category)) {
      return NextResponse.json(
        { success: false, error: `非法 category，必须是 ${DIAGNOSE_CATEGORIES.join(', ')} 之一` },
        { status: 400 }
      );
    }
    if (!ALLOWED_SOURCE.includes(source)) {
      return NextResponse.json({ success: false, error: '非法 source' }, { status: 400 });
    }

    const feedback = await prisma.testCaseFeedback.create({
      data: {
        source,
        caseExecutionId: caseExecutionId || null,
        testCaseId: testCaseId || null,
        apiId: apiId || null,
        stepNodeId: stepNodeId || null,
        category,
        targetField: targetField || null,
        summary,
        detail: detail || null,
        suggestion: suggestion || null,
        evidence: evidence ? (typeof evidence === 'string' ? evidence : JSON.stringify(evidence)) : null,
        status: 'open',
        workspaceId: ws.workspaceId,
        createdBy: currentUserId,
      },
    });

    return NextResponse.json({ success: true, data: feedback });
  } catch (error: any) {
    console.error('POST /api/feedback failed:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
