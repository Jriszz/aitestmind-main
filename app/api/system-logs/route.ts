import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getCurrentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * 系统/API 日志查看接口（读 logs/*.log 文件）
 *
 * 仅管理员可访问。日志含请求细节/错误栈，属敏感信息。
 *
 * GET /api/system-logs?action=files
 *   → 列出 logs/ 下的日志文件（按文件名倒序，即日期新→旧）
 *
 * GET /api/system-logs?file=2026-06-25-nextjs-api.log&level=ERROR&op=READ&q=keyword&limit=500
 *   → 读取并解析指定文件，支持按 级别 / 操作类型 / 关键词 过滤，返回尾部最近 N 条
 */

// 合法日志文件名：YYYY-MM-DD-(nextjs-api|executor).log —— 防目录穿越
const LOG_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-(nextjs-api|executor)\.log$/;

// 一条日志记录的起始行：[HH:MM:SS.mmm] [LEVEL] [OP] message
//   - [OP] 可选（部分日志没有操作类型）
const LINE_START_PATTERN =
  /^\[(\d{2}:\d{2}:\d{2}\.\d{3})\]\s+\[([A-Z]+)\](?:\s+\[([A-Z]+)\])?\s*(.*)$/;

interface ParsedLog {
  time: string;
  level: string;
  op: string | null;
  message: string;
  details: string | null;
}

function getLogsDir(): string {
  return path.join(process.cwd(), 'logs');
}

/**
 * 解析日志文件内容为结构化记录。
 * 以时间戳行为一条记录的起点；后续非时间戳开头的行（Data:/Error:/Stack: 等）归入上一条的 details。
 */
function parseLogContent(content: string): ParsedLog[] {
  const lines = content.split(/\r?\n/);
  const logs: ParsedLog[] = [];
  let current: ParsedLog | null = null;
  const detailBuffer: string[] = [];

  const flushDetails = () => {
    if (current && detailBuffer.length > 0) {
      current.details = detailBuffer.join('\n');
    }
    detailBuffer.length = 0;
  };

  for (const line of lines) {
    const m = line.match(LINE_START_PATTERN);
    if (m) {
      // 新记录开始：先把上一条的 details 落定
      flushDetails();
      current = {
        time: m[1],
        level: m[2],
        op: m[3] || null,
        message: m[4] || '',
        details: null,
      };
      logs.push(current);
    } else if (current && line.length > 0) {
      // 续行归入上一条记录的 details
      detailBuffer.push(line);
    }
  }
  flushDetails();

  return logs;
}

export async function GET(request: NextRequest) {
  try {
    // 管理员校验
    const currentUser = await getCurrentUser(request);
    if (!currentUser?.user) {
      return NextResponse.json(
        { success: false, error: '未登录' },
        { status: 401 }
      );
    }
    if (currentUser.user.role !== 'admin') {
      return NextResponse.json(
        { success: false, error: '无权限：仅管理员可查看系统日志' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action');
    const logsDir = getLogsDir();

    // ── 列出日志文件 ──
    if (action === 'files') {
      let files: string[] = [];
      try {
        files = fs
          .readdirSync(logsDir)
          .filter((f) => LOG_FILE_PATTERN.test(f))
          .sort()
          .reverse(); // 日期新→旧
      } catch {
        files = [];
      }
      return NextResponse.json({ success: true, files });
    }

    // ── 读取并解析某个文件 ──
    const file = searchParams.get('file') || '';
    if (!LOG_FILE_PATTERN.test(file)) {
      return NextResponse.json(
        { success: false, error: '非法的日志文件名' },
        { status: 400 }
      );
    }

    // 二次防护：解析后的绝对路径必须仍在 logs 目录内
    const filePath = path.join(logsDir, file);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(logsDir) + path.sep)) {
      return NextResponse.json(
        { success: false, error: '非法路径' },
        { status: 400 }
      );
    }

    if (!fs.existsSync(resolved)) {
      return NextResponse.json(
        { success: false, error: '日志文件不存在' },
        { status: 404 }
      );
    }

    const level = (searchParams.get('level') || '').toUpperCase();
    const op = (searchParams.get('op') || '').toUpperCase();
    const q = (searchParams.get('q') || '').toLowerCase();
    const limit = Math.min(
      Math.max(parseInt(searchParams.get('limit') || '500', 10) || 500, 1),
      5000
    );

    const content = fs.readFileSync(resolved, 'utf-8');
    let logs = parseLogContent(content);

    // 过滤
    if (level) logs = logs.filter((l) => l.level === level);
    if (op) logs = logs.filter((l) => l.op === op);
    if (q) {
      logs = logs.filter(
        (l) =>
          l.message.toLowerCase().includes(q) ||
          (l.details ? l.details.toLowerCase().includes(q) : false)
      );
    }

    const total = logs.length;
    // 只取尾部最近 N 条（时间正序，便于前端底部自动滚动）
    const sliced = logs.slice(-limit);

    return NextResponse.json({
      success: true,
      file,
      total,
      returned: sliced.length,
      logs: sliced,
    });
  } catch (error: any) {
    console.error('[API] 读取系统日志失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '读取系统日志失败' },
      { status: 500 }
    );
  }
}
