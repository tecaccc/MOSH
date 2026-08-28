/**
 * AI 实体图标解析(三级回退)与能力推断。
 *
 * 借鉴 Cherry Studio 的图标解析链思想(模型专属 → 模型名推厂商 → 厂商),
 * 规则表基于 @lobehub/icons(MIT)自写。全部图标走深路径按需引入,
 * 避免 barrel 全量打包(见 SettingsView 旧注释:全量 4MB+)。
 *
 * 解析顺序(每级命中即返回):
 *  1. 模型名规则 MODEL_ICON_RULES(特异在前)
 *  2. 模型名推厂商规则 MODEL_TO_PROVIDER_RULES
 *  3. 厂商键精确匹配(providerId / presetId)
 *  4. 厂商名正则(自定义 Provider 的显示名,如「我的 DeepSeek 中转」)
 *  5. 兜底:名称首字母圆标(<AiEntityIcon/> 内部处理)
 */
import Anthropic from "@lobehub/icons/es/Anthropic";
import Azure from "@lobehub/icons/es/Azure";
import Claude from "@lobehub/icons/es/Claude";
import DeepSeek from "@lobehub/icons/es/DeepSeek";
import Doubao from "@lobehub/icons/es/Doubao";
import Gemini from "@lobehub/icons/es/Gemini";
import Grok from "@lobehub/icons/es/Grok";
import Groq from "@lobehub/icons/es/Groq";
import Hunyuan from "@lobehub/icons/es/Hunyuan";
import Kimi from "@lobehub/icons/es/Kimi";
import Meta from "@lobehub/icons/es/Meta";
import Minimax from "@lobehub/icons/es/Minimax";
import Mistral from "@lobehub/icons/es/Mistral";
import Nvidia from "@lobehub/icons/es/Nvidia";
import Ollama from "@lobehub/icons/es/Ollama";
import OpenAI from "@lobehub/icons/es/OpenAI";
import OpenRouter from "@lobehub/icons/es/OpenRouter";
import Qwen from "@lobehub/icons/es/Qwen";
import SiliconCloud from "@lobehub/icons/es/SiliconCloud";
import Stepfun from "@lobehub/icons/es/Stepfun";
import Together from "@lobehub/icons/es/Together";
import Wenxin from "@lobehub/icons/es/Wenxin";
import XAI from "@lobehub/icons/es/XAI";
import Yi from "@lobehub/icons/es/Yi";
import Zhipu from "@lobehub/icons/es/Zhipu";
import type { ComponentType } from "react";

import styles from "./aiIcons.module.css";

/** lobehub 图标组件(接收 size 等透传 props;复合图标取 .Color 变体)。 */
type LobehubIcon = ComponentType<{ size?: number | string; className?: string }>

/** 彩色变体获取:复合图标优先 .Color,纯组件直接用。 */
function color(Icon: unknown): LobehubIcon {
  const anyIcon = Icon as { Color?: LobehubIcon } & LobehubIcon
  return anyIcon.Color ?? anyIcon
}

/** 厂商键 → 图标(键即预置键;大小写敏感,统一小写)。 */
const PROVIDER_ICONS: Record<string, LobehubIcon> = {
  anthropic: color(Anthropic),
  claude: color(Claude),
  azure: color(Azure),
  deepseek: color(DeepSeek),
  doubao: color(Doubao),
  gemini: color(Gemini),
  google: color(Gemini),
  grok: color(Grok),
  xai: color(XAI),
  groq: color(Groq),
  hunyuan: color(Hunyuan),
  kimi: color(Kimi),
  moonshot: color(Kimi),
  meta: color(Meta),
  minimax: color(Minimax),
  mistral: color(Mistral),
  nvidia: color(Nvidia),
  ollama: color(Ollama),
  openai: color(OpenAI),
  openrouter: color(OpenRouter),
  qwen: color(Qwen),
  siliconcloud: color(SiliconCloud),
  stepfun: color(Stepfun),
  together: color(Together),
  baidu: color(Wenxin),
  wenxin: color(Wenxin),
  yi: color(Yi),
  zhipu: color(Zhipu),
}

