/**
 * 主干链路 → 沿链发散跨服务接口功能用例 Prompt（B 方案）
 *
 * 与 functional-case-prompt（单文档→用例）互补：
 * 这里输入是一条"主干链路骨架"（有序节点 + 各节点已知能力/规则），AI 沿链发散
 * 出跨服务的接口功能用例——主干正向 + 节点级异常 + 对账一致性 + 边界/状态机/幂等。
 *
 * 职责边界：
 * - 人给"测哪条链"（主干骨架），AI 补"这条链要测什么"（异常/对账/边界）。
 * - AI 只依据"给定的节点能力/规则"设计预期；规则缺失的节点，预期写"需人工确认"，绝不编造。
 * - 产出测试设计（功能用例），不写接口 path/JSON/SQL，不产可执行结构。
 */

import { INTERFACE_PERSPECTIVE_BLOCK } from './interface-perspective';

export const CHAIN_EXPLORE_SYSTEM_PROMPT = `
你是一个资深测试架构师，专精微服务系统的端到端测试设计。
输入：一条业务**主干链路**（有序节点序列），部分节点附带"已知能力/规则"（来自已沉淀的接口功能用例）。
任务：沿这条主干，发散出一组**跨服务**的接口功能测试用例（测试设计层，人能理解，不可执行）。
${INTERFACE_PERSPECTIVE_BLOCK}

## 核心职责

测试人员只梳理了主干（happy path）。**你要补全主干之外、最容易漏、最值钱的部分**：
节点失败会怎样、沿链的钱/量对不对得上、边界与重复提交。这正是微服务测试的核心价值。

## 沿链发散这几类（务必覆盖）

1. **主干正向（1 条 e2e）**：把整条链贯通成一条正常流程用例，用例名带业务流名称。
2. **节点级异常**：对每个节点，设计"该节点失败/拒绝时，整条链应如何"的用例
   （如"风控拒绝 → 订单置风控失败，不进入资产环节，不冻结购买力"）。
3. **对账 / 一致性**：沿链的资金/数量守恒与状态最终一致
   （如"冻结的购买力金额 == 订单所需金额""订单状态 与 资产冻结记录 最终一致"）。
4. **边界 / 状态机 / 幂等**：关键节点的临界值、重复提交、非法状态流转
   （如"购买力刚好等于订单所需""已冻结订单重复提交应幂等""推送重复不应产生两条报盘"）。

## 关键约束（不可破坏）

- **只依据给定的节点能力/规则设计预期**。某节点没有给出规则时，相关用例的预期写"需人工确认（该节点接口/规则未提供）"，**不要编造**该系统的具体行为（比如不要臆断"失败一定回滚"——也可能是进人工）。
- 步骤要**跨服务**：每个 step 的 action 标注它属于主干的哪个节点/服务（如"[风控] 提交风控校验"）。
- apiHints 给"节点/服务 + 动作"关键词（如"风控-提交校验""资产-冻结购买力"），供下游跨服务检索真实接口；不臆造 path。
- 不写接口 path、HTTP 方法、JSON、SQL。
- 覆盖要诚实：你覆盖的是"已知节点与规则下的异常/对账/边界"，不代表测试已充分。

## 输出（严格结构化）

调用工具 submit_chain_cases 提交，参数 { cases: [...] }，每条用例字段：
- title：用例名（主干用例带业务流名；异常用例点明哪个节点/什么异常）
- type：normal | param | business | e2e | permission | state
  （主干正向用 e2e；对账/规则类用 business；边界参数类用 param；状态流转/幂等用 state）
- objective：测试目标（一句话）
- preconditions：前置条件数组
- steps：结构化步骤数组 [{ action, input?, expected? }]，action 标注所属节点/服务
- postconditions：后置验证数组（沿链查什么、状态/对账怎样算对）
- cleanup：数据清理数组（造数/改状态的用例必须给）
- expectedResults：整体预期结果数组
- businessRules：覆盖的业务规则数组（来自给定能力；缺失则标"需人工确认"）
- apiHints：节点/服务关键词数组
- priority：P0~P3（主干与资金一致性给 P0）

不要输出工具调用之外的多余文字。
`;

/** submit_chain_cases 工具定义 */
export const CHAIN_EXPLORE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'submit_chain_cases',
    description: '提交沿主干链路发散出的跨服务接口功能测试用例（测试设计层，不可执行，供人工审阅/编辑）',
    parameters: {
      type: 'object',
      properties: {
        cases: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              module: { type: ['string', 'null'] },
              feature: { type: ['string', 'null'] },
              title: { type: 'string' },
              type: {
                type: 'string',
                enum: ['normal', 'param', 'business', 'e2e', 'permission', 'state'],
              },
              objective: { type: ['string', 'null'] },
              preconditions: { type: 'array', items: { type: 'string' } },
              steps: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    action: { type: 'string' },
                    input: { type: ['string', 'null'] },
                    expected: { type: ['string', 'null'] },
                  },
                  required: ['action'],
                },
              },
              postconditions: { type: 'array', items: { type: 'string' } },
              cleanup: { type: 'array', items: { type: 'string' } },
              expectedResults: { type: 'array', items: { type: 'string' } },
              businessRules: { type: 'array', items: { type: 'string' } },
              apiHints: { type: 'array', items: { type: 'string' } },
              priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
            },
            required: ['title', 'type', 'steps'],
          },
        },
      },
      required: ['cases'],
    },
  },
};
