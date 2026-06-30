# AI 反馈闭环：执行结果 → 吐槽资产 → 反喂生成

## Context

当前两个 AI 生成 agent（smart-generate / explore-generate）和"用例执行结果"完全割裂：
- AI 生成用例后，落库即"撒手不管"
- 用例执行失败、用户改了、用户骂了 → 这些信号 AI 全部看不到
- 下次生成同类用例时，**继续犯同一个错**

业务目标：把"执行失败 + 用户行为"沉淀成结构化反馈资产，让两个生成 agent 在生成时能"翻看历史教训"，形成 **生成 → 执行 → 吐槽 → 反喂生成** 的闭环。

设计原则（与 CLAUDE.md 红线对齐）：
- 反馈是资产，不是对话历史。落库可查，不靠 prompt 现场记忆。
- 反馈采集挂在"执行失败现场"（用户已在那儿，无需新入口）。
- 反馈走"待评审 → 已生效"两态机制，**不自动改 businessSemantics**（决策 5）。
- 三向索引（execution / testCase / api），任意一轴都能聚合（为未来升格 AssetEvent 留通道）。
- AI 工具按 workspaceId 收敛（决策 10）。

---

## 总体架构

```
执行失败 ──┐
          │
用户改用例 ┼──> TestCaseFeedback（反馈资产）
          │       ├─ source: execution_failure / user_edit / ai_self_critic
用户骂吐槽 ┘       ├─ 三向外键: caseExecutionId / testCaseId / apiId
                  ├─ 结构化归因: category(枚举) + targetField
                  └─ 状态: open / acknowledged / fixed / wontfix
                       │
                       │  按 apiId / 按 category 聚合
                       ↓
                  query_api_feedback / query_prompt_lessons 工具
                       │
                       ↓
             smart-generate / explore-generate  生成前主动查询
                       │
                       ↓
                    生成更准的用例（带"避坑提示"）
```

---

## 一、Schema 变更（prisma/schema.prisma）

### 新增 `TestCaseFeedback`

```prisma
model TestCaseFeedback {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // 来源：执行失败 / 用户编辑用例 / AI 自检
  source String  // "execution_failure" | "user_edit" | "ai_self_critic" | "user_comment"

  // 三向索引：任意一轴都能聚合
  caseExecutionId String?  // 关联具体那次执行（执行失败时必填，其他可空）
  testCaseId      String?  // 用例（采纳后通常都有）
  apiId           String?  // 关键：让接口侧能反查"它在多少用例中翻车过"
  stepNodeId      String?  // 步骤节点 id（定位到具体步骤）

  // 结构化归因（不要自由文本）
  category String  // "api_path_changed" | "assertion_wrong" | "param_constraint_missed"
                   // | "business_code_assumption" | "missing_precondition"
                   // | "wrong_variable_ref" | "other"
  targetField String?  // 涉及的字段路径，如 "response.returnCode" / "body.adjustmentType"

  // 自然语言部分（用于 AI 阅读 + UI 展示）
  summary     String   // 一句话归因
  detail      String?  // 详情（AI 分析 / 用户描述）
  suggestion  String?  // 修复建议

  // 证据快照（保命用：审计 + 反馈不会因后续数据变化而失真）
  evidence String?  // JSON: { request, response, assertions, errorMessage }

  // 状态机
  status String @default("open")  // "open"(待处理) | "acknowledged"(已确认有效)
                                  // | "fixed"(已修复) | "wontfix"(误报/无关)

  // 谁打的标 / 谁处理的
  createdBy String?
  resolvedBy String?
  resolvedAt DateTime?

  // 工作区归属（决策 10：归属轴）
  workspaceId String?

  // 反馈被 N 次生成命中（每次 AI 查询并采纳后 ++，用于度量"反馈进化"是否真在起作用）
  consumedCount Int @default(0)

  @@index([apiId, status])           // 主查询路径：按接口拉"已确认"反馈
  @@index([testCaseId])
  @@index([caseExecutionId])
  @@index([category, status])         // 全局看：哪类错误最多
  @@index([workspaceId, status])
  @@index([createdAt])
}
```

