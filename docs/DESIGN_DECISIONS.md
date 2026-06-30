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
- **约束**：[REDACTED] 必须明确告知 AI"把 dbAsserts 转化为接口层断言，不要在用例里写 SQL"，避免误导用户以为已能跑 SQL。
- **涉及代码**：`lib/ai-prompts/system-prompt.ts`（业务语义章节）
- **反例**：不要在用例 flowConfig 里生成 SQL 断言节点（执行器跑不了）。

## 7. AI 生成是 Function Calling 编排，不直接写 flowConfig

- **决策**：AI 只输出轻量"编排指令"（orchestration，类似伪码），由 `assembler.ts` 负责转换为完整的、可执行的 `flowConfig` JSON。
- **为什么**：
  - flowConfig 有 100+ 字段（节点类型、前后置处理、变量提取、错误处理），直接让 AI 输出极易写错/丢字段
  - AI 擅长语义决策（选哪个接口、用哪个变量、断言什么），不擅长拼 JSON 细节
  - 组装逻辑沉淀在代码，可复用、可测试、可演化
- **约束**：
  - AI prompt 不给 flowConfig 示例（避免诱导 AI 直接写）
  - orchestration 字段：`apiId`、`params`（哪些参数）、`assertions`（断言什么）、`extractVars`（提取什么变量）
  - assembler 负责补全节点 id、坐标、边、变量引用、默认值
- **涉及代码**：`lib/ai-tools/assembler.ts`、`app/api/ai/smart-generate/route.ts`、`lib/ai-prompts/system-prompt.ts`
- **反例**：不要让 AI 直接输出 `{ nodes: [...], edges: [...] }` 的完整 flowConfig。

## 8. 用例优先级（P0-P3）挂在 TestCase，不单独建表

- **决策**：用例优先级（P0/P1/P2/P3）直接作为 `TestCase.priority` 字段，默认 P2。
- **为什么**：优先级是用例固有属性，不需要额外关联表；单字段更简单、查询更快。
- **约束**：
  - P0（核心/必跑）、P1（高）、P2（中，默认）、P3（低）
  - suite 执行可按优先级过滤（"只跑 P0+P1"）
  - AI 生成时根据接口重要性（如涉及资金/幂等性 → P0，普通查询 → P2）自动推断
- **涉及代码**：`prisma/schema.prisma`（`TestCase.priority`）、`lib/ai-tools/assembler.ts`（生成时推断）、执行器过滤逻辑（V2）
- **反例**：不要单独建 `Priority` 表做多对多关联。

## 9. 接口功能用例（FunctionalCase）与测试用例（TestCase）解耦

- **决策**：
  - `FunctionalCase` 是"接口级功能描述"（一个接口有哪些场景，纯语义，无编排细节）
  - `TestCase` 是"可执行测试用例"（完整 flowConfig + 断言）
  - 通过 `TestCase.sourceFunctionalCaseId` 建立"派生关系"（单向，可空）
- **为什么**：
  - 职责分离：FunctionalCase 供 AI 理解"该测什么"，TestCase 是"怎么测"
  - FunctionalCase 可复用（如同一功能用不同接口组合实现）
  - 链路清晰：语义 → 功能用例 → 测试用例，每层可独立演化
- **约束**：
  - FunctionalCase 不含 flowConfig，只有 `scenario` / `expectedOutcome` / `apiIds`
  - TestCase 有完整 flowConfig
  - 派生关系仅标记"来源"，不强制同步（用户可改测试用例）
- **涉及代码**：`prisma/schema.prisma`（`FunctionalCase` / `TestCase.sourceFunctionalCaseId`）、`lib/functional-case-utils.ts`、AI 探索链路
- **反例**：
  - ❌ 不要把 flowConfig 塞进 FunctionalCase
  - ❌ 不要让 FunctionalCase 变更自动覆盖 TestCase（用户可能已手动调整）

## 10. ⚠️ 资产管理四轴总线（Workspace / Lineage / Lifecycle / Event）

