import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCurrentUser, getCurrentWorkspace } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Swagger 数据源列表（按当前工作区收敛）
 * GET /api/swagger-sources
 *
 * 资产管理总线 Step 2：SwaggerSource 是工作区下的一等公民资产
 * 详见 docs/DESIGN_DECISIONS.md 决策 10
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

    const sources = await prisma.swaggerSource.findMany({
      where: { workspaceId: ws.workspaceId },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        name: true,
        url: true,
        defaultPlatform: true,
        defaultComponent: true,
        defaultFeature: true,
        lastSyncAt: true,
        lastSyncStatus: true,
        lastSyncMessage: true,
        totalApiCount: true,
        lastImportedCount: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({ success: true, sources });
  } catch (error: any) {
    console.error('查询 Swagger 数据源失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '查询失败' },
      { status: 500 }
    );
  }
}

/**
 * 创建 Swagger 数据源
 * POST /api/swagger-sources
 * body: { name, url, authHeaders?, defaultPlatform?, defaultComponent?, defaultFeature? }
 *
 * 仅创建，不立即同步——避免长事务。前端通常会在创建成功后立刻调 /sync 路由。
 */
export async function POST(request: NextRequest) {
  try {
    const currentUser = await getCurrentUser(request);
    if (!currentUser) {
      return NextResponse.json({ success: false, error: '未登录' }, { status: 401 });
    }
    const userId = currentUser.user.id;

    const ws = await getCurrentWorkspace(request);
    if (!ws) {
      return NextResponse.json(
        { success: false, error: '未登录或无可用工作区' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const {
      name,
      url,
      authHeaders,
      defaultPlatform,
      defaultComponent,
      defaultFeature,
    } = body;

    // 校验
    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json(
        { success: false, error: '数据源名称不能为空' },
        { status: 400 }
      );
    }
    if (!url || typeof url !== 'string' || !url.trim()) {
      return NextResponse.json(
        { success: false, error: 'URL 不能为空' },
        { status: 400 }
      );
    }

    // 验证 URL 格式
    try {
      const u = new URL(url.trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return NextResponse.json(
          { success: false, error: '仅支持 http/https 链接' },
          { status: 400 }
        );
      }
    } catch {
      return NextResponse.json(
        { success: false, error: 'URL 格式不合法' },
        { status: 400 }
      );
    }

    // authHeaders 必须是对象，序列化前校验
    let authHeadersJson: string | null = null;
    if (authHeaders) {
      if (typeof authHeaders !== 'object' || Array.isArray(authHeaders)) {
        return NextResponse.json(
          { success: false, error: 'authHeaders 必须是 key-value 对象' },
          { status: 400 }
        );
      }
      authHeadersJson = JSON.stringify(authHeaders);
    }

    // 同工作区名称查重（@@unique 也会兜底，这里给清晰错误）
    const exists = await prisma.swaggerSource.findFirst({
      where: { workspaceId: ws.workspaceId, name: name.trim() },
      select: { id: true },
    });
    if (exists) {
      return NextResponse.json(
        { success: false, error: `数据源名称 "${name}" 在当前工作区已存在` },
        { status: 409 }
      );
    }

    const source = await prisma.swaggerSource.create({
      data: {
        name: name.trim(),
        url: url.trim(),
        authHeaders: authHeadersJson,
        defaultPlatform: defaultPlatform || null,
        defaultComponent: defaultComponent || null,
        defaultFeature: defaultFeature || null,
        workspaceId: ws.workspaceId,
        createdBy: userId,
        updatedBy: userId,
      },
    });

    return NextResponse.json({ success: true, source });
  } catch (error: any) {
    console.error('创建 Swagger 数据源失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '创建失败' },
      { status: 500 }
    );
  }
}
