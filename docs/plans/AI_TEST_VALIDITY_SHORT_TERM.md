# AI 用例有效性提升 · 短期方案

> 背景：当前 AI 经常生成「空查询三态」「断言只校验 status==200」「单接口查询用例无前置数据」这类**伪用例** —— 语法上完美、语义上空洞，通过了也证明不了什么。
>
> 根因（详见对话）：LLM 任务最短路径偏好 + 训练语料里弱断言用例占绝大多数 + 当前 prompt/工具没有把"测试有效性"这个隐性标准显性化。
>
> 短期目标：**用 prompt + 工具层的轻量改造，把伪用例在生成阶段就暴露/拦截。** 不动 schema、不动执行器、不引入新依赖。

---

## 涉及红线对齐

- 决策 7：AI 能力作为"工具 + prompt 指导"扩展 —— 本方案完全在工具集和 prompt 里改，不让 AI 直接产出底层 flowConfig
- 决策 10：所有新增工具按 `workspaceId` 收敛
- 决策 12：本方案不改 `TestCaseFeedback`，是为它"事前"补位（事前自检 vs 事后反馈）

---

## 四项改动总览

| # | 改动 | 文件 | 类型 |
|---|------|------|------|
| 1 | search 结果增强：附带同业务实体 CRUD 全景 | `lib/ai-tools/hierarchical-search.ts` | 改 |
| 2 | 新增 `validate_test_case` 工具（纯规则） | `lib/ai-tools/validate-test-case.ts` (新) + `lib/ai-tools/index.ts` + `app/api/ai/smart-generate/route.ts` | 加 |
| 3 | system prompt：加"用例有效性自检清单" + 升级断言示例 | `lib/ai-prompts/system-prompt.ts` | 改 |
| 4 | system prompt：标注 search 结果的 siblingCrud 字段语义 + 工作流新增 validate 步骤 | `lib/ai-prompts/system-prompt.ts` | 改 |

---

## 改动 1：search 结果附带 siblingCrud（同实体 CRUD 全景）

**目标**：让 AI 看到 query 接口的同时，能立刻知道"这个实体在仓库里还有没有 create/update/delete"，从而**有机会**升级用例（造数据 → 查询）。

### 现状
`hierarchicalSearchApis()` 返回的每个 API 只包含 `{ id, name, method, path, platform, component, feature }`，AI 看不到同实体下的其他动作。

### 改动
在 `hierarchical-search.ts` 的 `SearchResult` 上**追加一个字段**：

```ts
interface SearchResult {
  id: string;
  name: string;
  description: string | null;
  method: string;
  path: string;
  platform: string | null;
  component: string | null;
  feature: string | null;
  // 新增：同业务实体下的其他 CRUD 动作（仅返回轻量摘要）
  siblingCrud?: Array<{
    id: string;
    name: string;
    method: string;
    action: 'create' | 'update' | 'delete' | 'query' | 'other'; // 按 method+name 关键词推断
  }>;
}
```

**实现方式**：
1. 评分排序完拿到 topN 后，按 `(workspaceId, platform, component, feature)` 三元组聚合
   - 同 `feature` 下的其他接口，取 method+name 关键词推断 action（复用 `index.ts` 里 `willCreateData` 的关键词逻辑，外加 query/update/delete 关键词）
   - 每条只返回 `{id, name, method, action}`，不返回详情，控制 token
2. 同 feature 没东西就回退到同 component；都没就 siblingCrud 为空数组（不是 undefined，让 AI 看清楚"真的没有"）
3. 单条 siblingCrud 长度上限 10 条（避免 feature 下接口太多撑爆）

### action 推断规则（与现有 `willCreateData` 风格一致）

| action | 触发关键词（name/path 含任一即可） + method |
|---|---|
| create | 创建/新增/添加/注册/保存/create/add/register/save，且 method ∈ {POST, PUT} |
| update | 修改/更新/编辑/update/edit/modify/patch，且 method ∈ {PUT, PATCH, POST} |
| delete | 删除/移除/delete/remove，且 method = DELETE |
| query | 查询/获取/列表/详情/query/list/get/detail，且 method = GET |
| other | 兜底 |

