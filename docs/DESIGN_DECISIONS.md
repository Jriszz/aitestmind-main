# 设计决策记录（DESIGN DECISIONS）

> 本文件记录关键设计决策的**为什么、约束、涉及代码、反例**。
> 代码里只有"是什么"，这里记录"为什么这么做"和"什么不能做"。
> **修改相关功能前必须先读对应决策**，避免好心改坏。

格式约定：每条决策包含
- **决策**：做了什么
- **为什么**：动机、要解决的问题
- **约束**：必须守住的红线
- **涉及代码**：相关文件
- **反例**：明确不能这么改

---

## 1. Swagger/OpenAPI 导入复用录制的保存链路

- **决策**：Swagger 解析产物转换为统一的 `CapturedApi[]` 结构，复用录制/HAR 的 `save` / `check-duplicates` / 四层分类 / 冲突解决链路，不另建一套。
- **为什么**：`importSource` 字段、`{id}` 路径约定、查重逻辑天然兼容；复用减少重复代码和维护面。
- **约束**：Swagger 解析的输出必须符合 `CapturedApi`（`types/har.ts` 的 `ApiRequestSummary`）。新增来源（如 Postman/curl）也应转成同一结构复用此链路。
- **涉及代码**：`lib/swagger-parser.ts`、`app/api/api-library/import-swagger/route.ts`、`app/api/api-library/save/route.ts`
- **反例**：不要为 Swagger 单独写一套保存/查重逻辑。

## 2. 解析放后端 + 用成熟库

- **决策**：Swagger 解析在后端路由完成（非前端），用 `@apidevtools/swagger-parser` 的 `dereference()`。
- **为什么**：后端解析绕开在线 URL 拉取的浏览器 CORS；成熟库自动处理 `$ref` 解引用/循环引用、兼容 Swagger 2.0 + OpenAPI 3.x。
- **约束**：在线 URL 拉取必须有 **SSRF 防护**（拒绝 localhost/内网段，除非 `SWAGGER_IMPORT_ALLOW_INTERNAL=true`）、超时、大小上限。
- **涉及代码**：`lib/swagger-parser.ts`、`app/api/api-library/import-swagger/route.ts`（`isPrivateHost`/`fetchDocument`）
- **反例**：不要把解析挪到前端；不要去掉 SSRF 防护直接 fetch 用户给的 URL。

## 3. 参数约束（paramConstraints）存入已有 schema 字段

- **决策**：从 Swagger schema 提取的 `required/enums/ranges/formats` 存进 `Api.schema` 列（不新增列）。
- **为什么**：`schema` 字段注释本就是"供 AI 理解参数结构"，语义契合；避免冗余列。
- **约束**：`schema` 字段存 `paramConstraints` JSON；与业务语义（`businessSemantics` 列）分开，二者职责不同——paramConstraints 是单接口单字段约束，businessSemantics 是跨接口业务规则。
- **涉及代码**：`lib/swagger-parser.ts`（`collectConstraints`）、`app/api/api-library/save/route.ts`、`lib/ai-tools/index.ts`（`getApiDetail` 解析返回）
- **反例**：不要把 paramConstraints 和 businessSemantics 混存到同一字段。

## 4. Swagger × 录制：字段级智能合并（普通字段）

- **决策**：同一接口被多来源导入时，覆盖分支不整条替换，而是**字段级智能合并**："新值有意义才覆盖，否则保留旧值；约束类只增不减"。
- **为什么**：Swagger 独有约束、录制独有真实 token/样本；整条覆盖会丢掉另一方独有信息。
- **约束**：
  - `requestHeaders`（token）：录制真值优先，existing 有内容则保留
  - `requestBody`/`responseBody`：录制真值优先
  - `schema`（约束）：只增不减
  - `importSource`：拼接去重（如 `har,swagger`）
