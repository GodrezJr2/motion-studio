// `ms export <scene> <as>`: the finished MP4 (rendered first if missing or older than the scene) in another format
// for where it goes next. gif: two-pass palette, for chats and READMEs; webm: VP9 + Opus, for the web; prores: ProRes
// 422 HQ + PCM in a .mov, for an editor (Premiere, Resolve, After Effects); png: a numbered still per frame;
// poster: one still at --at seconds (default the last frame), for a thumbnail.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { outDir, sceneDir } from "./session.mjs";
import { render } from "./render.mjs";

export const FORMATS = ["gif", "webm", "prores", "png", "poster"];

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: ["ignore", "inherit", "pipe"], windowsHide: true });
    let err = "";
    ff.stderr.on("data", d => { err += d; });
    ff.on("error", e => reject(e.code === "ENOENT" ? new Error("ffmpeg is not on PATH") : e));
    ff.on("close", code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 400)}`)));
  });
}

// newest source file in the scene folder (not .ms): a render older than it is stale
function sceneMtime(id) {
  let t = 0;
  for (const f of fs.readdirSync(sceneDir(id), { withFileTypes: true }))
    if (f.isFile() && /\.(js|html|css|json|md)$/.test(f.name) && f.name !== "notes.json") t = Math.max(t, fs.statSync(path.join(sceneDir(id), f.name)).mtimeMs);
  return t;
}

export async function exportAs(id, as, { width, fps, at, onLog = () => {} } = {}) {
  if (!FORMATS.includes(as)) throw new Error(`export as one of: ${FORMATS.join(", ")}`);
  const mp4 = path.join(outDir(id), `${id}.mp4`);
  if (!fs.existsSync(mp4) || fs.statSync(mp4).mtimeMs < sceneMtime(id)) {
    onLog("rendering first (no MP4, or the scene changed since)");
    await render(id);
  }
  const dir = path.join(outDir(id), "export");
  fs.mkdirSync(dir, { recursive: true });
  const scale = width ? `scale=${width}:-2:flags=lanczos` : null;
  let out;
  if (as === "gif") {
    out = path.join(dir, `${id}.gif`);
    const pre = [`fps=${fps || 24}`, scale || "scale=960:-2:flags=lanczos"].join(",");
    await ffmpeg(["-i", mp4, "-filter_complex", `[0:v]${pre},split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`, "-loop", "0", out]);
  } else if (as === "webm") {
    out = path.join(dir, `${id}.webm`);
    await ffmpeg(["-i", mp4, ...(scale ? ["-vf", scale] : []), "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2",
      "-c:a", "libopus", "-b:a", "128k", out]);
  } else if (as === "prores") {
    out = path.join(dir, `${id}.mov`);
    await ffmpeg(["-i", mp4, ...(scale ? ["-vf", scale] : []), "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", "-c:a", "pcm_s16le", out]);
  } else if (as === "png") {
    out = path.join(dir, "png");
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out);
    await ffmpeg(["-i", mp4, ...(scale ? ["-vf", scale] : []), path.join(out, "%05d.png")]);
  } else {
    out = path.join(dir, `${id}-poster.png`);
    await ffmpeg([...(at != null ? ["-ss", String(at)] : ["-sseof", "-0.1"]), "-i", mp4, "-frames:v", "1", ...(scale ? ["-vf", scale] : []), out]);
  }
  const size = as === "png" ? fs.readdirSync(out).length + " frames" : (fs.statSync(out).size / 1048576).toFixed(1) + " MB";
  return { file: out, size };
}