- **决策**：所有资产（API / TestCase / TestSuite / FunctionalCase / SwaggerSource）统一接入**资产四轴总线**：
  1. **Workspace 轴**（归属 + AI 上下文边界）：每个资产 `workspaceId`，AI 工具按此过滤，避免跨项目串味
  2. **AssetLineage 轴**（血缘）：记录"A 引用 B"关系（如 TestCase 引用 Api，FunctionalCase 派生 TestCase）
  3. **AssetLifecycle 轴**（统一四态）：`draft` → `active` → `deprecated` → `archived`；`deprecated` 态不进 AI 上下文
  4. **AssetEvent 轴**（事件流）：资产的创建/修改/同步/废弃等操作发事件，供"反馈闭环/漂移检测/Webhook"等订阅
- **为什么**：
  - **多项目隔离是刚需**：不同项目的接口/用例混在一起，AI 会"张冠李戴"
  - **血缘追溯是必需**：哪些用例用了某接口？某 Swagger 源同步影响哪些 API？不能靠人工记忆
  - **生命周期管理避免资产腐烂**：废弃接口不能继续喂 AI；历史用例不能永远堆积
  - **事件流是扩展点**：反馈闭环（决策 11）、自动通知、审计日志都挂在事件上
- **约束（红线）**：
  - 各资产保留强类型表（`Api` / `TestCase` 等），**绝不做 EAV 通用资产表**（会取消业务强类型）
  - AI 工具（`searchApis` / `getApiDetail`）默认按 `workspaceId` 过滤
  - AI 上下文**不包含 `deprecated` 态资产**（避免 AI 用废弃接口）
  - `AssetEvent` 订阅**不得触发 businessSemantics 自动合并**（与决策 5 协同）
  - Workspace 不是 tag 的语法糖——它是一等公民，有独立边界、配置、权限（V2）
- **实施路径**（Phase 1 → Phase 2 → Phase 3，不跳步）：
  - **Phase 1**（接通四轴，基础设施）：
    - Schema：新增 `Workspace` / `AssetLineage` / `AssetEvent` 表，各资产表加 `workspaceId` / `lifecycleStatus`
    - 代码层：`lib/asset-bus/`（lineage 读写、事件发布、状态机）
    - AI 工具：`searchApis` / `getApiDetail` 接 `workspaceId` + 过滤 `deprecated`
    - UI：workspace 选择器（顶栏）、资产列表按 workspace 过滤
  - **Phase 2**（打通核心链路）：
    - Swagger 同步 → 发 `AssetEvent` → 触发 lineage 更新
    - 业务语义 diff 产生 → 发 `semantic_diff_pending` 事件
    - 反馈闭环（决策 11）接入事件流
  - **Phase 3**（高级能力）：
    - Webhook 订阅 `AssetEvent`
    - 资产健康度看板（哪些接口长期无用例、哪些用例持续失败）
    - 自动废弃检测（接口 N 天未调用 → 建议标 `deprecated`）
- **涉及代码**（实施时补全）：
  - `prisma/schema.prisma`（新增 `Workspace` / `AssetLineage` / `AssetEvent` / `SwaggerSource` 表，各资产表加 `workspaceId`）
  - `lib/asset-bus/`（新建：lineage 读写、事件发布、lifecycle 状态机封装）
  - `lib/api-save.ts`（已建：批量保存 + 字段级合并 + 业务语义双层，`save` 路由与 `swagger-sources/[id]/sync` 共享同一套合并逻辑）
  - `lib/swagger-fetch.ts`（已建：SSRF + ETag 条件请求，`import-swagger` 与 `swagger-sources/[id]/sync` 共享）
  - `lib/ai-tools/index.ts`（`searchApis`/`getApiDetail` 接 `workspaceId` + 过滤 `deprecated`）
  - `app/api/api-library/save/route.ts`（合并完成发 `AssetEvent`）
  - `app/api/swagger-sources/**`（已建：list/create/patch/delete/sync）
  - `lib/semantics-diff.ts`（diff 产生时发 `semantic_diff_pending` 事件）
- **反例**：
  - ❌ 不要做 `Asset(type, id, jsonData)` 通用表——取消业务强类型，AI 工具和查询全部退化为字符串匹配
  - ❌ 不要把项目层做成 tag 的语法糖（如 `Api.tags` 加一个 `project:xxx` 标签）——AI 上下文仍然全局串味
  - ❌ 不要在事件订阅里自动应用业务语义变更（破坏决策 5）
  - ❌ 不要为每个资产单独建一套"通知/血缘/状态"——那就是补丁的补丁，违背抽象初衷
  - ❌ 不要在 Phase 1 还没接通时就跳到自动同步/Webhook（地基不稳，影响面无法分析）

