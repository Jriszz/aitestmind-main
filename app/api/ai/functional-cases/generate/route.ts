import { NextRequest, NextResponse } from 'next/server';
import { loadAIClient, type AIMessage } from '@/lib/ai-client';
import {
  FUNCTIONAL_CASE_SYSTEM_PROMPT,
  FUNCTIONAL_CASE_TOOL,
} from '@/lib/ai-prompts/functional-case-prompt';
import { parseLooseJsonObject } from '@/lib/json-utils';
import { splitDocument } from '@/lib/doc-splitter';
import { normalizeFunctionalCase } from '@/lib/functional-case-utils';
import type { FunctionalCase } from '@/types/functional-case';

export const dynamic = 'force-dynamic';

// ===== 防 token 爆仓的三道闸（集中常量，便于调） =====
const MAX_DOC_CHARS = 50000; // 闸1：输入文档总长上限（超出截断）
const SEG_CHARS = 3000; // 每段目标字数（按边界断）
const MAX_SEGMENTS = 12; // 闸2：最多处理的段数（控制调用次数/成本）
const MAX_CASES_PER_SEG = 8; // 闸3：单段最多产出用例数（治输出爆，prompt 内约束）

/**
 * AI 探索 · 文档 → 接口功能用例（测试设计层，不落库）
 * POST /api/ai/functional-cases/generate
 *   body: { docText: string, module?: string }
 *
 * 长文档会自动分段（按 Markdown 标题/段落），逐段喂 AI，合并去重，
 * 防止一次性塞入导致 token 爆仓。超限一律截断 + 明示提示，不静默。
 */
export async function POST(request: NextRequest) {
  try {
    const { docText, module } = await request.json();

    if (typeof docText !== 'string' || docText.trim().length < 10) {
      return NextResponse.json(
        { success: false, error: '请粘贴需求/功能规格文本（至少 10 个字符）' },
        { status: 400 }
      );
    }

    // 闸1：文档总长上限
    const rawLen = docText.length;
    const truncatedDoc = rawLen > MAX_DOC_CHARS;
    const doc = truncatedDoc ? docText.slice(0, MAX_DOC_CHARS) : docText;

    // 分段
    const allSegments = splitDocument(doc, { segChars: SEG_CHARS });
    // 闸2：分段数上限
    const truncatedSegments = allSegments.length > MAX_SEGMENTS;
    const segments = truncatedSegments ? allSegments.slice(0, MAX_SEGMENTS) : allSegments;

    if (segments.length === 0) {
      return NextResponse.json(
        { success: false, error: '文档内容为空或无法解析' },
        { status: 400 }
      );
    }

    // 全局上下文头：模块名 + 文档开头摘要，拼进每段，避免分段丢背景
    const docSummary = doc.slice(0, 500).replace(/\s+/g, ' ').trim();
    const contextHeader =
      `【文档背景】${module ? `模块：${module}。` : ''}文档开头摘要：${docSummary}\n` +
      `【约束】你现在只看到文档的一个片段，聚焦本片段涉及的功能即可，不要为未出现的功能编造用例。` +
      `本片段最多设计 ${MAX_CASES_PER_SEG} 条最有价值的用例，步骤简洁、不堆砌冗长描述。\n`;

    const client = await loadAIClient();

    // 串行逐段跑（避免并发打爆 AI 限流），单段失败不致命
    const merged: FunctionalCase[] = [];
    let failedSegments = 0;

    const runSegment = async (seg: { title?: string; content: string }) => {
      const userPayload = {
        module: module || null,
        section: seg.title || null,
        document: seg.content,
      };
      const messages: AIMessage[] = [
        { role: 'system', content: FUNCTIONAL_CASE_SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            contextHeader +
            '请阅读以下需求/功能规格片段，设计接口功能测试用例，并调用 submit_functional_cases 提交：\n\n' +
            JSON.stringify(userPayload, null, 2),
        },
      ];

      const response = await client.chat(messages, [FUNCTIONAL_CASE_TOOL]);
      const call = response.toolCalls?.find(
        (tc) => tc.function.name === 'submit_functional_cases'
      );
      if (!call) return [];
      const parsed = parseLooseJsonObject<{ cases: any[] }>(call.function.arguments, 'cases');
      const cases = Array.isArray(parsed?.cases) ? parsed!.cases : [];
      // 闸3 兜底：即便 AI 没遵守 prompt 的条数约束，服务端也截断
      return cases.slice(0, MAX_CASES_PER_SEG).map((c) => normalizeFunctionalCase(c, module));
    };

    for (const seg of segments) {
      try {
        merged.push(...(await runSegment(seg)));
      } catch (e: any) {
        failedSegments++;
        console.error(`功能用例生成·单段失败（${seg.title || '无标题段'}）:`, e?.message || e);
      }
    }

    // 合并去重（同功能跨段重复识别）：按 title 归一去重
    const seen = new Set<string>();
    const cases: FunctionalCase[] = [];
    for (const c of merged) {
      const key = (c.title || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      cases.push(c);
    }

    return NextResponse.json({
      success: true,
      data: {
        cases,
        total: cases.length,
        segments: allSegments.length, // 实际切出的总段数
        processedSegments: segments.length, // 本次实际处理的段数
        failedSegments,
        truncated: {
          doc: truncatedDoc, // 文档是否被截断
          segments: truncatedSegments ? allSegments.length - MAX_SEGMENTS : 0, // 被丢弃的段数
        },
      },
    });
  } catch (error: any) {
    console.error('接口功能用例生成失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '生成失败' },
      { status: 500 }
    );
  }
}
