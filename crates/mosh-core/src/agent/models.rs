//! AI Provider / Model 实体与 UniqueModelId。
//!
//! 架构思想借鉴 Cherry Studio（模型以 `providerId::modelId` 为全局唯一键、
//! 实体表 + 「非空列即用户覆盖」语义），实现为本项目自有代码。

use serde::{Deserialize, Serialize};

/// UniqueModelId 分隔符：`providerId::modelId`。
pub const MODEL_ID_SEP: &str = "::";

/// 拼接 UniqueModelId。provider_id 含分隔符时返回 None（防歧义）。
pub fn unique_model_id(provider_id: &str, model_id: &str) -> Option<String> {
    if provider_id.is_empty() || model_id.is_empty() || provider_id.contains(MODEL_ID_SEP) {
        return None;
    }
    Some(format!("{provider_id}{MODEL_ID_SEP}{model_id}"))
}

/// 解析 UniqueModelId（按首个 `::` 分割；模型 id 本身含 `::` 的罕见情形归入模型段）。
pub fn parse_unique_model_id(id: &str) -> Option<(String, String)> {
    let idx = id.find(MODEL_ID_SEP)?;
    let provider_id = &id[..idx];
    let model_id = &id[idx + MODEL_ID_SEP.len()..];
    if provider_id.is_empty() || model_id.is_empty() {
        return None;
    }
    Some((provider_id.to_string(), model_id.to_string()))
}

/// 模型能力标签（存储为字符串数组；前端展示点标）。
pub const CAP_VISION: &str = "vision";
pub const CAP_REASONING: &str = "reasoning";
pub const CAP_TOOLS: &str = "tools";
pub const CAP_EMBEDDING: &str = "embedding";

fn default_true() -> bool {
    true
}

/// AI 服务提供商（一个 Provider = 一个 OpenAI 兼容端点 + 一把 key）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiProvider {
    /// 稳定 slug：预置为预置键（如 `deepseek`），自定义为 `custom-<uuid8>`。
    pub id: String,
    /// 来源预置键（可空 = 全自定义）。
    #[serde(default)]
    pub preset_id: Option<String>,
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 分数索引（拖拽排序用）。
    #[serde(default)]
    pub sort_order: f64,
    #[serde(default)]
    pub created_at: String,
}

/// 模型实体。`id` 即 UniqueModelId；`name` 等列 NULL = 用默认（model_id）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiModel {
    /// UniqueModelId：`providerId::modelId`。
    pub id: String,
    pub provider_id: String,
    /// API 原始模型 id。
    pub model_id: String,
    /// 显示名；空 = 显示 model_id。
    #[serde(default)]
    pub name: Option<String>,
    /// 能力标签 JSON（"vision" | "reasoning" | "tools" | "embedding"）。
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub context_window: Option<i64>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 从选择器隐藏（保留配置不展示）。
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub sort_order: f64,
}

/// `ai_sync_models` 的 diff 结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSyncResult {
    /// 新拉到、已入库的模型 id（原始 model_id）。
    pub added: Vec<String>,
    /// 本地有、远端没有而标记 hidden 的 UniqueModelId。
    pub hidden: Vec<String>,
}

/// `ai_get_default_model` 返回体：默认模型的完整实体（model.id 即 UniqueModelId）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiDefaultModel {
    pub provider: AiProvider,
    pub model: AiModel,
}

/// 旧 `ai_providers` settings JSON 行（迁移源，字段对齐旧 `AiConfig`）。
#[derive(Debug, Clone, Deserialize)]
pub struct LegacyAiConfig {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_id_roundtrip() {
        let id = unique_model_id("deepseek", "deepseek-chat").unwrap();
        assert_eq!(id, "deepseek::deepseek-chat");
        assert_eq!(
            parse_unique_model_id(&id),
            Some(("deepseek".into(), "deepseek-chat".into()))
        );
    }

    #[test]
    fn unique_id_splits_on_first_sep() {
        // 模型段含 `::`（如某些网关的 namespace id）归入模型段。
        let (p, m) = parse_unique_model_id("custom-x::a::b").unwrap();
        assert_eq!(p, "custom-x");
        assert_eq!(m, "a::b");
    }

    #[test]
    fn unique_id_rejects_bad() {
        assert!(unique_model_id("", "m").is_none());
        assert!(unique_model_id("p", "").is_none());
        assert!(unique_model_id("a::b", "m").is_none());
        assert!(parse_unique_model_id("no-sep").is_none());
        assert!(parse_unique_model_id("::m").is_none());
        assert!(parse_unique_model_id("p::").is_none());
    }
}
