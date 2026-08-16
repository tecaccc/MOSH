import { useEffect, useRef, useState } from "react";
import Modal from "./Modal";
import { useDialogStore, type PromptOptions } from "../state/dialog";
import styles from "./DialogHost.module.css";

/**
 * 全局对话框宿主：挂在 App 根部，消费 dialog store 的当前请求。
 * 两种形态：confirm（标题+正文+按钮组）/ prompt（再加输入框）。
 * 交互：Enter 确认（prompt 非空）、Esc/遮罩取消、自动聚焦（prompt 聚输入框）。
 * danger=true 时图标与确认按钮为红色删除风格。
 */

/** 圆形底色图标（danger 红叉 / 常规 accent 问号）。 */
function HeadIcon({ danger }: { danger: boolean }) {
  if (danger) {
    return (
      <span className={`${styles.icon} ${styles.danger}`}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M5 5l14 14M19 5L5 19" />
        </svg>
      </span>
    );
  }
  return (
    <span className={styles.icon}>
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 9.3a2.6 2.6 0 0 1 5.1.6c0 1.7-2.6 2.2-2.6 3.6" />
        <path d="M12 17h.01" />
      </svg>
    </span>
  );
}

export default function DialogHost() {
  const request = useDialogStore((s) => s.request);
  const settle = useDialogStore((s) => s.settle);

  const promptReq = request?.kind === "prompt" ? (request.options as PromptOptions) : undefined;
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // 每次弹出重置输入并聚焦（prompt 聚输入框；confirm 聚确认按钮由 autofocus 完成）。
  useEffect(() => {
    if (!request) return;
    setValue(promptReq?.initialValue ?? "");
    if (promptReq) {
      // 等挂载完成再聚焦。
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  if (!request) return null;

  const { options } = request;
  const danger = options.danger === true;
  const confirmText = options.confirmText ?? "确定";
  const cancelText = options.cancelText ?? "取消";

  function onCancel() {
    settle(promptReq ? null : false);
  }
  function onConfirm() {
    if (promptReq && value.trim().length === 0) {
      inputRef.current?.focus();
      return;
    }
    settle(promptReq ? value.trim() : true);
  }
  function onInputKeydown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      onConfirm();
    }
  }

  return (
    <Modal onClose={onCancel} width="420px">
      <div className={styles.body}>
        <div className={styles.head}>
          <HeadIcon danger={danger} />
          <h3 className={styles.title}>{options.title}</h3>
        </div>
        {options.message ? (
          <p className={styles.message}>{options.message}</p>
        ) : null}
        {promptReq ? (
          <input
            ref={inputRef}
            className={styles.input}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onInputKeydown}
            placeholder={promptReq.placeholder ?? ""}
          />
        ) : null}
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onCancel}>
            {cancelText}
          </button>
          <button
            type="button"
            className={`${styles.confirm}${danger ? ` ${styles.danger}` : ""}`}
            onClick={onConfirm}
            autoFocus={!promptReq}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </Modal>
  );
}
