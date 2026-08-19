//! 邮件发送（SMTP 直发，lettre + rustls 纯 Rust TLS 栈）。
//!
//! 领域模型与校验在 `mosh-core::notify`（可单测）；本模块只负责把一份
//! 校验通过的 `EmailConfig` 变成一封发出的邮件。TLS 三档：
//! - ssl：隐式 TLS（465，`relay`）；
//! - starttls：明文连入后强制 STARTTLS 升级（587，`starttls_relay`）；
//! - none：不加密（25，仅本机/内网中继，`builder_dangerous`）。
//!
//! rustls + webpki-roots（Mozilla 根证书）与 sync/agent 的 reqwest 同栈，
//! 规避 windows-gnu 交叉编译的 OpenSSL 依赖。

use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use mosh_core::notify::{default_port, EmailConfig};
use std::time::Duration;

/// 发送超时（连接 + 逐命令；SMTP 慢路径授权 30s）。
const SMTP_TIMEOUT: Duration = Duration::from_secs(30);

/// 发送一封纯文本邮件；失败返回带原因的中文错误串。
pub async fn send_email(cfg: &EmailConfig, subject: &str, body: &str) -> Result<(), String> {
    let email = Message::builder()
        .from(cfg.from.parse().map_err(|e| format!("发件邮箱「{}」无效：{e}", cfg.from))?)
        .to(cfg.to.parse().map_err(|e| format!("收件邮箱「{}」无效：{e}", cfg.to))?)
        .subject(subject)
        .body(body.to_string())
        .map_err(|e| format!("构建邮件失败：{e}"))?;

    let port = if cfg.port == 0 { default_port(&cfg.encryption) } else { cfg.port };
    let builder = match cfg.encryption.as_str() {
        "ssl" => AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host)
            .map_err(|e| format!("SMTP 初始化失败：{e}"))?,
        "starttls" => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host)
            .map_err(|e| format!("SMTP 初始化失败：{e}"))?,
        _ => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&cfg.host),
    };
    let mailer = builder
        .port(port)
        .timeout(Some(SMTP_TIMEOUT))
        .credentials(Credentials::new(cfg.username.clone(), cfg.password.clone()))
        .build::<Tokio1Executor>();
    mailer.send(email).await.map_err(|e| format!("发送失败：{e}"))?;
    Ok(())
}
