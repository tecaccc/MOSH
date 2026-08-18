import { useToastStore, type ToastItem } from "../state/toast";
import css from "./ToastHost.module.css";

/**
 * 全局 Toast 渲染层：消费 useToastStore，在 App 顶部 toast-layer 中向下弹出
 * 堆叠（success 绿 / error 红 / info 紫圆形图标 + 文案 + 可选操作按钮；
 * 到时自动消失，无手动关闭）。与 UpdaterToast 同层同风格；
 * 状态展示类信息不走此处。
 */

const GLYPH: Record<ToastItem["kind"], string> = {
  success: "✓",
  error: "!",
  info: "i",
};

function ToastCard({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <div
      className={`${css.card} ${css[item.kind]}`}
      role={item.kind === "error" ? "alert" : "status"}
    >
      <div className={css.row}>
        <span className={`${css.ico} ${css[item.kind]}`} aria-hidden="true">
          {GLYPH[item.kind]}
        </span>
        <span className={css.text}>{item.text}</span>
        {item.action ? (
          <button
            type="button"
            className={css.act}
            onClick={() => {
              item.action!.run();
              dismiss(item.id);
            }}
          >
            {item.action.label}
          </button>
        ) : null}
      </div>
      {item.detail ? <div className={css.detail}>{item.detail}</div> : null}
    </div>
  );
}

export default function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <>
      {toasts.map((t) => (
        <ToastCard key={t.id} item={t} />
      ))}
    </>
  );
}
