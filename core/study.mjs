// Study a reference motion piece and measure a remake against it. `ms study <url|file>` downloads the video (yt-dlp:
// TikTok, Reels, Shorts, YouTube, X), finds its cuts, measures how much the picture moves per frame (motion energy:
// the rhythm), and lays both out with frames in one sheet. `ms compare <scene>` does the same to the scene's render
// and scores the remake against the reference: cut timing, rhythm and length, side by side in one MP4 and one sheet.
// The reference stays in refs/study/<slug>/ (gitignored: someone else's work, for study only).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { launch } from "./browser.mjs";
import { SHELF } from "./shelf.mjs";
import { sceneDir, outDir } from "./session.mjs";
import { newScene } from "./scaffold.mjs";
import { tokensFor } from "./tokens.mjs";
import { musicOf } from "./beat.mjs";

export const STUDY = path.join(SHELF, "study");
const EFPS = 30; // energy samples per second
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function run(cmd, args, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [], err = [];
    p.stdout.on("data", d => out.push(d));
    p.stderr.on("data", d => err.push(d));
    p.on("error", reject);
    p.on("close", code => {
      const stdout = Buffer.concat(out), stderr = Buffer.concat(err).toString();
      code === 0 ? resolve({ stdout: raw ? stdout : stdout.toString(), stderr })
        : reject(new Error(`${cmd} exited ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`));
    });
  });
}

export async function probe(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration", "-of", "json", file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find(s => s.codec_type === "video");
  const [a, b] = v.r_frame_rate.split("/").map(Number);
  return { width: v.width, height: v.height, fps: +(a / (b || 1)).toFixed(3), duration: +(+j.format.duration).toFixed(3),
    audio: j.streams.some(s => s.codec_type === "audio") };
}

// Hard cuts: ffmpeg's scene score jumps on a cut. 0.3 catches cuts and full-frame wipes, not ordinary moves
export async function cuts(file, threshold = 0.3) {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", file, "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"]);
  // The first frames are not a cut (a fade from black or an encoder's first keyframe can read as one)
  return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map(m => +(+m[1]).toFixed(3)).filter(t => t >= 0.1);
}

