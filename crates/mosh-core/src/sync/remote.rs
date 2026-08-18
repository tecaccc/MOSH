//! S3 兼容对象存储客户端：LIST / GET / PUT，AWS SigV4 签名。
//!
//! 手写签名（sha2 + hmac，函数不到百行）而非引入 S3 SDK——依赖最小化，
//! 且 COS / OSS / R2 / B2 均兼容 SigV4。统一 virtual-hosted 寻址：
//! `https://<bucket>.<endpoint-host>/<key>`。

use crate::error::CoreError;
use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;

use crate::sync::engine::Remote;

type HmacSha256 = Hmac<Sha256>;

fn default_addressing() -> String {
    "virtual".to_string()
}

fn default_timeout() -> u64 {
    30
}

fn default_tls_verify() -> bool {
    true
}

/// 远端连接配置（存 settings `sync.*` 键；`secret_key` 永不入 dump）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteConfig {
    /// 服务端点主机，如 `cos.ap-guangzhou.myqcloud.com`（可带 https:// 前缀）。
    pub endpoint: String,
    /// 地域，如 `ap-guangzhou`。
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    /// 寻址风格：`virtual`（默认，`bucket.endpoint/key`）| `path`（`endpoint/bucket/key`，
    /// MinIO 等自建网关常用）。
    #[serde(default = "default_addressing")]
    pub addressing: String,
    /// 单请求超时（秒；含响应体读取）。
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    /// 是否校验 TLS 证书（关闭仅限自签代理等特殊场景）。
    #[serde(default = "default_tls_verify")]
    pub tls_verify: bool,
}

/// 远端对象条目（LIST 结果）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteObject {
    pub key: String,
    #[serde(default)]
    pub etag: String,
    #[serde(default)]
    pub last_modified: String,
}

/// S3 兼容客户端。
pub struct S3Client {
    config: RemoteConfig,
    http: Client,
}

impl S3Client {
    pub fn new(config: RemoteConfig) -> Result<Self, CoreError> {
        let mut builder = Client::builder()
            .timeout(Duration::from_secs(config.timeout_secs.clamp(5, 600)));
        if !config.tls_verify {
            // 仅用户显式关闭时跳过证书校验（自签代理场景）。
            builder = builder.danger_accept_invalid_certs(true);
        }
        Ok(Self {
            config,
            http: builder.build()?,
        })
    }

    /// 归一化 endpoint：去 scheme / 尾斜杠。
    fn endpoint_host(&self) -> &str {
        self.config
            .endpoint
            .trim()
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/')
    }

    fn is_path_style(&self) -> bool {
        self.config.addressing == "path"
    }

    /// 请求基座（不含对象路径）：virtual → `https://<bucket>.<endpoint>`
    /// （endpoint 已含桶名前缀则不再拼）；path → `https://<endpoint>/<bucket>`。
    fn base(&self) -> String {
        let endpoint = self.endpoint_host();
        let bucket = self.config.bucket.trim();
        if self.is_path_style() {
            return format!("https://{endpoint}/{bucket}");
        }
        // 容错：用户常把控制台给的完整桶域名（含桶名）填进 endpoint。
        if !bucket.is_empty() && endpoint.starts_with(&format!("{bucket}.")) {
            return format!("https://{endpoint}");
        }
        format!("https://{bucket}.{endpoint}")
    }

    fn url(&self, key: &str) -> String {
        format!("{}/{}", self.base(), key)
    }
}

