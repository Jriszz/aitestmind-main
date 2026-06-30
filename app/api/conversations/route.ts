import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

// 获取对话列表（仅当前用户的对话）
export async function GET(request: NextRequest) {
  try {
    const { getCurrentUser, getCurrentWorkspace } = await import('@/lib/auth');
    const currentUser = await getCurrentUser(request);
    const userId = currentUser?.user?.id ?? null;
    // 资产管理总线 Step 1：对话也按工作区收敛（同一用户在不同工作区下的对话彼此隔离）
    const ws = await getCurrentWorkspace(request);

    const { searchParams } = new URL(request.url);
    const isArchived = searchParams.get('archived') === 'true';
    const isStarred = searchParams.get('starred') === 'true';

    // 仅返回当前用户在当前工作区创建的对话；未登录则返回空列表
    const where: any = {
      ...(userId && { createdBy: userId }),
      ...(ws && { workspaceId: ws.workspaceId }),
      ...(searchParams.has('archived') && { isArchived }),
      ...(searchParams.has('starred') && { isStarred }),
    };
    if (!userId || !ws) {
      // 未登录或无工作区时不返回任何对话
      return NextResponse.json({
        success: true,
        data: [],
      });
    }

    const conversations = await prisma.conversation.findMany({
      where,
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 1, // 只取第一条消息用于预览
        },
        _count: {
          select: { messages: true },
        },
        createdByUser: { select: { id: true, loginName: true } },
        updatedByUser: { select: { id: true, loginName: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return NextResponse.json({
      success: true,
      data: conversations,
    });
  } catch (error: any) {
    console.error('获取对话列表失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '获取对话列表失败' },
      { status: 500 }
    );
  }
}

// 创建新对话
export async function POST(request: NextRequest) {
  try {
    const { getCurrentUser, getCurrentWorkspace } = await import('@/lib/auth');
    const currentUser = await getCurrentUser(request);
    const userId = currentUser?.user?.id ?? null;
    // 资产管理总线 Step 1：归属当前工作区
    const ws = await getCurrentWorkspace(request);
    if (!ws) {
      return NextResponse.json({ success: false, error: '未登录或无可用工作区' }, { status: 401 });
    }

    const body = await request.json();
    const { title, message } = body;

    // 创建对话
    const conversation = await prisma.conversation.create({
      data: {
        title: title || '新对话',
        workspaceId: ws.workspaceId,
        ...(userId && { createdBy: userId, updatedBy: userId }),
        messages: {
          create: message
            ? [
                {
                  role: message.role || 'user',
                  content: message.content,
                },
              ]
            : [],
        },
      },
      include: {
        messages: true,
      },
    });

    return NextResponse.json({
      success: true,
      data: conversation,
    });
  } catch (error: any) {
    console.error('创建对话失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '创建对话失败' },
      { status: 500 }
    );
  }
}

