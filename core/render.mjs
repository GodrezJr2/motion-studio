// Video export: seek the same timeline frame by frame and pipe each screenshot into ffmpeg.
// Deterministic, so the MP4 matches what the studio scrubber shows, frame for frame.
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { withScene, outDir } from "./session.mjs";
import { plan, mix, mux } from "./audio.mjs";

export async function render(id, { fps, scale = 1, out, crf = 16, from = 0, to, audio = true, onProgress } = {}) {
  return withScene(id, async ({ page, info }) => {
    fps = fps || info.fps || 60;
    const end = Math.min(to ?? info.duration, info.duration);
    const count = Math.max(1, Math.round((end - from) * fps)) + 1;
    const file = out || path.join(outDir(id), `${id}.mp4`);
    // Sound only for a full render: a partial one would cut cues and the back-timed music
    const sound = audio && from === 0 && end === info.duration ? await plan(id, info, await page.evaluate(() => MS.tweens())) : null;
    const video = sound ? file.replace(/\.mp4$/, ".video.mp4") : file;

    const ff = spawn("ffmpeg", [
      "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-",
      "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      // Even dimensions for yuv420p
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", video,
    ], { stdio: ["pipe", "inherit", "pipe"] });
    let ffErr = "";
    ff.stderr.on("data", d => { ffErr += d; });
    const done = new Promise((resolve, reject) => {
      ff.on("error", reject);
      ff.on("close", code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${ffErr.trim()}`)));
    });

    const cdp = await page.context().newCDPSession(page);
    // Without a clip, system Chrome's headless window crops the frame by its own insets (1920x1080 came out 1904x984)
    const clip = { x: 0, y: 0, width: info.width, height: info.height, scale: 1 };
    for (let i = 0; i < count; i++) {
      await page.evaluate(t => MS.seek(t), Math.min(from + i / fps, end));
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, clip, captureBeyondViewport: true });
      if (!ff.stdin.write(Buffer.from(data, "base64"))) await new Promise(r => ff.stdin.once("drain", r));
      onProgress && onProgress(i + 1, count);
    }
    ff.stdin.end();
    await done;
    let mixed = null;
    if (sound) {
      mixed = await mix(id, sound);
      await mux(video, mixed.file, file);
      fs.rmSync(video, { force: true });
    }
    return { file, audio: mixed && { ...mixed, cues: sound.cues }, frames: count, fps, width: Math.round(info.width * scale), height: Math.round(info.height * scale) };
  }, { scale });
}
