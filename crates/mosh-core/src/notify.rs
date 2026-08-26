//! 通知方式（系统/邮件）的领域模型：设置读写合并、校验与回显（不含发送）。
//!
//! 持久化：settings 表 key=`notify_settings`（单 JSON；随多设备同步的 settings
//! 一起端到端加密同步）。`EmailConfig.password` 为 SMTP 授权码——仅存本地库，
//! 回显时剔除（`EmailConfigInfo.has_password` 探针），保存空串 = 保留原值。
//!
//! 默认行为（无此设置时）：系统通知开、邮件关——与引入本模块前只发系统通知一致。
//!
//! SMTP 发送（lettre）在 `src-tauri`（桌面壳）实现，本模块保持纯逻辑可测。

use serde::{Deserialize, Serialize};

/// settings 表中的通知配置键。
pub const KEY_NOTIFY: &str = "notify_settings";

/// 加密方式合法值。
pub const ENCRYPTIONS: [&str; 3] = ["starttls", "ssl", "none"];

/// 加密方式缺省端口（`port == 0` 时按此取值）。
pub fn default_port(encryption: &str) -> u16 {
    match encryption {
        "ssl" => 465,
        "starttls" => 587,
        _ => 25,
    }
}

/// 通知设置整体（持久化形态）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", default)]
pub struct NotifySettings {
    /// 系统通知（OS 通知中心）开关。
    pub system: bool,
    /// 邮件通知开关；开启时 `email` 必须完整有效。
    pub email_enabled: bool,
    /// SMTP 配置；未配置 = None。
    pub email: Option<EmailConfig>,
}

impl Default for NotifySettings {
    /// 旧版无此设置 → 系统通知开、邮件关（与既有行为一致）。
    fn default() -> Self {
        Self { system: true, email_enabled: false, email: None }
    }
}

/// SMTP 服务器与收发配置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", default)]
pub struct EmailConfig {
    /// SMTP 服务器主机名，如 smtp.qq.com。
    pub host: String,
    /// 端口；0 = 按加密方式取默认（ssl 465 / starttls 587 / none 25）。
    pub port: u16,
    /// 加密方式：starttls | ssl | none（仅内网中继用 none）。
    pub encryption: String,
    /// SMTP 用户名（多数服务商与发件邮箱相同）。
    pub username: String,
    /// 密码/授权码（保存时空串 = 保留已存值；回显时剔除）。
    pub password: String,
    /// 发件邮箱（须为该账号邮箱，否则多数服务器拒发）。
    pub from: String,
    /// 收件邮箱（通知送达地址）。
    pub to: String,
}

impl Default for EmailConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 0,
            encryption: "starttls".into(),
            username: String::new(),
            password: String::new(),
            from: String::new(),
            to: String::new(),
        }
    }
}

/// 通知设置回显（不含授权码）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct NotifySettingsInfo {
    pub system: bool,
    pub email_enabled: bool,
    pub email: Option<EmailConfigInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct EmailConfigInfo {
    pub host: String,
    pub port: u16,
    pub encryption: String,
    pub username: String,
    pub from: String,
    pub to: String,
    /// 已保存过授权码（表单留空 = 不改）。
    pub has_password: bool,
}

