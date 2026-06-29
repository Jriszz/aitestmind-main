/**
 * JSON 序列化/反序列化工具函数
 * 用于处理数据库中 String 类型的 JSON 字段
 */

/**
 * 安全地解析 JSON 字符串
 * @param value - 可能是 JSON 字符串或已经是对象
 * @returns 解析后的对象，或 null
 */
export function safeJsonParse<T = any>(value: any): T | null {
  if (!value) {
    return null;
  }

  // 如果已经是对象，直接返回
  if (typeof value === 'object') {
    return value as T;
  }

  // 如果是字符串，尝试解析
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      console.error('JSON parse error:', error, 'value:', value.substring(0, 100));
      return null;
    }
  }

  return null;
}

/**
 * 安全地序列化为 JSON 字符串
 * @param value - 要序列化的值
 * @returns JSON 字符串，或 null
 */
export function safeJsonStringify(value: any): string | null {
  if (!value) {
    return null;
  }

  // 如果已经是字符串，直接返回
  if (typeof value === 'string') {
    // 验证是否是有效的 JSON
    try {
      JSON.parse(value);
      return value;
    } catch {
      // 不是有效的 JSON，序列化它
      return JSON.stringify(value);
    }
  }

  // 如果是对象，序列化
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (error) {
      console.error('JSON stringify error:', error);
      return null;
    }
  }

  return null;
}

/**
 * 健壮解析 AI tool arguments —— 某些 OpenAI 兼容网关（如本项目的 Claude 网关）会在
 * arguments 前面附带垃圾，例如 `{}{"cases":[...]}`，直接 JSON.parse 会在 position 2 报错。
 * 这里用括号配平扫描，提取第一个"配平且能解析、且含 requiredKey"的完整 JSON 对象。
 *
 * @param raw     原始 tool arguments 字符串
 * @param requiredKey 期望对象里必须含有的键（如 'scenarios' / 'cases'）；跳过开头空 `{}`
 */
export function parseLooseJsonObject<T = any>(raw: string, requiredKey?: string): T | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!requiredKey || (obj && typeof obj === 'object' && requiredKey in obj)) {
      return obj as T;
    }
  } catch {
    /* 落到下面的扫描 */
  }
  for (let start = raw.indexOf('{'); start !== -1; start = raw.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = raw.slice(start, i + 1);
          try {
            const obj = JSON.parse(candidate);
            if (obj && typeof obj === 'object' && (!requiredKey || requiredKey in obj)) {
              return obj as T;
            }
          } catch {
            /* 这个候选不行，继续找下一个 '{' */
          }
          break;
        }
      }
    }
  }
  return null;
}

/**
 * 批量解析对象中的 JSON 字段
 * @param obj - 包含 JSON 字段的对象
 * @param fields - 需要解析的字段名数组
 * @returns 解析后的对象
 */
export function parseJsonFields<T extends Record<string, any>>(
  obj: T,
  fields: (keyof T)[]
): T {
  const result = { ...obj };
  
  for (const field of fields) {
    if (field in result) {
      result[field] = safeJsonParse(result[field]) as any;
    }
  }
  
  return result;
}

/**
 * 批量序列化对象中的字段为 JSON 字符串
 * @param obj - 包含需要序列化字段的对象
 * @param fields - 需要序列化的字段名数组
 * @returns 序列化后的对象
 */
export function stringifyJsonFields<T extends Record<string, any>>(
  obj: T,
  fields: (keyof T)[]
): T {
  const result = { ...obj };
  
  for (const field of fields) {
    if (field in result) {
      result[field] = safeJsonStringify(result[field]) as any;
    }
  }
  
  return result;
}

