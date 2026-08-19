/**
 * 同步设置分区（设置页「同步」卡）：
 * 远端配置（全量 srow 行布局）+ 启用开关 + 密钥生成/导出/导入 + 立即同步 + 状态展示。
 *
 * 设计要点（docs/sync-design.md）：
 * - COS 凭证与加密密钥为设备本地（`sync.*` settings 键），永不上云；
 * - 云端只见密文；密钥丢失 = 云端数据不可解（导出串请存密码管理器）；
 * - 同步触发为事件驱动（启动拉/变更防抖推/手动），无轮询；
 * - 操作反馈统一走全局 toast（state/toast），卡内只留持久状态展示。
 */

import { useEffect, useState } from "react";
import { syncTestConnection } from "../lib/ipc";
import { useSyncStore } from "../state/sync";
import { toast } from "../state/toast";
import SecretInput from "./SecretInput";
import styles from "./SettingsView.module.css";

export default function SyncSettings() {
  const config = useSyncStore((s) => s.config);
  const ui = useSyncStore((s) => s.ui);
  const generatedKey = useSyncStore((s) => s.generatedKey);
  const busy = useSyncStore((s) => s.busy);
  const init = useSyncStore((s) => s.init);
  const saveConfig = useSyncStore((s) => s.saveConfig);
  const setEnabled = useSyncStore((s) => s.setEnabled);
  const importKey = useSyncStore((s) => s.importKey);
  const exportKey = useSyncStore((s) => s.exportKey);
  const syncNow = useSyncStore((s) => s.syncNow);
  const clearGeneratedKey = useSyncStore((s) => s.clearGeneratedKey);

  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("");
  const [bucket, setBucket] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [addressing, setAddressing] = useState("virtual");
  const [timeout, setTimeout] = useState("30");
  const [tlsVerify, setTlsVerify] = useState(true);
  const [keyInput, setKeyInput] = useState("");
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [testing, setTesting] = useState(false);
  const [formInit, setFormInit] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    if (config && !formInit) {
      setEndpoint(config.endpoint);
      setRegion(config.region);
      setBucket(config.bucket);
      setAccessKey(config.access_key);
      setAddressing(config.addressing || "virtual");
      setTimeout(String(config.timeout_secs || 30));
      setTlsVerify(config.tls_verify !== false);
      setFormInit(true);
    }
  }, [config, formInit]);

  const parsedTimeout = Math.min(600, Math.max(5, parseInt(timeout, 10) || 30));
  const configured = !!config && config.has_secret && !!config.endpoint;
  const canSave =
    !busy && endpoint.trim() && bucket.trim() && accessKey.trim() && (secretKey.trim() || config?.has_secret);

  const onSave = async () => {
    try {
      await saveConfig({
        endpoint, region, bucket, access_key: accessKey,
        secret_key: secretKey || null, addressing,
        timeout_secs: parsedTimeout, tls_verify: tlsVerify,
      });
      setSecretKey("");
    } catch { /* store 已 toast */ }
  };

  const onExport = async () => {
    try {
      const key = await exportKey();
      await navigator.clipboard.writeText(key);
      toast.success("密钥已复制到剪贴板——请粘贴到密码管理器妥善保存。");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const onTest = async () => {
    setTesting(true);
    try {
      const n = await syncTestConnection({
        endpoint, region, bucket, access_key: accessKey,
        secret_key: secretKey || null, addressing,
        timeout_secs: parsedTimeout, tls_verify: tlsVerify,
      });
      toast.success(
        n > 0
          ? `连接成功——桶内已有 ${n} 个同步对象。`
          : "连接成功——桶为空（首次同步后会创建备份）。",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const onImport = async () => {
    try {
      await importKey(keyInput.trim());
      setKeyInput("");
      setShowKeyInput(false);
    } catch { /* store 已 toast */ }
  };

  const lastSuccess = ui.last_success_at ?? config?.last_sync_at ?? null;
  const lastSuccessText = lastSuccess
    ? `上次成功同步：${lastSuccess.replace("T", " ").slice(0, 19)}`
    : "尚未同步过";

  return (
    <div className={styles["content-scroll"]}>
      <div className={styles["content-body"]}>
        <div className={styles["content-header"]}>
          <div className={styles["content-title"]}>多设备同步</div>
          <div className={styles["content-desc"]}>
            通过 S3 兼容对象存储在多台设备间同步全部数据（待办、日程、设置、AI 会话）。
            数据经端到端加密后上传——云端只见密文，服务商无法读取。
          </div>
        </div>

        {/* ====== 远端配置 ====== */}
        <div className={styles.sgroup}>
          <div className={styles.stitle}>远端配置</div>
          <div className={styles.sdivider} />

          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>Endpoint</span>
              <span className={styles["srow-hint"]}>S3 兼容服务端点，如 cos.ap-guangzhou.myqcloud.com（不含 bucket 名与 https://）</span>
            </div>
            <input
              className={styles["srow-input"]}
              spellCheck={false}
              value={endpoint}
              onChange={(e) => setEndpoint(e.currentTarget.value)}
              placeholder="cos.ap-guangzhou.myqcloud.com"
            />
          </div>
          <div className={styles.sdivider} />

          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>Region</span>
              <span className={styles["srow-hint"]}>地域 ID，如 ap-guangzhou</span>
            </div>
            <input
              className={styles["srow-input"]}
              spellCheck={false}
              value={region}
              onChange={(e) => setRegion(e.currentTarget.value)}
              placeholder="ap-guangzhou"
            />
          </div>
          <div className={styles.sdivider} />

          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>Bucket</span>
              <span className={styles["srow-hint"]}>存储桶名称（腾讯云 COS 需带 APPID 后缀，如 mosh-sync-1250000000；建议私有读写）</span>
            </div>
            <input
              className={styles["srow-input"]}
              spellCheck={false}
              value={bucket}
              onChange={(e) => setBucket(e.currentTarget.value)}
              placeholder="mosh-sync"
            />
          </div>
          <div className={styles.sdivider} />

          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>SecretId</span>
              <span className={styles["srow-hint"]}>对象存储访问密钥 ID</span>
            </div>
            <input
              className={styles["srow-input"]}
              spellCheck={false}
              value={accessKey}
              onChange={(e) => setAccessKey(e.currentTarget.value)}
            />
          </div>
          <div className={styles.sdivider} />

          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>SecretKey</span>
              <span className={styles["srow-hint"]}>{config?.has_secret ? "已保存；留空则保持不变" : "对象存储访问密钥"}</span>
            </div>
            <SecretInput
              inputClassName={styles["srow-input"]}
              value={secretKey}
              onChange={(e) => setSecretKey(e.currentTarget.value)}
              placeholder={config?.has_secret ? "••••••••••••" : ""}
            />
          </div>
          <div className={styles.sdivider} />

          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>寻址方式</span>
              <span className={styles["srow-hint"]}>桶名在域名（默认）还是路径（endpoint/bucket，MinIO 等自建网关）</span>
            </div>
            <select
              className={styles["srow-select"]}
              value={addressing}
              onChange={(e) => setAddressing(e.currentTarget.value)}
            >
              <option value="virtual">虚拟主机式</option>
              <option value="path">路径式</option>
            </select>
          </div>
          <div className={styles.sdivider} />

          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>超时（秒）</span>
              <span className={styles["srow-hint"]}>单请求超时（5–600）；网络差可调大</span>
            </div>
            <input
              className={styles["srow-input"]}
              type="number"
              min={5}
              max={600}
              value={timeout}
              onChange={(e) => setTimeout(e.currentTarget.value)}
            />
          </div>
          <div className={styles.sdivider} />

          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>TLS 证书校验</span>
              <span className={styles["srow-hint"]}>校验服务端 HTTPS 证书；仅自签代理等特殊场景可关闭</span>
            </div>
            <button
              type="button"
              className={`${styles["sync-toggle"]}${tlsVerify ? ` ${styles.on}` : ""}`}
              onClick={() => setTlsVerify(!tlsVerify)}
              aria-pressed={tlsVerify}
              aria-label="TLS 证书校验"
            >
              <span className={styles["sync-toggle-knob"]} />
            </button>
          </div>
          <div className={styles.sdivider} />

          <div className={styles["sync-actions"]}>
            <button
              type="button"
              className={styles["sync-btn"]}
              disabled={testing || !endpoint.trim() || !bucket.trim() || !accessKey.trim()}
              onClick={() => void onTest()}
            >
              {testing ? "测试中…" : "测试连接"}
            </button>
            <button
              type="button"
              className={styles["sync-btn"]}
              disabled={!canSave}
              onClick={() => void onSave()}
            >
              {busy ? "保存中…" : "保存配置"}
            </button>
          </div>
          <div className={styles.sdivider} />
        </div>

        {/* ====== 新加密密钥（仅此一次展示）====== */}
        {generatedKey ? (
          <div className={styles.sgroup}>
            <div className={styles.stitle}>新加密密钥（仅此一次展示）</div>
            <div className={styles.sdivider} />
            <div className={styles["sync-keybox"]}>
              <code className={styles["sync-key"]}>{generatedKey}</code>
              <div className={styles["sync-key-actions"]}>
                <button
                  type="button"
                  className={styles["sync-btn"]}
                  onClick={() => void navigator.clipboard.writeText(generatedKey)}
                >
                  复制
                </button>
                <button type="button" className={styles["sync-btn"]} onClick={clearGeneratedKey}>
                  我已抄录，关闭
                </button>
              </div>
            </div>
            <div className={styles["sync-keynote"]}>
              请将此密钥粘贴到密码管理器或抄录到纸上，并在其他设备「导入密钥」时使用。
              密钥丢失后云端数据将无法解密（本机数据不受影响）。
            </div>
            <div className={styles.sdivider} />
          </div>
        ) : null}

        {/* ====== 同步开关 ====== */}
        <div className={styles.sgroup}>
          <div className={styles.stitle}>同步开关</div>
          <div className={styles.sdivider} />
          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>启用同步</span>
              <span className={styles["srow-hint"]}>启动时自动拉取；本地变更 5 秒后自动推送；退出时兜底推送。空闲时零网络请求。</span>
            </div>
            <button
              type="button"
              className={`${styles["sync-toggle"]}${config?.enabled ? ` ${styles.on}` : ""}`}
              disabled={!configured || busy}
              onClick={() => void setEnabled(!config?.enabled)}
              aria-pressed={!!config?.enabled}
            >
              <span className={styles["sync-toggle-knob"]} />
            </button>
          </div>
          {configured ? (
            <div className={styles.srow}>
              <div className={styles["srow-label"]}>
                <span className={styles["srow-name"]}>手动同步</span>
                {ui.phase === "error" && ui.error ? (
                  <span className={`${styles["srow-hint"]} ${styles["sync-err-hint"]}`}>上次同步失败：{ui.error}</span>
                ) : (
                  <span className={styles["srow-hint"]}>{lastSuccessText}</span>
                )}
              </div>
              <button
                type="button"
                className={styles["sync-btn"]}
                disabled={!config?.enabled || busy || ui.phase === "syncing"}
                onClick={() => void syncNow()}
              >
                {ui.phase === "syncing" ? "同步中…" : "立即同步"}
              </button>
            </div>
          ) : (
            <div className={`${styles.preview} ${styles.dim}`}>填写并保存远端配置后即可启用同步。</div>
          )}
          <div className={styles.sdivider} />
        </div>

        {/* ====== 加密密钥 ====== */}
        <div className={styles.sgroup}>
          <div className={styles.stitle}>加密密钥</div>
          <div className={styles.sdivider} />
          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>导出 / 导入</span>
              <span className={styles["srow-hint"]}>新设备在此粘贴任意一台旧设备导出的密钥串；所有设备必须使用同一密钥。</span>
            </div>
            <div className={styles["sync-key-actions"]}>
              <button
                type="button"
                className={styles["sync-btn"]}
                disabled={!config?.has_key || busy}
                onClick={() => void onExport()}
              >
                复制密钥
              </button>
              <button
                type="button"
                className={styles["sync-btn"]}
                onClick={() => setShowKeyInput((v) => !v)}
              >
                {showKeyInput ? "取消" : "导入密钥"}
              </button>
            </div>
          </div>
          {showKeyInput ? (
            <>
              <div className={styles.sdivider} />
              <div className={styles.srow}>
                <div className={styles["srow-label"]}>
                  <span className={styles["srow-name"]}>粘贴密钥</span>
                  <span className={styles["srow-hint"]}>44 位 base64 字符串（来自旧设备的「复制密钥」）</span>
                </div>
                <input
                  className={styles["srow-input"]}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.currentTarget.value)}
                  placeholder="如：dGhpc0lzTXlMb25nU2VjcmV0S2V5Rm9yU3luYw=="
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && keyInput.trim() && !busy) void onImport();
                  }}
                />
              </div>
              <div className={styles["sync-actions"]}>
                <button
                  type="button"
                  className={styles["sync-btn"]}
                  disabled={busy || !keyInput.trim()}
                  onClick={() => void onImport()}
                >
                  导入
                </button>
              </div>
            </>
          ) : null}
          <div className={styles.sdivider} />
        </div>
      </div>
    </div>
  );
}
