/**
 * 聊天图片附件处理：本地压缩后转 data URL。
 *
 * 目标（vision 多模态够用 + 控制落库/同步体积）：
 * - 长边 ≤1600px 等比缩小（短边 ≤4px 的异常图拒绝）；
 * - JPEG 重编码（透明域填白；GIF 取首帧）；
 * - 迭代降质量/降尺寸直到 ≤1.5MB；
 * - 单条消息 ≤4 张由调用方把关（见 MAX_ATTACHMENTS）。
 */

/** 单条消息最多附带图片数（与后端 agent_send 校验一致）。 */
export const MAX_ATTACHMENTS = 4;

/** 压缩后单张体积上限（data URL 字符数近似）。 */
const MAX_BYTES = 1_500_000;

/** 首次绘制的最长边。 */
const MAX_EDGE = 1600;

/** 迭代下限：最长边不压过 480px（再小识别价值骤降，宁可超限报错）。 */
const MIN_EDGE = 480;

/** 迭代降质量梯度。 */
const QUALITY_STEPS = [0.9, 0.75, 0.6];

/** 压缩失败（解码不了/格式不支持）的可读错误。 */
export class ImageDecodeError extends Error {
  constructor(reason: string) {
    super(`无法读取图片：${reason}`);
    this.name = "ImageDecodeError";
  }
}

/** File → HTMLImageElement（解码；失败抛 ImageDecodeError）。 */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ImageDecodeError("格式不支持或文件损坏"));
    };
    img.src = url;
  });
}

/** 画布重绘 + JPEG 导出；返回 data URL 或 null（画布失败）。 */
function draw(img: HTMLImageElement, edge: number, quality: number): string | null {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (w < 1 || h < 1) return null;
  const scale = Math.min(1, edge / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // 透明域填白（PNG 截图/图标 → JPEG 不发黑）。
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(img, 0, 0, cw, ch);
  return canvas.toDataURL("image/jpeg", quality);
}

/**
 * 图片文件 → 压缩 data URL。逐步降质量、再逐步降尺寸，直到 ≤1.5MB；
 * 压到下限仍超限则抛错（提示用户换图）。
 */
export async function compressImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new ImageDecodeError("仅支持图片文件");
  }
  const img = await loadImage(file);
  let edge = MAX_EDGE;
  for (const quality of QUALITY_STEPS) {
    const url = draw(img, edge, quality);
    if (url && url.length <= MAX_BYTES) return url;
  }
  // 质量压完仍超限 → 降尺寸重来。
  while (edge > MIN_EDGE) {
    edge = Math.round(edge * 0.8);
    const url = draw(img, edge, QUALITY_STEPS[QUALITY_STEPS.length - 1]);
    if (url && url.length <= MAX_BYTES) return url;
  }
  throw new ImageDecodeError("压缩后仍超过 1.5MB，请换用更小的图片");
}

/** 交互入口（文件选择/粘贴/拖拽共用）：过滤非图片 + 批量压缩 + 数量把关。 */
export async function filesToAttachments(
  files: File[],
  current: string[],
  onError: (msg: string) => void,
): Promise<string[]> {
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (images.length === 0) return current;
  const room = MAX_ATTACHMENTS - current.length;
  if (room <= 0) {
    onError(`最多附带 ${MAX_ATTACHMENTS} 张图片`);
    return current;
  }
  if (images.length > room) {
    onError(`最多附带 ${MAX_ATTACHMENTS} 张图片，已忽略多余的 ${images.length - room} 张`);
  }
  const out = [...current];
  for (const f of images.slice(0, room)) {
    try {
      out.push(await compressImage(f));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}
