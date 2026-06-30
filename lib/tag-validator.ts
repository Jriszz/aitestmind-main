/**
 * 标签校验与规范化（决策 11，已按"单层池"重构）
 */

import { validateTags } from './constants/tags';
import { safeJsonParse } from './json-utils';

/**
 * 规范化并校验标签
 * - 去重、trim
 * - 移除已废弃的标签（如 '待编排'、'AI探索'、'对话生成'、'手动创建'、'语义派生' —— 这些都是历史污染）
 * - 枚举校验（单层池）
 *
 * @param tags 输入标签（数组 / JSON 字符串）
 * @param _status 用例状态（保留参数兼容旧调用方，不再使用）
 * @returns { tags: string[], error?: string }
 */
export function normalizeAndValidateTags(
  tags: any,
  _status?: string | null
): { tags: string[]; error?: string } {
  // 解析输入
  let list: any[] = [];
  if (Array.isArray(tags)) {
    list = tags;
  } else if (typeof tags === 'string') {
    const parsed = safeJsonParse(tags);
    list = Array.isArray(parsed) ? parsed : [];
  }

  // 基础清理：去除空白、去重
  const cleaned = Array.from(
    new Set(list.filter((tag) => typeof tag === 'string' && tag.trim()))
  );

  // 移除已废弃的标签（历史污染兼容：自动剥离，不报错）
  // - '待编排'：旧版用 tag 表达"待处理"状态，现归 lifecycle 管
  // - 来源类标签：归 AssetLineage 管（决策 10），不进 tag
  const DEPRECATED_TAGS = new Set([
    '待编排',
    'AI探索', '对话生成', '手动创建', '语义派生',
    'AI生成', '接口测试', 'E2E测试', '流程测试', // 旧 system-prompt 里残留的自由文本
  ]);
  const withoutDeprecated = cleaned.filter((tag) => !DEPRECATED_TAGS.has(tag));

  // 枚举校验
  const enumValidation = validateTags(withoutDeprecated);
  if (!enumValidation.valid) {
    return {
      tags: [],
      error: `标签不在枚举范围内: ${enumValidation.invalid.join(', ')}。请从固定标签枚举中选择。`,
    };
  }

  return { tags: withoutDeprecated };
}
