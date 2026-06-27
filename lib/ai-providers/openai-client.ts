/**
 * OpenAI 适配器
 * 支持 GPT 系列模型
 */

import OpenAI from 'openai';
import { AIClient, type AIConfig, type AIMessage, type AITool, type AIResponse } from '../ai-client';

/**
 * 清洗 tool_calls.arguments —— 某些 OpenAI 兼容网关（如本项目的 Claude 网关）会在
 * arguments 前面附带垃圾，例如 `{}{"scenarios":[...]}`，导致下游 JSON.parse 失败。
 * 这里若直接解析失败，则用括号配平提取第一个“能解析的完整 JSON 对象”，返回其规范字符串。
 * 解析不出来则原样返回（交由下游各自的容错处理）。
 */
function sanitizeToolArguments(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) return '{}';
  try {
    JSON.parse(s);
    return s; // 正常网关：原样返回
  } catch {
    /* 落到扫描 */
  }
  for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        if (--depth === 0) {
          const candidate = s.slice(start, i + 1);
          try {
            const obj = JSON.parse(candidate);
            // 跳过开头的空 `{}`，取第一个非空对象
            if (obj && typeof obj === 'object' && Object.keys(obj).length > 0) {
              return JSON.stringify(obj);
            }
          } catch { /* 继续找下一个起点 */ }
          break;
        }
      }
    }
  }
  return s; // 实在清洗不出来，原样返回
}

export class OpenAIClient extends AIClient {
  private openai: OpenAI;

  constructor(config: AIConfig) {
    super(config);

    // Ollama 不需要真实的 API Key，使用占位符即可
    const apiKey = config.provider === 'ollama' && !config.apiKey 
      ? 'ollama' 
      : config.apiKey;

    this.openai = new OpenAI({
      apiKey: apiKey,
      baseURL: config.baseUrl || 'https://api.openai.com/v1',
    });
  }

  /**
   * 发送聊天请求
   */
  async chat(messages: AIMessage[], tools?: AITool[]): Promise<AIResponse> {
    try {
      // 转换消息格式
      const openaiMessages = messages.map(msg => {
        if (msg.role === 'tool') {
          // OpenAI 的工具结果格式
          return {
            role: 'tool' as const,
            tool_call_id: msg.tool_call_id!,
            content: msg.content || '',
          };
        }
        
        if (msg.role === 'assistant' && msg.tool_calls) {
          // assistant 消息包含 tool_calls
          return {
            role: 'assistant' as const,
            content: msg.content,
            tool_calls: msg.tool_calls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments,
              },
            })),
            // DeepSeek thinking 模型要求回传 reasoning_content，仅在存在时添加
            ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
          };
        }
        
        return {
          role: msg.role as 'system' | 'user' | 'assistant',
          content: msg.content || '',
          // DeepSeek thinking 模型要求回传 reasoning_content，仅在存在时添加
          ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
        };
      });

      // 调用 OpenAI API
      const completion = await this.openai.chat.completions.create({
        model: this.config.model,
        messages: openaiMessages as any,
        tools: tools as any,
        tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
        temperature: this.config.temperature || 0.7,
        max_tokens: this.config.maxTokens || 4000,
        top_p: this.config.topP || 1.0,
      });

      // 检查是否因为 token 限制被截断
      if (completion.choices[0].finish_reason === 'length') {
        console.warn('⚠️ AI 响应因 token 限制被截断，建议增加 maxTokens 配置');
      }

      const choice = completion.choices[0];
      const message = choice.message;

      // 转换响应格式
      // 注意：DeepSeek 的 thinking 模型会返回 reasoning_content，必须在后续请求中回传
      const reasoningContent = (message as any).reasoning_content || undefined;

      return {
        content: message.content,
        toolCalls: message.tool_calls?.filter((tc): tc is any => tc.type === 'function').map(tc => ({
          id: tc.id,
          function: {
            name: tc.function.name,
            arguments: sanitizeToolArguments(tc.function.arguments),
          },
        })) || [],
        reasoningContent,
        usage: {
          promptTokens: completion.usage?.prompt_tokens || 0,
          completionTokens: completion.usage?.completion_tokens || 0,
          totalTokens: completion.usage?.total_tokens || 0,
        },
      };
    } catch (error: any) {
      // 处理特定错误
      if (error.status === 401) {
        throw new Error(`${this.config.provider.toUpperCase()} API Key 无效或已过期`);
      } else if (error.status === 429) {
        throw new Error(`${this.config.provider.toUpperCase()} API 请求频率超限，请稍后再试`);
      } else if (error.status === 500) {
        throw new Error(`${this.config.provider.toUpperCase()} 服务器错误，请稍后再试`);
      } else if (error.code === 'ECONNREFUSED') {
        throw new Error(`无法连接到 ${this.config.provider.toUpperCase()} 服务 (${this.config.baseUrl})，请确保服务正在运行`);
      }

      throw new Error(`${this.config.provider.toUpperCase()} API 调用失败: ${error.message}`);
    }
  }
}

