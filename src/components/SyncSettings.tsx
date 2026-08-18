/**
 * 同步设置分区（设置页「同步」卡）：
 * 远端配置表单 + 启用开关 + 密钥生成/导出/导入 + 立即同步 + 状态展示。
 *
 * 设计要点（docs/sync-design.md）：
 * - COS 凭证与加密密钥为设备本地（`sync.*` settings 键），永不上云；
 * - 云端只见密文；密钥丢失 = 云端数据不可解（导出串请存密码管理器）；
 * - 同步触发为事件驱动（启动拉/变更防抖推/手动），无轮询。
 */

import { useEffect, useState, type InputHTMLAttributes } from "react";
import type { ReactNode, SelectHTMLAttributes } from "react";
import { syncTestConnection } from "../lib/ipc";
import { useSyncStore } from "../state/sync";
import styles from "./SettingsView.module.css";

/** 表单字段：标签在上的受控输入。 */
function Field({
  label,
  hint,
  ...inputProps
}: {
  label: string;
  hint?: string;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={styles["sync-field"]}>
      <span className={styles["sync-field-label"]}>
        {label}
        {hint ? <em className={styles["sync-field-hint"]}>{hint}</em> : null}
      </span>
      <input className={styles["sync-field-input"]} spellCheck={false} {...inputProps} />
    </label>
  );
}

/** 下拉选择字段（同 Field 布局）。 */
function SelectField({
  label,
  hint,
  children,
  ...selectProps
}: {
  label: string;
  hint?: string;
  children: ReactNode;
} & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <label className={styles["sync-field"]}>
      <span className={styles["sync-field-label"]}>
        {label}
        {hint ? <em className={styles["sync-field-hint"]}>{hint}</em> : null}
      </span>
      <select className={styles["sync-field-input"]} {...selectProps}>
        {children}
      </select>
    </label>
  );
}

/** 勾选字段（同 Field 布局，控件为 checkbox）。 */
function CheckField({
  label,
  hint,
  checked,
  ...rest
}: {
  label: string;
  hint?: string;
  checked: boolean;
} & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={styles["sync-field"]}>
      <span className={styles["sync-field-label"]}>
        {label}
        {hint ? <em className={styles["sync-field-hint"]}>{hint}</em> : null}
      </span>
      <span className={styles["sync-check"]}>
        <input type="checkbox" checked={checked} {...rest} />
      </span>
    </label>
  );
}

