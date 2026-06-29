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

## 8. 接口功能用例落库以 (module, title) 为业务键去重

- **决策**：接口功能用例（`InterfaceFunctionalCase`）所有落库入口，按 **(module, title)** 业务键 upsert——同键已存在则 `update`，否则 `create`。
- **为什么**：原先两条入口都一律 `create` 且内存草稿无 `id`，导致重复点「保存到用例库」、或"先保存再探索生成同一批草稿"会在用例层产生重复用例。库表无唯一约束，title 又是人能读懂的唯一名，(module, title) 是天然业务键。
- **约束**：
  - 两条入口必须走**同一套** upsert，不能只在一处加：`POST /api/functional-cases`（保存）与 `explore-generate` 的"先落库再生成"。
  - 保存批次内也先按键去重（防一次提交里就带重复）。
  - upsert 命中已有时**不回写 `status`**，避免把"已生成"打回"草稿"，也不动已有生成追溯。
- **涉及代码**：`app/api/functional-cases/route.ts`（POST）、`app/api/ai/explore-generate/route.ts`（fromFunctional 落库分支）
- **反例**：不要新增一个落库入口却只 `create` 不查重；不要把去重键改成纯 title（丢了模块维度会误并不同模块的同名用例）。

## 9. 子弹层的"启动型" effect 用 ref 守卫只跑一次，不依赖不稳定引用

- **决策**：`ExploreGenerateDialog` 这类"打开即自动启动生成/设计"的弹层，`useEffect` 依赖只收敛到 `[open]`，并用 `startedRef` 守卫"每次打开只启动一次"，`open` 变 false 时复位。
- **为什么**：原先 effect 依赖含 `apiIds`，而父组件传的是 `apiIds={[]}`（每次渲染新建的数组字面量，引用每次都变）；生成完成回调里 `load()` 又触发父组件重渲染 → `apiIds` 新引用 → effect 再触发 → 再次生成 → 又 `load()`，成**死循环**卡死。
- **约束**：副作用 effect 不要把**父组件每次渲染都新建的数组/对象/箭头函数字面量**放进依赖数组；尤其当 effect 内部会触发父组件重渲染时，引用不稳定直接成环。要么父层 `useMemo`/`useCallback` 稳引用，要么子层用 ref 守卫"只跑一次"。
- **涉及代码**：`components/api-repository/ExploreGenerateDialog.tsx`（`startedRef` + `useEffect([open])`）
- **反例**：不要把 `apiIds`/`functionalCases` 这类内联字面量数组放进会触发副作用的依赖数组。

## 10. ⚠️ 资产管理总线：四轴正交，不做 EAV（统一治理原则）

- **决策**：所有资产（`Api` / `TestCase` / `TestSuite` / `InterfaceFunctionalCase` / `SwaggerSource` / 未来的 `PublishedCase` 等）**保留各自的强类型表**，只把四个共同问题抽到四张**横向表/字段**统一管理：
  1. **归属轴 Workspace**：每个资产加 `workspaceId`，作为视图边界 + AI 上下文边界（**不做权限隔离**，只做范围收敛）
  2. **血缘轴 AssetLineage**：通用关系表，替代分散的 `importSource` / `sourceFingerprint` / `sourceFunctionalCaseId` / `generatedCaseIds` 等"源指针"字段
  3. **生命周期轴 AssetLifecycle**：统一四态 `draft | active | deprecated | archived`；现有 `isArchived`/`status` 字段映射到此
  4. **事件轴 AssetEvent**：所有变更（同步、合并、语义 diff 待评审、废弃）落事件，订阅方（通知中心/邮件/Webhook/未来自动复核）从事件流读