/** 模型名 → 模型专属图标(特异在前;对 base 名匹配)。 */
const MODEL_ICON_RULES: [RegExp, string][] = [
  // Anthropic / OpenAI / Google 三家先匹配(覆盖面最广的放最后)
  [/claude/i, "claude"],
  [/o[13](-|$)|gpt|chatgpt|dall-e|whisper|sora/i, "openai"],
  [/gemini|veo|imagen|learnlm/i, "gemini"],
  // 国内厂商
  [/deepseek/i, "deepseek"],
  [/qwen|qwq|qvq|tongyi/i, "qwen"],
  [/kimi|moonshot/i, "kimi"],
  [/glm|chatglm|cogview|cogvideo|codegeex/i, "zhipu"],
  [/doubao|seedream|seedance|skylark/i, "doubao"],
  [/ernie|wenxin/i, "baidu"],
  [/hunyuan|^hy[-_\d]/i, "hunyuan"],
  [/(^|[-_/])yi([-_/]|$)/i, "yi"],
  [/step[-_]/i, "stepfun"],
  [/minimax|abab/i, "minimax"],
  // 国际厂商
  [/grok/i, "grok"],
  [/llama|meta-/i, "meta"],
  [/mistral|codestral|pixtral|ministral|magistral/i, "mistral"],
  [/nemotron/i, "nvidia"],
]

/** 模型名 → 厂商图标(比上一级更宽:仅收录可确认归属的族)。 */
const MODEL_TO_PROVIDER_RULES: [RegExp, string][] = [
  [/gemma|palm|bison/i, "google"], // Google 系非 Gemini 命名
]

/** 厂商名(自定义 Provider 显示名)正则 → 厂商键。 */
const PROVIDER_NAME_RULES: [RegExp, string][] = [
  [/deepseek/i, "deepseek"],
  [/通义|千问|qwen|dashscope|阿里/i, "qwen"],
  [/kimi|moonshot|月之暗面/i, "kimi"],
  [/智谱|zhipu|glm|bigmodel/i, "zhipu"],
  [/gemini|google|谷歌/i, "gemini"],
  [/openai|gpt|chatgpt/i, "openai"],
  [/anthropic|claude/i, "anthropic"],
  [/grok|xai/i, "grok"],
  [/豆包|火山|doubao|volc/i, "doubao"],
  [/混元|hunyuan|腾讯/i, "hunyuan"],
  [/文心|ernie|百度/i, "baidu"],
  [/ollama/i, "ollama"],
  [/openrouter/i, "openrouter"],
  [/groq/i, "groq"],
  [/mistral/i, "mistral"],
  [/硅基|siliconflow/i, "siliconcloud"],
  [/minimax/i, "minimax"],
  [/阶跃|step/i, "stepfun"],
  [/azure|微软/i, "azure"],
]

/**
 * 名称规范化:小写、取 `vendor/` 后的末段、去 `:free`/`:cloud`/`(free)` 后缀。
 * (OpenRouter / Ollama 等会把定价或部署形态挂在模型 id 尾部。)
 */
export function lowerBaseName(raw: string): string {
  let s = raw.trim().toLowerCase()
  const slash = s.lastIndexOf("/")
  if (slash >= 0) s = s.slice(slash + 1)
  s = s.replace(/:free$/, "").replace(/:cloud$/, "").replace(/\(free\)$/, "")
  return s
}

export interface AiEntityRef {
  /** 原始模型 id(API id;provider 名兜底场景可空)。 */
  modelId?: string
  /** Provider id(预置键或 custom-*)。 */
  providerId?: string
  /** Provider 预置键(优先于 providerId 匹配)。 */
  presetId?: string
  /** Provider 显示名(自定义 Provider 的最后匹配手段)。 */
  providerName?: string
}

