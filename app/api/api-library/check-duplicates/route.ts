import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { parameterizePath } from '@/lib/path-parameterization';
import { getCurrentWorkspace } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * 检查API是否重复
 * POST /api/api-library/check-duplicates
 *
 * 资产管理总线 Step 1（红线）：查重必须严格按当前工作区收敛。
 * 否则跨工作区相同 method+path 的接口会被误判重复 → 触发字段级合并 →
 * 把另一工作区的真实 token/响应样本污染给当前工作区，违反决策 4 和决策 10。
 */
export async function POST(request: NextRequest) {
  try {
    const ws = await getCurrentWorkspace(request);
    if (!ws) {
      return NextResponse.json({ success: false, error: '未登录或无可用工作区' }, { status: 401 });
    }

    const body = await request.json();
    const { apis } = body as {
      apis: Array<{
        id?: string;
        method: string;
        url: string;
        path?: string;
        name?: string;
      }>;
    };

    if (!apis || !Array.isArray(apis) || apis.length === 0) {
      return NextResponse.json(
        { success: false, error: '请提供要检查的API列表' },
        { status: 400 }
      );
    }

    // 检查每个API是否重复
    const checkResults = await Promise.all(
      apis.map(async (api) => {
        // 提取或生成路径
        let apiPath = api.path;
        if (!apiPath) {
          try {
            const urlObj = new URL(api.url);
            apiPath = urlObj.pathname;
          } catch (error) {
            apiPath = api.url;
          }
        }

        // GET 请求：忽略 query，只按 pathname 判重
        if (api.method?.toUpperCase() === 'GET' && apiPath) {
          apiPath = apiPath.split('?')[0];
        }

        // 参数化路径（统一格式）
        const paramResult = parameterizePath(apiPath);
        const normalizedPath = paramResult.parameterizedPath;
        const normalizedMethod = api.method.toUpperCase();

        // 在数据库中查找是否存在相同 method + path 的API
        // 方案A：对于 GET，历史数据中可能保存了带 query 的 path，这里同时匹配
        // 红线：workspaceId 必须是第一个键，先按工作区收敛再查重
        const whereForMethodAndPath: any = {
          workspaceId: ws.workspaceId,
          method: normalizedMethod,
          name: {
            not: '_CLASSIFICATION_PLACEHOLDER_', // 排除占位API
          },
        };

        if (normalizedMethod === 'GET') {
          whereForMethodAndPath.OR = [
            { path: normalizedPath },
            { path: { startsWith: normalizedPath + '?' } },
          ];
        } else {
          whereForMethodAndPath.path = normalizedPath;
        }

        const existingApi = await prisma.api.findFirst({
          where: whereForMethodAndPath,
          include: {
            category: true,
            tags: {
              include: {
                tag: true,
              },
            },
          },
        });

        return {
          inputApi: api,
          isDuplicate: !!existingApi,
          existingApi: existingApi || undefined,
          normalizedPath,
          normalizedMethod,
        };
      })
    );

    return NextResponse.json({
      success: true,
      data: checkResults,
    });
  } catch (error: any) {
    console.error('检查API重复失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '检查失败' },
      { status: 500 }
    );
  }
}

