# PRD: ChatPanel 助手消息 Markdown 渲染

## 背景

ChatPanel（`src/lib/components/ChatPanel.svelte`）当前将助手消息以纯文本插值渲染
（`{m.text}` + `white-space: pre-wrap`）。模型输出的 markdown（列表、表格、代码块、
加粗等）以原始符号显示，可读性差。

本任务为助手气泡引入 markdown 渲染。技术选型已经过完整调研并拍板：

- **不迁移 React**（MCP/Skills 均落在 Rust 后端，前端仅是渲染层；重写 8400 行不产生新功能）。
- **v1 采用 marked + dompurify**（成熟、可控）。markstream-svelte（0.0.7，2026-05 首发，
  月下载 ~1k）列入观察名单，将来若需要可经隔离层低成本替换。
- 流式期间**直接渲染 markdown**，配合 fence 补全（思路源自 lobe-ui `fenceState.ts`，
  自研实现），而非"流式退回纯文本"。

## 需求

### R1 渲染管线

- 新建 `src/lib/markdown.ts`：
  - `marked` 配置 `gfm: true, breaks: true`（单换行 → `<br>`，贴近现有纯文本观感）；
  - `renderMarkdown(md, streaming)`：marked parse → DOMPurify sanitize；
  - `closeOpenFences(md)`：流式时检测未闭合的 ``` fence 并临时补一个闭合，
    使半成品代码块在流式期间即以代码块渲染。
- 新建隔离组件 `src/lib/components/Markdown.svelte`：
  - props：`text: string`、`streaming: boolean = false`；
  - 内部经 `renderMarkdown` 输出 `{@html}`；暴露 `streaming` 仅用于 fence 补全开关。
  - 该组件是**渲染实现的唯一入口**，未来更换渲染库（如 markstream）只改此文件。

### R2 ChatPanel 接入

- 仅**助手气泡**使用 `<Markdown />`；用户气泡保持纯文本 + `pre-wrap`（原样）。
- 工具卡片、错误行、会话侧栏、引导卡外观不变。
- `white-space: pre-wrap` 从 `.bubble` 基类移除，仅保留于 `.bubble.user`
  （与 Markdown 注入的块级 HTML 冲突）。

### R3 样式

- `Markdown.svelte` 内以 scoped + `:global()`（`{@html}` 内容不吃 Svelte 作用域样式）
  为 `p/ul/ol/li/h1-h4/table/code/pre/blockquote/a/hr/input[checkbox]` 提供间距与配色，
  全部使用现有 CSS 变量（`--surface-2`、`--border`、`--border-soft`、`--accent`、
  `--text-dim` 等），适配暗色主题。
- 代码块：等宽字体、背景 `--surface-2`、圆角、横向滚动；行内 code 类似但内联。

### R4 安全（验收级）

- 模型输出为不可信内容：**所有**经 `{@html}` 渲染的字符串必须先过 DOMPurify。
- 验收用例：`<script>alert(1)</script>`、`<img src=x onerror=alert(1)>`、
  `[x](javascript:alert(1))` 均不得产生可执行代码或危险跳转。

### R5 流式体验

- 流式期间代码块即时呈现为代码块（不闪现裸 ``` 字符，无大幅布局跳动）。
- 流式光标 `.cursor` 行为保持（追加在内容之后）。
- 消息 settle 后（`streaming=false`）不再做 fence 补全，最终渲染不含补全痕迹
  （补全只影响 parse 输入，不回写消息文本）。

## 非目标（本轮不做）

- 语法高亮（shiki/highlight.js）、katex 公式、mermaid、任务列表交互点击。
- 用户气泡 markdown 渲染。
- 消息内 raw HTML 支持（DOMPurify 白名单默认值即策略）。
- React 迁移（已否决）。

## 验收标准

1. `npm run check` 与 `npm run build` 全过（build 为权威门）。
2. 助手消息正确渲染：**粗体**、无序/有序列表、表格、行内 code、fenced code block、
   链接（新标签打开或当前页均可，但 URL 协议安全）、引用块、分隔线。
3. 流式中 fenced code block 即时代码块化；不出现裸 ``` 字符残留（允许补全引起的
   瞬时内容增量，不允许乱码/布局抖动）。
4. R4 的三条 XSS 用例通过（人工验证：渲染为文本或被移除，控制台无告警）。
5. 历史会话重放（`openSession` → DB 行）与实时流式渲染结果一致。
6. 用户气泡、工具卡片、错误提示、输入区、会话侧栏视觉无回归。

## 影响面

- 新增：`src/lib/markdown.ts`、`src/lib/components/Markdown.svelte`
- 修改：`src/lib/components/ChatPanel.svelte`（助手气泡 + CSS 挪动）
- 依赖：`+marked`、`+dompurify`
- 后端（Rust）：零改动