**注意**：推断是软启发，不强行准确；目的是让 AI 看到"哦旁边有 create"就够了，错判一两个不影响。

### 影响面
- `hierarchicalSearchApis()` 调用方：`route.ts` 第 308 行 + `index.ts` 的 `extractLayerKeywords` 不受影响
- 数据库查询多一次（按 feature 聚合），但 select 字段极少（id/name/method/path）；同 workspaceId 索引已有，性能可忽略
- prompt 同步标注此字段（见改动 4）

---

## 改动 2：新增 `validate_test_case` 工具（纯规则）

**目标**：在 AI 调用 `assemble_and_create_test_cases` **之前**强制走一道自检，把伪用例的常见模式当 warning 抛回去。

### 工具行为

**入参**：`orchestrationPlan`（与 assemble_and_create_test_cases 同构）+ `workspaceId`

**出参**：
```ts
{
  testCases: Array<{
    name: string;
    warnings: Array<{
      code: string;      // 规则编号，便于 prompt 引用
      severity: 'warn' | 'info';
      message: string;   // 给 AI 看的人话
      nodeId?: string;   // 命中哪个节点
    }>;
  }>;
  summary: { totalWarnings: number; rulesTriggered: string[] };
}
```

**规则集（v1，全部纯静态分析）**：

| code | 触发条件 | message 示例 |
|---|---|---|
| `WEAK_ASSERTION_ONLY_STATUS` | 节点 assertions 只有 `status==200`，无其他字段 | "节点 step_1 只断言了 HTTP 200，无法验证业务正确性。建议补充业务码或关键字段断言。" |
| `QUERY_WITHOUT_PRECONDITION` | 用例只有 1 个 query 类节点（GET + 名称含查询/列表/获取），且无前置 create/update 节点；且仓库里**存在**同实体 create 接口（查 siblingCrud 一致逻辑） | "用例只查询 X 接口、无前置造数据步骤。仓库里有同实体的创建接口（apiId=xxx），如果意图是验证业务功能（不只是接口契约），建议组装成『造数据→查询』flow。如果意图就是契约测试，请在用例 description 里写明并保留。" |
| `ASSERTION_ON_EMPTY_LIST` | 断言里出现 `total > 0` / `list.length > 0` / `returnObject[0]` 等"非空假设"，但该 API 是查询类且用例无前置造数据 | "节点 step_1 断言假设了结果非空（field=`returnObject[0].id`），但用例未造数据。如果环境无种子数据，此断言会失败；建议改为条件断言或先造数据。" |
| `MISSING_FILTER_VERIFICATION` | 查询类节点的 queryParams 里传了 status/state/type 等过滤参数，但 assertions 里没有对应字段一致性校验 | "节点 step_1 传了 queryParams.status='Active'，但未断言返回结果的 status 字段。过滤逻辑可能没生效也察觉不到。建议补：list 非空时每条记录 status 必须等于 Active。" |
| `IDENTICAL_PARAM_VARIANTS` | 同一用例批次里有 N 个用例只是 queryParams 某一个枚举字段不同、其他完全相同，且都无前置造数据 | "本批次有 3 个用例只是 status 枚举值不同（Active/Suspended/Closed），均无前置造数据。如果意图是契约测试，建议合并为 1 个用例 + 数据驱动；如果意图是功能验证，必须为每种状态准备数据。" |
| `CLEANUP_MISSING` | 节点含 create 类 API（按 siblingCrud 同款 action 推断）但用例无 isCleanup 节点 | "用例创建了资源但无清理节点。建议调用 smart_search_delete_api 查找删除接口并加 cleanup。" |

