import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, getCurrentWorkspace } from '@/lib/auth';
import { saveCapturedApis, type ApiInput } from '@/lib/api-save';

export const dynamic = 'force-dynamic';

/**
 * 批量保存采集的API到数据库
 * POST /api/api-library/save
 *
 * 实现已抽到 lib/api-save.ts 的 saveCapturedApis()，
 * 让 SwaggerSource 同步路由（资产管理总线 Step 2）也能复用——
 * 决策 4（字段级合并）和决策 5（语义双层）的合并逻辑只能有一份实现。
 */
export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser(request);
    const userId = currentUser?.user?.id ?? null;

    // 资产管理总线 Step 1：解析工作区，所有合并/创建按工作区收敛（红线）
    const ws = await getCurrentWorkspace(request);
    if (!ws) {
      return NextResponse.json({ success: false, error: '未登录或无可用工作区' }, { status: 401 });
    }

    const body = await request.json();
    const { apis } = body as { apis: ApiInput[] };

    if (!apis || !Array.isArray(apis) || apis.length === 0) {
      return NextResponse.json(
        { success: false, error: '请提供要保存的API列表' },
        { status: 400 }
      );
    }

    const result = await saveCapturedApis(apis, {
      workspaceId: ws.workspaceId,
      userId,
    });

    return NextResponse.json({
      success: result.savedApis.length > 0,
      count: result.savedApis.length,
      total: apis.length,
      created: result.createdCount,
      updated: result.updatedCount,
      failed: result.failedApis.length,
      failedDetails: result.failedApis,
      apis: result.savedApis,
      message:
        result.failedApis.length > 0
          ? `成功保存 ${result.savedApis.length} 个API（新增 ${result.createdCount} / 更新 ${result.updatedCount}），${result.failedApis.length} 个失败`
          : `成功保存 ${result.savedApis.length} 个API（新增 ${result.createdCount} / 更新 ${result.updatedCount}）`,
    });
  } catch (error: any) {
    console.error('批量保存API失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '保存失败' },
      { status: 500 }
    );
  }
}
