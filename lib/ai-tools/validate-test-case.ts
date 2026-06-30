/**
 * 用例有效性自检（v1 · 纯规则）
 *
 * 目的：在 AI 调用 assemble_and_create_test_cases 之前强制走一道自检，
 * 把"伪用例"（永远不会失败、断言空洞、无前置数据的查询、伪多样性枚举遍历…）
 * 的常见模式以 warning 形式暴露给 AI。
 *
 * 设计原则（与 CLAUDE.md 决策对齐）：
 *   - 决策 7：AI 能力作为"工具+prompt 指导"扩展。本工具不自动修改 plan，只暴露问题。
 *   - 决策 10：按 workspaceId 收敛，所有数据库查询都带 workspace 过滤。
 *   - 决策 12：本工具是"事前"自检，与 TestCaseFeedback（事后反馈）协同，互不替代。
 *
 * 第一版规则集（10 条，全部基于静态分析 + 一次性批量查同实体 CRUD）：
 *
 *   通用 6 条：
 *   - WEAK_ASSERTION_ONLY_STATUS    断言只有 HTTP 200，无业务码/字段校验
 *   - QUERY_WITHOUT_PRECONDITION    单接口查询用例无前置造数据，且仓库里存在同实体 create 接口
 *   - ASSERTION_ON_EMPTY_LIST       断言假设结果非空（如 returnObject[0].id），但无前置造数据
 *   - MISSING_FILTER_VERIFICATION   传了过滤参数（status/state/type）但未断言返回结果符合过滤条件
 *   - IDENTICAL_PARAM_VARIANTS      批次内多个用例只是某枚举字段不同，其他完全相同，均无前置造数据
 *   - CLEANUP_MISSING               用例创建了资源但无 isCleanup 节点
 *
 *   柜台专属 4 条（决策 13）：
 *   - MONEY_FLOAT_RISK              金额字段用了 number/auto 而非 decimal（精度风险）
 *   - TRACE_NO_ONLY_EXISTS          流水号/凭证号字段用了 exists（对空串放水），应改 notEmpty
 *   - RETURN_CODE_NOT_ASSERTED      没断言任何业务码（returnCode/respCode/...）
 *   - DETAIL_LIST_NO_OWNERSHIP_CHECK 查询传了归属参数（accountNo/customerId）但未验证返回明细的归属字段（越权风险）
 *
 * 工具不抛错；apiId 不存在 / workspace 越界等问题也以 warning 形式返回（code: INVALID_API_ID）。
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * 编排指令的最小子集（与 OrchestrationPlan 同构，但只取本工具用到的字段，
 * 避免与 types/orchestration 的演进强耦合）
 */
interface PlanNode {
  id: string;
  type?: string;
  apiId?: string;
  params?: {
    pathParams?: Record<string, unknown>;
    queryParams?: Record<string, unknown>;
    headers?: Record<string, unknown>;
    body?: Record<string, unknown>;
  };
  assertions?: Array<{
    field?: string;
    operator?: string;
    expected?: unknown;
    expectedType?: string;
  }>;
  variableRefs?: Array<{
    paramPath?: string;
    sourceNode?: string;
    sourcePath?: string;
  }>;
  isCleanup?: boolean;
}

interface PlanTestCase {
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  nodes: PlanNode[];
  edges?: Array<{ from: string; to: string }>;
}

interface OrchestrationPlanLike {
  testCases: PlanTestCase[];
}

export interface ValidateWarning {
  code: string;
  severity: 'warn' | 'info';
  message: string;
  nodeId?: string;
}

export interface ValidateResult {
  testCases: Array<{ name: string; warnings: ValidateWarning[] }>;
  summary: { totalWarnings: number; rulesTriggered: string[] };
}

type CrudAction = 'create' | 'update' | 'delete' | 'query' | 'other';

/**
 * 用例规则上下文：所有规则共享，避免每条规则重复查 DB
 */
