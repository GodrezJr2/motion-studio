// Video export: seek the same timeline frame by frame and pipe each screenshot into ffmpeg.
// Deterministic, so the MP4 matches what the studio scrubber shows, frame for frame. That also makes it safe to
// split: several pages of the same headless Chrome (all composited on the GPU) each capture one stretch of frames
// into their own ffmpeg, and the stretches are joined without re-encoding. Capture, not encoding, is the slow part.
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { withScene, outDir } from "./session.mjs";
import { plan, mix, mux } from "./audio.mjs";
import { encoder } from "./gpu.mjs";
import { tokensFor } from "./tokens.mjs";

// Pages capturing at once: MS_WORKERS or --workers; 4 by default, fewer on a small machine
const defaultWorkers = () => +process.env.MS_WORKERS || Math.max(1, Math.min(4, Math.floor(os.cpus().length / 4)));

function ffmpeg(args) {
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: ["pipe", "inherit", "pipe"] });
  let err = "";
  ff.stderr.on("data", d => { err += d; });
  ff.done = new Promise((resolve, reject) => {
    ff.on("error", reject);
    ff.on("close", code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim()}`)));
  });
  return ff;
}

// Another page on the same scene, ready to seek
async function clonePage(page, scale) {
  const p = await page.context().browser().newPage({ viewport: page.viewportSize(), deviceScaleFactor: scale });
  await p.goto(page.url(), { waitUntil: "load" });
  await p.waitForFunction(() => window.MS && window.MS.ready, null, { timeout: 15000 });
  await p.evaluate(() => document.fonts && document.fonts.ready);
  // Start from the top like the main page, so each worker reaches its stretch the same way (see lint "overlap")
  await p.evaluate(() => MS.seek(0));
  return p;
}

// Motion blur: each output frame is the average of `blur` subframes spread across the open shutter (180 degrees =
// half a frame), centred on the frame's time like After Effects' default phase. ffmpeg's tmix averages each run of
// subframes and select keeps the last frame of every run. Frames where nothing moves are captured once and
// repeated, so the cost lands only where the blur shows.
function blurFilter(n, fps) {
  return n > 1 ? `tmix=frames=${n},select='eq(mod(n\\,${n})\\,${n - 1})',setpts=N/(${fps}*TB),` : "";
}

const movingAt = (spans, t0, t1) => spans.some(([a, b]) => a < t1 && b > t0);

// A subframe never crosses an instant set (a hard cut, a swap): After Effects does not smear one shot into the next
function sameSide(cuts, t, s) {
  for (const c of cuts) {
    if (s < t && s < c && c <= t) s = c;
    else if (s > t && t < c && c <= s) s = c - 1e-4;
  }
  return s;
}

export async function render(id, { fps, scale = 1, out, crf = 16, from = 0, to, audio = true, encoder: want, workers, blur, shutter, onProgress } = {}) {
  // GPU encoder when the machine has one (core/gpu.mjs), libx264 otherwise
  const enc = encoder(want);
  const r = tokensFor(id).render || {};
  blur = Math.max(1, Math.round(blur ?? r.blur ?? 0));
  shutter = shutter ?? r.shutter ?? 180;
  return withScene(id, async ({ page, info }) => {
    fps = fps || info.fps || 60;
    const end = Math.min(to ?? info.duration, info.duration);
    const count = Math.max(1, Math.round((end - from) * fps)) + 1;
    const file = out || path.join(outDir(id), `${id}.mp4`);
    // Sound only for a full render: a partial one would cut cues and the back-timed music
    const tweens = await page.evaluate(() => MS.tweens());
    const sound = audio && from === 0 && end === info.duration ? await plan(id, info, tweens) : null;
    // Where something moves: tween spans, repeats included. Instant sets do not count
    const spans = tweens.filter(t => t.duration > 0).map(t => [t.start, t.start + (t.repeat < 0 ? 1e9 : t.duration * (t.repeat + 1))]);
    const open = shutter / 360 / fps;
    const cuts = tweens.filter(t => t.duration === 0).map(t => t.start);
    const video = sound ? file.replace(/\.mp4$/, ".video.mp4") : file;

    // Contiguous stretches of at least 2 s each, so every segment starts on a keyframe of its own
    const n = Math.max(1, Math.min(workers || defaultWorkers(), Math.floor(count / (fps * 2))));
    const size = Math.ceil(count / n);
    const parts = Array.from({ length: n }, (_, k) => [k * size, Math.min(count, (k + 1) * size)]).filter(([a, b]) => b > a);
    const segs = parts.map((_, k) => parts.length > 1 ? video.replace(/\.mp4$/, `.part${k}.mp4`) : video);
    const pages = [page, ...await Promise.all(parts.slice(1).map(() => clonePage(page, scale)))];

    // Without a clip, system Chrome's headless window crops the frame by its own insets (1920x1080 came out 1904x984)
    const clip = { x: 0, y: 0, width: info.width, height: info.height, scale: 1 };
    let captured = 0;
    await Promise.all(parts.map(async ([a, b], k) => {
      const p = pages[k];
      const ff = ffmpeg([
        "-f", "image2pipe", "-framerate", String(fps * blur), "-c:v", "png", "-i", "-",
        "-c:v", enc.codec, ...enc.args(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        // Even dimensions for yuv420p
        "-vf", blurFilter(blur, fps) + "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-r", String(fps), segs[k],
      ]);
      const cdp = await p.context().newCDPSession(p);
      const shot = async t => {
        await p.evaluate(x => MS.seek(x), t);
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, clip, captureBeyondViewport: true });
        return Buffer.from(data, "base64");
      };
      const write = async buf => { if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once("drain", r)); };
      for (let i = a; i < b; i++) {
        const t = Math.min(from + i / fps, end);
        if (blur > 1 && movingAt(spans, t - open / 2, t + open / 2)) {
          for (let s = 0; s < blur; s++) await write(await shot(sameSide(cuts, t, Math.max(0, Math.min(end, t + open * ((s + 0.5) / blur - 0.5))))));
        } else {
          const buf = await shot(t);
          for (let s = 0; s < blur; s++) await write(buf);
        }
        onProgress && onProgress(++captured, count);
      }
      ff.stdin.end();
      await ff.done;
    }));

    if (segs.length > 1) {
      const list = video.replace(/\.mp4$/, ".parts.txt");
      fs.writeFileSync(list, segs.map(s => `file '${path.basename(s)}'`).join("\n"));
      await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", video]).done;
      for (const s of [list, ...segs]) fs.rmSync(s, { force: true });
    }

    let mixed = null;
    if (sound) {
      mixed = await mix(id, sound);
      await mux(video, mixed.file, file);
      fs.rmSync(video, { force: true });
    }
    return { file, encoder: enc.name, workers: parts.length, blur: blur > 1 ? { samples: blur, shutter } : null, audio: mixed && { ...mixed, cues: sound.cues, vo: sound.vo, warnings: sound.warnings }, frames: count, fps, width: Math.round(info.width * scale), height: Math.round(info.height * scale) };
  }, { scale });
}
