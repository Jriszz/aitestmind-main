# AI Agent 能力与原理总览

> 本文档梳理当前系统的所有 AI 入口（俗称"agent"）。
> 严格说，本系统**没有"多 agent 协作"架构**——每个入口都是一次独立的 LLM 调用 + Function Calling，靠不同的 system prompt + 工具子集扮演不同角色。本文档把每个角色当作一个"逻辑 agent"来描述其能力与原理。
>
> 配套阅读：[DESIGN_DECISIONS.md](DESIGN_DECISIONS.md)（红线 #6：AI 作为"工具+prompt 指导"扩展，不直接产出底层 flowConfig/SQL）。

## 1. 总览

| # | Agent（路由） | 角色定位 | 输入 | 输出 | 落库 | 是否流式（SSE） |
|---|---|---|---|---|---|---|
| 1 | [smart-generate](../app/api/ai/smart-generate/route.ts) | **接口/E2E 用例生成主循环**：自由式从用户描述生成可执行用例 | 自然语言需求 + testType (api/e2e) | 可执行 TestCase（含 flowConfig/steps） | ✅ | ✅ |
| 2 | [explore-plan](../app/api/ai/explore-plan/route.ts) | **场景设计师**：在给定接口范围内自主推导"该测哪些场景" | apiIds[] | 场景清单（含来源指纹） | ❌ | ❌ |
| 3 | [explore-generate](../app/api/ai/explore-generate/route.ts) | **场景/功能用例 → 可执行用例的组装器**：把已审定的场景或功能用例落地为可执行用例 | scenarios[] 或 functionalCases[] | 可执行 TestCase（带追溯指纹） | ✅ | ✅ |
| 4 | [chain-explore](../app/api/ai/chain-explore/route.ts) | **链路发散师**：给定主干链路，沿链补全异常/对账/边界用例 | flowName + nodes[] | 跨服务接口功能用例（设计层） | ❌ | ❌ |
| 5 | [functional-cases/generate](../app/api/ai/functional-cases/generate/route.ts) | **需求文档分析师**：从需求/规格文档抽出接口功能用例 | docText + module | 接口功能用例（设计层） | ❌ | ❌ |

> 另有 `app/api/ai/test-connection/route.ts` 仅用于厂商连通性测试，不算 agent。

**两层结构**：
- **设计层 agent**（2/4/5）只产出"人能理解、能审、能改"的测试设计，**不写接口 path/JSON/SQL**，不落库；
- **生成层 agent**（1/3）调用 Function Calling 工具把设计落到可执行的 flowConfig，落库为 TestCase。

设计层与生成层之间通过**用例名 + 来源指纹/功能用例 id** 做追溯，避免重复生成、保留正反向链路。

---

## 2. 共享底座

所有 agent 共用以下机制（在 [lib/ai-tools/index.ts](../lib/ai-tools/index.ts) 与 [lib/ai-client](../lib/ai-client.ts) 中实现）：

### 2.1 Function Calling 工具集（`AI_TOOLS`）
仅暴露给"生成层"agent（smart-generate / explore-generate）：

| 工具 | 作用 |
|---|---|
| `hierarchical_search_apis` | 按 4 层分类（platform / component / feature / apiName）+ method 检索 API 仓库 |
| `get_api_detail` | 返回单个 API 的请求/响应结构、`paramConstraints`（required/enums/ranges/formats）、`businessSemantics`（仅 `confirmed` 状态、override 优先于 baseline，见决策 5） |
| `smart_search_delete_api` | 给定创建型 API id，找配套的删除 API（用于 cleanup 节点） |
| `assemble_and_create_test_cases` | 接收"轻量编排指令"（orchestrationPlan），后端组装为完整 flowConfig（节点位置、ParamValue 格式、edges、断言）并落库 |

**设计层** agent 各自定义专属"submit_xxx"工具，强制 LLM 用结构化输出（parameters schema 限定字段），避免兼容网关返回脏前缀时无法解析。