interface RuleContext {
  /** apiId → 该 API 的基本信息（含同实体 CRUD 全景） */
  apiInfo: Map<
    string,
    {
      id: string;
      name: string;
      method: string;
      path: string;
      platform: string | null;
      component: string | null;
      feature: string | null;
      /** 同实体内（按 feature 优先，回退到 component）是否存在 create 接口 */
      hasSiblingCreate: boolean;
      /** 同实体内 create 接口的 id 列表（最多 3 条，提示用） */
      siblingCreateIds: string[];
      /** 简单 CRUD 动作分类 */
      action: CrudAction;
    }
  >;
}

// ============================================================================
// 工具函数
// ============================================================================

const CREATE_KEYWORDS = ['创建', '新增', '添加', '注册', '保存', 'create', 'add', 'register', 'save'];
const UPDATE_KEYWORDS = ['修改', '更新', '编辑', 'update', 'edit', 'modify', 'patch'];
const DELETE_KEYWORDS = ['删除', '移除', 'delete', 'remove'];
const QUERY_KEYWORDS = ['查询', '获取', '列表', '详情', 'query', 'list', 'get', 'detail'];

/** 常见"过滤型"参数名（用于 MISSING_FILTER_VERIFICATION） */
const FILTER_PARAM_NAMES = [
  'status', 'state', 'type', 'category', 'kind', 'level', 'role', 'mode', 'tag',
];

/**
 * 柜台资金类字段关键字（用于 MONEY_FLOAT_RISK）。
 * 字段名命中这些关键字时，expectedType 应该用 decimal，否则金额走 float 有精度风险。
 */
const MONEY_FIELD_KEYWORDS = [
  'amount', 'balance', 'fee', 'price', 'sum', 'total', 'cost', 'rate', 'share',
  'money', 'cash', 'value', '金额', '余额', '手续费', '价格', '利率', '份额',
];

/**
 * 柜台流水号/凭证号/订单号字段关键字（用于 TRACE_NO_ONLY_EXISTS）。
 * 这些字段不能用 exists 断言——后端忘赋值时返回 "" 会被 exists 放水。
 */
const TRACE_FIELD_KEYWORDS = [
  'traceno', 'serialno', 'orderno', 'requestid', 'transactionid', 'transid', 'txnid',
  'voucherno', 'billno', 'refno', '流水号', '凭证号', '订单号', '交易号', '票号',
];

/**
 * 柜台业务码字段关键字（用于 RETURN_CODE_NOT_ASSERTED）。
 */
const RETURN_CODE_FIELD_KEYWORDS = [
  'returncode', 'respcode', 'resultcode', 'errcode', 'errorcode', 'bizcode', 'rspcode',
];

/**
 * 归属类参数名（用于 DETAIL_LIST_NO_OWNERSHIP_CHECK）。
 * 查询时传了这些参数 = 在查"某账户/某客户"的资源，返回的明细必须验证归属字段一致。
 */
const OWNERSHIP_PARAM_KEYWORDS = [
  'accountno', 'accountid', 'customerno', 'customerid', 'custno', 'custid',
  'tenantid', 'tenantno', 'userid', 'memberid',
  '账户', '客户', '租户',
];

function includesAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k.toLowerCase()));
}

function inferAction(api: { name: string; method: string; path: string }): CrudAction {
  const text = `${api.name} ${api.path}`;
  const method = (api.method || '').toUpperCase();

  if (method === 'DELETE' || includesAny(text, DELETE_KEYWORDS)) return 'delete';
  if ((method === 'POST' || method === 'PUT') && includesAny(text, CREATE_KEYWORDS)) return 'create';
  if ((method === 'PUT' || method === 'PATCH' || method === 'POST') && includesAny(text, UPDATE_KEYWORDS)) return 'update';
  if (method === 'GET' || includesAny(text, QUERY_KEYWORDS)) return 'query';
  return 'other';
}

/**
 * 收集 plan 中所有 apiId，批量查询 API 基本信息及其同实体 CRUD 全景
 *
 * 性能：N 个用例 + M 个不同 apiId 只产生 1 次 IN 查询 + 1 次按 feature/component 的聚合查询
 */