/// 邮箱串语义校验：`name@domain`（允许 `名字 <a@b>` 信头格式）。
fn valid_address(addr: &str) -> bool {
    let inner = addr.trim();
    // 去掉可选的显示名部分：`名字 <addr>`。
    let bare = if inner.ends_with('>') {
        match inner.rfind('<') {
            Some(i) => &inner[i + 1..inner.len() - 1],
            None => inner,
        }
    } else {
        inner
    };
    let Some((local, domain)) = bare.split_once('@') else {
        return false;
    };
    !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

/// 配置完整性校验（保存与测试共用）；错误信息面向用户。
pub fn validate_email(cfg: &EmailConfig) -> Result<(), String> {
    if cfg.host.trim().is_empty() {
        return Err("SMTP 服务器不能为空".into());
    }
    if !ENCRYPTIONS.contains(&cfg.encryption.as_str()) {
        return Err(format!("加密方式须为 {} 之一", ENCRYPTIONS.join(" / ")));
    }
    if cfg.from.trim().is_empty() || cfg.to.trim().is_empty() {
        return Err("发件邮箱与收件邮箱均不能为空".into());
    }
    for (label, addr) in [("发件", &cfg.from), ("收件", &cfg.to)] {
        if !valid_address(addr) {
            return Err(format!("{label}邮箱「{addr}」无效，应为 name@domain 形式"));
        }
    }
    if cfg.username.trim().is_empty() {
        return Err("SMTP 用户名不能为空".into());
    }
    if cfg.password.is_empty() {
        return Err("密码/授权码不能为空".into());
    }
    Ok(())
}

/// 规整入库（去空白、port=0 折算默认端口、加密方式小写）。
fn normalize_email(mut cfg: EmailConfig) -> EmailConfig {
    cfg.host = cfg.host.trim().to_string();
    cfg.encryption = cfg.encryption.trim().to_lowercase();
    if cfg.port == 0 {
        cfg.port = default_port(&cfg.encryption);
    }
    cfg.username = cfg.username.trim().to_string();
    cfg.from = cfg.from.trim().to_string();
    cfg.to = cfg.to.trim().to_string();
    cfg
}

/// 保存合并：空密码 = 沿用已存值；规整后校验。
///
/// 校验时机：`email_enabled` 开启必校验；未开启但 host 非空（填了一半）也校验，
/// 避免把明显错误的配置悄悄存进库；完全空壳（host 空）则原样放行存空。
pub fn merge_for_save(
    incoming: NotifySettings,
    saved: &NotifySettings,
) -> Result<NotifySettings, String> {
    let mut merged = incoming;
    if let Some(cfg) = merged.email.as_mut() {
        // 空密码 = 保留原值（回显表单不含密码）。
        if cfg.password.is_empty() {
            cfg.password = saved
                .email
                .as_ref()
                .map(|c| c.password.clone())
                .unwrap_or_default();
        }
        *cfg = normalize_email(cfg.clone());
        if merged.email_enabled || !cfg.host.is_empty() {
            validate_email(cfg).map_err(|e| format!("邮件配置无效：{e}"))?;
        }
    }
    if merged.email_enabled && merged.email.is_none() {
        return Err("开启邮件通知前需先填写邮件配置".into());
    }
    Ok(merged)
}

/// 生成回显（剔除授权码）。
pub fn info_of(settings: &NotifySettings) -> NotifySettingsInfo {
    NotifySettingsInfo {
        system: settings.system,
        email_enabled: settings.email_enabled,
        email: settings.email.as_ref().map(|c| EmailConfigInfo {
            host: c.host.clone(),
            port: c.port,
            encryption: c.encryption.clone(),
            username: c.username.clone(),
            from: c.from.clone(),
            to: c.to.clone(),
            has_password: !c.password.is_empty(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> EmailConfig {
        EmailConfig {
            host: "smtp.qq.com".into(),
            port: 465,
            encryption: "ssl".into(),
            username: "a@qq.com".into(),
            password: "secret".into(),
            from: "a@qq.com".into(),
            to: "b@qq.com".into(),
        }
    }

    #[test]
    fn default_keeps_system_only() {
        let d = NotifySettings::default();
        assert!(d.system && !d.email_enabled && d.email.is_none());
        // 旧版无设置 → 反序列化失败回退 default（由调用方 unwrap_or_default 兜底）。
        assert!(serde_json::from_str::<NotifySettings>("not json").is_err());
    }

    #[test]
    fn serde_roundtrip_snake_case() {
        let s = NotifySettings { system: false, email_enabled: true, email: Some(sample()) };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["email_enabled"], true);
        assert_eq!(v["email"]["encryption"], "ssl");
        let back: NotifySettings = serde_json::from_value(v).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn merge_keeps_saved_password_and_toggles() {
        let saved = NotifySettings { email: Some(sample()), email_enabled: true, ..Default::default() };
        // 表单回显（无密码）直接保存：授权码应沿用；system 开关独立生效。
        let incoming = NotifySettings {
            system: false,
            email_enabled: true,
            email: Some(EmailConfig { password: String::new(), ..sample() }),
        };
        let merged = merge_for_save(incoming, &saved).unwrap();
        assert_eq!(merged.email.as_ref().unwrap().password, "secret");
        assert!(!merged.system);
    }

    #[test]
    fn merge_fills_default_port_and_trims() {
        let mut cfg = sample();
        cfg.port = 0;
        cfg.host = "  smtp.example.com  ".into();
        cfg.encryption = " STARTTLS ".into();
        let merged = merge_for_save(
            NotifySettings { email: Some(cfg), email_enabled: true, ..Default::default() },
            &NotifySettings::default(),
        )
        .unwrap();
        let email = merged.email.unwrap();
        assert_eq!(email.host, "smtp.example.com");
        assert_eq!(email.encryption, "starttls");
        assert_eq!(email.port, 587);
    }

    #[test]
    fn merge_rejects_bad_address_and_missing_fields() {
        let mut cfg = sample();
        cfg.from = "not-an-email".into();
        let err = merge_for_save(
            NotifySettings { email: Some(cfg), email_enabled: true, ..Default::default() },
            &NotifySettings::default(),
        )
        .unwrap_err();
        assert!(err.contains("发件邮箱"), "{err}");

        let mut no_pwd = sample();
        no_pwd.password = String::new();
        let err = merge_for_save(
            NotifySettings { email: Some(no_pwd), email_enabled: false, ..Default::default() },
            &NotifySettings::default(), // 无已存密码可沿用
        )
        .unwrap_err();
        assert!(err.contains("授权码"), "{err}");
    }

    #[test]
    fn merge_rejects_email_enabled_without_config() {
        let err = merge_for_save(
            NotifySettings { email_enabled: true, ..Default::default() },
            &NotifySettings::default(),
        )
        .unwrap_err();
        assert!(err.contains("先填写"));
    }

    #[test]
    fn merge_allows_empty_shell_when_disabled() {
        // 未启用邮件且 host 为空：允许保存（比如先关掉邮件再清空表单）。
        let merged = merge_for_save(NotifySettings::default(), &NotifySettings::default()).unwrap();
        assert!(merged.email.is_none());
    }

    #[test]
    fn info_strips_password() {
        let settings =
            NotifySettings { email: Some(sample()), ..Default::default() };
        let info = serde_json::to_value(info_of(&settings)).unwrap();
        assert!(info["email"].get("password").is_none());
        assert_eq!(info["email"]["has_password"], true);
    }

    #[test]
    fn address_validation_forms() {
        assert!(valid_address("a@qq.com"));
        assert!(valid_address("Connor <a@qq.com>"));
        assert!(!valid_address("a@@qq"));
        assert!(!valid_address("a@qq"));
        assert!(!valid_address("@qq.com"));
        assert!(!valid_address("a@.com"));
    }
}
