/**
 * Markdown 渲染管线（任务 08-15-chat-markdown）。
 *
 * 模型输出属于不可信内容：所有经 `{@html}` 输出的 HTML 必须先过
 * DOMPurify。流式期间对未闭合 fenced code block 做临时补全（思路源自
 * lobe-ui `fenceState.ts`，自研实现），使半成品代码块即以代码块渲染；
 * 补全仅作用于 parse 输入，不回写消息文本。
 */

import DOMPurify from "dompurify";
import { marked } from "marked";

// breaks: 单换行 → <br>，贴近此前纯文本 + pre-wrap 的观感。
marked.setOptions({ gfm: true, breaks: true });

/** 检测最后一个未闭合的 ``` fence（true=存在奇数个 fence）。 */
function hasOpenFence(md: string): boolean {
  let open = false;
  for (const line of md.split("\n")) {
    if (line.trimStart().startsWith("```")) open = !open;
  }
  return open;
}

/** 流式输入修补：补一个临时闭合 fence，避免裸 ``` 闪现/布局抖动。 */
export function closeOpenFences(md: string): string {
  return hasOpenFence(md) ? `${md}\n\`\`\`` : md;
}

/** markdown → 消毒后 HTML。streaming=true 时先做 fence 补全。 */
export function renderMarkdown(md: string, streaming = false): string {
  const src = streaming ? closeOpenFences(md) : md;
  const html = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html);
}