async function buildContext(plan: OrchestrationPlanLike, workspaceId: string): Promise<RuleContext> {
  const apiIds = new Set<string>();
  for (const tc of plan.testCases) {
    for (const node of tc.nodes) {
      if (node.apiId) apiIds.add(node.apiId);
    }
  }

  if (apiIds.size === 0) {
    return { apiInfo: new Map() };
  }

  // 1) 批量查 plan 用到的 API
  const apis = await prisma.api.findMany({
    where: { id: { in: Array.from(apiIds) }, workspaceId },
    select: {
      id: true,
      name: true,
      method: true,
      path: true,
      platform: true,
      component: true,
      feature: true,
    },
  });

  // 2) 按 (platform, component, feature) 聚合，查同实体下的所有 API（仅为找 create 接口）
  type GroupKey = { platform: string | null; component: string | null; feature: string | null };
  const keyStr = (g: GroupKey) =>
    JSON.stringify([g.platform ?? null, g.component ?? null, g.feature ?? null]);

  const uniqueKeys = new Map<string, GroupKey>();
  for (const a of apis) {
    uniqueKeys.set(keyStr({ platform: a.platform, component: a.component, feature: a.feature }), {
      platform: a.platform,
      component: a.component,
      feature: a.feature,
    });
  }

  // 同 feature 优先；feature 太空时回退同 component
  const groupEntries = await Promise.all(
    Array.from(uniqueKeys.entries()).map(async ([k, gk]) => {
      const sameFeature = gk.feature
        ? await prisma.api.findMany({
            where: {
              workspaceId,
              platform: gk.platform,
              component: gk.component,
              feature: gk.feature,
            },
            select: { id: true, name: true, method: true, path: true },
            take: 30,
          })
        : [];

      let sameComponent: typeof sameFeature = [];
      if (sameFeature.length < 2 && gk.component) {
        sameComponent = await prisma.api.findMany({
          where: { workspaceId, platform: gk.platform, component: gk.component },
          select: { id: true, name: true, method: true, path: true },
          take: 30,
        });
      }

      return [k, sameFeature.length >= 2 ? sameFeature : sameComponent] as const;
    })
  );

  const groupPool = new Map(groupEntries);

  // 3) 组装 apiInfo
  const apiInfo: RuleContext['apiInfo'] = new Map();
  for (const a of apis) {
    const k = keyStr({ platform: a.platform, component: a.component, feature: a.feature });
    const pool = groupPool.get(k) ?? [];

    const createSiblings = pool
      .filter(p => p.id !== a.id)
      .filter(p => {
        const action = inferAction({ name: p.name, method: p.method, path: p.path ?? '' });
        return action === 'create';
      })
      .slice(0, 3);

    apiInfo.set(a.id, {
      id: a.id,
      name: a.name,
      method: a.method,
      path: a.path ?? '',
      platform: a.platform,
      component: a.component,
      feature: a.feature,
      hasSiblingCreate: createSiblings.length > 0,
      siblingCreateIds: createSiblings.map(s => s.id),
      action: inferAction({ name: a.name, method: a.method, path: a.path ?? '' }),
    });
  }

  return { apiInfo };
}

// ============================================================================
// 规则实现
// ============================================================================

type Rule = (tc: PlanTestCase, ctx: RuleContext, allCases: PlanTestCase[]) => ValidateWarning[];

/**
 * 规则 1: WEAK_ASSERTION_ONLY_STATUS
 * 节点的 assertions 只有 status==200，无其他字段校验
 *
 * 例外：清理节点（isCleanup: true）允许只校验 status，不强制业务码
 */
const ruleWeakAssertionOnlyStatus: Rule = (tc) => {
  const warnings: ValidateWarning[] = [];
  for (const node of tc.nodes) {
    if (node.type !== 'api') continue;
    if (node.isCleanup) continue; // 清理节点豁免
    const a = node.assertions ?? [];
    if (a.length === 0) continue; // 由组装器的 minItems:1 兜底，这里不重复抛

    const onlyStatus =
      a.every(x => {
        const f = (x.field ?? '').toLowerCase();
        // status / responseStatus / responseStatus.code 等都算 status 系列
        return f === 'status' || f === 'response.status' || f === 'responsestatus';
      });

    if (onlyStatus) {
      warnings.push({
        code: 'WEAK_ASSERTION_ONLY_STATUS',
        severity: 'warn',
        nodeId: node.id,
        message: `节点 ${node.id} 只断言了 HTTP status，无法验证业务正确性。HTTP 200 仅表示通信成功；请补充业务码（如 returnCode）或关键字段（如 returnObject.id）断言。`,
      });
    }
  }
  return warnings;
};

