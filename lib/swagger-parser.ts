/**
 * Swagger / OpenAPI 文档解析器
 *
 * 将一份 OpenAPI 3.x 或 Swagger 2.0 文档转换为平台统一的 CapturedApi[] 结构，
 * 以便复用现有的查重 / 四层分类 / 保存链路（与 HAR 导入产物结构完全一致）。
 *
 * 设计要点：
 * - 使用 @apidevtools/swagger-parser 的 dereference() 统一处理 2.0/3.x、内外部 $ref、循环引用
 * - 从 schema 递归生成示例 body/response（example > default > enum[0] > 按 type 造值）
 * - 保留 required/enum/min/max/format 等约束到 paramConstraints，供后续 AI 生成用例使用
 *
 * 仅在服务端（Node 运行时）使用。
 */

import SwaggerParser from '@apidevtools/swagger-parser';
import type {
  CapturedApi,
  ApiParamConstraints,
  SemanticSnapshot,
  SemanticDbAssert,
} from '@/types/har';

// 防止循环引用导致的无限递归
const MAX_EXAMPLE_DEPTH = 6;
// 单次导入的接口数量上限（防止超大文档拖垮解析/前端）
const MAX_OPERATIONS = 2000;

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'] as const;

export interface SwaggerParseResult {
  apis: CapturedApi[];
  info: {
    title: string;
    version: string;
    count: number;
    truncated: boolean; // 是否因超过 MAX_OPERATIONS 而截断
    semanticsCount: number; // 带业务语义的接口数
  };
}

/**
 * 把任意 schema 的 format 映射到平台运行时函数（执行时会被替换为真实值）
 * 对应 executor/runtime_functions.py 支持的函数
 */
function formatToRuntimeFunction(format?: string): string | null {
  switch (format) {
    case 'email':
      return '${{randomEmail()}}';
    case 'uuid':
      return '${{uuid()}}';
    case 'date-time':
      return '${{datetime()}}';
    case 'date':
      return '${{date()}}';
    default:
      return null;
  }
}

/**
 * 按 schema 的 type 造一个默认值
 */
function defaultByType(schema: any): any {
  const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
  switch (type) {
    case 'integer':
    case 'number':
      // 优先用约束范围内的值
      if (typeof schema.minimum === 'number') return schema.minimum;
      return 0;
    case 'boolean':
      return true;
    case 'string': {
      const fn = formatToRuntimeFunction(schema.format);
      if (fn) return fn;
      return 'string';
    }
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return null;
  }
}

/**
 * 从 schema 递归生成示例值
 * 优先级：example > default > enum[0] > format 运行时函数 > 按 type 造值
 */
function generateExample(schema: any, depth = 0): any {
  if (!schema || typeof schema !== 'object') {
    return null;
  }

  if (depth > MAX_EXAMPLE_DEPTH) {
    return null;
  }

  // 组合 schema：取第一个分支即可（dereference 后 $ref 已展开）
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    // allOf：合并所有子 schema 的属性
    const merged: Record<string, any> = {};
    for (const sub of schema.allOf) {
      const part = generateExample(sub, depth + 1);
      if (part && typeof part === 'object' && !Array.isArray(part)) {
        Object.assign(merged, part);
      }
    }
    return merged;
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return generateExample(schema.oneOf[0], depth + 1);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return generateExample(schema.anyOf[0], depth + 1);
  }

  // 显式示例 / 默认值 / 枚举
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  if (type === 'object' || schema.properties) {
    const obj: Record<string, any> = {};
    const props = schema.properties || {};
    for (const [key, propSchema] of Object.entries<any>(props)) {
      obj[key] = generateExample(propSchema, depth + 1);
    }
    return obj;
  }

  if (type === 'array' || schema.items) {
    const itemExample = generateExample(schema.items, depth + 1);
    return itemExample === null ? [] : [itemExample];
  }

  return defaultByType(schema);
}

