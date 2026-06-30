/**
 * 层级化智能API检索
 * 基于4层分类结构：Platform -> Component -> Feature -> API
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * 同业务实体下其他 CRUD 动作的轻量摘要
 *
 * 设计目的（用例有效性 v1）：
 * AI 看到 query 接口时，能立刻意识到"旁边还有 create/update/delete"，
 * 从而有机会把"空查询用例"升级为"造数据→查询"E2E flow。
 *
 * 推断是软启发（按 method + name 关键词），错判一两个不影响。
 */
export interface SiblingCrudHint {
  id: string;
  name: string;
  method: string;
  action: 'create' | 'update' | 'delete' | 'query' | 'other';
}

/**
 * 检索结果接口
 */
interface SearchResult {
  id: string;
  name: string;
  description: string | null;
  method: string;
  path: string;
  platform: string | null;
  component: string | null;
  feature: string | null;
  /**
   * 同业务实体下的其他 CRUD 动作（按 feature 聚合，回退到 component）。
   * 由 attachSiblingCrud() 在返回前填充；永远是数组（可能为空），让 AI 看清楚"真的没有同类接口"。
   * 仅返回轻量字段（id/name/method/action），不返回详情，控制 token。
   */
  siblingCrud?: SiblingCrudHint[];
}

/**
 * 根据 method + name 推断 API 的 CRUD 动作
 * 与 lib/ai-tools/index.ts 的 willCreateData 风格一致，但覆盖全部 4 类 + 其他
 */
function inferCrudAction(api: { name: string | null; method: string; path: string | null }): SiblingCrudHint['action'] {
  const name = api.name || '';
  const path = api.path || '';
  const method = (api.method || '').toUpperCase();

  const hasAny = (keywords: string[]) =>
    keywords.some(k => name.toLowerCase().includes(k.toLowerCase()) || path.toLowerCase().includes(k.toLowerCase()));

  // delete 优先（DELETE method 信号最强）
  if (method === 'DELETE' || hasAny(['删除', '移除', 'delete', 'remove'])) {
    return 'delete';
  }

  // create
  if ((method === 'POST' || method === 'PUT') && hasAny(['创建', '新增', '添加', '注册', '保存', 'create', 'add', 'register', 'save'])) {
    return 'create';
  }

  // update
  if ((method === 'PUT' || method === 'PATCH' || method === 'POST') && hasAny(['修改', '更新', '编辑', 'update', 'edit', 'modify', 'patch'])) {
    return 'update';
  }

  // query
  if (method === 'GET' || hasAny(['查询', '获取', '列表', '详情', 'query', 'list', 'get', 'detail'])) {
    return 'query';
  }

  return 'other';
}

/**
 * 给 topN 结果批量补 siblingCrud 字段
 *
 * 策略：
 * 1. 按 (platform, component, feature) 三元组聚合，同 feature 优先
 * 2. 同 feature 没东西就回退到同 component
 * 3. 单条 siblingCrud 上限 10 条
 * 4. 不包含自己（排除当前 api.id）
 */
async function attachSiblingCrud(
  apis: SearchResult[],
  workspaceId: string
): Promise<void> {
  if (apis.length === 0) return;

  type GroupKey = { platform: string | null; component: string | null; feature: string | null };
  type Sibling = { id: string; name: string; method: string; path: string | null };
  type Group = { sameFeature: Sibling[]; sameComponent: Sibling[] };

  // 用 JSON.stringify 做 Map key，避免分隔符冲突
  const keyStr = (g: GroupKey) =>
    JSON.stringify([g.platform ?? null, g.component ?? null, g.feature ?? null]);

  // 收集所有需要查询的 (platform, component, feature) 三元组（去重）
  const uniqueKeys = new Map<string, GroupKey>();
  for (const api of apis) {
    const gk: GroupKey = { platform: api.platform, component: api.component, feature: api.feature };
    uniqueKeys.set(keyStr(gk), gk);
  }

  // 一次性查出所有相关 feature / component 下的接口（按 workspace 收敛，决策 10）
  const groupEntries = await Promise.all(
    Array.from(uniqueKeys.entries()).map(async ([k, gk]) => {
      const sameFeature: Sibling[] = gk.feature
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

      // 同 feature 太少（<2 条意味着只有自己），回退到同 component
      let sameComponent: Sibling[] = [];
      if (sameFeature.length < 2 && gk.component) {
        sameComponent = await prisma.api.findMany({
          where: {
            workspaceId,
            platform: gk.platform,
            component: gk.component,
          },
          select: { id: true, name: true, method: true, path: true },
          take: 30,
        });
      }

      return [k, { sameFeature, sameComponent }] as [string, Group];
    })
  );

  const byKey = new Map<string, Group>(groupEntries);

  // 给每个 api 挂载 siblingCrud
  for (const api of apis) {
    const k = keyStr({ platform: api.platform, component: api.component, feature: api.feature });
    const group = byKey.get(k);
    if (!group) {
      api.siblingCrud = [];
      continue;
    }

    // 优先用 feature 集，太空就用 component 集
    const pool = group.sameFeature.length >= 2 ? group.sameFeature : group.sameComponent;

    api.siblingCrud = pool
      .filter(p => p.id !== api.id)
      .slice(0, 10)
      .map(p => ({
        id: p.id,
        name: p.name,
        method: p.method,
        action: inferCrudAction(p),
      }));
  }
}