impl Remote for S3Client {
    /// 列出前缀下全部对象（ ContinuationToken 分页跟随）。
    async fn list(&self, prefix: &str) -> Result<Vec<RemoteObject>, CoreError> {
        let mut out = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut query = format!("list-type=2&prefix={}", urlencode(prefix));
            if let Some(t) = &token {
                query.push_str(&format!("&continuation-token={}", urlencode(t)));
            }
            let url = format!("{}/?{}", self.base(), query);
            let body = self.request("GET", &url, &[], b"").await?;
            let (objects, next) = parse_list_result(&body)?;
            out.extend(objects);
            token = next;
            if token.is_none() {
                return Ok(out);
            }
        }
    }

    /// 取对象内容。404 → `Ok(None)`（远端尚无此设备 dump 属正常态）。
    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, CoreError> {
        let url = self.url(key);
        let resp = self.request_raw("GET", &url, &[], b"").await?;
        match resp.status().as_u16() {
            200 => Ok(Some(resp.bytes().await?.to_vec())),
            404 => Ok(None),
            code => Err(CoreError::Network(format!("GET {key} 返回 {code}"))),
        }
    }

    /// 上传对象（整体覆盖）。
    async fn put(&self, key: &str, body: &[u8]) -> Result<(), CoreError> {
        let url = self.url(key);
        self.request("PUT", &url, &[], body).await?;
        Ok(())
    }
}

impl S3Client {
    /// 发签名请求，非 2xx 报错（含响应体摘要，便于诊断 COS 错误码）。
    async fn request(
        &self,
        method: &str,
        url: &str,
        extra_headers: &[(&str, &str)],
        body: &[u8],
    ) -> Result<Vec<u8>, CoreError> {
        let resp = self.request_raw(method, url, extra_headers, body).await?;
        let status = resp.status().as_u16();
        let bytes = resp.bytes().await?.to_vec();
        if !(200..300).contains(&status) {
            let snippet = String::from_utf8_lossy(&bytes[..bytes.len().min(300)]).to_string();
            return Err(CoreError::Network(format!(
                "{method} 返回 {status}：{snippet}"
            )));
        }
        Ok(bytes)
    }

    async fn request_raw(
        &self,
        method: &str,
        url: &str,
        extra_headers: &[(&str, &str)],
        body: &[u8],
    ) -> Result<reqwest::Response, CoreError> {
        let now = Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let date = now.format("%Y%m%d").to_string();
        let host = url_host(url)?;
        let auth = authorization(
            &self.config.secret_key,
            &self.config.access_key,
            &date,
            &amz_date,
            &self.config.region,
            method,
            url,
            &[("host", host.as_str())],
            body,
        );
        let mut req = self
            .http
            .request(
                reqwest::Method::from_bytes(method.as_bytes())
                    .map_err(|e| CoreError::Validation(format!("非法方法：{e}")))?,
                url,
            )
            .header("x-amz-date", &amz_date)
            .header("x-amz-content-sha256", &sha256_hex(body))
            .header("Authorization", auth);
        for (k, v) in extra_headers {
            req = req.header(*k, *v);
        }
        Ok(req.body(body.to_vec()).send().await?)
    }
}

// —— SigV4 签名（纯函数，快照测试） ——

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

