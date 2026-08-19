/**
 * 事件提醒 + 待办到期提醒（zustand；原 reminder.svelte.ts 迁移）。
 *
 * 每 60s 轮询，到点按通知设置（设置 → 通知）分发：
 *  - 系统通知：OS 通知中心（tauri-plugin-notification；默认开）；
 *  - 邮件通知：后端 SMTP 直发（开启前需先在设置页配置并保存）。
 *
 *  - 事件：未来 15 天窗口，展开周期后提醒时刻已到（事件尚未开始）；
 *  - 待办：active 且有截止时间的，到达截止时间后 60 分钟内提醒一次。
 *
 * 已触发的提醒用模块级 _fired 去重（进程内记忆，不落库）；
 * 错过窗口（关机/未运行）不补发。
 */

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { addDays, expandRecurring, reminderMinutesOf, todayOnly } from "../lib/calendar-grid";
import { formatDateTime } from "../lib/datetime";
import { listEvents, listRecords, notifySendEmail } from "../lib/ipc";
import type { RecordData as RecordT } from "../lib/types";
import { channelsOf, useNotifyStore } from "./notify";

/** 待办到期后仍提醒的窗口（错过不补发）。 */
const TODO_DUE_WINDOW_MS = 60 * 60_000;

const _fired = new Set<string>();
let _started = false;

function keyOf(e: RecordT): string {
  return `${e.id}::${e.start_at ?? ""}`;
}

/** 权限探测结果缓存：null=未探测。 */
let _notifyGranted: boolean | null = null;

/** 确保通知权限（首次调用时探测/请求；结果缓存）。 */
async function ensureNotifyPermission(): Promise<boolean> {
  if (_notifyGranted !== null) return _notifyGranted;
  try {
    _notifyGranted =
      (await isPermissionGranted()) ||
      ((await requestPermission()) === "granted");
  } catch {
    _notifyGranted = false; // 非 Tauri 环境或插件缺失
  }
  return _notifyGranted;
}

/** 发系统通知（任何失败静默）。 */
async function notifySystem(title: string, body: string): Promise<void> {
  if (!(await ensureNotifyPermission())) return;
  try {
    sendNotification({ title, body });
  } catch {
    /* 部分平台通知守护未运行等；忽略 */
  }
}

/** 发邮件通知（SMTP 在后端；失败仅控制台留痕，不打断轮询）。 */
async function notifyEmail(title: string, body: string): Promise<void> {
  try {
    await notifySendEmail(title, body);
  } catch (e) {
    console.warn(`[reminder] 邮件通知发送失败：${e instanceof Error ? e.message : e}`);
  }
}

/** 按设置分发一条提醒（两个通道各自静默失败，互不阻塞）。 */
function dispatch(title: string, body: string): void {
  const ch = channelsOf();
  if (ch.system) void notifySystem(title, body);
  if (ch.email) void notifyEmail(`MOSH ${title}`, body);
}

/** 轮询一次：事件提醒时刻到 + 待办到期 → 按设置分发（系统/邮件）。 */
async function poll(): Promise<void> {
  const now = Date.now();

  // —— 事件：提醒时刻已到（start - reminder_minutes ≤ now < start）——
  const from = todayOnly();
  const to = addDays(from, 15);
  let list: RecordT[];
  try {
    list = await listEvents(from, to);
  } catch {
    return; // 非 Tauri 环境忽略
  }
  for (const ev of expandRecurring(list, from, to)) {
    if (ev.status !== "active" || !ev.start_at) continue;
    const minutes = reminderMinutesOf(ev);
    if (minutes <= 0) continue;
    const start = new Date(ev.start_at).getTime();
    if (Number.isNaN(start)) continue;
    const at = start - minutes * 60_000;
    const key = keyOf(ev);
    if (now >= at && now < start && !_fired.has(key)) {
      _fired.add(key);
      dispatch("日程提醒", `「${ev.title}」将于 ${formatDateTime(ev.start_at)} 开始`);
    }
  }

  // —— 待办：到达截止时间（due ≤ now < due + 60min；active 均提醒）——
  try {
    const todos = await listRecords({ kind: "todo", status: "active" });
    for (const t of todos) {
      if (!t.end_at) continue;
      const due = new Date(t.end_at).getTime();
      if (Number.isNaN(due)) continue;
      const key = `todo::${t.id}::${t.end_at}`;
      if (now >= due && now < due + TODO_DUE_WINDOW_MS && !_fired.has(key)) {
        _fired.add(key);
        dispatch("待办提醒", `「${t.title}」已到截止时间（${formatDateTime(t.end_at)}）`);
      }
    }
  } catch {
    /* 待办拉取失败忽略（事件提醒已处理） */
  }
}

/** 启动提醒轮询（幂等）。App 根挂载后调用一次。 */
export function startReminders(): void {
  if (_started) return;
  _started = true;
  // 提前探测/请求系统通知权限（macOS 需要用户授权；Windows/Linux 通常默认允许）。
  void ensureNotifyPermission();
  // 每次轮询先刷新通知设置（设置页开关后 ≤60s 内生效）。
  const pollWithSettings = async () => {
    await useNotifyStore.getState().load();
    await poll();
  };
  void pollWithSettings();
  setInterval(() => void pollWithSettings(), 60_000);
}
