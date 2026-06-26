import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { computeSyncPlan, type DerivedCaseRef } from '@/lib/semantics-sync';

export const dynamic = 'force-dynamic';

/**
 * 语义同步预览
 * GET /api/api-library/apis/[id]/semantics-sync
 *
 * 返回该接口的 SyncPlan：
 *   - toGenerate：新规则/改过的规则 → 待生成
 *   - inSync：    已有对应用例 → 跳过
 *   - orphaned：  对应规则已删/已改 → 旧用例待复核（仅提示不删）
 *   - hasSemantics：该接口是否有有效（confirmed）业务语义
 *
 * 纯预览，不写库。P1 再加 POST 触发差集生成。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const api = await prisma.api.findUnique({
      where: { id },
      select: { id: true, name: true, businessSemantics: true } as any,
    });

    if (!api) {
      return NextResponse.json({ success: false, error: 'API不存在' }, { status: 404 });
    }

    // 查"该接口已派生的用例"：sourceFingerprint 非 null 且有步骤引用本接口
    const derivedCases = await prisma.testCase.findMany({
      where: {
        sourceFingerprint: { not: null },
        steps: { some: { apiId: id } },
      } as any,
      select: { id: true, name: true, sourceFingerprint: true } as any,
    });

    const existing: DerivedCaseRef[] = (derivedCases as any[]).map((tc) => ({
      fingerprint: tc.sourceFingerprint as string,
      testCaseId: tc.id,
      testCaseName: tc.name,
    }));

    const plan = computeSyncPlan(id, (api as any).businessSemantics, existing);

    return NextResponse.json({
      success: true,
      data: {
        apiId: api.id,
        apiName: api.name,
        hasSemantics: plan.hasSemantics,
        toGenerate: plan.toGenerate,
        inSync: plan.inSync,
        orphaned: plan.orphaned,
        summary: {
          toGenerate: plan.toGenerate.length,
          inSync: plan.inSync.length,
          orphaned: plan.orphaned.length,
        },
      },
    });
  } catch (error: any) {
    console.error('语义同步预览失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '预览失败' },
      { status: 500 }
    );
  }
}
