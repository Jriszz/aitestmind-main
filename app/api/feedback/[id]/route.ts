import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCurrentUser, getCurrentWorkspace } from '@/lib/auth';

const ALLOWED_STATUS = ['open', 'acknowledged', 'fixed', 'wontfix'] as const;

// PATCH /api/feedback/[id] - 状态切换（评审通过/打回/标记修复）
// 注意：Next.js 15+ 的动态路由 params 是 Promise，必须 await
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const ws = await getCurrentWorkspace(request);
    if (!ws) {
      return NextResponse.json({ success: false, error: '未登录或无可用工作区' }, { status: 401 });
    }
    const currentUser = await getCurrentUser(request);
    const currentUserId = currentUser?.user?.id ?? null;

    const body = await request.json();
    const { status, suggestion } = body;

    if (status && !ALLOWED_STATUS.includes(status)) {
      return NextResponse.json(
        { success: false, error: `非法 status，必须是 ${ALLOWED_STATUS.join(', ')} 之一` },
        { status: 400 }
      );
    }

    // 工作区收敛：只能改自己工作区的反馈
    const existing = await prisma.testCaseFeedback.findFirst({
      where: { id, workspaceId: ws.workspaceId },
    });
    if (!existing) {
      return NextResponse.json({ success: false, error: '反馈不存在或无权限' }, { status: 404 });
    }

    const updateData: any = {};
    if (status) {
      updateData.status = status;
      // 从 open → 任何终态时记录处理人 + 时间
      if (status !== 'open' && existing.status === 'open') {
        updateData.resolvedBy = currentUserId;
        updateData.resolvedAt = new Date();
      }
    }
    if (suggestion !== undefined) {
      updateData.suggestion = suggestion;
    }

    const updated = await prisma.testCaseFeedback.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (error: any) {
    console.error('PATCH /api/feedback/[id] failed:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// DELETE /api/feedback/[id] - 删除（误报清理）
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const ws = await getCurrentWorkspace(request);
    if (!ws) {
      return NextResponse.json({ success: false, error: '未登录或无可用工作区' }, { status: 401 });
    }

    const existing = await prisma.testCaseFeedback.findFirst({
      where: { id, workspaceId: ws.workspaceId },
    });
    if (!existing) {
      return NextResponse.json({ success: false, error: '反馈不存在或无权限' }, { status: 404 });
    }

    await prisma.testCaseFeedback.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('DELETE /api/feedback/[id] failed:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
