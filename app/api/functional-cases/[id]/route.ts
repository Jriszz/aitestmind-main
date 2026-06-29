import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCurrentUser } from '@/lib/auth';
import { safeJsonStringify } from '@/lib/json-utils';
import { rowToCase } from '@/lib/functional-case-utils';
import type { FunctionalCase } from '@/types/functional-case';

export const dynamic = 'force-dynamic';

// GET /api/functional-cases/[id]
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const row = await (prisma as any).interfaceFunctionalCase.findUnique({ where: { id } });
    if (!row) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: rowToCase(row) });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || '获取失败' },
      { status: 500 }
    );
  }
}

// PUT /api/functional-cases/[id] - 编辑 / 回填生成追溯（generatedCaseIds + status）
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const currentUser = await getCurrentUser(request);
    const userId = currentUser?.user?.id ?? null;

    const c = (await request.json()) as FunctionalCase;

    // 只写入传入的字段，避免误清空；数组字段一律序列化
    const data: any = { ...(userId && { updatedBy: userId }) };
    const setIf = (key: string, value: any, jsonArray = false) => {
      if (value === undefined) return;
      data[key] = jsonArray ? safeJsonStringify(value ?? []) : value;
    };

    setIf('module', c.module ?? undefined);
    setIf('feature', c.feature ?? undefined);
    setIf('title', c.title);
    setIf('type', c.type);
    setIf('objective', c.objective ?? undefined);
    setIf('preconditions', c.preconditions, true);
    setIf('steps', c.steps, true);
    setIf('postconditions', c.postconditions, true);
    setIf('cleanup', c.cleanup, true);
    setIf('expectedResults', c.expectedResults, true);
    setIf('businessRules', c.businessRules, true);
    setIf('apiHints', c.apiHints, true);
    setIf('priority', c.priority);
    setIf('status', c.status);
    setIf('sourceDoc', c.sourceDoc ?? undefined);
    setIf('generatedCaseIds', c.generatedCaseIds, true);

    const row = await (prisma as any).interfaceFunctionalCase.update({ where: { id }, data });
    return NextResponse.json({ success: true, data: rowToCase(row) });
  } catch (error: any) {
    console.error('更新接口功能用例失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '更新失败' },
      { status: 500 }
    );
  }
}

// DELETE /api/functional-cases/[id]
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await (prisma as any).interfaceFunctionalCase.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || '删除失败' },
      { status: 500 }
    );
  }
}
