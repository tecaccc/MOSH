/**
 * AI 提供商预置目录(官方常见端点,事实自写;选中预置即预填表单)。
 *
 * `key` 同时是图标解析键(见 aiIcons.tsx 的 PROVIDER_ICONS)与新表的
 * provider.id 取值来源(预置添加的 Provider 用预置键作 id)。
 * `defaultModels` 为常见可用模型(仅预填建议,同步后以远端为准)。
 */

export interface ProviderPreset {
  /** 稳定 slug:图标键 / 预置 Provider id。 */
  key: string
  /** 显示名。 */
  name: string
  /** OpenAI 兼容 base_url(以 /v1 等版本段结尾,不带尾部 /)。 */
  baseUrl: string
  /** 预填建议模型(可空)。 */
  defaultModel?: string
  /** 是否本地服务(Ollama 等:无 key、勾选「本地」)。 */
  local?: boolean
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
  },
  {
    key: "qwen",
    name: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
  },
  {
    key: "kimi",
    name: "Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k2-0905-preview",
  },
  {
    key: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-plus",
  },
  {
    key: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
  },
  {
    key: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
  },
  {
    key: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-5",
  },
  {
    key: "grok",
    name: "xAI Grok",
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-3",
  },
  {
    key: "doubao",
    name: "火山方舟(豆包)",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  },
  {
    key: "hunyuan",
    name: "腾讯混元",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
  },
  {
    key: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimax.chat/v1",
  },
  {
    key: "stepfun",
    name: "阶跃星辰",
    baseUrl: "https://api.stepfun.com/v1",
  },
  {
    key: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
  },
  {
    key: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
  },
  {
    key: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    key: "siliconcloud",
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
  },
  {
    key: "ollama",
    name: "Ollama(本地)",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen3:8b",
    local: true,
  },
]

/** 按预置键取预置。 */
export function presetOf(key: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.key === key)
}
