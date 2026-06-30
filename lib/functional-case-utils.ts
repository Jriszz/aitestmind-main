/**
 * 接口功能用例 DB 行 ↔ 前端 FunctionalCase 互转（序列化/反序列化 JSON 字段）
 * 供 functional-cases CRUD 路由与 explore-generate 落库共用，避免逻辑分叉。
 */

import { safeJsonParse, safeJsonStringify } from './json-utils';
import type { FunctionalCase } from '@/types/functional-case';

/** DB 行 → 前端 FunctionalCase（解析 JSON 字段） */
export function rowToCase(
  row: any
): FunctionalCase & { id: string; createdAt: string; updatedAt: string } {
  return {
    id: row.id,
    module: row.module ?? undefined,
    feature: row.feature ?? undefined,
    title: row.title,
    type: row.type,
    objective: row.objective ?? undefined,
    preconditions: safeJsonParse<string[]>(row.preconditions) ?? [],
    steps: safeJsonParse<FunctionalCase['steps']>(row.steps) ?? [],
    postconditions: safeJsonParse<string[]>(row.postconditions) ?? [],
    cleanup: safeJsonParse<string[]>(row.cleanup) ?? [],
    expectedResults: safeJsonParse<string[]>(row.expectedResults) ?? [],
    businessRules: safeJsonParse<string[]>(row.businessRules) ?? [],
    apiHints: safeJsonParse<string[]>(row.apiHints) ?? [],
    priority: row.priority,
    status: row.status,
    sourceDoc: row.sourceDoc ?? undefined,
    generatedCaseIds: safeJsonParse<string[]>(row.generatedCaseIds) ?? [],
    sourceFingerprint: row.sourceFingerprint ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 前端 FunctionalCase → DB data（序列化 JSON 字段） */
export function caseToData(c: FunctionalCase) {
  return {
    module: c.module || null,
    feature: c.feature || null,
    title: c.title || '未命名用例',
    type: c.type || 'normal',
    objective: c.objective || null,
    preconditions: safeJsonStringify(c.preconditions ?? []),
    steps: safeJsonStringify(c.steps ?? []),
    postconditions: safeJsonStringify(c.postconditions ?? []),
    cleanup: safeJsonStringify(c.cleanup ?? []),
    expectedResults: safeJsonStringify(c.expectedResults ?? []),
    businessRules: safeJsonStringify(c.businessRules ?? []),
    apiHints: safeJsonStringify(c.apiHints ?? []),
    priority: c.priority || 'P2',
    status: c.status || 'draft',
    sourceDoc: c.sourceDoc || null,
    sourceFingerprint: c.sourceFingerprint ?? null,
  };
}

/** 规整 AI 返回的单条用例：保证字段齐全、类型/优先级兜底（供文档/主干链路两条生成链路复用） */
export function normalizeFunctionalCase(c: any, fallbackModule?: string): FunctionalCase {
  return {
    module: c?.module ?? fallbackModule ?? undefined,
    feature: c?.feature ?? undefined,
    title: c?.title || '未命名用例',
    type: (c?.type as FunctionalCase['type']) || 'normal',
    objective: c?.objective ?? undefined,
    preconditions: Array.isArray(c?.preconditions) ? c.preconditions : [],
    steps: Array.isArray(c?.steps)
      ? c.steps.map((s: any) => ({
          action: s?.action || '',
          input: s?.input ?? undefined,
          expected: s?.expected ?? undefined,
        }))
      : [],
    postconditions: Array.isArray(c?.postconditions) ? c.postconditions : [],
    cleanup: Array.isArray(c?.cleanup) ? c.cleanup : [],
    expectedResults: Array.isArray(c?.expectedResults) ? c.expectedResults : [],
    businessRules: Array.isArray(c?.businessRules) ? c.businessRules : [],
    apiHints: Array.isArray(c?.apiHints) ? c.apiHints : [],
    priority: (c?.priority as FunctionalCase['priority']) || 'P2',
    status: 'draft',
  };
}
