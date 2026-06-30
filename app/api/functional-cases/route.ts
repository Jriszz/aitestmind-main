import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCurrentUser, getCurrentWorkspace } from '@/lib/auth';
import { caseToData, rowToCase } from '@/lib/functional-case-utils';
import type { FunctionalCase } from '@/types/functional-case';

export const dynamic = 'force-dynamic';

// GET /api/functional-cases - 列表（支持 status / module 过滤）
export async function GET(request: NextRequest) {
  try {
    // 资产管理总线 Step 1
    const ws = await getCurrentWorkspace(request);
    if (!ws) {
      return NextResponse.json({ success: false, error: '未登录或无可用工作区' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const module = searchParams.get('module');

    const where: any = { workspaceId: ws.workspaceId };
    if (status) where.status = status;
    if (module) where.module = module;

    const rows = await (prisma as any).interfaceFunctionalCase.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });

    return NextResponse.json({ success: true, data: rows.map(rowToCase) });
  } catch (error: any) {
    console.error('获取接口功能用例失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '获取失败' },
      { status: 500 }
    );
  }
}

// POST /api/functional-cases - 批量保存（前端勾选的清单落库）
// 去重：以 (workspaceId, module, title) 为业务键。同键已存在则更新（不新建），避免重复点击/重复保存产生重复用例。
export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser(request);
    const userId = currentUser?.user?.id ?? null;
    // 资产管理总线 Step 1：归属当前工作区，业务键里加入 workspaceId
    const ws = await getCurrentWorkspace(request);
    if (!ws) {
      return NextResponse.json({ success: false, error: '未登录或无可用工作区' }, { status: 401 });
    }

    const body = await request.json();
    const cases: FunctionalCase[] = Array.isArray(body?.cases) ? body.cases : [];
    if (cases.length === 0) {
      return NextResponse.json(
        { success: false, error: '没有可保存的功能用例' },
        { status: 400 }
      );
    }

    // 本批内部先按 (module|title) 去重，保留最后一条，避免一次提交里就带重复
    const dedupedInBatch = Array.from(
      cases
        .reduce((m, c) => {
          const key = `${(c.module || '').trim()}||${(c.title || '').trim()}`;
          m.set(key, c);
          return m;
        }, new Map<string, FunctionalCase>())
        .values()
    );

    const results = await Promise.all(
      dedupedInBatch.map(async (c) => {
        const data = caseToData(c);
        // 同 (workspaceId, module, title) 已存在 → 更新（内容以本次为准，但保留已有 status/追溯，避免把"已生成"打回草稿）
        const existing = await (prisma as any).interfaceFunctionalCase.findFirst({
          where: { workspaceId: ws.workspaceId, module: data.module, title: data.title },
          select: { id: true, status: true },
        });
        if (existing) {
          const { status: _incomingStatus, ...rest } = data;
          return (prisma as any).interfaceFunctionalCase.update({
            where: { id: existing.id },
            data: { ...rest, ...(userId && { updatedBy: userId }) },
          });
        }
        return (prisma as any).interfaceFunctionalCase.create({
          data: {
            ...data,
            workspaceId: ws.workspaceId,
            ...(userId && { createdBy: userId, updatedBy: userId }),
          },
        });
      })
    );

    return NextResponse.json({
      success: true,
      data: results.map(rowToCase),
    });
  } catch (error: any) {
    console.error('保存接口功能用例失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '保存失败' },
      { status: 500 }
    );
  }
}

// DELETE /api/functional-cases - 批量删除（仅 admin）
// body: { ids: string[] }
export async function DELETE(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser(request);
    if (!currentUser?.user) {
      return NextResponse.json({ success: false, error: '未登录' }, { status: 401 });
    }
    if (currentUser.user.role !== 'admin') {
      return NextResponse.json(
        { success: false, error: '仅管理员可批量删除接口用例' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const ids: string[] = Array.isArray(body?.ids)
      ? body.ids.filter((x: any) => typeof x === 'string' && x)
      : [];
    if (ids.length === 0) {
      return NextResponse.json(
        { success: false, error: '没有要删除的用例' },
        { status: 400 }
      );
    }

    const result = await (prisma as any).interfaceFunctionalCase.deleteMany({
      where: { id: { in: ids }, workspaceId: (await getCurrentWorkspace(request))?.workspaceId },
    });

    return NextResponse.json({ success: true, data: { deleted: result.count } });
  } catch (error: any) {
    console.error('批量删除接口功能用例失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '删除失败' },
      { status: 500 }
    );
  }
}
