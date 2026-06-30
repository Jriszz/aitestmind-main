import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCurrentUser, getCurrentWorkspace } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * 工作区列表（含每个工作区的资产数量）
 * GET /api/workspaces
 * 响应附带 currentWorkspaceId 供切换器使用
 */
export async function GET(request: NextRequest) {
  try {
    const ws = await getCurrentWorkspace(request);
    if (!ws) {
      return NextResponse.json(
        { success: false, error: '未登录或无可用工作区' },
        { status: 401 }
      );
    }

    const workspaces = await prisma.workspace.findMany({
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      include: {
        _count: {
          select: {
            apis: true,
            testCases: true,
            testSuites: true,
            interfaceFunctionalCases: true,
            conversations: true,
          },
        },
      },
    });

    return NextResponse.json({
      success: true,
      workspaces,
      currentWorkspaceId: ws.workspaceId,
    });
  } catch (error: any) {
    console.error('查询工作区失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '查询失败' },
      { status: 500 }
    );
  }
}

/**
 * 创建工作区
 * POST /api/workspaces
 * body: { name, slug?, description? }
 * 注意：isDefault 仅由回填脚本设置，CRUD 路由不允许设置
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getCurrentUser(request);
    if (!session) {
      return NextResponse.json({ success: false, error: '未登录' }, { status: 401 });
    }

    const body = await request.json();
    const { name, slug, description } = body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json(
        { success: false, error: '工作区名称不能为空' },
        { status: 400 }
      );
    }

    // slug 自动生成：小写、空格转横线、去除特殊字符
    const finalSlug = (slug || name)
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9\-一-龥]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (!finalSlug) {
      return NextResponse.json(
        { success: false, error: 'slug 无法从名称生成，请显式指定' },
        { status: 400 }
      );
    }

    // 显式查重，避免 P2002 错误难以理解
    const [nameExists, slugExists] = await Promise.all([
      prisma.workspace.findUnique({ where: { name: name.trim() } }),
      prisma.workspace.findUnique({ where: { slug: finalSlug } }),
    ]);
    if (nameExists) {
      return NextResponse.json(
        { success: false, error: `工作区名称 "${name}" 已存在` },
        { status: 409 }
      );
    }
    if (slugExists) {
      return NextResponse.json(
        { success: false, error: `slug "${finalSlug}" 已存在` },
        { status: 409 }
      );
    }

    const workspace = await prisma.workspace.create({
      data: {
        name: name.trim(),
        slug: finalSlug,
        description: description || null,
        // isDefault 永远不通过 CRUD 设置，保持系统唯一默认
      },
    });

    return NextResponse.json({ success: true, workspace });
  } catch (error: any) {
    console.error('创建工作区失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '创建失败' },
      { status: 500 }
    );
  }
}
