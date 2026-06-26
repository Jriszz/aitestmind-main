/**
 * 业务语义 → 测试用例 增量同步引擎
 *
 * 与 lib/semantics-diff.ts 同构：
 *   - semantics-diff 比的是"文档新旧 baseline"
 *   - 本模块比的是"语义项（应派生）vs 已派生用例的指纹（已派生）"
 *
 * 纯函数，不触碰数据库 —— 调用方负责查出 existingFingerprints 再传入，便于单测与复用。
 */

import {
  enumerateSemanticItems,
  resolveEffectiveSemantics,
  type SemanticItem,
} from './semantics-fingerprint';
import type { ApiBusinessSemantics } from '@/types/har';

/** 已派生用例的简要信息（用于 orphaned 复核提示） */
export interface DerivedCaseRef {
  fingerprint: string;
  testCaseId?: string;
  testCaseName?: string;
}

export interface SyncPlan {
  apiId: string;
  /** 待生成：新规则 / 改过的规则（D - C） */
  toGenerate: SemanticItem[];
  /** 已同步：规则已有对应用例（D ∩ C） */
  inSync: SemanticItem[];
  /** 待复核：对应规则已删/已改，旧用例可能过时（C - D），仅提示不删 */
  orphaned: DerivedCaseRef[];
  /** 该接口是否有有效（confirmed）业务语义 */
  hasSemantics: boolean;
}

/**
 * 计算同步计划
 * @param apiId 接口 ID
 * @param rawSemantics 数据库 Api.businessSemantics（JSON 字符串或已解析对象）
 * @param existing 该接口相关用例已派生的指纹（sourceFingerprint 非 null 的用例）
 */
export function computeSyncPlan(
  apiId: string,
  rawSemantics: string | ApiBusinessSemantics | null | undefined,
  existing: DerivedCaseRef[]
): SyncPlan {
  const effective = resolveEffectiveSemantics(rawSemantics);
  const items = enumerateSemanticItems(apiId, effective);

  const existingByFp = new Map<string, DerivedCaseRef>();
  for (const ref of existing) {
    if (ref.fingerprint) existingByFp.set(ref.fingerprint, ref);
  }
  const desiredFps = new Set(items.map((i) => i.fingerprint));

  const toGenerate: SemanticItem[] = [];
  const inSync: SemanticItem[] = [];
  for (const item of items) {
    if (existingByFp.has(item.fingerprint)) inSync.push(item);
    else toGenerate.push(item);
  }

  // 已派生但不再对应任何当前语义项 → 孤儿（规则被删或被改，旧指纹失配）
  const orphaned: DerivedCaseRef[] = [];
  for (const ref of existing) {
    if (!desiredFps.has(ref.fingerprint)) orphaned.push(ref);
  }

  return {
    apiId,
    toGenerate,
    inSync,
    orphaned,
    hasSemantics: effective !== null,
  };
}