export default function SyncSettings() {
  const config = useSyncStore((s) => s.config);
  const ui = useSyncStore((s) => s.ui);
  const generatedKey = useSyncStore((s) => s.generatedKey);
  const busy = useSyncStore((s) => s.busy);
  const message = useSyncStore((s) => s.message);
  const error = useSyncStore((s) => s.error);
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
  /** 高级：寻址风格 / 超时（秒）/ TLS 校验。 */
  const [addressing, setAddressing] = useState("virtual");
  const [timeout, setTimeout] = useState("30");
  const [tlsVerify, setTlsVerify] = useState(true);
  const [keyInput, setKeyInput] = useState("");
  const [showKeyInput, setShowKeyInput] = useState(false);
  /** 测试连接进行中。 */
  const [testing, setTesting] = useState(false);
  /** 表单已从 config 初始化一次。 */
  const [formInit, setFormInit] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  // config 载入后回填表单（一次）。
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
        endpoint,
        region,
        bucket,
        access_key: accessKey,
        secret_key: secretKey || null, // 空 = 保留原值
        addressing,
        timeout_secs: parsedTimeout,
        tls_verify: tlsVerify,
      });
      setSecretKey("");
    } catch {
      /* 错误已在 store，卡片内展示 */
    }
  };

  const onExport = async () => {
    try {
      const key = await exportKey();
      await navigator.clipboard.writeText(key);
      useSyncStore.setState({ message: "密钥已复制到剪贴板——请粘贴到密码管理器妥善保存。" });
    } catch (e) {
      useSyncStore.setState({ error: String(e) });
    }
  };

  const onTest = async () => {
    setTesting(true);
    useSyncStore.getState().clearFeedback();
    try {
      const n = await syncTestConnection({
        endpoint,
        region,
        bucket,
        access_key: accessKey,
        secret_key: secretKey || null,
        addressing,
        timeout_secs: parsedTimeout,
        tls_verify: tlsVerify,
      });
      useSyncStore.setState({
        message:
          n > 0
            ? `连接成功——桶内已有 ${n} 个同步对象。`
            : "连接成功——桶为空（首次同步后会创建备份）。",
      });
    } catch (e) {
      useSyncStore.setState({ error: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const onImport = async () => {
    try {
      await importKey(keyInput.trim());
      setKeyInput("");
      setShowKeyInput(false);
    } catch {
      /* store 已展示 */
    }
  };

  const lastSuccess =
    ui.last_success_at ??
    config?.last_sync_at ??
    null;
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

        <div className={styles.sgroup}>
          <div className={styles.stitle}>远端配置</div>
          <div className={styles.sdivider} />

          <div className={styles["sync-form"]}>
            <Field
              label="Endpoint"
              hint="S3 兼容服务端点，如 cos.ap-guangzhou.myqcloud.com（不含 bucket 名与 https://）"
              value={endpoint}
              onChange={(e) => setEndpoint(e.currentTarget.value)}
              placeholder="cos.ap-guangzhou.myqcloud.com"
            />

            <div className={styles["sync-grid2"]}>
              <Field
                label="Region"
                hint="地域 ID，如 ap-guangzhou"
                value={region}
                onChange={(e) => setRegion(e.currentTarget.value)}
                placeholder="ap-guangzhou"
              />
              <Field
                label="Bucket"
                hint="存储桶名称（建议私有读写）"
                value={bucket}
                onChange={(e) => setBucket(e.currentTarget.value)}
                placeholder="mosh-sync"
              />
            </div>

            <div className={styles["sync-grid2"]}>
              <Field
                label="SecretId"
                hint="对象存储访问密钥 ID"
                value={accessKey}
                onChange={(e) => setAccessKey(e.currentTarget.value)}
              />
              <Field
                label="SecretKey"
                hint={config?.has_secret ? "已保存；留空则保持不变" : "对象存储访问密钥"}
                type="password"
                value={secretKey}
                onChange={(e) => setSecretKey(e.currentTarget.value)}
                placeholder={config?.has_secret ? "••••••••••••" : ""}
              />
            </div>

            <div className={styles["sync-grid3"]}>
              <SelectField
                label="寻址方式"
                hint="桶名的位置"
                value={addressing}
                onChange={(e) => setAddressing(e.currentTarget.value)}
              >
                <option value="virtual">虚拟主机式（bucket.endpoint）</option>
                <option value="path">路径式（endpoint/bucket）</option>
              </SelectField>
              <Field
                label="超时（秒）"
                hint="5–600"
                type="number"
                min={5}
                max={600}
                value={timeout}
                onChange={(e) => setTimeout(e.currentTarget.value)}
              />
              <CheckField
                label="TLS 证书校验"
                hint="自签代理可关"
                checked={tlsVerify}
                onChange={(e) => setTlsVerify(e.currentTarget.checked)}
              />
            </div>

            <div className={styles["sync-form-actions"]}>
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
          </div>
          <div className={styles.sdivider} />
        </div>

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

        <div className={styles.sgroup}>
          <div className={styles.stitle}>同步开关</div>
          <div className={styles.sdivider} />
          <div className={styles["srow"]}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>启用同步</span>
              <span className={styles["srow-hint"]}>
                启动时自动拉取；本地变更 5 秒后自动推送；退出时兜底推送。空闲时零网络请求。
              </span>
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
            <div className={styles["srow"]}>
              <div className={styles["srow-label"]}>
                <span className={styles["srow-name"]}>手动同步</span>
                <span className={styles["srow-hint"]}>{lastSuccessText}</span>
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
            <div className={`${styles.preview} ${styles.dim}`}>
              填写并保存远端配置后即可启用同步。
            </div>
          )}
          <div className={styles.sdivider} />
        </div>

        <div className={styles.sgroup}>
          <div className={styles.stitle}>加密密钥</div>
          <div className={styles.sdivider} />
          <div className={styles["srow"]}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>导出 / 导入</span>
              <span className={styles["srow-hint"]}>
                新设备在此粘贴任意一台旧设备导出的密钥串；所有设备必须使用同一密钥。
              </span>
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
            <div className={styles["sync-form"]}>
              <Field
                label="粘贴密钥"
                hint="44 位 base64 字符串（来自旧设备的「复制密钥」）"
                value={keyInput}
                onChange={(e) => setKeyInput(e.currentTarget.value)}
                placeholder="如：dGhpc0lzTXlMb25nU2VjcmV0S2V5Rm9yU3luYw=="
                onKeyDown={(e) => {
                  if (e.key === "Enter" && keyInput.trim() && !busy) void onImport();
                }}
              />
              <div className={styles["sync-form-actions"]}>
                <button
                  type="button"
                  className={styles["sync-btn"]}
                  disabled={busy || !keyInput.trim()}
                  onClick={() => void onImport()}
                >
                  导入
                </button>
              </div>
            </div>
          ) : null}
          <div className={styles.sdivider} />
        </div>

        {ui.phase === "error" && ui.error ? (
          <div className={`${styles.preview} ${styles.error}`}>
            <span className={styles["pv-text"]}>同步失败：{ui.error}</span>
          </div>
        ) : null}
        {message ? <div className={`${styles.preview}`}>{message}</div> : null}
        {error && !ui.error ? (
          <div className={`${styles.preview} ${styles.error}`}>
            <span className={styles["pv-text"]}>{error}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
