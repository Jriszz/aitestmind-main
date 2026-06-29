import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { loadAIClient, type AIMessage } from '@/lib/ai-client';
import {
  CHAIN_EXPLORE_SYSTEM_PROMPT,
  CHAIN_EXPLORE_TOOL,
} from '@/lib/ai-prompts/chain-explore-prompt';
import { parseLooseJsonObject } from '@/lib/json-utils';
import { rowToCase, normalizeFunctionalCase } from '@/lib/functional-case-utils';
import type { FunctionalCase } from '@/types/functional-case';

export const dynamic = 'force-dynamic';

const MAX_NODES = 20; // 主干节点数上限（防超长链爆仓）

interface ChainNodeInput {
  name: string;
  functionalCaseId?: string;
}

/**
 * AI 探索 · 主干链路 → 沿链发散跨服务接口功能用例（B 方案，不落库）
 * POST /api/ai/chain-explore
 *   body: { flowName: string, nodes: { name: string; functionalCaseId? }[] }
 *
 * 人给主干骨架（有序节点 + 可选关联已沉淀用例），AI 沿链发散异常/对账/边界，
 * 产出跨服务接口功能用例清单（设计层，不可执行）。交前端审阅/编辑后走探索生成。
 */
export async function POST(request: NextRequest) {
  try {
    const { flowName, nodes } = await request.json();

    if (typeof flowName !== 'string' || !flowName.trim()) {
      return NextResponse.json({ success: false, error: '请填写业务流名称' }, { status: 400 });
    }
    if (!Array.isArray(nodes) || nodes.length < 2) {
      return NextResponse.json(
        { success: false, error: '主干链路至少需要 2 个节点' },
        { status: 400 }
      );
    }

    const chainNodes: ChainNodeInput[] = nodes
      .filter((n: any) => n && typeof n.name === 'string' && n.name.trim())
      .slice(0, MAX_NODES)
      .map((n: any) => ({ name: n.name.trim(), functionalCaseId: n.functionalCaseId || undefined }));

    if (chainNodes.length < 2) {
      return NextResponse.json(
        { success: false, error: '主干链路至少需要 2 个有效节点' },
        { status: 400 }
      );
    }

    // 拉取已关联节点的"能力/规则"依据；未关联的标记 unmatched
    const unmatchedNodes: string[] = [];
    const nodeContexts = await Promise.all(
      chainNodes.map(async (node, idx) => {
        if (!node.functionalCaseId) {
          unmatchedNodes.push(node.name);
          return { order: idx + 1, name: node.name, capability: null };
        }
        try {
          const row = await (prisma as any).interfaceFunctionalCase.findUnique({
            where: { id: node.functionalCaseId },
          });
          if (!row) {
            unmatchedNodes.push(node.name);
            return { order: idx + 1, name: node.name, capability: null };
          }
          const c = rowToCase(row);
          return {
            order: idx + 1,
            name: node.name,
            capability: {
              title: c.title,
              objective: c.objective,
              steps: c.steps,
              businessRules: c.businessRules,
              apiHints: c.apiHints,
            },
          };
        } catch {
          unmatchedNodes.push(node.name);
          return { order: idx + 1, name: node.name, capability: null };
        }
      })
    );

    const client = await loadAIClient();

    const userPayload = {
      flowName,
      mainChain: nodeContexts, // 有序节点 + 各节点能力（null=未提供规则，预期需人工确认）
    };

    const messages: AIMessage[] = [
      { role: 'system', content: CHAIN_EXPLORE_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `业务流「${flowName}」的主干链路如下（有序节点，部分附带已知能力/规则）。` +
          `请沿这条主干发散出跨服务接口功能用例，并调用 submit_chain_cases 提交：\n\n` +
          JSON.stringify(userPayload, null, 2),
      },
    ];

    let cases: FunctionalCase[] = [];
    let failedCount = 0;
    try {
      const response = await client.chat(messages, [CHAIN_EXPLORE_TOOL]);
      const call = response.toolCalls?.find((tc) => tc.function.name === 'submit_chain_cases');
      if (call) {
        const parsed = parseLooseJsonObject<{ cases: any[] }>(call.function.arguments, 'cases');
        const raw = Array.isArray(parsed?.cases) ? parsed!.cases : [];
        // 用业务流名作为 module 软归类
        cases = raw.map((c) => normalizeFunctionalCase(c, flowName));
      }
    } catch (e: any) {
      failedCount = 1;
      console.error('主干链路发散失败:', e?.message || e);
    }

    return NextResponse.json({
      success: true,
      data: {
        cases,
        total: cases.length,
        failedCount,
        unmatchedNodes, // 未关联（AI 据节点名设计，预期可能标"需人工确认"）
      },
    });
  } catch (error: any) {
    console.error('主干链路探索失败:', error);
    return NextResponse.json(
      { success: false, error: error.message || '生成失败' },
      { status: 500 }
    );
  }
}