/**
 * 规则 2: QUERY_WITHOUT_PRECONDITION
 * 用例只有 1 个 query 节点、无前置 create/update 节点，且仓库存在同实体 create 接口
 */
const ruleQueryWithoutPrecondition: Rule = (tc, ctx) => {
  const warnings: ValidateWarning[] = [];
  const apiNodes = tc.nodes.filter(n => n.type === 'api' && !n.isCleanup);
  if (apiNodes.length !== 1) return warnings; // 多步用例不触发本规则

  const only = apiNodes[0];
  const info = only.apiId ? ctx.apiInfo.get(only.apiId) : undefined;
  if (!info || info.action !== 'query') return warnings;

  if (info.hasSiblingCreate) {
    const hint = info.siblingCreateIds.slice(0, 2).join(', ');
    warnings.push({
      code: 'QUERY_WITHOUT_PRECONDITION',
      severity: 'warn',
      nodeId: only.id,
      message:
        `用例 "${tc.name}" 只调用查询接口 "${info.name}"，无前置造数据步骤；仓库里有同实体的创建接口（apiId: ${hint}）。` +
        `如果意图是验证业务功能，建议升级为「造数据 → 查询」E2E flow；如果意图是接口契约测试（不验证业务数据），请在用例 description 里显式写明，否则视为伪用例。`,
    });
  }
  return warnings;
};

/**
 * 规则 3: ASSERTION_ON_EMPTY_LIST
 * 断言假设结果非空（出现 list[0]、returnObject[0]、total>0、length>0 等模式），
 * 但用例无前置造数据节点
 */
const ruleAssertionOnEmptyList: Rule = (tc, ctx) => {
  const warnings: ValidateWarning[] = [];
  const apiNodes = tc.nodes.filter(n => n.type === 'api' && !n.isCleanup);
  // 是否有前置 create 节点（在该 query 节点之前出现）
  const hasPriorCreate = (nodeIdx: number) => {
    for (let i = 0; i < nodeIdx; i++) {
      const prior = apiNodes[i];
      const info = prior.apiId ? ctx.apiInfo.get(prior.apiId) : undefined;
      if (info && info.action === 'create') return true;
    }
    return false;
  };

  for (let i = 0; i < apiNodes.length; i++) {
    const node = apiNodes[i];
    const info = node.apiId ? ctx.apiInfo.get(node.apiId) : undefined;
    if (!info || info.action !== 'query') continue;
    if (hasPriorCreate(i)) continue; // 有前置造数据就不警告

    for (const asn of node.assertions ?? []) {
      const f = asn.field ?? '';
      const op = asn.operator ?? '';
      const exp = asn.expected;

      const fieldImpliesNonEmpty = /\[\s*0\s*\]/.test(f) || f.endsWith('.length') || f.endsWith('total');
      const opImpliesNonEmpty =
        (f.endsWith('total') || f.endsWith('.length')) &&
        (op === 'greaterThan' || (op === 'equals' && typeof exp === 'number' && exp > 0));

      if (fieldImpliesNonEmpty || opImpliesNonEmpty) {
        warnings.push({
          code: 'ASSERTION_ON_EMPTY_LIST',
          severity: 'warn',
          nodeId: node.id,
          message:
            `节点 ${node.id} 的断言 "${f} ${op} ${JSON.stringify(exp ?? '')}" 假设了结果非空，` +
            `但用例无前置造数据步骤。如果测试环境无种子数据，该断言必失败；` +
            `请改为条件断言（list 非空时再校验）或在用例前加造数据节点。`,
        });
        break; // 同节点同类问题只报一次
      }
    }
  }
  return warnings;
};

/**
 * 规则 4: MISSING_FILTER_VERIFICATION
 * 查询节点传了 status/state/type 等过滤参数，但断言里没有对应字段一致性校验
 */