**规则文件位置**：`lib/ai-tools/validate-test-case.ts`
- 单文件实现，每条规则是一个纯函数 `(plan, ctx) => Warning[]`
- `ctx` 里塞 `siblingCrudByApiId`（按 plan 里用到的 apiId 提前查一次）
- 不抛错，全部转 warning；严重错误（比如 apiId 不存在）当 `severity: warn` + code `INVALID_API_ID` 返回

### 工具注册
- `lib/ai-tools/index.ts` 在 `AI_TOOLS` 末尾追加 schema
- `app/api/ai/smart-generate/route.ts` 在 dispatch 链路里加一支 `else if (functionName === 'validate_test_case')`，与其他工具同款 SSE 输出

---

## 改动 3：system prompt 加"用例有效性自检清单"

在现有 prompt 的 "🎯 工作方式" 之后、"📝 编排指令格式" 之前，插入新的章节：

```markdown
## 🧪 用例有效性自检（生成前必读）

在输出编排指令之前，对照下面 5 条问自己一遍。任何一条答不上来，就回到 search/get_api_detail 重新设计；不要硬交付。

1. **这个用例如果失败了，能定位什么？如果通过了，能证明什么？** —— 一个永远不会失败的用例（比如对空结果的查询断言 status==200）等于没测。
2. **接口需要的前置数据从哪来？** —— 查询类接口如果意图是验证业务功能，仓库里必须有对应的 create 接口（看 search 返回的 `siblingCrud` 字段）；没有就在用例 description 里写明"契约测试，依赖环境种子数据"，并降级断言强度。
3. **断言强度够吗？** —— 只校验 HTTP 200 是最弱的；至少补一条业务码断言；如果传了过滤参数，必须断言返回结果符合过滤条件（list 非空时每条记录的过滤字段必须匹配入参）。
4. **用例之间有没有"伪多样性"？** —— 三个用例只是 status 枚举值不同、其他完全相同、都没造数据，本质是一个用例。要么合并为数据驱动、要么为每种状态准备前置数据。
5. **造了数据有没有清理？** —— 创建类节点必须有配套 cleanup（调 smart_search_delete_api）。

如果用例**意图就是接口契约测试**（不是业务功能验证），允许保留单接口、空结果通过等设计，但**必须在用例 description 里显式写明意图**，例如："契约测试：验证接口对 status 枚举值的处理一致性，不验证业务数据正确性"。否则视为伪用例。
```

同时在 "📤 完整工作流程" 的"第二阶段"和"第三阶段"之间插入：

```markdown
### 第二阶段补充：用例设计完成后必须自检

在调用 `assemble_and_create_test_cases` 之前，**必须调用一次 `validate_test_case`**，传入即将提交的 orchestrationPlan。

- 工具返回 warnings 后，对每条 warning 做出选择：
  - **修复**：调整 plan（补造数据节点、加业务码断言、加 cleanup、降级断言等），再次调用 validate
  - **接受**：在响应文本里**明确说明**为什么这条 warning 在本场景下可接受（比如"用例意图是接口契约测试，已在 description 写明"）
- 不允许在有 warning 且无说明的情况下直接调用 assemble_and_create_test_cases
```

并在 "🛠️ 可用工具" 章节加一段工具说明：

```markdown
### 5. validate_test_case —— 提交前自检
对 orchestrationPlan 做规则化自检，返回 warnings 列表。每条 warning 含 code/severity/message/nodeId。
**强制使用**：assemble_and_create_test_cases 之前必须调一次。
**怎么处理 warnings**：要么修复后重新 validate，要么在响应里说明为什么接受这条 warning（描述清楚后再去 assemble）。
```

---

## 改动 4：升级断言模板示例 + 标注 siblingCrud 字段

在 prompt 现有 "常用断言模板" 区域**增加**两个示例，让模型从复制范本时就学到强断言：

