import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCurrentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * 切换当前工作区
 * POST /api/workspaces/switch
 * body: { workspaceId }
 * 写入到 User.currentWorkspaceId，下一次请求 getCurrentWorkspace 即读取此值
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getCurrentUser(request);
    if (!session) {
      return NextResponse.json({ success: false, error: '未登录' }, { status: 401 });
    }

    const { workspaceId } = await request.json();
    if (!workspaceId || typeof workspaceId !== 'string') {
      return NextResponse.json(
        { success: false, error: 'workspaceId 不能为空' },
        { status: 400 }
      );
    }

    const target = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, name: true, slug: true },
    });
    if (!target) {
      return NextResponse.json(
        { success: false, error: '目标工作区不存在' },
        { status: 404 }
      );
    }

    await prisma.user.update({
      where: { id: session.user.id },
      data: { currentWorkspaceId: target.id },
    });

    return NextResponse.json({ success: true, workspace: target });
  } catch (error: any) {
    console.error('切换工作区失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '切换失败' },
      { status: 500 }
    );
  }
}