const ruleMissingFilterVerification: Rule = (tc, ctx) => {
  const warnings: ValidateWarning[] = [];
  for (const node of tc.nodes) {
    if (node.type !== 'api' || node.isCleanup) continue;
    const info = node.apiId ? ctx.apiInfo.get(node.apiId) : undefined;
    if (!info || info.action !== 'query') continue;

    const queryParams = (node.params?.queryParams ?? {}) as Record<string, unknown>;
    const filterFields = Object.keys(queryParams).filter(k =>
      FILTER_PARAM_NAMES.includes(k.toLowerCase())
    );
    if (filterFields.length === 0) continue;

    for (const ff of filterFields) {
      const value = queryParams[ff];
      // 断言里是否有任何字段路径包含该过滤字段名（如 returnObject.list[0].status）
      const hasMatchingAssertion = (node.assertions ?? []).some(asn => {
        const af = (asn.field ?? '').toLowerCase();
        return af.includes(ff.toLowerCase());
      });

      if (!hasMatchingAssertion) {
        warnings.push({
          code: 'MISSING_FILTER_VERIFICATION',
          severity: 'warn',
          nodeId: node.id,
          message:
            `节点 ${node.id} 传了过滤参数 queryParams.${ff}=${JSON.stringify(value)}，` +
            `但 assertions 里没有任何字段校验 ${ff}。过滤逻辑反了也察觉不到；` +
            `建议补充：返回结果非空时，至少校验首条记录的 ${ff} 等于入参（如 returnObject.list[0].${ff} == ${JSON.stringify(value)}）。`,
        });
      }
    }
  }
  return warnings;
};

/**
 * 规则 5: IDENTICAL_PARAM_VARIANTS（批次级规则，扫所有用例）
 * 批次内出现 N≥2 个用例：节点序列相同 + 只有某一个枚举字段不同 + 都无前置造数据
 */
const ruleIdenticalParamVariants = (allCases: PlanTestCase[], ctx: RuleContext): Map<string, ValidateWarning[]> => {
  const perCase = new Map<string, ValidateWarning[]>();

  // 取每个用例的"签名"：节点 apiId 序列 + 节点数 + 是否含造数据
  // 同签名分组后，若组内 ≥2 个，且 queryParams 只在 1 个 key 上不同，触发警告
  const sigOf = (tc: PlanTestCase) => {
    const apiNodes = tc.nodes.filter(n => n.type === 'api' && !n.isCleanup);
    return apiNodes.map(n => n.apiId ?? '').join('|');
  };

  const hasPriorCreateInCase = (tc: PlanTestCase) => {
    return tc.nodes.some(n => {
      if (n.type !== 'api' || n.isCleanup) return false;
      const info = n.apiId ? ctx.apiInfo.get(n.apiId) : undefined;
      return info?.action === 'create';
    });
  };

  const groups = new Map<string, PlanTestCase[]>();
  for (const tc of allCases) {
    const sig = sigOf(tc);
    if (!sig) continue;
    if (hasPriorCreateInCase(tc)) continue; // 有造数据就不算伪多样性
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig)!.push(tc);
  }

  for (const [, group] of groups) {
    if (group.length < 2) continue;

    // 对比组内首个用例第一个 api 节点的 queryParams + body
    const baseline = group[0];
    const baseFirst = baseline.nodes.find(n => n.type === 'api' && !n.isCleanup);
    if (!baseFirst) continue;
    const baseFlat = JSON.stringify({
      q: baseFirst.params?.queryParams ?? {},
      b: baseFirst.params?.body ?? {},
    });

    // 找差异字段
    const diffFields = new Set<string>();
    for (const tc of group) {
      const first = tc.nodes.find(n => n.type === 'api' && !n.isCleanup);
      if (!first) continue;
      const q = (first.params?.queryParams ?? {}) as Record<string, unknown>;
      const bq = (baseFirst.params?.queryParams ?? {}) as Record<string, unknown>;
      for (const k of new Set([...Object.keys(q), ...Object.keys(bq)])) {
        if (JSON.stringify(q[k]) !== JSON.stringify(bq[k])) diffFields.add(k);
      }
    }

    // 只在 1 个字段上不同 → 伪多样性
    if (diffFields.size === 1) {
      const [diffKey] = diffFields;
      const msg =
        `本批次有 ${group.length} 个用例（${group.map(g => `"${g.name}"`).join(', ')}）只是 queryParams.${diffKey} 不同，` +
        `节点序列完全相同，且均无前置造数据。这是"伪多样性"——` +
        `如果意图是接口契约测试，建议合并为 1 个用例（在 description 里写明意图）；` +
        `如果意图是验证每种枚举值的业务正确性，必须为每种状态准备前置数据，否则空结果通过没有验证价值。`;
      for (const tc of group) {
        const arr = perCase.get(tc.name) ?? [];
        arr.push({
          code: 'IDENTICAL_PARAM_VARIANTS',
          severity: 'warn',
          message: msg,
        });
        perCase.set(tc.name, arr);
      }
    }
    void baseFlat; // 保留以便未来扩展 body diff
  }

  return perCase;
};

