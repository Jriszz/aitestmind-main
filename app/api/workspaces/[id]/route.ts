import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCurrentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * 修改工作区
 * PATCH /api/workspaces/[id]
 * body: { name?, slug?, description? }
 * 不允许修改 isDefault
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getCurrentUser(request);
    if (!session) {
      return NextResponse.json({ success: false, error: '未登录' }, { status: 401 });
    }

    const { id } = await params;
    const body = await request.json();
    const { name, slug, description } = body;

    const existing = await prisma.workspace.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ success: false, error: '工作区不存在' }, { status: 404 });
    }

    const data: any = {};
    if (typeof name === 'string' && name.trim()) data.name = name.trim();
    if (typeof slug === 'string' && slug.trim()) {
      const finalSlug = slug
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9\-一-龥]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      if (!finalSlug) {
        return NextResponse.json(
          { success: false, error: 'slug 不合法' },
          { status: 400 }
        );
      }
      data.slug = finalSlug;
    }
    if (typeof description === 'string') data.description = description || null;

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { success: false, error: '没有可更新的字段' },
        { status: 400 }
      );
    }

    const workspace = await prisma.workspace.update({ where: { id }, data });
    return NextResponse.json({ success: true, workspace });
  } catch (error: any) {
    console.error('更新工作区失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '更新失败' },
      { status: 500 }
    );
  }
}

/**
 * 删除工作区
 * DELETE /api/workspaces/[id][?force=true]
 * - isDefault=true 一律 403
 * - 含资产且未带 force=true → 409 + counts
 * - force=true：事务里把所有资产的 workspaceId 置 null，再删工作区
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getCurrentUser(request);
    if (!session) {
      return NextResponse.json({ success: false, error: '未登录' }, { status: 401 });
    }

    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const force = searchParams.get('force') === 'true';

    const existing = await prisma.workspace.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ success: false, error: '工作区不存在' }, { status: 404 });
    }
    if (existing.isDefault) {
      return NextResponse.json(
        { success: false, error: '默认工作区不可删除' },
        { status: 403 }
      );
    }

    // 统计资产数量
    const [apiCount, testCaseCount, testSuiteCount, funcCaseCount, conversationCount] =
      await Promise.all([
        prisma.api.count({ where: { workspaceId: id } }),
        prisma.testCase.count({ where: { workspaceId: id } }),
        prisma.testSuite.count({ where: { workspaceId: id } }),
        (prisma as any).interfaceFunctionalCase.count({ where: { workspaceId: id } }),
        prisma.conversation.count({ where: { workspaceId: id } }),
      ]);

    const total = apiCount + testCaseCount + testSuiteCount + funcCaseCount + conversationCount;
    const counts = {
      apis: apiCount,
      testCases: testCaseCount,
      testSuites: testSuiteCount,
      interfaceFunctionalCases: funcCaseCount,
      conversations: conversationCount,
    };

    if (total > 0 && !force) {
      return NextResponse.json(
        {
          success: false,
          error: '工作区下还有资产，请确认后强制删除',
          counts,
        },
        { status: 409 }
      );
    }

    await prisma.$transaction(async (tx) => {
      if (total > 0) {
        await tx.api.updateMany({ where: { workspaceId: id }, data: { workspaceId: null } });
        await tx.testCase.updateMany({ where: { workspaceId: id }, data: { workspaceId: null } });
        await tx.testSuite.updateMany({ where: { workspaceId: id }, data: { workspaceId: null } });
        await (tx as any).interfaceFunctionalCase.updateMany({
          where: { workspaceId: id },
          data: { workspaceId: null },
        });
        await tx.conversation.updateMany({
          where: { workspaceId: id },
          data: { workspaceId: null },
        });
      }
      // SwaggerSource 是 workspace 必填关系（onDelete: Cascade）——不能 SetNull，
      // 必须显式 deleteMany 才能在删除工作区前清空（资产管理总线 Step 2）
      await tx.swaggerSource.deleteMany({ where: { workspaceId: id } });
      // 用户 currentWorkspaceId 指向该工作区的也清空（onDelete: SetNull 会处理，这里显式）
      await tx.user.updateMany({
        where: { currentWorkspaceId: id },
        data: { currentWorkspaceId: null },
      });
      await tx.workspace.delete({ where: { id } });
    });

    return NextResponse.json({ success: true, deleted: counts });
  } catch (error: any) {
    console.error('删除工作区失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '删除失败' },
      { status: 500 }
    );
  }
}