### 2.2 关键设计点
- **AI 不直接产 flowConfig**：智能体只输出"业务值 + 变量引用关系"的轻量编排指令，由 [lib/ai-tools/assembler.ts](../lib/ai-tools/assembler.ts) 在后端组装。这是红线 #6 的落地。
- **认证由平台全局注入**：所有 agent 的 prompt 都明确写"不要生成登录节点"，平台的认证 Token 配置会自动给请求加 Authorization 头。
- **JSON 容错**：smart-generate 自带尾随逗号、未闭合括号/字符串的修复（`tryFixJSON`）；其他设计层 agent 用 `parseLooseJsonObject` 处理网关脏前缀（如 `{}{"scenarios":[...]}`）。
- **服务端去重**：场景/用例的来源指纹在服务端计算（[lib/semantics-fingerprint.ts](../lib/semantics-fingerprint.ts)），AI 无法伪造。

---

## 3. 五个 Agent 详解

### Agent 1 — smart-generate（用例生成主循环）

**入口**：`POST /api/ai/smart-generate`，body `{ userInput, testType }`

**原理**：
1. 加载统一 system prompt（[system-prompt.ts](../lib/ai-prompts/system-prompt.ts)），目前 api / e2e 共用同一份。
2. 进入 **Function Calling 循环**（最多 15 轮）：
   - 调 LLM → 拿到 toolCalls
   - 依次执行 `hierarchical_search_apis` / `get_api_detail` / `smart_search_delete_api` / `assemble_and_create_test_cases`
   - 把工具结果作为 `tool` 消息回喂给 LLM
   - 直到 LLM 不再调用工具（生成完成）或达到迭代上限
3. 全程 SSE 流式推送：`thinking` / `tool_call (start/progress/success/error)` / `content` / `summary`。

**核心能力**：
- 基于 `paramConstraints` 自动覆盖 required / enums / ranges / formats 异常用例
- 基于 `businessSemantics` 生成"操作 → 查询 → 对账"的资金守恒/落库验证用例
- 同一批用例统一 `category`，正常用例自动加 `${{random(8)}}` 防唯一性冲突
- 创建型用例自动配套 cleanup 节点（`isCleanup: true`）

**适用场景**：用户已经知道要测什么，用自然语言描述需求一次性生成。

---

### Agent 2 — explore-plan（场景设计师，设计层）

**入口**：`POST /api/ai/explore-plan`，body `{ apiIds, includeGenerated? }`

**原理**：
1. 拉取入参所有接口的 detail（含 paramConstraints + businessSemantics）。
2. 服务端对每个接口枚举"语义项 → 指纹"，建立 `(apiId, sourceField, sourceKey) → fingerprint` 映射。
3. 查该范围内**已生成过的指纹集合**（`TestCase.sourceFingerprint`），作为隐形去重依据。
4. **按 ≤2 个接口分批**串行调 LLM（防 token 超限/超时），每批用 [explore-prompt.ts](../lib/ai-prompts/explore-prompt.ts) 引导 AI 自主推导场景，强制走 `submit_exploration_plan` 工具结构化输出。
5. 服务端给每个场景附指纹、标记 `alreadyGenerated`，默认隐藏已生成的（除非 `includeGenerated`）。
6. 单批失败不影响其他批，回传 `failedCount` 给前端不静默吞错。

**Prompt 哲学**：**主动覆盖（聪明），不是忠实执行（听话）**——鼓励 AI 补人想不到的场景，尤其是 businessSemantics 里跨字段/跨接口的业务规则。

**输出场景结构**（不落库）：
```json
{
  "title": "换汇下单 - 资金守恒对账",
  "type": "business",          // normal | param | business | e2e
  "apiIds": ["api_xxx"],
  "sourceField": "fundConsistency",
  "sourceKey": "守恒",
  "rationale": "...",
  "steps": ["..."]
}
```

**适用场景**：已有接口仓库，想让 AI 主动告诉我"这些接口该测什么"。

