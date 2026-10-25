// Contact sheet: frame stills across the timeline above per-element velocity curves, with lint issues marked
// on the same time axis. One PNG an AI (or a person) can read in a glance: where things move, how they ease,
// what is wrong and when.
import fs from "node:fs";
import path from "node:path";
import { withScene, outDir, stills } from "./session.mjs";
import { lint } from "./lint.mjs";

const W = 1600, PAD = 40, LABEL = 190;
const PLOT = W - PAD * 2 - LABEL;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function curves(sample, e) {
  const { frames, fps } = sample;
  const speed = [0], opacity = [], scale = [];
  const w0 = frames.find(f => f[e][2] > 0)?.[e][2] || 1;
  frames.forEach((f, i) => {
    opacity.push(f[e][4]);
    scale.push(f[e][2] / w0);
    if (i) speed.push(Math.hypot(f[e][0] - frames[i - 1][e][0], f[e][1] - frames[i - 1][e][1]) * fps);
  });
  return { speed, opacity, scale };
}

function line(values, max, h, n) {
  if (!max) return "";
  return values.map((v, i) => `${i ? "L" : "M"}${(i / (n - 1) * PLOT).toFixed(1)},${(h - v / max * (h - 4) - 2).toFixed(1)}`).join("");
}

export function sheetHtml({ report, sample, thumbs, times }) {
  const dur = sample.duration || 1;
  const n = sample.frames.length;
  const x = t => (t / dur) * PLOT;
  const sev = { error: "#d4380d", warn: "#b7791f", info: "#5a6b7b" };
  const counts = { error: 0, warn: 0, info: 0 };
  report.issues.forEach(i => counts[i.severity]++);

  const moving = report.elements.filter(el => el.moves.length).slice(0, 16);
  const rows = moving.map(el => {
    const e = sample.names.indexOf(el.name);
    const c = curves(sample, e);
    const peak = Math.max(...c.speed);
    const smax = Math.max(1.02, ...c.scale), smin = Math.min(0.98, ...c.scale);
    const H = 64;
    const bands = report.issues.filter(i => i.element === el.name).map(i =>
      `<rect x="${x(i.t0) - 3}" y="0" width="${Math.max(6, x(i.t1) - x(i.t0) + 6)}" height="${H}" fill="${sev[i.severity]}" opacity=".16"/>` +
      `<text x="${x(i.t0) + 2}" y="11" class="tag" fill="${sev[i.severity]}">${esc(i.rule)}</text>`).join("");
    const scalePath = smax - smin > 0.03
      ? `<path d="${c.scale.map((v, i) => `${i ? "L" : "M"}${(i / (n - 1) * PLOT).toFixed(1)},${(H - (v - smin) / (smax - smin) * (H - 4) - 2).toFixed(1)}`).join("")}" class="sc"/>` : "";
    return `<div class="row"><div class="lab"><b>${esc(el.name)}</b><span>${peak ? Math.round(peak) + " px/s peak" : "no travel"}</span>
      <span>${el.moves.map(m => m.channel).filter((v, i, a) => a.indexOf(v) === i).join(" · ")}</span></div>
      <svg width="${PLOT}" height="${H}">${bands}
        <path d="${line(c.opacity, 1, H, n)}" class="op"/>${scalePath}
        <path d="${line(c.speed, peak, H, n)}" class="sp"/></svg></div>`;
  }).join("");

  const ticks = [];
  for (let t = 0; t <= dur + 1e-6; t += dur > 6 ? 1 : 0.5) ticks.push(`<span style="left:${LABEL + x(t)}px">${t.toFixed(1)}s</span>`);
  const thumbW = PLOT / thumbs.length;
  const strip = thumbs.map((b, i) => `<figure style="width:${thumbW}px"><img src="data:image/png;base64,${b.toString("base64")}"><figcaption>${times[i].toFixed(2)}s</figcaption></figure>`).join("");
  const list = report.issues.slice(0, 18).map(i => `<li><i style="background:${sev[i.severity]}"></i><code>${i.t0.toFixed(2)}–${i.t1.toFixed(2)}s</code>
    <b>${esc(i.rule)}</b> <em>${esc(i.element)}</em> ${esc(i.message)}<small>${esc(i.fix)}</small></li>`).join("")
    || `<li class="clean">No issues. Curves ease in and out, nothing teleports or stops dead.</li>`;
  const perf = report.perf ? `p50 ${report.perf.p50}ms · p95 ${report.perf.p95}ms · ${report.perf.droppedPct}% dropped` : "perf not measured";

  return `<!doctype html><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  body{width:${W}px;padding:${PAD}px;background:#f3f0e8;color:#16130f;font:13px/1.45 "Cascadia Mono",ui-monospace,Consolas,monospace}
  header{display:flex;align-items:baseline;gap:28px;border-bottom:2px solid #16130f;padding-bottom:14px;margin-bottom:22px}
  h1{font:600 30px/1 Georgia,"Times New Roman",serif;letter-spacing:-.01em}
  .score{font:600 30px/1 Georgia,serif;margin-left:auto}.score small{font:13px ui-monospace,monospace;color:#6b645a}
  .meta{color:#6b645a}
  .strip{display:flex;margin-left:${LABEL}px;gap:0;border:1px solid #16130f}
  figure{position:relative;border-right:1px solid #16130f}figure:last-child{border-right:0}
  img{display:block;width:100%}
  figcaption{position:absolute;left:4px;bottom:3px;background:#16130f;color:#f3f0e8;padding:0 5px;font-size:11px}
  .ticks{position:relative;height:22px;margin:6px 0 4px}.ticks span{position:absolute;transform:translateX(-50%);color:#6b645a;font-size:11px}
  .row{display:flex;align-items:stretch;border-top:1px solid #d6d0c4}.row:last-of-type{border-bottom:1px solid #d6d0c4}
  .lab{width:${LABEL}px;padding:7px 10px 6px 0;display:flex;flex-direction:column;font-size:11px;color:#6b645a}
  .lab b{color:#16130f;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  svg{display:block;background:repeating-linear-gradient(90deg,transparent 0 ${PLOT / 10 - 1}px,#e4dfd4 ${PLOT / 10 - 1}px ${PLOT / 10}px)}
  .sp{fill:none;stroke:#16130f;stroke-width:1.8}.op{fill:none;stroke:#2f6fdf;stroke-width:1;stroke-dasharray:3 3}
  .sc{fill:none;stroke:#8a5cf6;stroke-width:1;stroke-dasharray:1 2}
  .tag{font-size:10px;font-weight:600}
  .legend{margin:10px 0 0 ${LABEL}px;color:#6b645a;font-size:11px;display:flex;gap:22px}
  .legend i{display:inline-block;width:22px;height:0;border-top:2px solid #16130f;vertical-align:middle;margin-right:6px}
  h2{font:600 18px Georgia,serif;margin:26px 0 10px}
  ul{list-style:none;padding:0;columns:2;column-gap:36px}
  li{break-inside:avoid;padding:6px 0;border-top:1px solid #d6d0c4;font-size:12px}
  li i{display:inline-block;width:8px;height:8px;margin-right:6px}
  li code{color:#6b645a;margin-right:6px}li em{font-style:normal;color:#6b645a}
  li small{display:block;color:#6b645a;padding-left:14px}.clean{color:#3d7a3a}
  </style>
  <header><h1>${esc(report.scene)}</h1>
    <span class="meta">${dur.toFixed(2)}s · ${report.info.width}×${report.info.height} · ${report.tweens.length} tweens · ${sample.names.length} tracked · ${perf}</span>
    <span class="score">${report.score}<small>/100 · ${counts.error}E ${counts.warn}W ${counts.info}I</small></span></header>
  <div class="strip">${strip}</div>
  <div class="ticks">${ticks.join("")}</div>
  ${rows || `<p class="meta">Nothing moves.</p>`}
  <div class="legend"><span><i></i>speed (own peak = top)</span><span><i style="border-top:1px dashed #2f6fdf"></i>opacity 0–1</span>
    <span><i style="border-top:1px dotted #8a5cf6"></i>scale</span><span>shaded = lint issue</span></div>
  ${report.errors.length ? `<h2>Page errors</h2><ul>${report.errors.map(e => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
  <h2>Issues</h2><ul>${list}</ul>`;
}

export async function sheet(id, { frames = 8, fps = 60, perf = true } = {}) {
  return withScene(id, async ({ page, info, errors }) => {
    const tweens = await page.evaluate(() => MS.tweens());
    const sample = await page.evaluate(f => MS.sample(f), fps);
    const gaps = perf ? await page.evaluate(() => MS.measure()) : null;
    const result = lint(sample, tweens, gaps);
    const report = { scene: id, at: new Date().toISOString(), info, errors, tweens, ...result };
    const dur = sample.duration;
    const times = Array.from({ length: frames }, (_, i) => +(dur * i / (frames - 1)).toFixed(3));
    const thumbs = await stills(page, times);

    // Own page at full scale: the scene page shoots thumbnails at a quarter of the size
    const sheetPage = await page.context().browser().newPage({ viewport: { width: W, height: 900 }, deviceScaleFactor: 1 });
    await sheetPage.setContent(sheetHtml({ report, sample, thumbs, times }), { waitUntil: "load" });
    const dir = outDir(id);
    const file = path.join(dir, "sheet.png");
    await sheetPage.screenshot({ path: file, fullPage: true });
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(dir, "sample.json"), JSON.stringify(sample));
    return { file, report };
  }, { scale: 0.25 });
}
