/**
 * 业务语义指纹 —— "业务语义 → 测试用例" 增量同步的锚点
 *
 * 语义里"可独立派生一条用例的最小单元"称为一个 **语义项（SemanticItem）**。
 * 每个语义项算一个稳定指纹（绑定"规则内容"这一事实）：
 *   - 规则内容不变 → 指纹不变（幂等，二次同步为空）
 *   - 规则内容改了 → 指纹变（自动触发待生成 + 旧用例进 orphaned 待复核）
 *
 * 与 lib/semantics-diff.ts 同源复用 stableStringify，保证"内容实质相等→指纹相等"。
 * 有效语义（override 优先 baseline、仅 confirmed）与 ai-tools/getApiDetail 注入给 AI
 * 的口径完全一致，避免"AI 看到的"和"指纹算的"是两份数据。
 */

import { createHash } from 'crypto';
import { stableStringify } from './semantics-diff';
import type {
  ApiBusinessSemantics,
  SemanticSnapshot,
  SemanticDbAssert,
} from '@/types/har';

/** 一个可派生用例的语义项 */
export interface SemanticItem {
  /** 语义类别 */
  field: 'description' | 'sideEffect' | 'fundConsistency' | 'dbAsserts';
  /** 该规则在接口内的稳定标识（如 fundConsistency.守恒 / dbAsserts.<desc> / sideEffect / description） */
  semanticKey: string;
  /** 规则内容（用于指纹与喂给 AI 生成） */
  content: unknown;
  /** 该语义项的指纹 */
  fingerprint: string;
}

function isPresent(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

/**
 * 解析接口的"有效语义"：仅 status=confirmed 才返回；逐项 override 覆盖 baseline。
 * 与 ai-tools/getApiDetail 注入 AI 的口径一致（共享同一函数，避免分叉）。
 *
 * @param raw 数据库 Api.businessSemantics 字段（JSON 字符串或已解析对象，可空）
 * @returns 有效语义快照，或 null（无语义 / 未 confirmed / 解析失败）
 */
export function resolveEffectiveSemantics(
  raw: string | ApiBusinessSemantics | null | undefined
): SemanticSnapshot | null {
  if (!raw) return null;
  let sem: ApiBusinessSemantics | null = null;
  try {
    sem = typeof raw === 'string' ? (JSON.parse(raw) as ApiBusinessSemantics) : raw;
  } catch {
    return null;
  }
  if (!sem || sem.status !== 'confirmed') return null;

  const baseline = sem.baseline ?? {};
  const override = sem.override ?? {};
  return {
    description: override.description ?? baseline.description,
    sideEffect: override.sideEffect ?? baseline.sideEffect,
    fundConsistency: override.fundConsistency ?? baseline.fundConsistency,
    dbAsserts: override.dbAsserts ?? baseline.dbAsserts,
  };
}

/** 计算单个语义项的指纹 */
export function fingerprintItem(apiId: string, semanticKey: string, content: unknown): string {
  const payload = `${apiId}:${semanticKey}:${stableStringify(content)}`;
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * 枚举接口的全部语义项（每项 → 一条待派生用例，粒度=每条规则一条）。
 *
 * 粒度约定：
 * - description：整体一条（条件约束）
 * - sideEffect：整体一条（落库副作用）
 * - fundConsistency：Record 的每个键各一条（键即规则名）
 * - dbAsserts：数组每条各一条，按 desc 取键（避免数组重排导致指纹漂移）
 */
export function enumerateSemanticItems(
  apiId: string,
  effective: SemanticSnapshot | null
): SemanticItem[] {
  if (!effective) return [];
  const items: SemanticItem[] = [];

  const push = (field: SemanticItem['field'], semanticKey: string, content: unknown) => {
    if (!isPresent(content)) return;
    items.push({ field, semanticKey, content, fingerprint: fingerprintItem(apiId, semanticKey, content) });
  };

  // description：条件约束整体一条
  push('description', 'description', effective.description);

  // sideEffect：落库副作用整体一条
  push('sideEffect', 'sideEffect', effective.sideEffect);

  // fundConsistency：每个键一条
  if (effective.fundConsistency && typeof effective.fundConsistency === 'object') {
    for (const ruleName of Object.keys(effective.fundConsistency)) {
      const value = effective.fundConsistency[ruleName];
      // content 含规则名与说明，使同名不同义的规则指纹可区分
      push('fundConsistency', `fundConsistency.${ruleName}`, { rule: ruleName, desc: value });
    }
  }

  // dbAsserts：每条一条，按 desc 取键（无 desc 时回退到内容序列化片段）
  if (Array.isArray(effective.dbAsserts)) {
    effective.dbAsserts.forEach((assert: SemanticDbAssert, idx: number) => {
      const keyPart = assert?.desc?.trim() || `#${idx}`;
      push('dbAsserts', `dbAsserts.${keyPart}`, assert);
    });
  }

  return items;
}

/**
 * 给一条"接口功能用例"（InterfaceFunctionalCase）算稳定指纹。
 *
 * 用途：
 *   - explore-generate 二次点击同一批功能用例时按 (workspaceId, sourceFingerprint) 去重，
 *     避免在功能用例表里重复落同一条业务设计。
 *   - 与 fingerprintItem 共享 sha256 + stableStringify 哈希口径，保持指纹族同构。
 *
 * 字段口径（变了任一项指纹就变，与 InterfaceFunctionalCase 表 (module,title) 软键互补）：
 *   - workspaceId / module / feature / title：业务归属与标题
 *   - apiHints：去空、去重、排序后纳入；不依赖前端原始顺序，避免漂移
 *
 * 不纳入 steps/objective/businessRules 等内容字段——这些是"内容修订"，
 * 改了应保留同一 fingerprint 让二次点击继续命中复用，不应触发新建。
 */
export function fingerprintFunctionalCase(input: {
  workspaceId?: string | null;
  module?: string | null;
  feature?: string | null;
  title: string;
  apiHints?: string[] | null;
}): string {
  const normHints = Array.isArray(input.apiHints)
    ? Array.from(
        new Set(
          input.apiHints
            .map((h) => (typeof h === 'string' ? h.trim() : ''))
            .filter((h) => h.length > 0)
        )
      ).sort()
    : [];
  const payload = stableStringify({
    workspaceId: input.workspaceId ?? null,
    module: input.module ?? null,
    feature: input.feature ?? null,
    title: input.title,
    apiHints: normHints,
  });
  return createHash('sha256').update(`functionalCase:${payload}`).digest('hex');
}
