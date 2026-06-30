/**
 * 节点角色派生工具
 *
 * 角色从节点 ID 前缀和 isCleanup 标记推断，不作为单独字段存储。
 * 用于 UI 展示和审核场景，帮助用户快速区分前置造数、主业务、后置清理节点。
 */

import { FlowNode, ApiNodeData, ParallelNodeData } from '@/types/test-case';

/**
 * 节点角色类型
 * - precondition: 前置节点（造数/查既有数据），ID 为 step_pre_<n>
 * - main: 主业务节点（被测核心步骤），ID 为 step_<n>
 * - cleanup: 后置清理节点（删除测试数据），ID 为 step_cleanup_<n> 或 isCleanup=true
 */
export type NodeRole = 'precondition' | 'main' | 'cleanup';

/**
 * 从节点推导角色
 *
 * 推导规则（按优先级）：
 * 1. isCleanup=true → cleanup
 * 2. ID 前缀 step_cleanup_ → cleanup
 * 3. ID 前缀 step_pre_ → precondition
 * 4. 其他 → main
 *
 * @param node 流程图节点
 * @returns 节点角色
 */
export function deriveNodeRole(node: FlowNode): NodeRole {
  // 只有 API 节点和并行节点有角色概念
  if (node.type !== 'api' && node.type !== 'parallel') {
    return 'main';
  }

  const data = node.data as ApiNodeData | ParallelNodeData;

  // 优先级 1: isCleanup 标记
  if (data.isCleanup) {
    return 'cleanup';
  }

  // 优先级 2: ID 前缀 step_cleanup_
  if (node.id.startsWith('step_cleanup_')) {
    return 'cleanup';
  }

  // 优先级 3: ID 前缀 step_pre_
  if (node.id.startsWith('step_pre_')) {
    return 'precondition';
  }

  // 默认: main
  return 'main';
}

/**
 * 获取角色的显示名称（中文）
 */
export function getNodeRoleLabel(role: NodeRole): string {
  const labels: Record<NodeRole, string> = {
    precondition: '前置',
    main: '主步骤',
    cleanup: '清理',
  };
  return labels[role];
}

/**
 * 获取角色的说明文案（用于 tooltip）
 */
export function getNodeRoleDescription(role: NodeRole): string {
  const descriptions: Record<NodeRole, string> = {
    precondition: '前置造数或查询节点，用于满足主业务步骤的前置条件',
    main: '主业务步骤，被测试的核心接口',
    cleanup: '后置清理节点，用于删除或复原测试数据',
  };
  return descriptions[role];
}