/**
 * 规则 6: CLEANUP_MISSING
 * 用例含 create 类节点但无 isCleanup 节点
 */
const ruleCleanupMissing: Rule = (tc, ctx) => {
  const warnings: ValidateWarning[] = [];
  const hasCreate = tc.nodes.some(n => {
    if (n.type !== 'api' || n.isCleanup) return false;
    const info = n.apiId ? ctx.apiInfo.get(n.apiId) : undefined;
    return info?.action === 'create';
  });
  const hasCleanup = tc.nodes.some(n => n.isCleanup === true);

  if (hasCreate && !hasCleanup) {
    warnings.push({
      code: 'CLEANUP_MISSING',
      severity: 'warn',
      message:
        `用例 "${tc.name}" 创建了资源但无清理节点（isCleanup: true）。` +
        `建议调用 smart_search_delete_api 查找删除接口并加 cleanup 节点，避免污染测试环境。`,
    });
  }
  return warnings;
};

/**
 * 规则 7: MONEY_FLOAT_RISK（柜台资金断言精度防线）
 * 字段名含 amount/balance/fee/... 等金额关键字，但 expectedType 是 number/auto
 * → 警告改用 decimal，避免 float 精度误差（如 0.1+0.2≠0.3）
 */
const ruleMoneyFloatRisk: Rule = (tc) => {
  const warnings: ValidateWarning[] = [];
  for (const node of tc.nodes) {
    if (node.type !== 'api') continue;
    for (const asn of node.assertions ?? []) {
      const f = (asn.field ?? '').toLowerCase();
      const op = asn.operator ?? '';
      const et = asn.expectedType ?? 'auto';

      // 只对数值类比较算子检查
      if (!['equals', 'notEquals', 'greaterThan', 'lessThan'].includes(op)) continue;
      if (et === 'decimal' || et === 'string') continue; // string 是字符串字面量比较，安全

      const hitsMoney = MONEY_FIELD_KEYWORDS.some(kw => f.includes(kw));
      if (hitsMoney) {
        warnings.push({
          code: 'MONEY_FLOAT_RISK',
          severity: 'warn',
          nodeId: node.id,
          message:
            `节点 ${node.id} 的断言 "${asn.field} ${op} ${JSON.stringify(asn.expected ?? '')}" ` +
            `命中金额字段（金额/余额/手续费/利率等），但 expectedType=${et}。` +
            `走 float 比较有精度风险（典型如 0.1+0.2≠0.3）。柜台资金断言强制 expectedType: "decimal"。`,
        });
      }
    }
  }
  return warnings;
};

/**
 * 规则 8: TRACE_NO_ONLY_EXISTS（柜台凭证类字段空串放水）
 * 字段名含流水号/凭证号/订单号关键字，但断言用了 exists（对空串放水）
 * → 警告改用 notEmpty
 */
const ruleTraceNoOnlyExists: Rule = (tc) => {
  const warnings: ValidateWarning[] = [];
  for (const node of tc.nodes) {
    if (node.type !== 'api') continue;
    for (const asn of node.assertions ?? []) {
      const f = (asn.field ?? '').toLowerCase();
      const op = asn.operator ?? '';
      if (op !== 'exists') continue;

      const hitsTrace = TRACE_FIELD_KEYWORDS.some(kw => f.includes(kw));
      if (hitsTrace) {
        warnings.push({
          code: 'TRACE_NO_ONLY_EXISTS',
          severity: 'warn',
          nodeId: node.id,
          message:
            `节点 ${node.id} 用 exists 断言流水号/凭证类字段 "${asn.field}"。` +
            `exists 对空字符串 "" 放水——后端忘赋值时返回 "" 会被判通过，但柜台流水号为空就是事故。` +
            `请改用 operator: "notEmpty"，或进一步加 eachMatches 校验格式（如 "^\\\\d{18}$"）。`,
        });
      }
    }
  }
  return warnings;
};

