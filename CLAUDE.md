# CLAUDE.md — AI 开发上岗须知

> 本文件供 Claude Code / AI agent 在本项目开发前自动阅读。
> **开发任何功能前，先读 [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md)。**

## ⚠️ 第一条：开发前必读

**在修改代码前，必须先阅读 [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md)。**

该文件记录了关键设计决策的"为什么、约束、涉及代码、反例"。代码里只有结论没有推理；不读它直接改，极易破坏既有设计（典型如把业务语义改成自动合并）。改动涉及的功能，先找到对应决策条目，确认其"约束"和"反例"。

## 项目是什么

AI 驱动的接口测试平台：用户用自然语言描述需求 → AI 通过 Function Calling 搜接口、设计用例、组装结构 → 落库 → Python 执行器实际跑测试。

- 前端/后端：Next.js（端口 3009），TypeScript
- 执行器：Python + FastAPI（端口 8001），纯 HTTP 断言引擎
- 数据库：SQLite + Prisma（用 `prisma db push`，无 migration 文件）
- AI：多厂商（OpenAI/DeepSeek/Ollama，OpenAI 兼容）

## 接口知识来源（API 仓库）

接口通过四种方式进入仓库，都转成统一的 `CapturedApi`（`types/har.ts`）：
1. 录制（浏览器/代理/mitmproxy）— 真实 token + 真实样本
2. HAR 导入
3. **Swagger/OpenAPI 导入** — 全量接口 + 参数约束 + 业务语义
4. 手动新建

## 🚫 不可破坏的核心约束（红线）

详见 DESIGN_DECISIONS.md，最关键的几条：

1. **业务语义（businessSemantics）必须走 diff 人工评审，绝不自动合并**。它是 baseline（文档）+ override（平台）双层存储；同步时 baseline 反映文档、override 不被同步改动；仅 `confirmed` 状态注入 AI。（决策 5）
2. **普通字段**（body/header/约束）多来源导入走 `lib/api-merge.ts` 字段级智能合并——"新值有意义才覆盖，约束只增不减、录制真值优先"。不要改回整条覆盖。（决策 4）
3. **新接口来源**（curl/Postman 等）转成 `CapturedApi` 复用现有 save/查重链路，不另起炉灶。（决策 1）
4. **Swagger 在线拉取必须有 SSRF 防护**，不要去掉。（决策 2）
5. **x-db-asserts 的 SQL 当前不执行**，只作 AI 理解素材；不要在 flowConfig 生成 SQL 断言节点。（决策 6）
6. **AI 能力作为"工具 + prompt 指导"扩展**，不要让 AI 直接产出底层 flowConfig/SQL。（决策 7）

## 关键文件地图

| 关注点 | 文件 |
|--------|------|
| 统一接口结构 / 语义类型 | `types/har.ts` |
| Swagger 解析 + 语义提取 | `lib/swagger-parser.ts` |
| 普通字段合并 | `lib/api-merge.ts` |
| 语义 diff / 同步 | `lib/semantics-diff.ts` |
| 保存（含合并/语义同步） | `app/api/api-library/save/route.ts` |
| Swagger 导入路由（SSRF） | `app/api/api-library/import-swagger/route.ts` |
| AI 生成主循环 | `app/api/ai/smart-generate/route.ts` |
| AI 工具 / getApiDetail | `lib/ai-tools/index.ts` |
| AI system prompt | `lib/ai-prompts/system-prompt.ts` |
| 编排组装引擎 | `lib/ai-tools/assembler.ts` |
| 执行器（断言引擎） | `executor/assertion_engine.py` |

## 开发约定

- 验证：`npm run build` 通过；改动文件 lint 不引入新的错误类别（项目存量大量 `no-explicit-any`，沿用既有风格，不必为旧代码消除）
- 改 schema：编辑 `prisma/schema.prisma` 后 `npx prisma db push`（Windows 上 dev 服务器占用引擎 DLL 时 `prisma generate` 可能 EPERM，重启 dev 即可）
- 文档：用户操作文档在 `docs/user-guide/`；设计决策追加到 `docs/DESIGN_DECISIONS.md`（新增重要决策时同步更新本文件红线清单）