/** 三级回退解析图标;未命中返回 undefined(调用方走首字母兜底)。 */
export function resolveAiIcon(ref: AiEntityRef): LobehubIcon | undefined {
  const base = ref.modelId ? lowerBaseName(ref.modelId) : ""
  if (base) {
    for (const [re, key] of MODEL_ICON_RULES) {
      if (re.test(base)) return PROVIDER_ICONS[key]
    }
    for (const [re, key] of MODEL_TO_PROVIDER_RULES) {
      if (re.test(base)) return PROVIDER_ICONS[key]
    }
  }
  for (const id of [ref.presetId, ref.providerId]) {
    if (id) {
      const hit = PROVIDER_ICONS[id.toLowerCase()]
      if (hit) return hit
    }
  }
  if (ref.providerName) {
    for (const [re, key] of PROVIDER_NAME_RULES) {
      if (re.test(ref.providerName)) return PROVIDER_ICONS[key]
    }
  }
  return undefined
}

/** 兜底首字母:模型名优先,否则厂商名,再否则 "AI"。 */
function fallbackLetter(ref: AiEntityRef): string {
  const src = ref.modelId || ref.providerName || ""
  const base = lowerBaseName(src)
  const ch = [...base].find((c) => /[a-z0-9\u4e00-\u9fff]/.test(c))
  return (ch ?? "a").toUpperCase()
}

/** 统一图标组件:命中规则渲染厂商/模型图标,否则首字母圆标。 */
export function AiEntityIcon({
  modelId,
  providerId,
  presetId,
  providerName,
  size = 20,
  className,
}: AiEntityRef & { size?: number; className?: string }) {
  const Icon = resolveAiIcon({ modelId, providerId, presetId, providerName })
  if (Icon) {
    return <Icon size={size} className={className} />
  }
  return (
    <span className={`${styles.fallback} ${className ?? ""}`} style={{ width: size, height: size }}>
      {fallbackLetter({ modelId, providerId, presetId, providerName })}
    </span>
  )
}

// ── 能力推断(同步入库/展示用;用户可在模型编辑里覆盖)──

export type ModelCapability = "vision" | "reasoning" | "tools" | "embedding"

export const MODEL_CAPABILITIES: ModelCapability[] = ["vision", "reasoning", "tools", "embedding"]

/** 能力中文名(设置页勾选/点标 tooltip 用)。 */
export const CAPABILITY_LABELS: Record<ModelCapability, string> = {
  vision: "视觉",
  reasoning: "推理",
  tools: "工具",
  embedding: "嵌入",
}

/** 常见模型名 → 能力推断(未命中返回空数组;由用户手动补)。 */
const CAPABILITY_RULES: [RegExp, ModelCapability[]][] = [
  [
    /(^|[-_.])vl($|[-_.])|vision|-image|image-|glm-4v|dall-e|sora|seedream|seedance|flux|pixtral/i,
    ["vision"],
  ],
  [/deepseek-r\d|reasoner|thinking|qwq|(^|[-_.])(o1|o3|o4)([-_.]|$)|z1/i, ["reasoning"]],
  [/(^|[-_.])fc($|[-_.])|function.?call/i, ["tools"]],
  [/embed|(^|[-_.])bge($|[-_.])|(^|[-_.])m3e|text-embedding/i, ["embedding"]],
]

/** 按模型名推断能力标签(小写 base 名匹配;仅供默认值,非权威)。 */
export function inferCapabilities(modelId: string): ModelCapability[] {
  const base = lowerBaseName(modelId)
  if (!base) return []
  const caps = new Set<ModelCapability>()
  for (const [re, list] of CAPABILITY_RULES) {
    if (re.test(base)) list.forEach((c) => caps.add(c))
  }
  // 纯 embedding 模型不给 tools/vision。
  if (caps.has("embedding")) return ["embedding"]
  return [...caps]
}

/** 展示用能力:库内有值用库值,否则推断(空数组如实返回)。 */
export function effectiveCapabilities(
  stored: string[] | undefined,
  modelId: string,
): ModelCapability[] {
  if (stored && stored.length > 0) {
    return stored.filter((c): c is ModelCapability =>
      (MODEL_CAPABILITIES as string[]).includes(c),
    )
  }
  return inferCapabilities(modelId)
}
