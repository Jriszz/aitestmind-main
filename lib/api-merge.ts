/**
 * API 记录智能字段级合并
 *
 * 当同一接口（同 method+path）被多种来源（Swagger 导入 / 录制 / HAR）先后导入时，
 * 整条覆盖会丢失各来源的独有信息：
 *   - Swagger 独有：schema（参数约束 paramConstraints）
 *   - 录制独有：真实 requestHeaders（鉴权 token）、真实 requestBody/responseBody 样本
 *
 * 本模块提供"新值有意义才覆盖，否则保留旧值；约束类字段只增不减"的合并策略，
 * 让一条记录既有 Swagger 约束（AI 知道怎么测）又有录制真值（能跑通）。
 *
 * 注意：传入的请求/响应相关字段都是已 JSON 序列化后的 string | null。
 */

/**
 * 判断一个（可能是 JSON 序列化后的）值是否"有意义"
 * 空 / null / 空对象 / 空数组 视为无意义
 */
export function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === 'null' || trimmed === '{}' || trimmed === '[]') {
      return false;
    }
    return true;
  }
  // 非字符串（数字、布尔等）只要不是 null/undefined 即有意义
  return true;
}

/**
 * 合并 importSource：拼接来源并去重幂等
 * 例：existing='har' + incoming='swagger' → 'har,swagger'
 *     existing='har,swagger' + incoming='swagger' → 'har,swagger'（不重复）
 */
export function mergeImportSource(existing?: string | null, incoming?: string | null): string {
  const set = new Set<string>();
  for (const src of [existing, incoming]) {
    if (src) {
      for (const part of src.split(',')) {
        const trimmed = part.trim();
        if (trimmed) set.add(trimmed);
      }
    }
  }
  return Array.from(set).join(',');
}

/**
 * 一条 API 记录中参与合并的字段集合（与 prisma Api 写入字段对应）
 */
export interface MergeableApiData {
  name?: string | null;
  description?: string | null;
  method?: string | null;
  url?: string | null;
  path?: string | null;
  domain?: string | null;
  categoryId?: string | null;
  platform?: string | null;
  component?: string | null;
  feature?: string | null;
  subFeature?: string | null;
  importSource?: string | null;
  schema?: string | null; // paramConstraints 序列化
  requestHeaders?: string | null;
  requestQuery?: string | null;
  requestBody?: string | null;
  requestMimeType?: string | null;
  responseStatus?: number | null;
  responseHeaders?: string | null;
  responseBody?: string | null;
  responseMimeType?: string | null;
  responseTime?: number | null;
  responseSize?: number | null;
  resourceType?: string | null;
  startedDateTime?: string | null;
  rawHarEntry?: unknown;
  [key: string]: unknown;
}

/**
 * 字段级智能合并：返回最终应写入数据库的字段对象
 *
 * 规则：
 * - schema（约束）：incoming 有约束就用 incoming，否则保留 existing —— 约束只增不减
 * - requestHeaders（token）：existing 有内容则保留（录制真实 token 优先），否则用 incoming
 * - requestBody / responseBody / responseHeaders：incoming 有意义则用 incoming，
 *   否则保留 existing（录制真值不被 Swagger 空示例冲掉）
 * - rawHarEntry：existing 有则保留（录制原始数据优先，不被 Swagger 覆盖）
 * - importSource：拼接去重
 * - 其余字段：incoming 有意义则用 incoming，否则保留 existing
 *
 * @param existing 数据库中已有记录（prisma Api）
 * @param incoming 本次导入计算出的待写入数据
 */
export function mergeApiData(
  existing: MergeableApiData,
  incoming: MergeableApiData
): MergeableApiData {
  const pickIncomingOrExisting = <K extends keyof MergeableApiData>(key: K): MergeableApiData[K] =>
    hasMeaningfulValue(incoming[key]) ? incoming[key] : existing[key];

  return {
    // 基本信息：新值有意义则用新值，否则保留旧值
    name: pickIncomingOrExisting('name'),
    description: pickIncomingOrExisting('description'),
    method: pickIncomingOrExisting('method'),
    url: pickIncomingOrExisting('url'),
    path: pickIncomingOrExisting('path'),
    domain: pickIncomingOrExisting('domain'),

    // 分类：新值有意义则用新值（允许重新分类），否则保留旧值
    categoryId: pickIncomingOrExisting('categoryId'),
    platform: pickIncomingOrExisting('platform'),
    component: pickIncomingOrExisting('component'),
    feature: pickIncomingOrExisting('feature'),
    subFeature: pickIncomingOrExisting('subFeature'),

    // 约束（paramConstraints）：只增不减 —— incoming 带约束就更新，否则保留已有约束
    schema: hasMeaningfulValue(incoming.schema) ? incoming.schema : existing.schema,

    // 鉴权头：录制真实 token 优先 —— existing 有内容则保留，避免被 Swagger 空头覆盖
    requestHeaders: hasMeaningfulValue(existing.requestHeaders)
      ? existing.requestHeaders
      : incoming.requestHeaders,

    // 请求/响应样本：录制真值优先 —— incoming 有意义才覆盖，否则保留 existing
    requestQuery: pickIncomingOrExisting('requestQuery'),
    requestBody: hasMeaningfulValue(incoming.requestBody)
      ? incoming.requestBody
      : existing.requestBody,
    requestMimeType: pickIncomingOrExisting('requestMimeType'),
    responseStatus: pickIncomingOrExisting('responseStatus'),
    responseHeaders: hasMeaningfulValue(incoming.responseHeaders)
      ? incoming.responseHeaders
      : existing.responseHeaders,
    responseBody: hasMeaningfulValue(incoming.responseBody)
      ? incoming.responseBody
      : existing.responseBody,
    responseMimeType: pickIncomingOrExisting('responseMimeType'),

    // 性能指标：新值有意义则用新值
    responseTime: pickIncomingOrExisting('responseTime'),
    responseSize: pickIncomingOrExisting('responseSize'),

    // 元数据
    resourceType: pickIncomingOrExisting('resourceType'),
    startedDateTime: pickIncomingOrExisting('startedDateTime'),

    // 原始数据：录制原始数据优先保留，不被 Swagger 导入覆盖
    rawHarEntry: hasMeaningfulValue(existing.rawHarEntry)
      ? existing.rawHarEntry
      : incoming.rawHarEntry,

    // 来源：拼接去重
    importSource: mergeImportSource(existing.importSource, incoming.importSource),
  };
}