/**
 * 层级化搜索参数
 */
interface HierarchicalSearchParams {
  // 用户原始描述
  userQuery?: string;

  // 分层关键词（AI提取）
  platform?: string;
  component?: string;
  feature?: string;
  apiName?: string;

  // 辅助过滤
  method?: string; // HTTP方法
  limit?: number; // 返回结果数量限制

  // 资产管理总线 Step 1：工作区归属边界
  // 强制收敛检索范围到当前工作区。调用方必须从 getCurrentWorkspace(request) 解析后传入。
  workspaceId: string;
}

/**
 * 对搜索结果按层级匹配度评分排序
 * 匹配的层级越多分数越高，确保最相关的 API 排在前面
 */
function scoreAndSort(
  apis: SearchResult[],
  params: HierarchicalSearchParams,
  topN: number
): SearchResult[] {
  const scored = apis.map(api => {
    let score = 0;

    if (params.platform && api.platform && api.platform.includes(params.platform)) {
      score += 1;
    }
    if (params.component && api.component && api.component.includes(params.component)) {
      score += 1;
    }
    if (params.feature && api.feature && api.feature.includes(params.feature)) {
      score += 1;
    }
    if (params.apiName) {
      if (api.name && api.name.includes(params.apiName)) score += 1;
      if (api.path && api.path.includes(params.apiName)) score += 1;
      if (api.description && api.description.includes(params.apiName)) score += 1;
    }

    return { api, score };
  });

  // 按分数降序排列，相同分数保持数据库原始顺序（稳定排序）
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topN).map(item => item.api);
}

/**
 * 层级化智能搜索API
 *
 * @description
 * 基于4层分类结构进行智能搜索，自动从高到低匹配：
 * - 第1层：平台 (Platform)
 * - 第2层：组件 (Component)
 * - 第3层：功能 (Feature)
 * - 第4层：API名称
 *
 * 匹配策略：
 * 1. 优先匹配多层级 (分数更高)
 * 2. 完全匹配优于包含匹配
 * 3. 支持关键词模糊搜索
 *
 * @example
 * // 示例1: 提供完整层级
 * hierarchicalSearchApis({
 *   platform: 'inet',
 *   component: '高可用组',
 *   feature: '管理',
 *   apiName: '新增'
 * })
 *
 * // 示例2: 只提供部分层级
 * hierarchicalSearchApis({
 *   platform: 'inet',
 *   apiName: '查询实例列表'
 * })
 *
 * // 示例3: 使用原始用户查询
 * hierarchicalSearchApis({
 *   userQuery: '创建ECS云主机实例',
 *   method: 'POST'
 * })
 */