- **为什么**：
  - 资产数量上去后，"归属/血缘/状态/变更"四个问题每个资产都要回答，**不抽出来就会在每张表上各打补丁**（当前已经出现 `Api.importSource` 字符串 / `TestCase.sourceFingerprint` 字符串 / `InterfaceFunctionalCase.generatedCaseIds` JSON 三种血缘格式并存）
  - AI 上下文跨项目串味、Swagger 更新后下游用例不知情、过期接口仍进 AI prompt——这些都是"四轴缺失"的具体症状，不是各资产自己的 bug
  - 统一治理后，"影响面分析 / 通知 / 自动复核"等上层能力**只需对接四轴**，不必对接每个资产表
- **约束（红线，不可破坏）**：
  - ❌ **不做 EAV**（不做 `Asset(type, id, data)` 通用表合并所有资产）——那是取消业务模型，不是统一管理
  - 新增资产类型时，必须把 `workspaceId` + lineage 关系 + 顶层 lifecycle 状态 + 关键变更事件接上，**不能只建独立表**
  - **生命周期 `deprecated` 态不进 AI 上下文**（`searchApis` / `getApiDetail` / 工具检索默认过滤 `active`）——这是 AI 质量收益最大的一处
  - **AI 上下文必须按当前 workspace 收敛**：工具层默认按 `workspaceId` 过滤，调用方传入上下文
  - 与决策 5 协同：`businessSemantics` 仍走人工 diff 评审，事件流只是把"待评审"这件事推到通知中心，**绝不变成"事件触发自动合并"**
  - 与决策 4 协同：字段级合并逻辑不变，合并完成后写一条 `AssetEvent`，不在合并逻辑里耦合通知
  - 迁移期允许新旧字段双写（如 `Api.importSource` 与 `AssetLineage` 并存），但**新代码只读新结构**，老字段进只读维护期
- **实施次序（按收益密度）**：
  1. Workspace + AI 上下文过滤（地基）
  2. SwaggerSource 表 + 一键同步（解决"重复贴链接"痛点，自然挂在 Workspace 下）
  3. AssetLineage + 现有 sourceXxx 字段迁移（解锁影响面分析）
  4. Lifecycle `deprecated` 态（AI 质量立刻变好）
  5. AssetEvent + 通知中心
  6. 自动同步 / Webhook / 发布流水线（上层应用，按需）
- **涉及代码**（实施时补全）：
  - `prisma/schema.prisma`（新增 `Workspace` / `AssetLineage` / `AssetEvent` / `SwaggerSource` 表，各资产表加 `workspaceId`）
  - `lib/asset-bus/`（新建：lineage 读写、事件发布、lifecycle 状态机封装）
  - `lib/ai-tools/index.ts`（`searchApis`/`getApiDetail` 接 `workspaceId` + 过滤 `deprecated`）
  - `app/api/api-library/save/route.ts`（合并完成发 `AssetEvent`）
  - `lib/semantics-diff.ts`（diff 产生时发 `semantic_diff_pending` 事件）
- **反例**：
  - ❌ 不要做 `Asset(type, id, jsonData)` 通用表——取消业务强类型，AI 工具和查询全部退化为字符串匹配
  - ❌ 不要把项目层做成 tag 的语法糖（如 `Api.tags` 加一个 `project:xxx` 标签）——AI 上下文仍然全局串味
  - ❌ 不要在事件订阅里自动应用业务语义变更（破坏决策 5）
  - ❌ 不要为每个资产单独建一套"通知/血缘/状态"——那就是补丁的补丁，违背抽象初衷
  - ❌ 不要在 Phase 1 还没接通时就跳到自动同步/Webhook（地基不稳，影响面无法分析）

---

## 待办 / V2（已占位未实现）

- **语义漂移检测**：语义对应断言持续失败 → 标记健康度 → 提醒复查（依赖执行数据积累）
- **SQL 断言执行**：执行器新增"数据库断言节点"，让 x-db-asserts 真正可跑
- **curl / Postman 导入**：转成 `CapturedApi` 复用现有链路（见决策 1）
- **约束/语义人工补录**：让录制/手动建的接口也能补 paramConstraints/businessSemantics