/**
 * 从 schema 递归收集约束信息（required/enum/range/format）
 * @param schema 已 dereference 的 schema
 * @param basePath 字段路径前缀，如 "body" / "query"
 */
function collectConstraints(
  schema: any,
  basePath: string,
  acc: Required<ApiParamConstraints>,
  depth = 0
): void {
  if (!schema || typeof schema !== 'object' || depth > MAX_EXAMPLE_DEPTH) return;

  // 合并 allOf 后再收集
  const schemas = Array.isArray(schema.allOf) ? schema.allOf : [schema];

  for (const s of schemas) {
    if (!s || typeof s !== 'object') continue;

    // required 数组（针对当前对象的直接子属性）
    if (Array.isArray(s.required)) {
      for (const field of s.required) {
        acc.required.push(`${basePath}.${field}`);
      }
    }

    const props = s.properties;
    if (props && typeof props === 'object') {
      for (const [key, propSchema] of Object.entries<any>(props)) {
        const fieldPath = `${basePath}.${key}`;
        if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) {
          acc.enums[fieldPath] = propSchema.enum;
        }
        const range: Record<string, number> = {};
        if (typeof propSchema.minimum === 'number') range.min = propSchema.minimum;
        if (typeof propSchema.maximum === 'number') range.max = propSchema.maximum;
        if (typeof propSchema.minLength === 'number') range.minLength = propSchema.minLength;
        if (typeof propSchema.maxLength === 'number') range.maxLength = propSchema.maxLength;
        if (Object.keys(range).length > 0) acc.ranges[fieldPath] = range;
        if (propSchema.format) acc.formats[fieldPath] = propSchema.format;

        // 递归嵌套对象
        if (propSchema.properties || propSchema.type === 'object') {
          collectConstraints(propSchema, fieldPath, acc, depth + 1);
        }
      }
    }
  }
}

/**
 * 解析 servers / host+basePath，得到请求 URL 的前缀
 */
function resolveBaseUrl(doc: any): string {
  // OpenAPI 3.x
  if (Array.isArray(doc.servers) && doc.servers.length > 0 && doc.servers[0].url) {
    return String(doc.servers[0].url).replace(/\/+$/, '');
  }
  // Swagger 2.0
  if (doc.host) {
    const scheme = Array.isArray(doc.schemes) && doc.schemes.length > 0 ? doc.schemes[0] : 'https';
    const basePath = doc.basePath || '';
    return `${scheme}://${doc.host}${basePath}`.replace(/\/+$/, '');
  }
  return '';
}

/**
 * 提取请求体的 schema 与 mimeType（兼容 3.x 的 requestBody 与 2.0 的 body 参数）
 */
function extractRequestBody(operation: any): { schema: any; mimeType: string } | null {
  // OpenAPI 3.x
  if (operation.requestBody?.content) {
    const content = operation.requestBody.content;
    // 优先 application/json
    const jsonKey = Object.keys(content).find((k) => k.includes('json')) || Object.keys(content)[0];
    if (jsonKey && content[jsonKey]?.schema) {
      return { schema: content[jsonKey].schema, mimeType: jsonKey };
    }
  }
  // Swagger 2.0：body 参数
  if (Array.isArray(operation.parameters)) {
    const bodyParam = operation.parameters.find((p: any) => p.in === 'body');
    if (bodyParam?.schema) {
      return { schema: bodyParam.schema, mimeType: 'application/json' };
    }
  }
  return null;
}

/**
 * 提取成功响应（2xx）的 schema（兼容 3.x 与 2.0）
 */
function extractResponseSchema(operation: any): any | null {
  const responses = operation.responses;
  if (!responses || typeof responses !== 'object') return null;

  // 找第一个 2xx 响应
  const okKey =
    ['200', '201', '202', '2XX', 'default'].find((k) => responses[k]) ||
    Object.keys(responses).find((k) => /^2\d\d$/.test(k));
  if (!okKey) return null;

  const resp = responses[okKey];
  // OpenAPI 3.x
  if (resp.content) {
    const jsonKey = Object.keys(resp.content).find((k) => k.includes('json')) || Object.keys(resp.content)[0];
    if (jsonKey && resp.content[jsonKey]?.schema) return resp.content[jsonKey].schema;
  }
  // Swagger 2.0
  if (resp.schema) return resp.schema;
  return null;
}