---

### Agent 3 — explore-generate（设计→可执行的组装器）

**入口**：`POST /api/ai/explore-generate`，body 二选一：
- `{ scenarios }`（来自 explore-plan，接口已知）
- `{ functionalCases }`（来自 functional-cases/generate 或 chain-explore，接口未知）

**原理**：
1. 复用 smart-generate 的 system prompt 和 Function Calling 工具集（**同引擎，不同入口提示词**）。
2. 根据入参类型构造**定向指令**：
   - 场景路径：接口已知，AI 直接 `get_api_detail` 后组装。
   - 功能用例路径：AI 需先用 `hierarchical_search_apis` 按 `apiHints` / 步骤动作检索接口，把业务步骤映射成接口节点。
3. **分批执行**（场景每批 8 条，功能用例每批 4 条），每批一个独立 Function Calling 循环。
4. **追溯指纹双向写入**：
   - 用例名 → `sourceFingerprint`（来自 explore-plan 的指纹），落到 `TestCase.sourceFingerprint`，构成隐形去重的下次依据。
   - 用例名 → `sourceFunctionalCaseId`（功能用例链路），并在生成完成后**回填**功能用例的 `generatedCaseIds`（正向追溯）+ 标记 `status: generated`。
5. 服务端强制注入工作流标签（`AI探索` / `待编排` / 类型标签），AI 无需感知。

**关键 prompt 约束**（功能用例链路）：
- 认证类前置不生成节点（平台全局注入）
- 数据类前置生成 `step_pre_<n>` 节点 + 配套 cleanup
- 环境类前置不生成节点，写到 description 让人审
- 残留前端措辞按"接口契约视角"过滤（不断 UI 元素）
- 不写 SQL，dbAsserts 转为接口层断言

**适用场景**：人工评审过设计层产物（场景/功能用例）后，一键落到可执行用例。

---

### Agent 4 — chain-explore（链路发散师，设计层）

**入口**：`POST /api/ai/chain-explore`，body `{ flowName, nodes }`

**原理**：
1. 主干节点上限 20（防超长链爆仓），节点可选关联已沉淀的 `interfaceFunctionalCase`。
2. 服务端拉取每个关联节点的"能力/规则"作为上下文（title/objective/steps/businessRules/apiHints），未关联节点标记 `unmatched`。
3. 调 LLM（[chain-explore-prompt.ts](../lib/ai-prompts/chain-explore-prompt.ts)），强制 `submit_chain_cases` 结构化输出。
4. 输出按业务流名归到 `module`。

**Prompt 哲学**：人给主干（happy path），AI 沿链发散最易漏、最值钱的部分——
- 主干正向（1 条 e2e）
- 节点级异常（每个节点失败/拒绝时整条链如何）
- 对账/一致性（资金/数量守恒、状态最终一致）
- 边界/状态机/幂等

**关键约束**：
- **只依据给定的节点能力/规则设计预期**；规则缺失的节点写"需人工确认"，不臆造。
- 步骤 action 标注所属节点/服务（如 `[风控] 提交风控校验`），便于下游跨服务检索。
- 复用 [interface-perspective.ts](../lib/ai-prompts/interface-perspective.ts) 强制接口契约视角，不写 path/JSON/SQL。

**适用场景**：已有跨服务业务流的主干骨架，想让 AI 补全主干之外的测试。

---

### Agent 5 — functional-cases/generate（需求文档分析师，设计层）

**入口**：`POST /api/ai/functional-cases/generate`，body `{ docText, module? }`

**原理**：
1. **三道闸防 token 爆仓**：
   - 闸 1：文档总长 ≤ 50000 字符，超限截断
   - 闸 2：分段（[lib/doc-splitter.ts](../lib/doc-splitter.ts) 按 Markdown 标题/段落，每段 ~3000 字）后 ≤ 12 段
   - 闸 3：单段最多产出 8 条用例（prompt 内约束 + 服务端兜底截断）
