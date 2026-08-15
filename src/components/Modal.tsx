import { useEffect, type ReactNode } from "react";
import styles from "./Modal.module.css";

/**
 * 通用模态弹窗：半透明遮罩 + 居中卡片。
 * 关闭途径：按 ESC / 点遮罩空白处（卡片内冒泡不关）。
 * 卡片限宽限高且为纵向 flex：内容给 flex:1 + overflow-y:auto 即可自滚动。
 */

export default function Modal({
  onClose,
  width = "540px",
  children,
}: {
  onClose: () => void;
  width?: string;
  children?: ReactNode;
}) {
  useEffect(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [onClose]);

  const onOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className={styles.overlay} onClick={onOverlayClick} role="presentation">
      <div className={styles.card} role="dialog" aria-modal="true" style={{ width }}>
        {children}
      </div>
    </div>
  );
}
