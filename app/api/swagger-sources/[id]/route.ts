import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCurrentUser, getCurrentWorkspace } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * 修改 Swagger 数据源
 * PATCH /api/swagger-sources/[id]
 * body: { name?, url?, authHeaders?, defaultPlatform?, defaultComponent?, defaultFeature? }
 *
 * 资产管理总线 Step 2：剥离客户端的 workspaceId（防越权移动）
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

    const { id } = await params;

    // 工作区收敛：跨工作区直接 404
    const existing = await prisma.swaggerSource.findFirst({
      where: { id, workspaceId: ws.workspaceId },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json(
        { success: false, error: '数据源不存在' },
        { status: 404 }
      );
    }

    const body = await request.json();
    delete body.workspaceId; // 防越权
    const { name, url, authHeaders, defaultPlatform, defaultComponent, defaultFeature } = body;

    const data: any = { updatedBy: userId };

    if (typeof name === 'string' && name.trim()) {
      // 校验名称在工作区内的唯一性（排除自己）
      const conflict = await prisma.swaggerSource.findFirst({
        where: {
          workspaceId: ws.workspaceId,
          name: name.trim(),
          NOT: { id },
        },
        select: { id: true },
      });
      if (conflict) {
        return NextResponse.json(
          { success: false, error: `数据源名称 "${name}" 在当前工作区已存在` },
          { status: 409 }
        );
      }
      data.name = name.trim();
    }

    if (typeof url === 'string' && url.trim()) {
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
      data.url = url.trim();
      // URL 变更后，旧的 ETag/hash 应失效（避免误判"未变更"）
      data.lastEtag = null;
      data.lastHash = null;
    }

    if (authHeaders !== undefined) {
      if (authHeaders === null || authHeaders === '') {
        data.authHeaders = null;
      } else if (typeof authHeaders === 'object' && !Array.isArray(authHeaders)) {
        data.authHeaders = JSON.stringify(authHeaders);
      } else {
        return NextResponse.json(
          { success: false, error: 'authHeaders 必须是 key-value 对象' },
          { status: 400 }
        );
      }
    }

    if (defaultPlatform !== undefined) data.defaultPlatform = defaultPlatform || null;
    if (defaultComponent !== undefined) data.defaultComponent = defaultComponent || null;
    if (defaultFeature !== undefined) data.defaultFeature = defaultFeature || null;

    const source = await prisma.swaggerSource.update({
      where: { id },
      data,
    });

    return NextResponse.json({ success: true, source });
  } catch (error: any) {
    console.error('更新 Swagger 数据源失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '更新失败' },
      { status: 500 }
    );
  }
}

/**
 * 删除 Swagger 数据源
 * DELETE /api/swagger-sources/[id]
 *
 * 不级联删除已落库的接口——已落库的 API 是独立资产。
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ws = await getCurrentWorkspace(request);
    if (!ws) {
      return NextResponse.json(
        { success: false, error: '未登录或无可用工作区' },
        { status: 401 }
      );
    }

    const { id } = await params;
    const existing = await prisma.swaggerSource.findFirst({
      where: { id, workspaceId: ws.workspaceId },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json(
        { success: false, error: '数据源不存在' },
        { status: 404 }
      );
    }

    await prisma.swaggerSource.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('删除 Swagger 数据源失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '删除失败' },
      { status: 500 }
    );
  }
}
