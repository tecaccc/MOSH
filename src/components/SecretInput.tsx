/**
 * 密钥输入框：password 态 + 右侧小眼睛切换明文查看。
 * 输入框样式由调用方通过 inputClassName 传入（各设置卡自有 input 类）。
 */

import { useState, type InputHTMLAttributes } from "react";
import css from "./SecretInput.module.css";

export default function SecretInput({
  inputClassName,
  ...rest
}: {
  /** 调用方样式类（如 sync-field-input / input）。 */
  inputClassName?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className">) {
  const [show, setShow] = useState(false);
  return (
    <span className={css.wrap}>
      <input
        className={inputClassName}
        type={show ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        {...rest}
      />
      <button
        type="button"
        className={css.eye}
        onClick={() => setShow((v) => !v)}
        aria-label={show ? "隐藏明文" : "显示明文"}
        title={show ? "隐藏明文" : "显示明文"}
      >
        {show ? (
          /* 眼睛加斜线 = 当前明文可见，点击隐藏 */
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.5 10.5 0 0 1 12 19.5c-5 0-9.3-3-11-7.5 1-2.6 3-4.8 5.6-6.1M1 1l22 22" />
            <path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c5 0 9.3 3 11 7.5a11.8 11.8 0 0 1-3.6 4.9" />
            <path d="M14.1 14.1a3 3 0 1 1-4.2-4.2" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-7.5 11-7.5S23 12 23 12s-4 7.5-11 7.5S1 12 1 12z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </span>
  );
}
