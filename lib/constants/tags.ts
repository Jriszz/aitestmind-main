/**
 * 用例标签枚举定义（决策 11，已按"单层池"重构）
 *
 * 核心原则：
 * - 单层池，10 个固定标签，可多选可空
 * - "来源"不进 tag（由 AssetLineage 管，决策 10）
 * - "状态"不进 tag（由 lifecycle 状态机管，决策 10）
 * - "优先级"不进 tag（由 TestCase.priority 管，决策 8）
 * - tag 只表达"用例在测什么"和"属于哪个业务领域"两件事
 *
 * 变更约束：
 * - 此枚举需项目管理员审批后修改
 * - AI prompt / 前端 / 后端校验全部依赖此文件
 */

/**
 * 场景类标签（描述用例在测什么）
 * 与 FunctionalCase.type 对齐，AI 可由场景结构化字段映射得来
 */
export const SCENARIO_TAGS = [
  '正常场景',
  '参数校验',
  '业务语义',
  'E2E流程',
  '权限校验',
  '状态流转',
] as const;

/**
 * 业务域标签（描述用例属于哪个业务领域）
 * 用于跨场景的业务聚合（如"看所有资金相关用例"）
 */
export const DOMAIN_TAGS = [
  '资金对账',
  '落库验证',
  '幂等性',
  '超时重试',
] as const;

/**
 * 所有合法标签（单层池）
 */
export const ALL_VALID_TAGS = [
  ...SCENARIO_TAGS,
  ...DOMAIN_TAGS,
] as const;

export type ValidTag = typeof ALL_VALID_TAGS[number];

/**
 * 供 UI 分组展示用（仅为视觉分组，校验时是单层池）
 */
export const TAG_GROUPS = {
  scenario: {
    label: '场景类型',
    tags: SCENARIO_TAGS,
  },
  domain: {
    label: '业务域',
    tags: DOMAIN_TAGS,
  },
} as const;

/**
 * 场景类型映射（explore-generate 用）
 * 把 scenario.type 转成对应的场景标签
 */
export const SCENARIO_TYPE_MAP: Record<string, typeof SCENARIO_TAGS[number]> = {
  normal: '正常场景',
  param: '参数校验',
  business: '业务语义',
  e2e: 'E2E流程',
  permission: '权限校验',
  state: '状态流转',
};

/**
 * 校验标签数组是否合法
 * 单层池：所有标签都在 ALL_VALID_TAGS 里即合法，无组合规则限制
 *
 * @param tags 待校验的标签数组
 * @returns { valid: boolean, invalid: string[] }
 */
export function validateTags(tags: string[]): { valid: boolean; invalid: string[] } {
  const validSet = new Set<string>(ALL_VALID_TAGS);
  const invalid = tags.filter(tag => !validSet.has(tag));
  return {
    valid: invalid.length === 0,
    invalid,
  };
}