## 11. ⚠️ 用例标签：单层固定枚举池，禁止自由文本

- **决策**：用例标签（`TestCase.tags` / `TestSuite.tags`）只允许从**单层固定枚举池**中选择，可多选可空。共 10 个值，分两类（仅 UI 分组展示，校验时不分层）：
  - **场景类（6）**：`正常场景` / `参数校验` / `业务语义` / `E2E流程` / `权限校验` / `状态流转`
  - **业务域（4）**：`资金对账` / `落库验证` / `幂等性` / `超时重试`
- **为什么**：
  - 自由文本标签会无限膨胀（AI 随手造、用户随手加），最终失去聚合价值
  - 固定枚举让标签成为可靠的**筛选/统计维度**（如"所有资金对账用例"、"所有 E2E 用例"）
  - **单层池**比多层结构（来源/场景/业务域）简单，避免"为了分层而分层"
- **决策演化历史（重要）**：
  - **初版（错的）**：三层结构（来源 + 场景 + 业务域），强制来源/场景必选 1 个
  - **修正后（当前）**：单层池，可空可多选；"来源"归 AssetLineage（决策 10），"状态"归 lifecycle（决策 10），"优先级"归 `TestCase.priority`（决策 8）——**每个维度有专门的字段/状态机，tag 只表达"在测什么"和"业务域"**
  - 教训：分层结构看似严谨，实则把本属其他维度的语义挤进 tag，违反"一个字段表达一件事"
- **约束（红线）**：
  - **前端**：标签选择必须用 `<Select multiple>` / `<Checkbox>`，禁用自由输入框
  - **后端**：保存时校验标签是否在枚举内，不在则拒绝（返回 400）
  - **AI prompt**：明确给出单层枚举池，告知"只能从中选择，可空"
  - **AI 生成代码**（如 `explore-generate` 的 `buildScenarioTags`）：必须从枚举选；**不要在 tag 里塞来源/状态**
  - **历史污染**：旧的 `AI探索` / `对话生成` / `待编排` 等标签由校验器**静默剥离**（不报错，避免破坏历史用例），新写入禁止使用
  - 枚举变更：由项目管理员在 `lib/constants/tags.ts` 统一维护，不可随意增删
- **涉及代码**：
  - `lib/constants/tags.ts`（单一来源：枚举定义 + 校验函数 + SCENARIO_TYPE_MAP）
  - `lib/tag-validator.ts`（统一校验器：解析 + 去重 + 历史标签剥离 + 枚举校验）
  - `lib/ai-prompts/system-prompt.ts`（标签枚举专章）
  - `app/api/ai/explore-generate/route.ts`（`buildScenarioTags` 程序化贴标签）
  - `app/api/test-cases/route.ts` / `app/api/test-cases/[id]/route.ts`（保存时校验）
  - `app/api/test-suites/route.ts` / `app/api/test-suites/[id]/route.ts`（保存时校验）
- **反例**：
  - ❌ 不要给用户提供"自定义标签"输入框
  - ❌ 不要让 AI 在 prompt 里造标签（如 `tags: ["重要"]`、`tags: ["P0"]`）
  - ❌ 不要在后端允许任意字符串标签通过
  - ❌ 不要用 tag 表达"来源"/"状态"/"优先级"——这些是其他维度的职责
  - ❌ 不要把 tag 改回多层强制结构（"来源必选 1 个、场景必选 1 个"是过度设计）

---

## 12. ⚠️ AI 反馈闭环走独立资产，不污染 businessSemantics

- **决策**：把"执行失败 + 用户编辑 + 主动吐槽"作为独立 `TestCaseFeedback` 资产沉淀，按 acknowledged 状态门控后通过 `query_api_feedback` 工具反喂 smart-generate / explore-generate。**绝不写回 `Api.businessSemantics`**。
- **为什么**：
  - 生成端与执行端之前完全割裂，AI 一辈子活在"生成那一刻"，下次生成同类用例继续犯同样的错
  - 反馈数据本身是**未经评审的猜测**（AI 归因可能错、用户编辑动机不一定是"AI 错了"），直接写回 businessSemantics 会变相绕过决策 5
  - 独立资产可以按"接口/用例/category"三轴聚合，是未来 AssetEvent 总线的天然第一类事件