- **涉及代码**：`lib/api-merge.ts`（`mergeApiData`/`hasMeaningfulValue`/`mergeImportSource`）、`app/api/api-library/save/route.ts` 覆盖分支
- **反例**：不要把覆盖改回整条 `update({ data: apiData })`。

## 5. ⚠️ 业务语义双层存储 + 同步必须人工评审（核心治理原则）

- **决策**：业务语义（来自 Swagger 的 `description`/`x-side-effect`/`x-fund-consistency`/`x-db-asserts`）采用 **baseline（文档）+ override（平台）双层存储**；文档重新导入时，语义变更**绝不自动合并**，必须算 diff 走人工三栏评审。
- **为什么**：
  - 文档为权威源，但平台需可调（"文档为主、平台可调"）——双层才能在同步时判断"听文档还是听平台"
  - 语义错了的后果是"测试看起来在跑实则测错"，代价极大，不能自动覆盖
- **约束（红线，不可破坏）**：
  - 语义字段**不走** `api-merge.ts` 的自动合并（那是给普通字段的）
  - 同步时 `baseline` 如实反映文档；`override` 不被同步流程改动（仅 ApiEditDialog 维护）
  - 仅 `status === 'confirmed'` 的语义注入 AI；draft/deprecated 不注入
  - 消费时 override 优先于 baseline
- **涉及代码**：`lib/semantics-diff.ts`（`diffSemantics`/`mergeSemanticsOnSync`）、`app/api/api-library/save/route.ts`（`computeMergedSemantics`）、`components/api-capture/SemanticReviewDialog.tsx`、`lib/ai-tools/index.ts`（`getApiDetail` 仅取 confirmed）
- **反例**：
  - ❌ 不要把业务语义改成自动合并（必须走 diff 人工评审）
  - ❌ 不要让同步流程改动 override 层
  - ❌ 不要把 draft/deprecated 语义注入 AI

## 6. x-db-asserts 的 SQL 当前不执行

- **决策**：`x-db-asserts` 里的 SQL 仅作为"该验证什么"的素材喂给 AI，**不真正执行**。
- **为什么**：执行器（`executor/assertion_engine.py`）是 HTTP 断言引擎，无数据库断言能力。执行 SQL 属 V2（需新增数据库断言节点）。
- **约束**：system prompt 必须明确告知 AI"把 dbAsserts 转化为接口层断言，不要在用例里写 SQL"，避免误导用户以为已能跑 SQL。
- **涉及代码**：`lib/ai-prompts/system-prompt.ts`（业务语义章节）
- **反例**：不要在用例 flowConfig 里生成 SQL 断言节点（执行器跑不了）。

## 7. AI 生成是 Function Calling 编排，不直接写 flowConfig

- **决策**：AI 只输出轻量"编排指令"（orchestrationPlan），后端 assembler 组装完整 flowConfig；AI 通过工具搜接口/取详情/创建用例。
- **为什么**：减少 AI 要生成的 JSON 体积和复杂度，降低 JSON 出错率和 token 超限；接口真实数据消除幻觉。
- **约束**：新增 AI 能力应作为"工具"（如 paramConstraints/businessSemantics 通过 `get_api_detail` 返回 + prompt 指导），而非让 AI 直接产出底层结构。
- **涉及代码**：`app/api/ai/smart-generate/route.ts`、`lib/ai-tools/index.ts`、`lib/ai-tools/assembler.ts`、`lib/ai-prompts/system-prompt.ts`
- **反例**：不要让 AI 直接生成完整 flowConfig/SQL/底层 ParamValue。

---

## 待办 / V2（已占位未实现）

- **语义漂移检测**：语义对应断言持续失败 → 标记健康度 → 提醒复查（依赖执行数据积累）
- **SQL 断言执行**：执行器新增"数据库断言节点"，让 x-db-asserts 真正可跑
- **curl / Postman 导入**：转成 `CapturedApi` 复用现有链路（见决策 1）
- **约束/语义人工补录**：让录制/手动建的接口也能补 paramConstraints/businessSemantics
