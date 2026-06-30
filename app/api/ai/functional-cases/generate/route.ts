import { NextRequest, NextResponse } from 'next/server';
import { loadAIClient, type AIMessage } from '@/lib/ai-client';
import {
  FUNCTIONAL_CASE_SYSTEM_PROMPT,
  FUNCTIONAL_CASE_TOOL,
  COMPLETENESS_CRITIC_PROMPT,
  COMPLETENESS_CRITIC_TOOL,
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

// ===== 二轮 completeness critic =====
// 大文档下分段策略的固有问题：段间互盲，导致跨章节关联场景、文档结尾段、
// 异常路径/权限维度容易漏。二轮让 AI 从"通览者"视角对照原文找漏，仅补不改。
//
// 触发阈值经验值：4 段（~12000 字）。低于此值单次 prompt 已能容纳全文，
// 退化不明显，多一轮 LLM call 纯浪费 token。
const MIN_SEGMENTS_FOR_CRITIC = 4;
// 二轮输入要带"已有 cases 摘要"。条数太多时，喂全量会撑爆上下文窗口。
// 100 条以内全传；超过则首尾各 50 条 title（覆盖文档前后部分，正中央反而是
// 段间衔接最薄弱的位置，但首尾取舍比按时间序裁后半更稳）。
const CRITIC_MAX_EXISTING_CASES = 100;

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

    // ===== 二轮 completeness critic =====
    // 仅大文档（≥MIN_SEGMENTS_FOR_CRITIC 段）触发；小文档退化不明显，不浪费 token。
    // 二轮失败不影响一轮结果——catch 后照常返回 cases，仅在 data.critic 标记 failed。
    let critic: {
      ran: boolean;
      added: number;
      failed?: boolean;
      reason?: string;
    } = { ran: false, added: 0 };

    if (segments.length >= MIN_SEGMENTS_FOR_CRITIC && cases.length > 0) {
      try {
        // 已有 cases 的摘要：只取 title + type + objective（避免 steps/expected 撑爆上下文）。
        // 条数超限时首尾各取 CRITIC_MAX_EXISTING_CASES/2，覆盖文档前后部分。
        const existingSummary = (() => {
          const compact = (c: FunctionalCase) => ({
            title: c.title,
            type: c.type,
            objective: c.objective ?? null,
          });
          if (cases.length <= CRITIC_MAX_EXISTING_CASES) return cases.map(compact);
          const half = Math.floor(CRITIC_MAX_EXISTING_CASES / 2);
          return [...cases.slice(0, half), ...cases.slice(-half)].map(compact);
        })();

        const criticPayload = {
          module: module || null,
          document: doc, // 完整原文（已经过 MAX_DOC_CHARS 截断保护）
          existingCases: existingSummary,
        };
        const criticMessages: AIMessage[] = [
          { role: 'system', content: COMPLETENESS_CRITIC_PROMPT },
          {
            role: 'user',
            content:
              '请对照下面的"原始文档"，检查"已生成用例清单"遗漏了哪些需求点。' +
              '只补遗漏，不要重复设计已有的，不要质疑已有的步骤/断言/优先级。' +
              '找不到遗漏返回空数组。最后调用 submit_missing_cases 提交。\n\n' +
              JSON.stringify(criticPayload, null, 2),
          },
        ];

        const criticResp = await client.chat(criticMessages, [COMPLETENESS_CRITIC_TOOL]);
        const criticCall = criticResp.toolCalls?.find(
          (tc) => tc.function.name === 'submit_missing_cases'
        );
        const criticParsed = criticCall
          ? parseLooseJsonObject<{ cases: any[] }>(criticCall.function.arguments, 'cases')
          : null;
        const rawMissing = Array.isArray(criticParsed?.cases) ? criticParsed!.cases : [];
        // 同样守 MAX_CASES_PER_SEG 上限（避免 critic 膨胀失控）
        const missing = rawMissing
          .slice(0, MAX_CASES_PER_SEG)
          .map((c) => normalizeFunctionalCase(c, module));

        // 与一轮一致的口径去重：title 归一对照 seen 集合
        let added = 0;
        for (const c of missing) {
          const key = (c.title || '').trim().toLowerCase();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          cases.push(c);
          added++;
        }
        critic = { ran: true, added };
      } catch (e: any) {
        critic = {
          ran: true,
          added: 0,
          failed: true,
          reason: e?.message || String(e),
        };
        console.error('completeness critic 失败（不影响一轮结果）:', e);
      }
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
        critic,
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