- **约束**：
  - 反馈必须三向索引（`caseExecutionId` / `testCaseId` / `apiId`），任意一轴可聚合
  - `category` 必须从固定枚举选（`api_path_changed` / `assertion_wrong` / `param_constraint_missed` / `business_code_assumption` / `missing_precondition` / `wrong_variable_ref` / `other`），自由文本反馈进 AI 等于垃圾
  - `query_api_feedback` 工具**只返回 `status=acknowledged`** 的反馈——`open` 是猜测，要人工评审通过才生效
  - 反馈带 `evidence`（执行快照），不依赖关联资源后续不变
  - 工作区收敛：所有读写按 `workspaceId` 过滤（决策 10 协同）
  - 失败归因（`execution_failure`）走 `submit_diagnosis` 强结构化工具，category 服务端枚举校验，AI 不能瞎填
- **涉及代码**：
  - 表：`prisma/schema.prisma` 的 `TestCaseFeedback`
  - 归因 AI：`app/api/ai/diagnose-failure/route.ts`、`lib/ai-prompts/diagnose-prompt.ts`
  - 反喂工具：`lib/ai-tools/index.ts` 的 `queryApiFeedback` + `AI_TOOLS` 里的 `query_api_feedback`
  - 入口 A（执行失败）：`app/execution/suite/[executionId]/page.tsx` 的「AI 归因」按钮 + `components/feedback/FailureDiagnoseDialog.tsx`
  - 入口 B（用户编辑）：`app/api/test-cases/[id]/route.ts` 的 PUT 路由 `detectUserEditDiff` 函数
  - 评审：`app/feedback/page.tsx`、`app/api/feedback/route.ts`、`app/api/feedback/[id]/route.ts`
  - prompt 改写：`lib/ai-prompts/system-prompt.ts`、`lib/ai-prompts/explore-generate-prompt.ts`
  - 总览：`docs/AI_FEEDBACK_LOOP_PLAN.md`
- **反例**：
  - ❌ 不要直接把 `acknowledged` 反馈合并到 `Api.businessSemantics`——businessSemantics 是文档/平台双层评审产物（决策 5），反馈只能"提示 AI 注意"，不能"改语义"
  - ❌ 不要在 `query_api_feedback` 里返回 `status: open` 的反馈——会让 AI 误判污染未来生成
  - ❌ 不要让 AI 自由写 `category`——服务端必须枚举校验，否则 AI 会创造无穷类别（"接口奇怪"/"看起来不对"），变成不可索引的垃圾
  - ❌ 不要把反馈写成"自由文本对话"挂在用例旁——没结构化的吐槽对 AI 没用
  - ❌ 不要在用户改一次用例就提示用户"是不是要打反馈"——`user_edit` 反馈静默采集，避免打扰

---

## 13. ⚠️ 断言算子按语义维度扩展；`exists` 不动语义；金额走 `Decimal`

- **决策**：断言能力升级时遵循三条原则——
  1. **按语义维度扩展，不按业务领域扩展**：加 `notEmpty`/`in`/`notIn`/`length_*`/`each_*` 这种通用语义算子；**绝不**加 `amountEquals`/`tradeStatusValid` 这种业务领域算子（柜台、电商各自一套会无限膨胀）
  2. **`exists` 不动语义**：保持"非 None 即通过"的向后兼容（空串/空数组/空对象都算"存在"）；"非空"语义由新增的 `notEmpty` 显式表达
  3. **金额/利率/份额走 `ExpectedType.DECIMAL`**：执行器内部用 Python `decimal.Decimal(str(x))` 比较，避开 IEEE 754 误差；柜台场景 validate_test_case 强制校验
- **为什么**：
  - 柜台测试发现两类真实漏洞：
    - `exists` 对空串放水 → 后端返回 `traceNo: ""` 也被断言放过，柜台流水号 = 空就是事故源
    - `float("100.10") = 100.09999...` → 金额断言走 float 必有精度风险
  - 业务领域算子（如 `amountEquals`）短期方便长期碎片化：每个新业务都要加一套，AI 提示词膨胀、前端选项膨胀、文档膨胀
  - 语义维度算子（如 `decimal` 类型 + `equals`）正交可组合，AI 学习一次到处可用