/**
 * 从 query 参数列表生成示例查询参数对象
 */
function extractQueryParams(operation: any): Record<string, string> {
  const result: Record<string, string> = {};
  if (Array.isArray(operation.parameters)) {
    for (const p of operation.parameters) {
      if (p.in === 'query') {
        const example = generateExample(p.schema || p);
        result[p.name] = example === null || example === undefined ? '' : String(example);
      }
    }
  }
  return result;
}

/**
 * 提取接口内嵌的业务语义（baseline 快照）
 * 来源：operation.description（条件约束）、x-side-effect、x-fund-consistency、x-db-asserts
 * 返回 null 表示该接口没有任何业务语义
 */
function extractBusinessSemantics(operation: any): SemanticSnapshot | null {
  const snapshot: SemanticSnapshot = {};
  let hasAny = false;

  // description：只有包含条件约束语义时才纳入（避免把纯摘要也当语义）
  if (typeof operation.description === 'string' && operation.description.trim()) {
    snapshot.description = operation.description.trim();
    hasAny = true;
  }

  const sideEffect = operation['x-side-effect'];
  if (sideEffect && typeof sideEffect === 'object') {
    snapshot.sideEffect = {
      changedFields: Array.isArray(sideEffect.changedFields) ? sideEffect.changedFields : undefined,
      queryKey: Array.isArray(sideEffect.queryKey) ? sideEffect.queryKey : undefined,
      writes: Array.isArray(sideEffect.writes) ? sideEffect.writes : undefined,
    };
    hasAny = true;
  }

  const fundConsistency = operation['x-fund-consistency'];
  if (fundConsistency && typeof fundConsistency === 'object') {
    snapshot.fundConsistency = { ...fundConsistency };
    hasAny = true;
  }

  const dbAsserts = operation['x-db-asserts'];
  if (Array.isArray(dbAsserts) && dbAsserts.length > 0) {
    snapshot.dbAsserts = dbAsserts.map(
      (a: any): SemanticDbAssert => ({
        desc: a.desc,
        sql: a.sql,
        field: a.field,
        operator: a.operator,
        expect: a.expect,
      })
    );
    hasAny = true;
  }

  return hasAny ? snapshot : null;
}

/**
 * 主入口：把 OpenAPI/Swagger 文档（对象或字符串）解析为 CapturedApi[]
 *
 * @param input 文档内容，可以是 JSON 字符串、YAML 字符串，或已解析的对象
 */
