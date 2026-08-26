/**
 * 响应式「今日」date-only（hook）。
 *
 * 历史 BUG：各视图在模块顶层 `const today = todayOnly()` 固化了应用启动那天的
 * 日期；应用为托盘常驻进程，跨午夜后「今天」高亮、今日过滤、日期文案全部停留
 * 在昨天（日历月视图定位到前一天即此因）。
 *
 * 修复：本 hook 持有今日 date-only 状态，对齐分钟边界轮询，并在窗口重新可见/
 * 聚焦（托盘唤起、休眠唤醒）时立即校准；跨天即返回新值。setState 同值时 React
 * 直接跳过重渲染，分钟级轮询无实际渲染开销。
 */

import { useEffect, useState } from "react";
import { todayOnly } from "./calendar-grid";

export function useToday(): string {
  const [today, setToday] = useState<string>(todayOnly);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const cur = todayOnly();
      setToday((prev) => (prev === cur ? prev : cur));
      // 对齐下一个分钟边界（跨天最迟一分钟内生效）。
      timer = setTimeout(check, 60_000 - (Date.now() % 60_000) + 50);
    };
    check();
    // 定时器在窗口隐藏/系统休眠时可能被节流滞后：重新可见或聚焦时立即校准。
    const recalibrate = () => check();
    document.addEventListener("visibilitychange", recalibrate);
    window.addEventListener("focus", recalibrate);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", recalibrate);
      window.removeEventListener("focus", recalibrate);
    };
  }, []);

  return today;
}