- **约束（红线）**：
  - 断言算子新增必须是**通用语义**，不接受任何业务领域名（`amount*`/`trade*`/`order*` 等开头一律拒）
  - `exists` 永远保持当前实现（`actual is not None`）。修复"空串放水"必须通过引导用户/AI 使用 `notEmpty`，**不允许悄悄改 exists 语义**（会破坏存量历史用例）
  - 金额字段（field 命中 `amount/balance/fee/price/sum/total/cost/rate/share` 关键字）的 equals/notEquals/greaterThan/lessThan 必须用 `expectedType: "decimal"`；非 decimal 时 validate_test_case 触发 `MONEY_FLOAT_RISK`
  - 流水号字段（field 命中 `traceNo/serialNo/orderNo/...` 关键字）禁止 `exists`，必须 `notEmpty`（违反时 validate_test_case 触发 `TRACE_NO_ONLY_EXISTS`）
  - 业务码（returnCode 等）非断不可：节点没有任何业务码断言时触发 `RETURN_CODE_NOT_ASSERTED`
- **算子全集（16 个，按语义分组）**：
  - 等值/比较：`equals`/`notEquals`/`contains`/`notContains`/`greaterThan`/`lessThan`
  - 存在性：`exists`/`notExists`/`notEmpty`
  - 集合：`in`/`notIn`（expected 用 list）
  - 长度：`lengthEquals`/`lengthGreaterThan`/`lengthLessThan`
  - 遍历：`eachEquals`/`eachMatches`（actual 必须是数组，每一项满足）
- **涉及代码**：
  - `executor/models.py`（`AssertionOperator`/`ExpectedType` 枚举）
  - `executor/assertion_engine.py`（`_compare`/`_convert_expected_value`/`_is_empty`/`_safe_len`/`_coerce_expected_to_list`）
  - `executor/test_assertion_new_operators.py`（24 个回归测试）
  - `types/test-case.ts`（`Assertion.operator`/`Assertion.expectedType`）
  - `components/test-orchestration/AssertionConfig.tsx`（操作符 Select 16 项 + expectedType decimal）
  - `i18n/messages/{zh,en}.json`（`assertionConfig` 节）
  - `lib/ai-prompts/system-prompt.ts`（操作符清单 + 柜台 5 个模板 + 柜台铁律）
  - `lib/ai-tools/validate-test-case.ts`（柜台 4 条规则：MONEY_FLOAT_RISK / TRACE_NO_ONLY_EXISTS / RETURN_CODE_NOT_ASSERTED / DETAIL_LIST_NO_OWNERSHIP_CHECK）
- **反例**：
  - ❌ 不要悄悄改 `exists` 语义让它拒绝空串——会破坏所有依赖旧 exists 行为的历史用例
  - ❌ 不要加 `amountEquals`/`amountGreaterThan` 等业务领域算子——用 `expectedType: "decimal"` + 现有 equals/greaterThan 解决
  - ❌ 不要让 number 类型的 equals 自动升级到 decimal——会让"我就是要 float 比较"的存量用例行为漂移；只在显式 `expectedType: "decimal"` 时走 Decimal
  - ❌ 不要在 prompt 里教 AI "金额可以用 number"——validate 规则会拦截，但 prompt 不写明 AI 会反复犯
  - ❌ 不要把 `each_equals` 实现成"对空数组通过"——会让"造数据失败导致空列表"漏过；空数组必须判失败
  - ❌ 不要继续扩 8 算子时代留下的"`list[0]` 抓首项兜底"模式作为推荐用法——能用 `each_equals` 时必须用，`list[0]` 只在执行器不支持 `[*]` 通配时作临时退路

---

## 待办 / V2（已占位未实现）

- **语义漂移检测**：语义对应断言持续失败 → 标记健康度 → 提醒复查（依赖执行数据积累）
- **SQL 断言执行**：执行器新增"数据库断言节点"，让 x-db-asserts 真正可跑
- **curl / Postman 导入**：转成 `CapturedApi` 复用现有链路（见决策 1）
- **约束/语义人工补录**：让录制/手动建的接口也能补 paramConstraints/businessSemantics
- **断言字段路径支持 `[*]` 通配**：让 `each_equals` 能直接写 `returnObject.list[*].accountNo` 而不需要 actual 已是 list；当前 v1 实现需要字段路径取出整个数组，再对每一项做"项 == expected"，对结构 `list[*].field` 不友好。后续扩展 `variable_manager.extract_from_response` 支持 `[*]` 即可，引擎层 `each_*` 无需改