2. 全局上下文头（模块 + 文档开头摘要）拼进每段，避免分段丢背景。
3. **串行**逐段调 LLM（[functional-case-prompt.ts](../lib/ai-prompts/functional-case-prompt.ts)），强制 `submit_functional_cases` 结构化输出。
4. 单段失败不致命，回传 `failedSegments`、`truncated` 给前端不静默。
5. 跨段按 title 去重合并。

**Prompt 哲学**：测试设计而非可执行脚本，**用业务语言**（不写接口 path/JSON/SQL），覆盖要全（normal / param / business / e2e / permission / state 六类）。共用 `INTERFACE_PERSPECTIVE_BLOCK` 约束接口契约视角。

**输出**：完整功能用例（含 preconditions / steps / postconditions / cleanup / expectedResults / businessRules / apiHints / priority），交人工评审编辑后由 explore-generate 落地。

**适用场景**：拿到需求/规格文档，让 AI 抽出测试设计清单。

---

## 4. 工作流串联

典型的两条端到端链路：

### 链路 A：接口范围 → 探索 → 生成（沉淀型）
```
[已有 API 仓库]
   └─ explore-plan (Agent 2)         ← AI 自主推导场景，附指纹
       └─ [人工审阅/取舍]
           └─ explore-generate (Agent 3, 场景路径)   ← 落地为可执行 TestCase
               └─ TestCase.sourceFingerprint        ← 下次 explore-plan 自动隐藏已生成场景
```

### 链路 B：需求文档/主干链路 → 功能用例 → 生成（探索型）
```
[需求文档]                    [人画的主干链路]
     │                              │
functional-cases (Agent 5)    chain-explore (Agent 4)
     └──────────┬───────────────────┘
                ▼
        [接口功能用例（设计层，待编排）]
                ├─ 落库为 InterfaceFunctionalCase
                └─ explore-generate (Agent 3, 功能用例路径)
                       ├─ AI 检索 API 仓库（hierarchical_search_apis）
                       ├─ 落库 TestCase
                       └─ 反向回填 InterfaceFunctionalCase.generatedCaseIds
```

### 兜底链路：直接对话
```
[自然语言需求] → smart-generate (Agent 1) → TestCase
```

---

## 5. 共性约束（红线提醒）

| 约束 | 体现 |
|---|---|
| AI 不直接产 flowConfig/SQL | 生成层只产 orchestrationPlan，由 [assembler.ts](../lib/ai-tools/assembler.ts) 组装；dbAsserts 转接口层断言 |
| 业务语义不被 AI 自动改写 | `get_api_detail` 只注入 `confirmed` 状态、override 优先；AI 仅消费不写回 |
| 不臆造接口 | 设计层只产 `apiHints` 关键词，由生成层走 `hierarchical_search_apis` 查真实接口；找不到时在 description 标"需人工准备" |
| 接口契约视角 | `INTERFACE_PERSPECTIVE_BLOCK` 强制断言只断响应字段，不断 UI 元素/文案/跳转 |
| 防 token 爆仓 | 文档分段（Agent 5）、接口分批（Agent 2/3）、迭代上限（smart-generate 15 / explore-generate 20）|
| 失败不静默 | 各 agent 回传 `failedCount` / `failedSegments` / `truncated` 给前端 |

---

## 6. 现状与定位

- **架构上是"多入口 + 单 agent"**，每次调用都是独立的一次 LLM + Function Calling，agent 之间通过**业务数据**（功能用例落库、追溯指纹）串联，**不通过 agent-to-agent 通信**。
- 这与"多 agent 协作"的差别：当前任意一次失败不影响其他入口；不存在 agent 之间互相评审/挑刺的对抗结构。
- 何时考虑升级为多 agent，参考 [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) 与团队约定的触发信号（如 AI 用例错误率高需自动 review、单次涉及 >20 接口装不下、组装 prompt 复杂到必须拆分等）。