**为什么这样设计：**
- **三向外键全部可空**：source = `user_comment` 时可能没绑定 execution，只挂 testCase
- **category 是枚举**：自由文本反馈进 AI 等于垃圾。category 给 AI 当索引键
- **evidence 是快照**：执行记录可能被清理 / 接口可能被改，反馈作为资产必须自带证据
- **consumedCount**：度量"AI 是否真的看了反馈"，避免反馈攒了一堆没人用

---

## 二、捕获层（数据怎么进来）

### 2.1 入口 A：执行失败现场（主入口）

**位置**：[app/execution/suite/[executionId]/page.tsx](app/execution/suite/[executionId]/page.tsx) 的 case 行 + [components/reports/CaseExecutionDialog.tsx](components/reports/CaseExecutionDialog.tsx) 的步骤面板

**两个按钮**：

1. **case 行（page.tsx 行 488-525 区域）**：仅 `status === 'failed'` 时显示「AI 归因」按钮
   - 点击 → 调 `POST /api/ai/diagnose-failure`（新增），传 `caseExecutionId`
   - 后端拉执行快照 + testCaseSnapshot + 关联 API 详情 → 喂 AI → AI 输出**结构化归因**（category + summary + suggestion）
   - 直接落 `TestCaseFeedback`，status = `open`
   - 弹小卡片展示 AI 分析，用户可一键「确认」(→ acknowledged) / 「不准」(→ wontfix)

2. **CaseExecutionDialog 步骤详情面板**：每条断言旁加小按钮「我觉得这断言有问题」
   - 直接打 `category: assertion_wrong`，跳过 AI 分析（用户直接知道）
   - 弹简单输入框收 summary + suggestion

### 2.2 入口 B：用例编辑（次入口）

**位置**：用例编辑保存时（[app/api/test-cases/[id]/route.ts](app/api/test-cases/[id]/route.ts) 的 PUT 路径）

逻辑：
- 用例存在 `sourceFingerprint` 或 `sourceFunctionalCaseId`（说明是 AI 生成的）
- 且这次编辑改动了 assertions / variableRefs / params
- → 自动打一条 `source: user_edit` 的反馈，category 用启发式规则推断（断言改了 → `assertion_wrong`，参数改了 → `param_constraint_missed`）
- status = `open`（不打扰用户，但攒料）

**为什么自动**：用户**改用例的行为**比"主动吐槽"频繁 100 倍，是最大的反馈金矿。

### 2.3 入口 C：用例旁的吐槽框（最低优先级，后做）

用例详情页加「反馈给 AI」按钮 → 写一条 `source: user_comment` 的开放反馈。

**先做 A 和 B，C 等数据攒起来再说**——没锚点的吐槽是垃圾。

---

## 三、归因 AI（diagnose-failure 路由）

**新增**：[app/api/ai/diagnose-failure/route.ts](app/api/ai/diagnose-failure/route.ts)

**输入**：`{ caseExecutionId }`

**流程**：
1. 拉 `TestCaseExecution` + `stepExecutions`（含 request/response/assertionResults/errorMessage）
2. 拉 `testCaseSnapshot`（用例当时的完整配置）
3. 对失败步骤的 apiId 调 `getApiDetail`（复用 [lib/ai-tools/index.ts](lib/ai-tools/index.ts:23)）拿当前接口真相
4. 喂 AI，prompt 要求**输出严格枚举的 category** + summary + detail + suggestion + targetField
5. 服务端验证 category 是合法枚举 → 落 `TestCaseFeedback`
6. SSE 流回前端

**Prompt 核心约束**（新文件 [lib/ai-prompts/diagnose-prompt.ts](lib/ai-prompts/diagnose-prompt.ts)）：
- 角色：根因分析师，不是修理工（不要"我帮你改"，要"为什么错"）
- category 必须从枚举里选一个
- 如果 AI 觉得是"接口变了"（看 getApiDetail 返回的 path / 字段名 vs 快照），明确标 `api_path_changed`
- 不在归因里搞自由发挥

---

## 四、反喂层：让两个生成 agent 看到反馈