export async function parseSwaggerDocument(input: string | object): Promise<SwaggerParseResult> {
  // 把输入统一转换为对象：JSON 优先，失败再按 YAML 解析（dereference 只接受对象/路径，不接受裸字符串）
  let raw: any = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    try {
      raw = JSON.parse(trimmed);
    } catch {
      try {
        // @ts-expect-error js-yaml 无类型声明（transitive 依赖），运行时存在
        const yaml = (await import('js-yaml')).default;
        raw = yaml.load(trimmed);
      } catch {
        throw new Error('文档既不是有效的 JSON 也不是有效的 YAML，请确认内容为 OpenAPI/Swagger 文档');
      }
    }
  }

  if (!raw || typeof raw !== 'object') {
    throw new Error('文档内容为空或格式不正确');
  }

  // dereference 解引用（统一处理 2.0/3.x、内外部 $ref、循环引用）
  let doc: any;
  try {
    doc = await SwaggerParser.dereference(raw);
  } catch (err: any) {
    throw new Error(`Swagger/OpenAPI 文档解析失败：${err.message || err}`);
  }

  const baseUrl = resolveBaseUrl(doc);
  const title = doc.info?.title || 'OpenAPI';
  const version = doc.info?.version || doc.openapi || doc.swagger || '';

  const apis: CapturedApi[] = [];
  let truncated = false;

  const paths = doc.paths || {};
  outer: for (const [pathKey, pathItem] of Object.entries<any>(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== 'object') continue;

      if (apis.length >= MAX_OPERATIONS) {
        truncated = true;
        break outer;
      }

      const upperMethod = method.toUpperCase();
      const lastSegment = pathKey.split('/').filter(Boolean).pop() || 'api';
      const name = operation.summary || operation.operationId || `${upperMethod} ${lastSegment}`;

      // 请求体
      const bodyInfo = extractRequestBody(operation);
      const requestBody = bodyInfo ? generateExample(bodyInfo.schema) : undefined;
      const requestMimeType = bodyInfo?.mimeType;

      // 响应体
      const respSchema = extractResponseSchema(operation);
      const responseBody = respSchema ? generateExample(respSchema) : undefined;

      // 查询参数
      const queryParams = extractQueryParams(operation);

      // 约束收集
      const constraintsAcc: Required<ApiParamConstraints> = {
        required: [],
        enums: {},
        ranges: {},
        formats: {},
      };
      if (bodyInfo?.schema) {
        collectConstraints(bodyInfo.schema, 'body', constraintsAcc);
      }
      // query 必填
      if (Array.isArray(operation.parameters)) {
        for (const p of operation.parameters) {
          if (p.in === 'query' && p.required) constraintsAcc.required.push(`query.${p.name}`);
          if (p.in === 'query' && Array.isArray(p.schema?.enum)) {
            constraintsAcc.enums[`query.${p.name}`] = p.schema.enum;
          }
        }
      }
      const hasConstraints =
        constraintsAcc.required.length > 0 ||
        Object.keys(constraintsAcc.enums).length > 0 ||
        Object.keys(constraintsAcc.ranges).length > 0 ||
        Object.keys(constraintsAcc.formats).length > 0;

      const fullUrl = `${baseUrl}${pathKey}`;

      // 业务语义（baseline）：从 description / x-* 提取，包装溯源与状态
      const semanticsBaseline = extractBusinessSemantics(operation);

      // 自动分类预填（用户在导入对话框可统一覆盖，不填则各自保留）：
      // - component（二级）← 文档 info.title
      // - feature（三级）← operation.tags[0]
      const tag = Array.isArray(operation.tags) && operation.tags.length > 0
        ? String(operation.tags[0]).trim() || undefined
        : undefined;

      apis.push({
        id: `swagger_${apis.length}_${upperMethod}_${pathKey}`,
        name,
        method: upperMethod,
        url: fullUrl,
        path: pathKey, // 直接使用 OpenAPI 模板路径，如 /pets/{petId}
        status: 200,
        statusText: 'OK',
        resourceType: 'xhr',
        time: 0,
        size: 0,
        startedDateTime: '',
        headers: {},
        queryParams,
        requestBody,
        requestMimeType,
        responseHeaders: {},
        responseBody,
        mimeType: 'application/json',
        importSource: 'swagger',
        paramConstraints: hasConstraints ? constraintsAcc : undefined,
        businessSemantics: semanticsBaseline
          ? {
              baseline: semanticsBaseline,
              // provenance 的 sourceDoc / importedAt 由导入路由补全（它知道来源与时间）
              provenance: { docVersion: String(version) },
              status: 'draft',
            }
          : undefined,
        // 分类预填字段——CapturedApi/ApiRequestSummary 类型未声明，但
        // app/api/api-library/save/route.ts 通过 (api as any).component/feature 读取，链路已通
        ...(title ? { component: title } : {}),
        ...(tag ? { feature: tag } : {}),
      } as CapturedApi);
    }
  }

  return {
    apis,
    info: {
      title,
      version: String(version),
      count: apis.length,
      truncated,
      semanticsCount: apis.filter((a) => a.businessSemantics?.baseline).length,
    },
  };
}
