// `ms new <id> --format 9:16`: a scene skeleton laid out for one format. Sizes come from MOTION.md `formats`; each
// format is laid out for itself (never a 16:9 cropped to vertical). The skeleton is plumbing, not a design: the
// agent writes the piece from the brief.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tokensFor } from "./tokens.mjs";

const SCENES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scenes");

// Where platform UI (captions, buttons, profile row) covers a vertical feed video: keep type and the product
// inside. Rounded from the Reels / TikTok / Shorts overlay guides, at 1080 wide.
const SAFE = {
  "9:16": { top: 220, right: 120, bottom: 420, left: 60 },
  "4:5": { top: 60, right: 60, bottom: 120, left: 60 },
  "1:1": { top: 60, right: 60, bottom: 60, left: 60 },
  "16:9": { top: 54, right: 96, bottom: 54, left: 96 },
  web: { top: 48, right: 72, bottom: 48, left: 72 },
};

export function newScene(id, { format = "16:9", kind, title } = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`scene id "${id}": use lowercase letters, digits and dashes`);
  const formats = tokensFor().formats || {};
  const size = formats[format];
  if (!size) throw new Error(`format "${format}": one of ${Object.keys(formats).join(", ")} (MOTION.md formats)`);
  const dir = path.join(SCENES, id);
  if (fs.existsSync(dir)) throw new Error(`scene "${id}" already exists`);
  kind = kind || (format === "web" ? "web" : "ad");
  const [w, h] = size;
  const s = SAFE[format] || SAFE["16:9"];
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title || id}</title>
<style>
  /* ${format} ${kind}: ${w}x${h}. Keep type and product inside the safe area (platform UI covers the rest). */
  :root { --w: ${w}px; --h: ${h}px; --safe-t: ${s.top}px; --safe-r: ${s.right}px; --safe-b: ${s.bottom}px; --safe-l: ${s.left}px; }
  * { box-sizing: border-box; margin: 0; }
  html, body { width: var(--w); height: var(--h); overflow: hidden; background: #eeeae1; color: #121110; }
  body { position: relative; font: 32px/1.3 system-ui, sans-serif; }
  .safe { position: absolute; inset: var(--safe-t) var(--safe-r) var(--safe-b) var(--safe-l); }
</style>
</head>
<body>
  <div class="safe">
    <h1 data-ms="title">${title || id}</h1>
  </div>
  <script src="/vendor/gsap/gsap.min.js"></script>
  <script src="/vendor/gsap/CustomEase.min.js"></script>
  <script src="tokens.js"></script>
  <script src="/core/runtime.js"></script>
  <script src="scene.js"></script>
</body>
</html>
`);

  fs.writeFileSync(path.join(dir, "scene.js"), `// ${title || id}: ${format} ${kind}. Read MOTION.md first; eases are "ms.<name>".
const tl = gsap.timeline({ defaults: { ease: "ms.out" } });

tl.from("[data-ms=title]", { yPercent: 40, autoAlpha: 0, duration: 0.8 }, 0.2)
  .to({}, { duration: 1 }, 1.0); // ${kind === "web" ? "rest" : "end hold: MOTION.md limits.endHold"}

MS.register(tl, {
  width: ${w}, height: ${h}, fps: ${tokensFor().fps || 60}, kind: "${kind}",
  // audio: { music: { src: "music.mp3", from: "end" }, sfx: [{ at: "<tween id>", sound: "land" }]  // kit roles: see core/audio.mjs },
});
`);

  fs.writeFileSync(path.join(dir, "brief.md"), `Kind: ${kind} (${format}, ${w}x${h})${kind === "web" ? ", plays once then rests" : ""}.
Audience:
Feel:
The one idea:
Assets (real logo, screenshots, copy, music; from Jay or the brief, never invented):
`);
  return { dir, width: w, height: h, kind, safe: s };
}