### 4.1 新增 AI 工具 `query_api_feedback`

**位置**：[lib/ai-tools/index.ts](lib/ai-tools/index.ts) 的 `AI_TOOLS` 数组

```ts
{
  name: "query_api_feedback",
  description: "查询某个接口在历史用例中暴露过的问题（仅返回 acknowledged 状态的反馈，避免噪音）。在调用 get_api_detail 之后、设计用例参数/断言之前调用，可以避开已知坑。",
  parameters: {
    apiId: string,
    limit?: number  // 默认 5
  }
}
```

**实现**：
```ts
prisma.testCaseFeedback.findMany({
  where: { apiId, workspaceId, status: 'acknowledged' },
  orderBy: [{ consumedCount: 'desc' }, { updatedAt: 'desc' }],
  take: limit
})
```

返回字段精简到 AI 必需的：`category`、`summary`、`targetField`、`suggestion`。**不返回 detail / evidence**（节省 token，AI 不需要原始证据）。

同时 `consumedCount++`（度量反馈被实际使用的次数）。

### 4.2 system prompt 微调

**smart-generate 的 [lib/ai-prompts/system-prompt.ts](lib/ai-prompts/system-prompt.ts)**：
在「## 🛠️ 可用工具」`get_api_detail` 之后新增 `query_api_feedback`，并在「工作流程」加一句：
> 对每个将要使用的接口，在 `get_api_detail` 之后调一次 `query_api_feedback`，把返回的避坑提示作为设计断言/参数/前置的约束输入。

**explore-generate 的 [lib/ai-prompts/explore-generate-prompt.ts](lib/ai-prompts/explore-generate-prompt.ts)**：
在「工具调用顺序」第 2 步后加 2.5：
> 2.5. `query_api_feedback` → 拉该接口的历史避坑清单，影响断言和参数的取舍。

**关键**：避坑提示**作为软约束**进 prompt——AI 仍按场景/title 严格落地，但断言/参数受历史经验影响。

---

## 五、反馈生效门控（评审环节）

新增简单的反馈列表页 [app/feedback/page.tsx](app/feedback/page.tsx)：
- 默认筛 `status: open` + 按 category 分组
- 每条可 acknowledged / wontfix
- 只有 `acknowledged` 的反馈才会被 `query_api_feedback` 返回给 AI

**为什么必须门控**：
- `execution_failure` 来源的归因可能是 AI 误判
- `user_edit` 来源的反馈是启发式推断，未必准
- **直接喂 AI 等于变相绕过决策 5**（businessSemantics 不自动合并的精神）

入口可挂在 sidebar 「AI 探索」分组下，或在执行详情页加角标提示「3 条反馈待评审」。

---

## 六、闭环度量（数据告诉我们值不值）

每条反馈带 `consumedCount`，每周看：
- 反馈总量、按 category 分布
- acknowledged 占比（评审是否积压）
- 高 consumedCount 的反馈（说明在反复救命）
- 同接口反馈率（哪些接口是"用例失败重灾区"）

挂在已有 [app/api/dashboard/stats/route.ts](app/api/dashboard/stats/route.ts) 里加几个字段即可。

---

## 七、与既有红线 / 资产总线的对齐

| 红线 | 本方案如何遵守 |
|------|--------------|
| 决策 5：businessSemantics 不自动合并 | 反馈是独立资产，**绝不写回 API.businessSemantics**；要更新语义必须人工到接口详情页编辑 override |
| 决策 7：AI 作工具+prompt 扩展，不产 SQL/flowConfig | 反馈只影响 AI **设计阶段** 的取舍，不直接生成代码或 SQL |
| 决策 10：workspace 收敛 + AssetEvent 总线 | TestCaseFeedback 带 workspaceId；表结构按"未来 1:1 映射到 AssetEvent"设计（三向外键 + category + evidence），等 AssetEvent 表建好后可平移迁移 |

---

## 八、实施顺序（按价值密度排序）

