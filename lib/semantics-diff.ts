/**
 * 业务语义 diff 工具 —— 生命周期治理核心
 *
 * 文档为主、平台可调 + 手动同步 + diff 确认：
 * 当文档重新导入时，语义字段绝不静默合并，而是算出 baseline 层面的变更，
 * 交人工评审；并识别"平台 override 存在且 baseline 也变"的三方冲突。
 */

import type {
  ApiBusinessSemantics,
  SemanticSnapshot,
} from '@/types/har';

/** 语义可比较的四个类别 */
export type SemanticField = 'description' | 'sideEffect' | 'fundConsistency' | 'dbAsserts';

export interface SemanticFieldDiff {
  field: SemanticField;
  type: 'added' | 'changed' | 'removed';
  old?: unknown; // 文档旧 baseline 的该项
  new?: unknown; // 文档新 baseline 的该项
  /** 平台是否对该项有 override（存在则为三方冲突，需重点确认） */
  hasOverride: boolean;
  overrideValue?: unknown;
}

export interface SemanticsDiffResult {
  hasChanges: boolean;
  diffs: SemanticFieldDiff[];
}

/** 稳定序列化：用于比较对象/数组是否实质相等（键排序后比对，避免顺序/空白误判） */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value).trim();
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => `${k}:${stableStringify(obj[k])}`).join(',') + '}';
}

/** 两个语义项是否实质相等 */
function semanticEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

const FIELDS: SemanticField[] = ['description', 'sideEffect', 'fundConsistency', 'dbAsserts'];

function getField(snapshot: SemanticSnapshot | undefined, field: SemanticField): unknown {
  if (!snapshot) return undefined;
  return (snapshot as Record<string, unknown>)[field];
}

function isPresent(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

/**
 * 计算文档语义变更
 * @param existing 数据库中已存的语义（含 baseline 与可能的 override）
 * @param incomingBaseline 本次文档导入解析出的新 baseline
 */
export function diffSemantics(
  existing: ApiBusinessSemantics | null | undefined,
  incomingBaseline: SemanticSnapshot | null | undefined
): SemanticsDiffResult {
  const oldBaseline = existing?.baseline;
  const override = existing?.override;
  const diffs: SemanticFieldDiff[] = [];

  for (const field of FIELDS) {
    const oldVal = getField(oldBaseline, field);
    const newVal = getField(incomingBaseline ?? undefined, field);
    const overrideVal = getField(override, field);
    const hasOverride = isPresent(overrideVal);

    const oldPresent = isPresent(oldVal);
    const newPresent = isPresent(newVal);

    if (!oldPresent && newPresent) {
      diffs.push({ field, type: 'added', new: newVal, hasOverride, overrideValue: overrideVal });
    } else if (oldPresent && !newPresent) {
      diffs.push({ field, type: 'removed', old: oldVal, hasOverride, overrideValue: overrideVal });
    } else if (oldPresent && newPresent && !semanticEqual(oldVal, newVal)) {
      diffs.push({
        field,
        type: 'changed',
        old: oldVal,
        new: newVal,
        hasOverride,
        overrideValue: overrideVal,
      });
    }
  }

  return { hasChanges: diffs.length > 0, diffs };
}

/** 单条评审决策 */
export interface SemanticDecision {
  field: SemanticField;
  resolution: 'accept' | 'keepOld' | 'keepOverride';
}

/**
 * 按人工评审决策，应用文档新 baseline，得到最终落库的语义对象
 * - accept：采纳文档新值（写入 baseline）
 * - keepOld：保留文档旧值（baseline 不变）
 * - keepOverride：保留平台调整（override 已在 override 层，baseline 仍采纳新值以保持溯源真实）
 *
 * 注意：baseline 始终如实反映文档（accept 时更新、keepOld 时保留旧），
 * override 层不被本流程改动（平台调整由 ApiEditDialog 单独维护）。
 */
export function mergeSemanticsOnSync(
  existing: ApiBusinessSemantics | null | undefined,
  incomingBaseline: SemanticSnapshot | null | undefined,
  decisions: SemanticDecision[],
  provenancePatch?: { sourceDoc?: string; docVersion?: string; lastSyncedAt?: string }
): ApiBusinessSemantics {
  const base: SemanticSnapshot = { ...(existing?.baseline ?? {}) };
  const decisionMap = new Map(decisions.map((d) => [d.field, d.resolution]));

  for (const field of FIELDS) {
    const resolution = decisionMap.get(field);
    if (!resolution) continue; // 无决策的字段：无变更，保持原 baseline
    const newVal = getField(incomingBaseline ?? undefined, field);

    if (resolution === 'accept' || resolution === 'keepOverride') {
      // baseline 如实采纳文档新值（keepOverride 时 override 层独立保留平台调整）
      if (isPresent(newVal)) {
        (base as Record<string, unknown>)[field] = newVal;
      } else {
        delete (base as Record<string, unknown>)[field];
      }
    }
    // keepOld：baseline 保留旧值，不动
  }

  return {
    baseline: base,
    override: existing?.override,
    provenance: {
      ...(existing?.provenance ?? {}),
      ...(provenancePatch?.sourceDoc ? { sourceDoc: provenancePatch.sourceDoc } : {}),
      ...(provenancePatch?.docVersion ? { docVersion: provenancePatch.docVersion } : {}),
      ...(provenancePatch?.lastSyncedAt ? { lastSyncedAt: provenancePatch.lastSyncedAt } : {}),
    },
    status: existing?.status ?? 'draft',
  };
}