/**
 * 规则 9: RETURN_CODE_NOT_ASSERTED（柜台业务码缺失）
 * 节点的断言字段不含任何业务码（returnCode/respCode/...），仅有 status 类断言
 * → 警告：HTTP 200 + 业务码 != 0 也是失败，柜台用例必须断言业务码
 *
 * 与 WEAK_ASSERTION_ONLY_STATUS 的差异：本规则更严，即使断言里有其他业务字段（如 returnObject.id exists）
 * 但只要没断业务码，依然警告；柜台语境下业务码是必断项
 */
const ruleReturnCodeNotAsserted: Rule = (tc) => {
  const warnings: ValidateWarning[] = [];
  for (const node of tc.nodes) {
    if (node.type !== 'api') continue;
    if (node.isCleanup) continue; // 清理节点豁免

    const assertions = node.assertions ?? [];
    if (assertions.length === 0) continue;

    const hasReturnCode = assertions.some(asn => {
      const f = (asn.field ?? '').toLowerCase();
      return RETURN_CODE_FIELD_KEYWORDS.some(kw => f.includes(kw));
    });

    if (!hasReturnCode) {
      warnings.push({
        code: 'RETURN_CODE_NOT_ASSERTED',
        severity: 'warn',
        nodeId: node.id,
        message:
          `节点 ${node.id} 未断言任何业务码（returnCode/respCode/resultCode 等）。` +
          `柜台语境下 HTTP 200 仅表示通信成功；业务成功必须由业务码决定。` +
          `请补充：{ "field": "returnCode", "operator": "equals", "expected": 0 } ` +
          `或对枚举集合用 in：{ "operator": "in", "expected": [0, 1001, 1002] }。`,
      });
    }
  }
  return warnings;
};

/**
 * 规则 10: DETAIL_LIST_NO_OWNERSHIP_CHECK（柜台越权风险防线）
 * 查询节点传了 accountNo/customerId/tenantId 等归属参数，但断言里没有验证返回明细的归属字段
 * → 警告：越权返回别人的数据时无法察觉
 */
const ruleDetailListNoOwnershipCheck: Rule = (tc, ctx) => {
  const warnings: ValidateWarning[] = [];
  for (const node of tc.nodes) {
    if (node.type !== 'api' || node.isCleanup) continue;
    const info = node.apiId ? ctx.apiInfo.get(node.apiId) : undefined;
    if (!info || info.action !== 'query') continue;

    // 检查所有参数（pathParams + queryParams + body 顶层）里是否含归属字段
    const allParams = {
      ...(node.params?.pathParams ?? {}),
      ...(node.params?.queryParams ?? {}),
      ...(node.params?.body ?? {}),
    } as Record<string, unknown>;

    const ownershipParams = Object.keys(allParams).filter(k => {
      const lk = k.toLowerCase();
      return OWNERSHIP_PARAM_KEYWORDS.some(kw => lk.includes(kw));
    });
    if (ownershipParams.length === 0) continue;

    // 断言里是否有任意字段路径包含归属字段名
    for (const op of ownershipParams) {
      const hasOwnershipAssertion = (node.assertions ?? []).some(asn => {
        const af = (asn.field ?? '').toLowerCase();
        return af.includes(op.toLowerCase());
      });

      if (!hasOwnershipAssertion) {
        warnings.push({
          code: 'DETAIL_LIST_NO_OWNERSHIP_CHECK',
          severity: 'warn',
          nodeId: node.id,
          message:
            `节点 ${node.id} 查询了归属参数 ${op}=${JSON.stringify(allParams[op])}，` +
            `但 assertions 里没有验证返回明细的 ${op} 字段。这是越权风险——` +
            `如果接口实现漏写归属过滤，返回别人的明细也察觉不到。` +
            `建议至少抓首项：{ "field": "returnObject.list[0].${op}", "operator": "equals", "expected": ${JSON.stringify(allParams[op])} }；` +
            `或对整列表用 eachEquals 更严格。`,
        });
      }
    }
  }
  return warnings;
};

