/**
 * 通知设置分区（设置页「通知」卡）：
 * 通知方式开关（系统通知 / 邮件通知）+ SMTP 邮件配置表单 + 测试邮件。
 *
 * 数据流：state/notify（zustand）持回显配置并落库（后端 settings 键
 * `notify_settings`）；授权码明文回显（本地单机凭据，小眼睛可查看），
 * 留空保存/测试 = 沿用已存值。
 * 提醒轮询（state/reminder）到点按这里保存的开关分发两个通道。
 */

import { useEffect, useState } from "react";
import { testEmail } from "../lib/ipc";
import { EMAIL_ENCRYPTIONS, type EmailEncryption } from "../lib/types";
import { useNotifyStore } from "../state/notify";
import { toast } from "../state/toast";
import SecretInput from "./SecretInput";
import styles from "./SettingsView.module.css";

export default function NotifySettings() {
  const config = useNotifyStore((s) => s.config);
  const busy = useNotifyStore((s) => s.busy);
  const load = useNotifyStore((s) => s.load);
  const save = useNotifyStore((s) => s.save);
  const setChannel = useNotifyStore((s) => s.setChannel);

  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [encryption, setEncryption] = useState<EmailEncryption>("starttls");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [formInit, setFormInit] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  // 回显载入后同步表单初值（仅一次；后续编辑不受 store 更新影响）。
  useEffect(() => {
    if (config && !formInit) {
      const e = config.email;
      setHost(e?.host ?? "");
      setPort(String(e?.port ?? 587));
      setEncryption((e?.encryption as EmailEncryption) ?? "starttls");
      setUsername(e?.username ?? "");
      setPassword(e?.password ?? "");
      setFrom(e?.from ?? "");
      setTo(e?.to ?? "");
      setFormInit(true);
    }
  }, [config, formInit]);

  const hasPassword = !!config?.email?.has_password;
  const parsedPort = Math.min(65535, Math.max(1, parseInt(port, 10) || 587));
  /** 表单完整性（未填 host 视为“未配置”，允许整体保存空壳）。 */
  const formComplete =
    host.trim() !== "" && from.trim() !== "" && to.trim() !== "" && username.trim() !== "";
  const canTest = formComplete && (password.trim() !== "" || hasPassword);

  /** 切加密方式时联动回填该方式缺省端口（仅当用户未改过/仍为旧缺省值时）。 */
  function onEncryptionChange(next: EmailEncryption) {
    const prevDefault = EMAIL_ENCRYPTIONS.find((e) => e.value === encryption)?.port ?? 587;
    if (parseInt(port, 10) === prevDefault || port.trim() === "") {
      setPort(String(EMAIL_ENCRYPTIONS.find((e) => e.value === next)?.port ?? 587));
    }
    setEncryption(next);
  }

  async function onSave() {
    const email =
      host.trim() === "" && !config?.email
        ? null // 从未配置且表单为空：不落邮件配置（空壳）。
        : { host, port: parsedPort, encryption, username, password, from, to };
    try {
      await save({ system: config?.system ?? true, email_enabled: config?.email_enabled ?? false, email });
      // 保存后 store 已拿到新回显;回填授权码,避免小眼睛再对空输入
      // (同同步设置 SecretKey BUG 的复发点)。
      setPassword(useNotifyStore.getState().config?.email?.password ?? "");
      toast.success("通知设置已保存");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function onToggleSystem(on: boolean) {
    try {
      await setChannel({ system: on });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function onToggleEmail(on: boolean) {
    if (on && !config?.email?.host) {
      toast.error("请先在下方填写邮件配置并保存，再开启邮件通知。");
      return;
    }
    try {
      await setChannel({ emailEnabled: on });
      toast.success(on ? "已开启邮件通知" : "已关闭邮件通知");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function onTest() {
    setTesting(true);
    try {
      await testEmail({
        host, port: parsedPort, encryption, username, password, from, to,
      });
      toast.success(`测试邮件已发送至「${to.trim()}」，请查收（部分邮箱可能落入垃圾箱）。`);
    } catch (e) {
      toast.error(`测试邮件发送失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className={styles["content-scroll"]}>
      <div className={styles["content-body"]}>
        <div className={styles["content-header"]}>
          <div className={styles["content-title"]}>通知</div>
          <div className={styles["content-desc"]}>
            日程提醒与待办到期的送达方式；系统通知与邮件通知可各自开关、也可同时开启。
          </div>
        </div>

        {/* ====== 通知方式 ====== */}
        <div className={styles.sgroup}>
          <div className={styles.stitle}>通知方式</div>
          <div className={styles.sdivider} />

          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>系统通知</span>
              <span className={styles["srow-hint"]}>
                经操作系统通知中心弹出（默认开启；macOS 首次需授权）。
              </span>
            </div>
            <button
              type="button"
              className={`${styles["sync-toggle"]}${config?.system ? ` ${styles.on}` : ""}`}
              disabled={busy}
              onClick={() => void onToggleSystem(!config?.system)}
              aria-pressed={config?.system ?? true}
              aria-label="系统通知"
            >
              <span className={styles["sync-toggle-knob"]} />
            </button>
          </div>
          <div className={styles.sdivider} />

          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>邮件通知</span>
              <span className={styles["srow-hint"]}>
                {config?.email?.host
                  ? `到点时经 ${config.email.host} 向「${config.email.to}」发送提醒邮件。`
                  : "需先在下方填写并保存邮件配置。"}
              </span>
            </div>
            <button
              type="button"
              className={`${styles["sync-toggle"]}${config?.email_enabled ? ` ${styles.on}` : ""}`}
              disabled={busy}
              onClick={() => void onToggleEmail(!config?.email_enabled)}
              aria-pressed={!!config?.email_enabled}
              aria-label="邮件通知"
            >
              <span className={styles["sync-toggle-knob"]} />
            </button>
          </div>
          <div className={styles.sdivider} />
        </div>

        {/* ====== 邮件配置（SMTP） ====== */}
        <div className={styles.sgroup}>
          <div className={styles.stitle}>邮件配置（SMTP）</div>
          <div className={styles.sdivider} />

          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>SMTP 服务器</span>
              <span className={styles["srow-hint"]}>
                如 smtp.qq.com / smtp.163.com / smtp.gmail.com
              </span>
            </div>
            <input
              className={styles["srow-input"]}
              spellCheck={false}
              value={host}
              onChange={(e) => setHost(e.currentTarget.value)}
              placeholder="smtp.qq.com"
            />
          </div>
          <div className={styles.sdivider} />

          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>加密方式</span>
              <span className={styles["srow-hint"]}>
                {EMAIL_ENCRYPTIONS.find((e) => e.value === encryption)?.desc}
              </span>
            </div>
            <select
              className={styles["srow-select"]}
              value={encryption}
              onChange={(e) => onEncryptionChange(e.currentTarget.value as EmailEncryption)}
            >
              {EMAIL_ENCRYPTIONS.map((e) => (
                <option key={e.value} value={e.value}>{e.label}</option>
              ))}
            </select>
          </div>
          <div className={styles.sdivider} />

          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>端口</span>
              <span className={styles["srow-hint"]}>切换加密方式时自动填入对应默认端口，可手动修改。</span>
            </div>
            <input
              className={styles["srow-input"]}
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.currentTarget.value)}
            />
          </div>
          <div className={styles.sdivider} />

          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>SMTP 用户名</span>
              <span className={styles["srow-hint"]}>多数服务商即发件邮箱本身。</span>
            </div>
            <input
              className={styles["srow-input"]}
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              placeholder="you@example.com"
            />
          </div>
          <div className={styles.sdivider} />

          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>密码 / 授权码</span>
              <span className={styles["srow-hint"]}>
                {hasPassword ? "已保存；小眼睛可查看，留空保存则保持不变" : "QQ/163 等需在邮箱设置中生成的 SMTP 授权码"}
              </span>
            </div>
            <SecretInput
              inputClassName={styles["srow-input"]}
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              placeholder={hasPassword ? "留空保持原授权码" : "授权码"}
            />
          </div>
          <div className={styles.sdivider} />

          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>发件邮箱</span>
              <span className={styles["srow-hint"]}>须为该 SMTP 账号邮箱，否则多数服务器拒发。</span>
            </div>
            <input
              className={styles["srow-input"]}
              spellCheck={false}
              value={from}
              onChange={(e) => setFrom(e.currentTarget.value)}
              placeholder="you@example.com"
            />
          </div>
          <div className={styles.sdivider} />

          <div className={styles.srow}>
            <div className={styles["srow-label"]}>
              <span className={styles["srow-name"]}>收件邮箱</span>
              <span className={styles["srow-hint"]}>提醒邮件的送达地址，可填常用邮箱。</span>
            </div>
            <input
              className={styles["srow-input"]}
              spellCheck={false}
              value={to}
              onChange={(e) => setTo(e.currentTarget.value)}
              placeholder="me@example.com"
            />
          </div>
          <div className={styles.sdivider} />

          <div className={styles["sync-actions"]}>
            <button
              type="button"
              className={styles["sync-btn"]}
              disabled={testing || !canTest}
              title={!canTest ? "先完整填写（授权码可用已保存值）" : undefined}
              onClick={() => void onTest()}
            >
              {testing ? "发送中…" : "发送测试邮件"}
            </button>
            <button
              type="button"
              className={styles["sync-btn"]}
              disabled={busy || (!formComplete && !!host.trim())}
              onClick={() => void onSave()}
            >
              {busy ? "保存中…" : "保存配置"}
            </button>
          </div>
          <div className={styles.sdivider} />
        </div>
      </div>
    </div>
  );
}