```markdown
**查询类用例 - 带过滤参数（必须验证过滤生效）**：
\`\`\`json
[
  { "field": "status", "operator": "equals", "expected": 200, "expectedType": "number" },
  { "field": "returnCode", "operator": "equals", "expected": 0, "expectedType": "number" },
  // 关键：list 非空时，每条记录的过滤字段必须等于入参
  // 由于平台当前断言操作符不支持遍历断言，下面是"至少抓首项"的最小可执行兜底
  { "field": "returnObject.list[0].status", "operator": "equals", "expected": "Active", "expectedType": "string" }
]
\`\`\`

**E2E 造数据 + 查询验证（推荐模式）**：
\`\`\`
step_pre_1: 创建租户(status=Active) → step_1: 查询租户列表(filter=Active) → 断言：list 非空 + 首条 status==Active → step_cleanup_1: 删除租户
\`\`\`
```

并在 "1. hierarchical_search_apis" 工具说明的"返回结果"示例里追加 siblingCrud 字段：

```json
{
  "id": "api_xxx",
  "name": "查询租户列表",
  "method": "GET",
  "path": "/api/v1/tenant/list",
  "platform": "...",
  "component": "...",
  "feature": "...",
  "siblingCrud": [
    { "id": "api_yyy", "name": "创建租户", "method": "POST", "action": "create" },
    { "id": "api_zzz", "name": "更新租户状态", "method": "PUT", "action": "update" },
    { "id": "api_www", "name": "删除租户", "method": "DELETE", "action": "delete" }
  ]
}
```

并加一段使用指引：

> **怎么用 siblingCrud**：当你选中一个 query 接口准备建查询用例时，先看 siblingCrud：
> - 如果存在 create → 强烈建议升级为「造数据 → 查询」E2E flow，否则空查询用例没有业务验证价值
> - 如果只有 query 没有 create → 在用例 description 里明确写"契约测试，依赖环境种子数据"
> - 此字段是平台给你的能力提示，不是强制的；validate_test_case 会校验你是否合理利用了它

---

## 验证步骤

1. `npm run build` 通过
2. 跑一遍现有的对话生成场景（任选一个有 query+create 同实体的工作区），确认：
   - search 返回里出现 siblingCrud 字段
   - AI 主动调用 validate_test_case
   - 故意构造一个"只有 status==200 断言"的 plan，validate 返回 WEAK_ASSERTION_ONLY_STATUS
3. 跑你提到的原始 case："依次以 Active/Suspended/Closed 三种状态调用租户列表查询" —— 期望 AI：
   - 看到 siblingCrud 里有 create → 提示升级为造数据 flow
   - 如果坚持不升级 → validate 触发 IDENTICAL_PARAM_VARIANTS + QUERY_WITHOUT_PRECONDITION + MISSING_FILTER_VERIFICATION
   - AI 必须在响应里说明意图（契约测试）或修复

## 不做的事（划清边界）

- 不改 schema，不动 TestCaseFeedback —— 那是事后反馈闭环（决策 12），本方案是事前自检
- 不让 validate 自动修复 plan —— 决策权在 AI/用户，工具只暴露问题
- 不调小模型做元判断 —— 第一版纯规则，足够拦住绝大多数伪用例；后续如果误报率高/漏报多再考虑（中期方案）
- 不改执行器（决策 6：SQL 不执行）—— 数据库验证仍靠"查询接口 + 断言"
- siblingCrud 不做精确的实体识别（NLP），按 platform+component+feature 聚合是当前 Swagger 导入语义下的最佳近似；如果某些 feature 同时塞了多个实体导致误关联，后续靠语义标签（决策 10 资产总线）升级

## 工时估算

| 改动 | 估算 |
|---|---|
| 1（搜索 siblingCrud） | 1.5h |
| 2（validate 工具 + 6 条规则 + dispatch + SSE） | 3h |
| 3（prompt 自检清单 + 工作流补充） | 0.5h |
| 4（prompt 断言模板 + siblingCrud 说明） | 0.5h |
| build + 联调 + 跑一遍租户用例验证 | 1h |
| **合计** | **6.5h** |