/**
 * 规则集（按 code 顺序登记，方便 summary 统计）
 */
const PER_CASE_RULES: Array<{ code: string; run: Rule }> = [
  { code: 'WEAK_ASSERTION_ONLY_STATUS', run: ruleWeakAssertionOnlyStatus },
  { code: 'QUERY_WITHOUT_PRECONDITION', run: ruleQueryWithoutPrecondition },
  { code: 'ASSERTION_ON_EMPTY_LIST', run: ruleAssertionOnEmptyList },
  { code: 'MISSING_FILTER_VERIFICATION', run: ruleMissingFilterVerification },
  { code: 'CLEANUP_MISSING', run: ruleCleanupMissing },
  // 柜台专属（决策 13）
  { code: 'MONEY_FLOAT_RISK', run: ruleMoneyFloatRisk },
  { code: 'TRACE_NO_ONLY_EXISTS', run: ruleTraceNoOnlyExists },
  { code: 'RETURN_CODE_NOT_ASSERTED', run: ruleReturnCodeNotAsserted },
  { code: 'DETAIL_LIST_NO_OWNERSHIP_CHECK', run: ruleDetailListNoOwnershipCheck },
];

// ============================================================================
// 入口
// ============================================================================

/**
 * 主入口：对 plan 做规则化自检
 *
 * @param plan AI 即将提交的 orchestrationPlan
 * @param workspaceId 当前工作区（决策 10：所有内部检索按 workspace 收敛）
 */
export async function validateTestCase(
  plan: OrchestrationPlanLike,
  workspaceId: string
): Promise<ValidateResult> {
  const result: ValidateResult = {
    testCases: [],
    summary: { totalWarnings: 0, rulesTriggered: [] },
  };

  // 防御：plan 结构异常时直接返回空结果（不抛错）
  if (!plan || !Array.isArray(plan.testCases) || plan.testCases.length === 0) {
    return result;
  }

  // 构建共享上下文（批量查 DB）
  let ctx: RuleContext;
  try {
    ctx = await buildContext(plan, workspaceId);
  } catch (err) {
    console.error('[validateTestCase] buildContext 失败:', err);
    ctx = { apiInfo: new Map() };
  }

  // 检查 plan 里引用的 apiId 是否都在当前 workspace 中
  const presentIds = new Set(ctx.apiInfo.keys());
  const missingApiWarnings = new Map<string, ValidateWarning[]>();
  for (const tc of plan.testCases) {
    for (const node of tc.nodes) {
      if (node.apiId && !presentIds.has(node.apiId)) {
        const arr = missingApiWarnings.get(tc.name) ?? [];
        arr.push({
          code: 'INVALID_API_ID',
          severity: 'warn',
          nodeId: node.id,
          message: `节点 ${node.id} 引用的 apiId=${node.apiId} 在当前工作区中不存在或越界，请重新搜索/确认。`,
        });
        missingApiWarnings.set(tc.name, arr);
      }
    }
  }

  // 批次级规则
  const variantWarnings = ruleIdenticalParamVariants(plan.testCases, ctx);

  // 用例级规则
  const triggeredSet = new Set<string>();
  for (const tc of plan.testCases) {
    const warnings: ValidateWarning[] = [];

    for (const { run } of PER_CASE_RULES) {
      try {
        const ws = run(tc, ctx, plan.testCases);
        warnings.push(...ws);
      } catch (err) {
        console.error('[validateTestCase] 规则执行失败:', err);
      }
    }

    const variantWs = variantWarnings.get(tc.name) ?? [];
    warnings.push(...variantWs);

    const missingWs = missingApiWarnings.get(tc.name) ?? [];
    warnings.push(...missingWs);

    for (const w of warnings) triggeredSet.add(w.code);
    result.testCases.push({ name: tc.name, warnings });
    result.summary.totalWarnings += warnings.length;
  }

  result.summary.rulesTriggered = Array.from(triggeredSet).sort();
  return result;
}
