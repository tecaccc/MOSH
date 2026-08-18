//! 端到端加密：密钥生成 / 导出导入 / AES-256-GCM 加解密。
//!
//! 设计（docs/sync-design.md §3.2）：
//! - 密钥 = 32 字节随机数（APP 生成，用户不得自编），导出为 base64 文本串（44 字符）。
//! - 云端只见密文；密钥丢失 = 云端数据永久不可解。
//! - 文件格式：`"MOSHSYNC1" || 12B nonce || ciphertext || 16B tag`。
//! - 压缩在加密之前（密文不可压）。

use crate::error::CoreError;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine as _;

/// 同步密钥：32 字节（AES-256）。
pub const KEY_LEN: usize = 32;
/// GCM nonce：12 字节（标准值）。
pub const NONCE_LEN: usize = 12;
/// 密文格式魔数（含版本，前向演进时换魔数）。
const MAGIC: &[u8] = b"MOSHSYNC1";

/// 生成新的 32 字节随机密钥。
pub fn generate_key() -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    getrandom::fill(&mut key).expect("OS RNG unavailable");
    key
}

/// 密钥 → base64 导出串（44 字符），供用户抄录 / 粘贴到新设备。
pub fn encode_key(key: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(key)
}

/// 导出串 → 密钥。校验 base64 合法性与长度。
pub fn decode_key(s: &str) -> Result<[u8; KEY_LEN], CoreError> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| CoreError::Validation(format!("密钥不是合法的 base64：{e}")))?;
    if raw.len() != KEY_LEN {
        return Err(CoreError::Validation(format!(
            "密钥长度错误：期望 {KEY_LEN} 字节，实际 {}",
            raw.len()
        )));
    }
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(&raw);
    Ok(key)
}

/// 加密任意字节流（gzip 之后调用）。
pub fn seal(plaintext: &[u8], key: &[u8; KEY_LEN]) -> Result<Vec<u8>, CoreError> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce_bytes = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce_bytes).expect("OS RNG unavailable");

    // payload = MAGIC || plaintext；密文内含魔数，解密后立即校验版本。
    let mut pl = Vec::with_capacity(MAGIC.len() + plaintext.len());
    pl.extend_from_slice(MAGIC);
    pl.extend_from_slice(plaintext);

    let sealed = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload::from(pl.as_slice()),
        )
        .map_err(|_| CoreError::Validation("加密失败".to_string()))?;
    let mut out = Vec::with_capacity(NONCE_LEN + sealed.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// 解密 [`seal`] 的输出。密钥错误 / 数据损坏 / 版本不符均报错（GCM 认证标签保证完整性）。
pub fn open(sealed: &[u8], key: &[u8; KEY_LEN]) -> Result<Vec<u8>, CoreError> {
    if sealed.len() < NONCE_LEN + MAGIC.len() + 16 {
        return Err(CoreError::Validation("密文数据不完整".to_string()));
    }
    let (nonce_bytes, ct) = sealed.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let pl = cipher
        .decrypt(Nonce::from_slice(nonce_bytes), Payload::from(ct))
        .map_err(|_| CoreError::Validation("解密失败：密钥错误或数据损坏".to_string()))?;
    if !pl.starts_with(MAGIC) {
        return Err(CoreError::Validation(format!(
            "不支持的同步数据格式（magic 不匹配）"
        )));
    }
    Ok(pl[MAGIC.len()..].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_export_import_roundtrip() {
        let key = generate_key();
        let s = encode_key(&key);
        assert_eq!(s.len(), 44);
        assert_eq!(decode_key(&s).unwrap(), key);
        // 前后空白容忍。
        assert_eq!(decode_key(&format!("  {s}\n")).unwrap(), key);
    }

    #[test]
    fn decode_key_rejects_garbage() {
        assert!(decode_key("不是密钥").is_err());
        assert!(decode_key("AAAA").is_err()); // 长度不足
        let short = base64::engine::general_purpose::STANDARD.encode([0u8; 16]);
        assert!(decode_key(&short).is_err());
    }

    #[test]
    fn seal_open_roundtrip() {
        let key = generate_key();
        let data = b"hello mosh sync".to_vec();
        let sealed = seal(&data, &key).unwrap();
        assert_eq!(open(&sealed, &key).unwrap(), data);
    }

    #[test]
    fn wrong_key_fails() {
        let key = generate_key();
        let other = generate_key();
        let sealed = seal(b"secret", &key).unwrap();
        assert!(open(&sealed, &other).is_err());
    }

    #[test]
    fn truncated_ciphertext_fails() {
        let key = generate_key();
        let sealed = seal(b"secret", &key).unwrap();
        assert!(open(&sealed[..10], &key).is_err());
        assert!(open(&[], &key).is_err());
    }

    #[test]
    fn nonce_uniqueness_same_plaintext_different_ciphertext() {
        let key = generate_key();
        let a = seal(b"same", &key).unwrap();
        let b = seal(b"same", &key).unwrap();
        assert_ne!(a, b); // 随机 nonce → 密文不同（语义安全）
    }
}