// Motion energy: mean absolute change of a small grey copy, frame to frame, 0..1. The shape of this curve is the
// piece's rhythm: spikes are cuts and whips, plateaus are travel, troughs are holds.
export async function energy(file) {
  const W = 96, H = 96;
  const { stdout } = await run("ffmpeg", ["-v", "error", "-i", file, "-vf", `fps=${EFPS},scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"], { raw: true });
  const n = Math.floor(stdout.length / (W * H)), out = [0];
  for (let f = 1; f < n; f++) {
    let s = 0;
    const a = (f - 1) * W * H, b = f * W * H;
    for (let i = 0; i < W * H; i++) s += Math.abs(stdout[b + i] - stdout[a + i]);
    out.push(+(s / (W * H * 255)).toFixed(4));
  }
  return out;
}

// One still per time, small JPEGs (fast seek, then exact)
export async function grab(file, times, dir, prefix, width = 320) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const t of times) {
    const f = path.join(dir, `${prefix}-${t.toFixed(2)}.jpg`);
    await run("ffmpeg", ["-v", "error", "-y", "-ss", String(Math.max(0, t - 1)), "-i", file, "-ss", String(Math.min(1, t)), "-frames:v", "1",
      "-vf", `scale=${width}:-2`, "-q:v", "4", f]);
    files.push(f);
  }
  return files;
}

const slugify = s => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "ref";

// Download (or copy) the reference into refs/study/<slug>/source.mp4
async function fetchSource(src, slug) {
  if (fs.existsSync(src)) {
    slug = slug || slugify(path.basename(src, path.extname(src)));
    const dir = path.join(STUDY, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, path.join(dir, "source.mp4"));
    return { dir, slug, meta: { title: path.basename(src) } };
  }
  const { stdout } = await run("yt-dlp", ["--no-warnings", "--no-playlist", "-J", src]);
  const info = JSON.parse(stdout);
  slug = slug || slugify(`${info.uploader || info.channel || "ref"}-${info.id}`);
  const dir = path.join(STUDY, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "source.mp4");
  if (!fs.existsSync(file)) await run("yt-dlp", ["--no-warnings", "--no-playlist", "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
    "--merge-output-format", "mp4", "-o", file, src]);
  const meta = { url: info.webpage_url || src, title: (info.description || info.title || "").split("\n")[0].slice(0, 160),
    uploader: info.uploader || info.channel, likes: info.like_count, views: info.view_count, posted: info.upload_date };
  return { dir, slug, meta };
}

// Shots from cuts: [start, end] pairs over the whole duration
const shotsOf = (cutList, duration) => {
  const edges = [0, ...cutList.filter(c => c > 0.15 && c < duration - 0.15), duration];
  return edges.slice(0, -1).map((a, i) => [a, edges[i + 1]]);
};

function curveSvg(series, duration, { W = 1520, H = 120, cutSets = [] } = {}) {
  const max = Math.max(0.02, ...series.flatMap(s => s.values));
  const x = t => (t / duration) * W;
  const paths = series.map(s => `<path d="${s.values.map((v, i) => `${i ? "L" : "M"}${x(i / EFPS).toFixed(1)},${(H - Math.min(1, v / max) * (H - 6) - 3).toFixed(1)}`).join("")}" fill="none" stroke="${s.color}" stroke-width="1.6"/>`).join("");
  const marks = cutSets.map(c => c.times.map(t => `<line x1="${x(t)}" x2="${x(t)}" y1="${c.top ? 0 : H / 2}" y2="${c.top ? H / 2 : H}" stroke="${c.color}" stroke-width="2"/>`).join("")).join("");
  const ticks = [];
  for (let t = 0; t <= duration; t += duration > 30 ? 5 : 1) ticks.push(`<text x="${x(t) + 2}" y="${H + 13}" font-size="11" fill="#6b645a">${t}s</text>`);
  return `<svg width="${W}" height="${H + 16}" style="display:block;background:#fbf9f4;border:1px solid #16130f">${marks}${paths}${ticks.join("")}</svg>`;
}

const CSS = `*{box-sizing:border-box;margin:0}body{width:1600px;padding:40px;background:#f3f0e8;color:#16130f;font:13px/1.45 "Cascadia Mono",ui-monospace,Consolas,monospace}
h1{font:600 28px/1.1 Georgia,serif;margin-bottom:6px}h2{font:600 17px Georgia,serif;margin:24px 0 8px}.meta{color:#6b645a}
.grid{display:grid;gap:6px}.grid figure{position:relative}.grid img{display:block;width:100%;border:1px solid #16130f}
figcaption{position:absolute;left:3px;top:3px;background:#16130f;color:#f3f0e8;padding:0 5px;font-size:11px}
.score{display:flex;gap:36px;margin:14px 0}.score b{font:600 30px Georgia,serif;display:block}
.key{display:flex;gap:22px;margin-top:6px;color:#6b645a}.key i{display:inline-block;width:20px;border-top:2px solid;vertical-align:middle;margin-right:6px}`;

async function shoot(html, file) {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    // file:// images: set the content from a file next to them so relative paths resolve
    const tmp = file.replace(/\.png$/, ".html");
    fs.writeFileSync(tmp, html);
    await page.goto("file:///" + tmp.replace(/\\/g, "/"), { waitUntil: "load" });
    await page.screenshot({ path: file, fullPage: true });
    fs.rmSync(tmp, { force: true });
  } finally { await browser.close(); }
}

// Nearest format in MOTION.md for the reference's aspect
function formatFor(w, h) {
  const formats = tokensFor().formats || {};
  let best = "16:9", d = Infinity;
  for (const [k, [fw, fh]] of Object.entries(formats)) {
    if (k === "web") continue;
    const e = Math.abs(Math.log((w / h) / (fw / fh)));
    if (e < d) { d = e; best = k; }
  }
  return best;
}

export async function study(src, { slug, scene, threshold = 0.3 } = {}) {
  const { dir, slug: s, meta } = await fetchSource(src, slug);
  const file = path.join(dir, "source.mp4");
  const info = await probe(file);
  const cutList = await cuts(file, threshold);
  const e = await energy(file);
  const shots = shotsOf(cutList, info.duration);
  // Music: tempo and how the cuts sit on it (the lead an editor cuts ahead of the beat)
  const music = info.audio ? await musicOf(file, cutList).catch(() => null) : null;

  // Frames every step (at most 40), plus the first frame after each cut
  const step = Math.max(0.5, Math.ceil(info.duration / 40 * 2) / 2);
  const times = [];
  for (let t = 0.05; t < info.duration - 0.05; t += step) times.push(+t.toFixed(2));
  const fdir = path.join(dir, "frames");
  fs.rmSync(fdir, { recursive: true, force: true });
  const frames = await grab(file, times, fdir, "t", 300);
  const shotFrames = await grab(file, shots.map(([a, b]) => +Math.min(a + 0.12, (a + b) / 2).toFixed(2)), fdir, "shot", 300);

  const avg = shots.reduce((a, [x, y]) => a + y - x, 0) / shots.length;
  const portrait = info.height > info.width;
  const cols = portrait ? 10 : 6;
  const data = { src, slug: s, ...meta, ...info, format: formatFor(info.width, info.height), cuts: cutList, shots, music, energyFps: EFPS, energy: e,
    at: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, "study.json"), JSON.stringify(data));

  const rel = f => path.relative(dir, f).replace(/\\/g, "/");
  const html = `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
  <h1>${esc(meta.title || s)}</h1>
  <p class="meta">${esc(meta.uploader || "")} · ${info.duration}s · ${info.width}×${info.height} @ ${info.fps}fps · ${shots.length} shots, avg ${avg.toFixed(2)}s
  ${meta.likes != null ? ` · ${meta.likes} likes` : ""} · ${esc(meta.url || src)}</p>
  <h2>Rhythm: motion energy per frame, cuts in red</h2>
  ${curveSvg([{ values: e, color: "#16130f" }], info.duration, { cutSets: [{ times: cutList, color: "#d4380d", top: true }, { times: cutList, color: "#d4380d" }] })}
  <h2>Shots (first frame after each cut)</h2>
  <div class="grid" style="grid-template-columns:repeat(${cols},1fr)">${shotFrames.map((f, i) => `<figure><img src="${rel(f)}"><figcaption>${i + 1} · ${shots[i][0].toFixed(2)}s · ${(shots[i][1] - shots[i][0]).toFixed(2)}s</figcaption></figure>`).join("")}</div>
  <h2>Every ${step}s</h2>
  <div class="grid" style="grid-template-columns:repeat(${cols},1fr)">${frames.map((f, i) => `<figure><img src="${rel(f)}"><figcaption>${times[i].toFixed(2)}s</figcaption></figure>`).join("")}</div>`;
  const sheetFile = path.join(dir, "sheet.png");
  await shoot(html, sheetFile);

  // Notes to fill while watching: what moves, how, and which MS.moves it maps to
  const md = path.join(dir, "study.md");
  // Front matter is what ms playbook folds into refs/PLAYBOOK.md: fill it while watching
  if (!fs.existsSync(md)) fs.writeFileSync(md, `---
title: ${JSON.stringify((meta.title || s).slice(0, 80))}
by: ${JSON.stringify(meta.uploader || "")}
tags: []        # style words to find it by: minimal, kinetic-type, ui-mock, 3d, staccato, brand-ad, ...
palette: []     # hex colours
type: []        # typefaces / type treatment
moves: []       # MS.moves names seen (new ones too), "name: how it is done here"
techniques: []  # one line each: a trick worth stealing and how it is built
---

# ${meta.title || s}

${meta.url || src}  ·  ${meta.uploader || ""}  ·  ${info.duration}s ${info.width}x${info.height} @ ${info.fps}fps  ·  format ${data.format}
Sheet: sheet.png. Shots: ${shots.length}, average ${avg.toFixed(2)} s.${music ? `
Music: ${music.bpm} BPM, ${Math.round(100 * music.onBeat)}% of cuts on a beat${music.lead != null ? `, cuts lead the beat by ${music.lead} s` : ""}.` : ""}

## Shots

| # | start | length | what happens | move (MS.moves) | ease / feel |
|---|---|---|---|---|---|
${shots.map(([a, b], i) => `| ${i + 1} | ${a.toFixed(2)} | ${(b - a).toFixed(2)} |  |  |  |`).join("\n")}

## What makes it good

-

## New moves to add to core/moves.js

-
`);

  let made = null;
  if (scene) made = startRemake(scene, data);
  return { dir, sheet: sheetFile, md, data, scene: made };
}

// A scene wired to its reference: same format, ref.json pointing at the study, brief and refs.md for the critic
export function startRemake(id, data) {
  const s = newScene(id, { format: data.format, kind: "ad", title: `${data.title || data.slug} (remake)` });
  fs.writeFileSync(path.join(s.dir, "ref.json"), JSON.stringify({ study: data.slug }, null, 2) + "\n");
  fs.appendFileSync(path.join(s.dir, "brief.md"), `
Remake study of ${data.url || data.src} (refs/study/${data.slug}/): match its shots, timing and moves as closely as
possible (${data.shots.length} shots, ${data.duration} s). Sample images stand in for the reference's assets and are labelled as samples.
`);
  const rdir = path.join(outDir(id), "refs");
  fs.mkdirSync(rdir, { recursive: true });
  fs.writeFileSync(path.join(rdir, "refs.md"), `# Reference being remade\n\n## ${data.title || data.slug}\n${data.url || data.src}\nimage: ${path.join(STUDY, data.slug, "sheet.png")}\n`);
  return s;
}

function readStudy(slug) {
  const f = path.join(STUDY, slug, "study.json");
  if (!fs.existsSync(f)) throw new Error(`no study "${slug}" (run ms study <url> first)`);
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

// Pearson correlation of two energy curves, both smoothed over ~0.2 s and cut to the shorter one
function correlate(a, b) {
  const smooth = v => v.map((_, i) => { let s = 0, n = 0; for (let k = -3; k <= 3; k++) if (v[i + k] != null) { s += v[i + k]; n++; } return s / n; });
  const n = Math.min(a.length, b.length);
  const x = smooth(a).slice(0, n), y = smooth(b).slice(0, n);
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

// Cuts that land within `tol` seconds of a reference cut, as an F1 over both lists
function cutMatch(ref, mine, tol = 0.2) {
  if (!ref.length && !mine.length) return { f1: 1, hits: 0, offsets: [] };
  const used = new Set(), offsets = [];
  for (const r of ref) {
    let best = -1, d = Infinity;
    mine.forEach((m, i) => { if (!used.has(i) && Math.abs(m - r) < d) { d = Math.abs(m - r); best = i; } });
    if (best >= 0 && d <= tol) { used.add(best); offsets.push(+(mine[best] - r).toFixed(3)); }
  }
  const p = mine.length ? used.size / mine.length : 0, r = ref.length ? used.size / ref.length : 0;
  return { f1: p + r ? 2 * p * r / (p + r) : 0, hits: used.size, offsets };
}

export async function compare(id, { slug, threshold = 0.3, video } = {}) {
  const dir = sceneDir(id);
  const refFile = path.join(dir, "ref.json");
  slug = slug || (fs.existsSync(refFile) && JSON.parse(fs.readFileSync(refFile, "utf8")).study);
  if (!slug) throw new Error(`scene "${id}" has no ref.json {"study": "<slug>"}: pass --study <slug>`);
  const ref = readStudy(slug);
  ref.cuts = ref.cuts.filter(t => t >= 0.1);
  const refVideo = path.join(STUDY, slug, "source.mp4");
  video = video || path.join(outDir(id), `${id}.mp4`);
  if (!fs.existsSync(video)) throw new Error(`no render at ${video}: run ms render ${id} first`);

  const mine = await probe(video);
  const myCuts = await cuts(video, threshold);
  const myEnergy = await energy(video);
  const rhythm = correlate(ref.energy, myEnergy);
  const cm = cutMatch(ref.cuts, myCuts);
  const length = Math.min(ref.duration, mine.duration) / Math.max(ref.duration, mine.duration);
  const score = Math.round(100 * (0.45 * Math.max(0, rhythm) + 0.4 * cm.f1 + 0.15 * length));

  const out = outDir(id);
  const cdir = path.join(out, "compare");
  fs.rmSync(cdir, { recursive: true, force: true });
  const dur = Math.max(ref.duration, mine.duration);
  const times = [];
  const step = Math.max(0.5, Math.ceil(dur / 20 * 2) / 2);
  for (let t = 0.05; t < dur - 0.05; t += step) times.push(+t.toFixed(2));
  const a = await grab(refVideo, times.map(t => Math.min(t, ref.duration - 0.05)), cdir, "ref", 260);
  const b = await grab(video, times.map(t => Math.min(t, mine.duration - 0.05)), cdir, "mine", 260);

  // Side by side at one height, reference sound
  const sbs = path.join(out, "compare.mp4");
  await run("ffmpeg", ["-v", "error", "-y", "-i", refVideo, "-i", video, "-filter_complex",
    "[0:v]scale=-2:720,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=30[a];[1:v]scale=-2:720,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=30[b];[a][b]hstack=inputs=2,format=yuv420p[v]",
    "-map", "[v]", ...(ref.audio ? ["-map", "0:a"] : []), "-t", String(dur), "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-c:a", "aac", sbs]);

  const rel = f => path.relative(out, f).replace(/\\/g, "/");
  const n = times.length;
  const pct = v => `${Math.round(v * 100)}`;
  const html = `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
  <h1>${esc(id)} vs ${esc(ref.title || slug)}</h1>
  <p class="meta">reference ${ref.duration}s ${ref.width}×${ref.height}, ${ref.cuts.length} cuts · remake ${mine.duration}s ${mine.width}×${mine.height}, ${myCuts.length} cuts</p>
  <div class="score"><span><b>${score}</b>match /100</span><span><b>${pct(Math.max(0, rhythm))}</b>rhythm (energy correlation)</span>
    <span><b>${pct(cm.f1)}</b>cuts within 0.2 s (${cm.hits}/${ref.cuts.length})</span><span><b>${pct(length)}</b>length</span></div>
  ${curveSvg([{ values: ref.energy, color: "#16130f" }, { values: myEnergy, color: "#d4380d" }], dur,
    { cutSets: [{ times: ref.cuts, color: "#16130f", top: true }, { times: myCuts, color: "#d4380d" }] })}
  <div class="key"><span><i style="border-color:#16130f"></i>reference (cuts on top)</span><span><i style="border-color:#d4380d"></i>remake (cuts below)</span></div>
  <h2>Same moments: reference above, remake below</h2>
  <div class="grid" style="grid-template-columns:repeat(${Math.min(n, 10)},1fr)">
  ${Array.from({ length: Math.ceil(n / 10) }, (_, r) => {
    const idx = times.slice(r * 10, r * 10 + 10).map((_, k) => r * 10 + k);
    return idx.map(i => `<figure><img src="${rel(a[i])}"><figcaption>${times[i].toFixed(2)}s</figcaption></figure>`).join("") +
      (idx.length < 10 ? "<figure></figure>".repeat(Math.min(n, 10) - idx.length) : "") +
      idx.map(i => `<figure><img src="${rel(b[i])}" style="border-color:#d4380d"></figure>`).join("");
  }).join("")}</div>`;
  const sheetFile = path.join(out, "compare.png");
  await shoot(html, sheetFile);
  const result = { scene: id, study: slug, score, rhythm: +rhythm.toFixed(3), cuts: { ...cm, ref: ref.cuts, mine: myCuts }, length: +length.toFixed(3),
    sheet: sheetFile, video: sbs, at: new Date().toISOString() };
  fs.writeFileSync(path.join(out, "compare.json"), JSON.stringify(result, null, 2));
  return result;
}
