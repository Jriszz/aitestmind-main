import { randomBytes, pbkdf2Sync } from 'crypto';
import prisma from './prisma';

// 密码加密
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

// 验证密码
export function verifyPassword(password: string, hashedPassword: string): boolean {
  const [salt, hash] = hashedPassword.split(':');
  const verifyHash = pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === verifyHash;
}

// 生成 session token
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

// 创建 session
export async function createSession(userId: string, ipAddress?: string, userAgent?: string) {
  const token = generateSessionToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7天过期

  const session = await prisma.session.create({
    data: {
      userId,
      token,
      expiresAt,
      ipAddress,
      userAgent,
    },
  });

  return session;
}

// 验证 session
export async function validateSession(token: string) {
  const session = await prisma.session.findUnique({
    where: { token },
  });

  if (!session) {
    return null;
  }

  // 检查是否过期
  if (session.expiresAt < new Date()) {
    await prisma.session.delete({
      where: { id: session.id },
    });
    return null;
  }

  // 获取用户信息
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      loginName: true,
      email: true,
      role: true,
      status: true,
      createdAt: true,
      lastLoginAt: true,
    },
  });

  if (!user || user.status !== 'active') {
    return null;
  }

  return { user, session };
}

// 删除 session
export async function deleteSession(token: string) {
  await prisma.session.deleteMany({
    where: { token },
  });
}

// 清理过期 session
export async function cleanExpiredSessions() {
  await prisma.session.deleteMany({
    where: {
      expiresAt: {
        lt: new Date(),
      },
    },
  });
}

// 获取当前用户（从请求中）
export async function getCurrentUser(request: Request) {
  const token = request.headers.get('Authorization')?.replace('Bearer ', '');

  if (!token) {
    // 尝试从 cookie 中获取
    const cookies = request.headers.get('cookie');
    const cookieToken = cookies?.split(';').find(c => c.trim().startsWith('session='))?.split('=')[1];

    if (!cookieToken) {
      return null;
    }

    return validateSession(cookieToken);
  }

  return validateSession(token);
}

// 获取当前工作区（资产管理总线 Step 1：归属轴）
// 返回 { workspaceId } | null
// - 未登录或无可用工作区时返回 null（调用方应返回 401）
// - 已登录用户优先用 User.currentWorkspaceId
// - 老 token / 未初始化用户兜底到 isDefault=true 的工作区，并回写 currentWorkspaceId
// - 详见 docs/DESIGN_DECISIONS.md 决策 10
export async function getCurrentWorkspace(
  request: Request
): Promise<{ workspaceId: string } | null> {
  const session = await getCurrentUser(request);
  if (!session) return null;

  // 1. 用户已设的当前工作区
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { currentWorkspaceId: true },
  });
  if (user?.currentWorkspaceId) {
    return { workspaceId: user.currentWorkspaceId };
  }

  // 2. fallback：默认工作区，并回写到用户记录，避免每次重查
  const def = await prisma.workspace.findFirst({
    where: { isDefault: true },
    select: { id: true },
  });
  if (!def) return null;

  await prisma.user.update({
    where: { id: session.user.id },
    data: { currentWorkspaceId: def.id },
  });

  return { workspaceId: def.id };
}