export async function hierarchicalSearchApis(
  params: HierarchicalSearchParams
): Promise<SearchResult[]> {
  try {
    // 最终返回给调用方的数量上限
    const resultLimit = params.limit || 15;
    // 数据库拉取时放宽上限，给评分排序留出足够候选集，避免匹配度高的 API 被截断
    const fetchLimit = Math.max(resultLimit * 3, 50);

    // 构建查询条件
    // 资产管理总线 Step 1：先按 workspaceId 收敛，再叠加层级条件
    const where: any = { workspaceId: params.workspaceId };

    // ========== 阶段1: 层级化精确查询 ==========

    // 如果提供了平台，优先按平台过滤
    if (params.platform) {
      where.OR = [
        { platform: { contains: params.platform } },
      ];
    }

    // 如果提供了组件，添加组件过滤
    if (params.component) {
      if (!where.OR) where.OR = [];
      where.OR.push(
        { component: { contains: params.component } }
      );
    }

    // 如果提供了功能，添加功能过滤
    if (params.feature) {
      if (!where.OR) where.OR = [];
      where.OR.push(
        { feature: { contains: params.feature } }
      );
    }

    // 如果提供了API名称，添加名称过滤
    if (params.apiName) {
      if (!where.OR) where.OR = [];
      where.OR.push(
        { name: { contains: params.apiName } },
        { path: { contains: params.apiName } },
        { description: { contains: params.apiName } }
      );
    }

    // ========== 阶段2: 原始查询关键词搜索 (fallback) ==========

    // 如果提供了原始查询且没有其他层级参数，使用全文搜索
    if (params.userQuery && !params.platform && !params.component && !params.feature && !params.apiName) {
      const keywords = params.userQuery.split(/\s+/).filter(k => k.length > 1);

      where.OR = keywords.flatMap(keyword => [
        { name: { contains: keyword } },
        { description: { contains: keyword } },
        { path: { contains: keyword } },
        { platform: { contains: keyword } },
        { component: { contains: keyword } },
        { feature: { contains: keyword } },
      ]);
    }

    // HTTP方法过滤
    if (params.method) {
      where.method = params.method.toUpperCase();
    }

    // 执行数据库查询（拉取更多候选以便评分排序）
    // where 永远包含 workspaceId，即便其他条件为空也不会越界
    const apis = await prisma.api.findMany({
      where,
      select: {
        id: true,
        name: true,
        description: true,
        method: true,
        path: true,
        platform: true,
        component: true,
        feature: true,
      },
      take: fetchLimit,
    });

    // 按层级匹配度评分排序，确保最相关的 API 排在前面
    const topResults = scoreAndSort(apis as SearchResult[], params, resultLimit);

    // 补充同业务实体下的 CRUD 全景（用例有效性提升 v1）
    await attachSiblingCrud(topResults, params.workspaceId);

    return topResults;
  } catch (error) {
    console.error('[hierarchicalSearchApis] 检索失败:', error);
    
    // 返回空结果而不是抛出错误
    // 这样AI可以继续执行，而不会中断整个流程
    return [];
  }
}

/**
 * 智能提取层级关键词
 * 
 * @description
 * 从用户自然语言描述中提取4层分类关键词
 * 这个函数可以作为辅助工具，帮助AI更好地构造 hierarchicalSearchApis 的参数
 * 
 * @example
 * extractLayerKeywords('创建巡检平台凭证管理的新凭证')
 * // 返回: { platform: '巡检平台', component: '凭证管理', feature: '增删改查', apiName: '创建', method: 'POST' }
 */
export async function extractLayerKeywords(userQuery: string): Promise<{
  platform?: string;
  component?: string;
  feature?: string;
  apiName?: string;
  method?: string;
}> {
  // 常见HTTP方法关键词映射
  const methodKeywords: Record<string, string> = {
    '新增': 'POST',
    '创建': 'POST',
    '添加': 'POST',
    '注册': 'POST',
    '查询': 'GET',
    '获取': 'GET',
    '列表': 'GET',
    '详情': 'GET',
    '删除': 'DELETE',
    '移除': 'DELETE',
    '修改': 'PUT',
    '更新': 'PUT',
    '编辑': 'PUT',
  };
  
  const result: any = {};
  
  // 提取HTTP方法
  for (const [keyword, method] of Object.entries(methodKeywords)) {
    if (userQuery.includes(keyword)) {
      result.method = method;
      // 同时将动作关键词作为apiName
      if (!result.apiName) {
        result.apiName = keyword;
      }
      break;
    }
  }
  
  // 尝试提取"平台"关键词
  const platformMatch = userQuery.match(/([\u4e00-\u9fa5]+)平台/);
  if (platformMatch) {
    result.platform = platformMatch[1] + '平台';
  }
  
  // 尝试提取"管理"类组件
  const componentMatch = userQuery.match(/([\u4e00-\u9fa5]+)管理/);
  if (componentMatch) {
    result.component = componentMatch[1] + '管理';
  }
  
  return result;
}

