/**
 * 图标方案对比图：4 个设计方向 → PNG → 拼成一张对比图供挑选。
 * 用法：node scripts/icon-options.mjs → docs/images/icon-options.png
 */
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";

const W = 512; // 单方案渲染尺寸

const variants = {
  // 方案1「暖纸墨韵」：应用同款暖纸底 + 墨色衬线感 M + 绿色小点缀
  paper: `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 512 512">
  <rect x="16" y="16" width="480" height="480" rx="108" fill="#F4F1E8"/>
  <path d="M 128 350 L 128 176 L 256 296 L 384 176 L 384 350"
        fill="none" stroke="#1C1B19" stroke-width="44"
        stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="384" cy="384" r="26" fill="#36AC74"/>
</svg>`,

  // 方案2「日历卡」：产品隐喻——日历页 + 紫头 + 大对勾
  calendar: `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="h" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8677F0"/><stop offset="1" stop-color="#5A48C9"/>
    </linearGradient>
  </defs>
  <rect x="48" y="72" width="416" height="392" rx="56" fill="#FFFFFF"/>
  <path d="M 48 168 h 416 v 0" stroke="none"/>
  <rect x="48" y="72" width="416" height="96" rx="56" fill="url(#h)"/>
  <rect x="48" y="132" width="416" height="36" fill="url(#h)"/>
  <rect x="128" y="40" width="28" height="64" rx="14" fill="#8B84E8"/>
  <rect x="356" y="40" width="28" height="64" rx="14" fill="#8B84E8"/>
  <path d="M 152 306 L 228 382 L 366 240"
        fill="none" stroke="#36AC74" stroke-width="46"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`,

  // 方案3「挖空渐变」：紫渐变底 + 负空间 M（实心块挖出，更现代）
  negative: `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0.1" y1="0" x2="0.9" y2="1">
      <stop offset="0" stop-color="#9285F5"/><stop offset="0.55" stop-color="#6D5DD3"/><stop offset="1" stop-color="#4B3AB8"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#bg)"/>
  <!-- 负空间 M：白色实心，字形更饱满 -->
  <path d="M 118 386 L 118 150 L 172 150 L 256 252 L 340 150 L 394 150 L 394 386 L 338 386 L 338 244 L 256 346 L 174 244 L 174 386 Z"
        fill="#FFFFFF"/>
  <circle cx="404" cy="404" r="40" fill="#36AC74" stroke="#FFFFFF" stroke-width="10"/>
</svg>`,

  // 方案4「深空霓虹」：深色底 + 发光描线 M + 绿对勾（暗色模式审美）
  neon: `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="dk" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2A2740"/><stop offset="1" stop-color="#16142B"/>
    </linearGradient>
    <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="10" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#dk)"/>
  <path d="M 138 356 L 138 168 L 256 272 L 374 168 L 374 356"
        fill="none" stroke="#9C8FFF" stroke-width="38"
        stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>
  <circle cx="390" cy="390" r="38" fill="#36AC74" filter="url(#glow)"/>
  <path d="M 373 392 L 386 405 L 410 374"
        fill="none" stroke="#FFFFFF" stroke-width="16"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`,
};

const root = new URL("..", import.meta.url);
await mkdir(new URL("docs/images", root), { recursive: true });

// 每个方案渲染 512 PNG
const labels = { paper: "1 暖纸墨韵", calendar: "2 日历卡", negative: "3 挖空渐变", neon: "4 深空霓虹" };
const pngs = [];
for (const [name, svg] of Object.entries(variants)) {
  await writeFile(new URL(`src-tauri/icons/_opt-${name}.svg`, root), svg, "utf8");
  const buf = await sharp(Buffer.from(svg)).resize(W, W).png().toBuffer();
  pngs.push({ name, label: labels[name], buf });
}

// 拼 2×2 对比图（间隙 + 标签条）
const gap = 28, labelH = 56, pad = 40;
const cell = W;
const canvasW = pad * 2 + cell * 2 + gap;
const canvasH = pad * 2 + (cell + labelH) * 2 + gap;
const comps = pngs.map((p, i) => ({
  input: p.buf,
  left: pad + (i % 2) * (cell + gap),
  top: pad + Math.floor(i / 2) * (cell + labelH + gap),
}));

const labelSvgs = pngs.map((p, i) => {
  const x = pad + (i % 2) * (cell + gap);
  const y = pad + Math.floor(i / 2) * (cell + labelH + gap) + cell + 8;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${labelH}">
       <text x="${cell / 2}" y="36" font-family="sans-serif" font-size="30" font-weight="700"
             fill="#1C1B19" text-anchor="middle">${p.label}</text>
     </svg>`,
  );
});

await sharp({
  create: { width: canvasW, height: canvasH, channels: 4, background: { r: 247, g: 246, b: 242, alpha: 1 } },
})
  .composite([...comps, ...labelSvgs.map((buf, i) => ({
    input: buf,
    left: pad + (i % 2) * (cell + gap),
    top: pad + Math.floor(i / 2) * (cell + labelH + gap) + cell + 8,
  }))])
  .png()
  .toFile(new URL("docs/images/icon-options.png", root).pathname);

// 单方案也各存一份便于细看
for (const p of pngs) {
  await sharp(p.buf).png().toFile(new URL(`docs/images/icon-${p.name}.png`, root).pathname);
}

console.log("✓ 对比图 docs/images/icon-options.png（2×2）；单图 docs/images/icon-*.png");