1. **Schema + 入口 A 主路径**（最高密度）
   - 加 `TestCaseFeedback` 表 + `prisma db push`
   - 新增 [app/api/ai/diagnose-failure/route.ts](app/api/ai/diagnose-failure/route.ts)
   - 在执行详情页加「AI 归因」按钮（仅 failed 用例）
   - 写一个最小评审弹窗（确认 / 不准）

2. **反馈反喂生成**
   - 加 `query_api_feedback` 工具
   - 改两个 system prompt
   - 加反馈列表页 [app/feedback/page.tsx](app/feedback/page.tsx)

3. **入口 B：用例编辑自动打反馈**
   - 改 [app/api/test-cases/[id]/route.ts](app/api/test-cases/[id]/route.ts) 的 PUT
   - 启发式推断 category

4. **入口 C：用例详情吐槽框**（最后做，看 1+2 数据再决定）

5. **闭环度量**
   - 在 dashboard 加反馈相关指标
   - 上 docs/DESIGN_DECISIONS.md 一条新决策："AI 反馈闭环走独立资产，不污染 businessSemantics"

---

## 关键文件总览

**新建**：
- `prisma/schema.prisma` 内新增 model TestCaseFeedback
- [app/api/ai/diagnose-failure/route.ts](app/api/ai/diagnose-failure/route.ts) —— AI 归因路由
- [app/api/feedback/route.ts](app/api/feedback/route.ts) —— 反馈 CRUD（列表 / 改状态）
- [app/feedback/page.tsx](app/feedback/page.tsx) —— 反馈评审页
- [lib/ai-prompts/diagnose-prompt.ts](lib/ai-prompts/diagnose-prompt.ts) —— 归因 prompt
- [components/feedback/FailureDiagnoseDialog.tsx](components/feedback/FailureDiagnoseDialog.tsx) —— 执行详情页里的归因小弹窗

**改动**：
- [lib/ai-tools/index.ts](lib/ai-tools/index.ts) —— 加 `query_api_feedback` 工具
- [lib/ai-prompts/system-prompt.ts](lib/ai-prompts/system-prompt.ts) —— smart-generate 提示 AI 用新工具
- [lib/ai-prompts/explore-generate-prompt.ts](lib/ai-prompts/explore-generate-prompt.ts) —— explore-generate 提示 AI 用新工具
- [app/execution/suite/[executionId]/page.tsx](app/execution/suite/[executionId]/page.tsx) —— failed case 行加「AI 归因」按钮
- [components/reports/CaseExecutionDialog.tsx](components/reports/CaseExecutionDialog.tsx) —— 断言旁加「断言有问题」小按钮
- [app/api/test-cases/[id]/route.ts](app/api/test-cases/[id]/route.ts) —— 编辑保存时自动打 user_edit 反馈
- [components/sidebar.tsx](components/sidebar.tsx) —— 加「反馈评审」入口
- [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md) —— 追加决策条目
- [CLAUDE.md](CLAUDE.md) —— 红线清单加一条「反馈不污染 businessSemantics」

---

## 验证

**端到端验证路径**（按这个跑一遍证明闭环成立）：

1. 用 smart-generate 生成一条用例（接口 X，假设 X 的成功业务码是 0，但 AI 默认按 200 断言）
2. 执行 → 失败（业务码不匹配）
3. 点「AI 归因」→ 应输出 `category: business_code_assumption` + `targetField: response.returnCode` + suggestion
4. 在反馈评审页 acknowledged
5. 再用 smart-generate 生成涉及接口 X 的新用例 → AI 在工具调用日志里能看到 `query_api_feedback` 被调用 + 返回了"X 的成功码是 0" → 新用例的断言写对
6. 反馈记录的 `consumedCount` 应该 ++

**单元测试**：
- `TestCaseFeedback` schema 字段完整性
- `diagnose-failure` 路由的 category 枚举校验
- `query_api_feedback` 按 status / workspace 过滤正确

**手动验证**：
- 在 [app/execution/suite/[executionId]/page.tsx](app/execution/suite/[executionId]/page.tsx) 跑一次失败用例，验证按钮显示和归因流程
- 验证 `user_edit` 自动反馈不会重复打（同一用例同一字段改两次 → 只更新最近一条 / 或合并）