pub(crate) fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 计算 Authorization 头。signed headers 固定为 `host;x-amz-content-sha256;x-amz-date`。
#[allow(clippy::too_many_arguments)]
fn authorization(
    secret_key: &str,
    access_key: &str,
    date: &str,
    amz_date: &str,
    region: &str,
    method: &str,
    url: &str,
    base_headers: &[(&str, &str)],
    body: &[u8],
) -> String {
    let (path, query) = split_url(url);
    let mut headers: Vec<(String, String)> = base_headers
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    headers.push(("x-amz-content-sha256".into(), sha256_hex(body)));
    headers.push(("x-amz-date".into(), amz_date.to_string()));
    headers.sort_by(|a, b| a.0.cmp(&b.0));

    let signed_headers = headers
        .iter()
        .map(|(k, _)| k.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical_headers = headers
        .iter()
        .map(|(k, v)| format!("{k}:{}\n", v.trim()))
        .collect::<String>();

    let canonical_request = format!(
        "{method}\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\n{}",
        sha256_hex(body)
    );
    let scope = format!("{date}/{region}/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    let k_date = hmac_sha256(format!("AWS4{secret_key}").as_bytes(), date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = hex(&hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    format!(
        "AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    )
}

fn split_url(url: &str) -> (&str, &str) {
    let no_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    // 从首个 '/' 起是 path（保留前导斜杠；canonical path 要求）。
    match no_scheme.find('/') {
        Some(i) => {
            let path_query = &no_scheme[i..];
            path_query
                .split_once('?')
                .map(|(p, q)| (p, q))
                .unwrap_or((path_query, ""))
        }
        None => ("/", ""),
    }
}

fn url_host(url: &str) -> Result<String, CoreError> {
    let no_scheme = url.split_once("://").map(|(_, rest)| rest).unwrap_or(url);
    let host = no_scheme
        .split('/')
        .next()
        .unwrap_or_default()
        .split(':')
        .next()
        .unwrap_or_default();
    if host.is_empty() {
        return Err(CoreError::Validation(format!("非法 URL：{url}")));
    }
    Ok(host.to_string())
}

/// 最小百分比编码（RFC 3986 unreserved 之外全转义）。
fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// —— LIST XML 解析（仅取 Key/ETag/LastModified；结构扁平，手解析避免引依赖）——

fn parse_list_result(xml: &[u8]) -> Result<(Vec<RemoteObject>, Option<String>), CoreError> {
    let text = String::from_utf8_lossy(xml);
    let mut objects = Vec::new();
    for block in split_tag(&text, "Contents") {
        objects.push(RemoteObject {
            key: extract_tag(&block, "Key").unwrap_or_default(),
            etag: extract_tag(&block, "ETag").unwrap_or_default(),
            last_modified: extract_tag(&block, "LastModified").unwrap_or_default(),
        });
    }
    let next = extract_tag(&text, "NextContinuationToken");
    Ok((objects, next.filter(|t| !t.is_empty())))
}

fn split_tag(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        // 跳过自闭合与属性：从 '>' 起找内容。
        let content_start = match rest[start..].find('>') {
            Some(i) => start + i + 1,
            None => break,
        };
        let Some(end_rel) = rest[content_start..].find(&close) else {
            break;
        };
        let end = content_start + end_rel;
        // 自闭合 <Tag/> 产生空内容，跳过。
        out.push(rest[content_start..end].to_string());
        rest = &rest[end + close.len()..];
    }
    out
}

fn extract_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let start = xml.find(&open)?;
    let content_start = xml[start..].find('>')? + start + 1;
    let end = xml[content_start..].find(&close)? + content_start;
    Some(xml[content_start..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> RemoteConfig {
        RemoteConfig {
            endpoint: "cos.ap-guangzhou.myqcloud.com".into(),
            region: "ap-guangzhou".into(),
            bucket: "mosh-test".into(),
            access_key: "AKIDEXAMPLE".into(),
            secret_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
            addressing: default_addressing(),
            timeout_secs: default_timeout(),
            tls_verify: default_tls_verify(),
        }
    }

    #[test]
    fn host_and_url_building() {
        let c = S3Client::new(config()).unwrap();
        assert_eq!(
            c.url("mosh-sync/dev1/dump.bin"),
            "https://mosh-test.cos.ap-guangzhou.myqcloud.com/mosh-sync/dev1/dump.bin"
        );
        // 带 scheme 与尾斜杠的 endpoint 也归一。
        let mut cfg2 = config();
        cfg2.endpoint = "https://cos.ap-shanghai.myqcloud.com/".into();
        let c2 = S3Client::new(cfg2).unwrap();
        assert_eq!(
            c2.url("k"),
            "https://mosh-test.cos.ap-shanghai.myqcloud.com/k"
        );
        // 容错：endpoint 填了完整桶域名（含桶名）不再二次拼桶。
        let mut cfg3 = config();
        cfg3.endpoint = "mosh-test.cos.ap-guangzhou.myqcloud.com".into();
        let c3 = S3Client::new(cfg3).unwrap();
        assert_eq!(
            c3.url("k"),
            "https://mosh-test.cos.ap-guangzhou.myqcloud.com/k"
        );
        // 桶名仅是前缀而非整段时不去重（mosh-test ≠ mosh-test-1258463625）。
        let mut cfg4 = config();
        cfg4.endpoint = "mosh-test-1258463625.cos.ap-guangzhou.myqcloud.com".into();
        let c4 = S3Client::new(cfg4).unwrap();
        assert_eq!(
            c4.url("k"),
            "https://mosh-test.mosh-test-1258463625.cos.ap-guangzhou.myqcloud.com/k"
        );
        // path 式：桶名进路径，host 不带桶前缀（MinIO 等自建网关）。
        let mut cfg5 = config();
        cfg5.addressing = "path".into();
        let c5 = S3Client::new(cfg5).unwrap();
        assert_eq!(
            c5.url("mosh-sync/dev1/dump.bin"),
            "https://cos.ap-guangzhou.myqcloud.com/mosh-test/mosh-sync/dev1/dump.bin"
        );
    }

    /// SigV4 快照：固定输入 → 固定签名。期望值由独立 Python 实现交叉验证产生，
    /// 签名逻辑任何改动都会在此显形。path-style 桶名进 canonical path。
    #[test]
    fn sigv4_signature_snapshot() {
        let auth = authorization(
            "secret",
            "AKID",
            "20260818",
            "20260818T120000Z",
            "ap-guangzhou",
            "PUT",
            "https://b.cos.ap-guangzhou.myqcloud.com/mosh-sync/dev1/dump.bin",
            &[("host", "b.cos.ap-guangzhou.myqcloud.com")],
            b"hello",
        );
        assert!(auth.starts_with("AWS4-HMAC-SHA256 Credential=AKID/20260818/ap-guangzhou/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature="));
        let sig = auth.rsplit("Signature=").next().unwrap();
        assert_eq!(sig.len(), 64);
        assert_eq!(
            sig,
            "586faf8b483e5bb6be2cd1ef4fcd180ec9f6ef0efacad587412980905b51575f"
        );

        // path-style：桶名进路径、host 无桶前缀（MinIO 等自建网关）。
        let auth_path = authorization(
            "secret",
            "AKID",
            "20260818",
            "20260818T120000Z",
            "ap-guangzhou",
            "PUT",
            "https://cos.ap-guangzhou.myqcloud.com/mosh-test/mosh-sync/dev1/dump.bin",
            &[("host", "cos.ap-guangzhou.myqcloud.com")],
            b"hello",
        );
        let sig_path = auth_path.rsplit("Signature=").next().unwrap();
        assert_eq!(
            sig_path,
            "0e654d51be537be3e072626559b32d4569d7600d5c519e62fd39670035d9c619"
        );
    }

    #[test]
    fn split_url_paths_and_query() {
        assert_eq!(
            split_url("https://h.example.com/a/b?list-type=2&prefix=x"),
            ("/a/b", "list-type=2&prefix=x")
        );
        assert_eq!(split_url("https://h.example.com/"), ("/", ""));
        assert_eq!(split_url("https://h.example.com"), ("/", ""));
    }

    #[test]
    fn list_xml_parsing() {
        let xml = br#"<?xml version="1.0"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <IsTruncated>false</IsTruncated>
  <NextContinuationToken></NextContinuationToken>
  <Contents>
    <Key>mosh-sync/dev1/dump.bin</Key>
    <LastModified>2026-08-18T12:00:00.000Z</LastModified>
    <ETag>&quot;abc123&quot;</ETag>
  </Contents>
  <Contents>
    <Key>mosh-sync/dev2/dump.bin</Key>
    <LastModified>2026-08-18T13:00:00.000Z</LastModified>
    <ETag>&quot;def456&quot;</ETag>
  </Contents>
</ListBucketResult>"#;
        let (objects, next) = parse_list_result(xml).unwrap();
        assert_eq!(objects.len(), 2);
        assert_eq!(objects[0].key, "mosh-sync/dev1/dump.bin");
        assert_eq!(objects[1].etag, "&quot;def456&quot;");
        assert!(next.is_none()); // 空的 NextContinuationToken 视为无分页
    }

    #[test]
    fn urlencode_encodes_reserved() {
        assert_eq!(urlencode("a/b c"), "a%2Fb%20c");
        assert_eq!(urlencode("mosh-sync"), "mosh-sync");
    }
}
