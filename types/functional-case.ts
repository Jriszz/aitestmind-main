/**
 * 接口功能用例类型（测试设计层，人能理解，不可执行）
 *
 * 由 AI 从需求/功能规格文档抽取，人工审阅/编辑后，经 explore-generate 探索 API
 * 生成可执行的待编排 TestCase。与 TestCase（可执行编排）语义不同，独立存储。
 */

/** 功能用例类型 */
export type FunctionalCaseType =
  | 'normal' // 正常场景
  | 'param' // 参数校验
  | 'business' // 业务语义/规则
  | 'e2e' // E2E 流程
  | 'permission' // 权限
  | 'state'; // 状态流转

/** 功能用例优先级 */
export type FunctionalCasePriority = 'P0' | 'P1' | 'P2' | 'P3';

/** 结构化测试步骤：与下游接口节点 + 断言天然对应 */
export interface FunctionalStep {
  /** 这一步做什么（业务语言，如"提交换汇申请"） */
  action: string;
  /** 输入/参数说明（如 "from=USD, to=HKD, amount=100"），可空 */
  input?: string;
  /** 该步预期（如"提交成功，返回申请单号"），可空 */
  expected?: string;
}

/** 一条完整的接口功能用例 */
export interface FunctionalCase {
  id?: string;
  module?: string;
  feature?: string;
  title: string;
  type: FunctionalCaseType;
  objective?: string;
  /** 前置条件 */
  preconditions?: string[];
  /** 结构化测试步骤 */
  steps?: FunctionalStep[];
  /** 后置验证（操作后该查什么、状态/数据怎样算对） */
  postconditions?: string[];
  /** 数据清理（撤销/删除/恢复，供下游加后置清理节点） */
  cleanup?: string[];
  /** 整体预期结果 */
  expectedResults?: string[];
  /** 覆盖的业务规则 */
  businessRules?: string[];
  /** 可能涉及的接口关键词（供 AI 探索检索，不臆造 path） */
  apiHints?: string[];
  priority?: FunctionalCasePriority;
  status?: string;
  sourceDoc?: string;
  generatedCaseIds?: string[];
}
