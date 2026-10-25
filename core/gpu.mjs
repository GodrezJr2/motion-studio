// GPU first: pick the video encoder for renders. Hardware encoders are tried in order (NVIDIA NVENC, Intel Quick
// Sync, AMD AMF) with a tiny test encode, because ffmpeg lists encoders it was built with even when the machine has
// no such GPU or driver. libx264 on the CPU is the fallback. MS_ENCODER or --encoder picks one: auto (default) |
// nvenc | qsv | amf | cpu.
import { spawnSync } from "node:child_process";

// Quality settings tuned to look like libx264 -crf 16 (visually lossless for flat motion graphics). NVENC -cq 25
// measured the same SSIM against the source as -crf 16 (0.9987) at 10 MB for a 22 s 1080x1920 ad; -cq 18 was 28 MB
const ENCODERS = {
  nvenc: { codec: "h264_nvenc", args: q => ["-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", String(q + 9), "-b:v", "0", "-profile:v", "high", "-spatial-aq", "1"] },
  qsv: { codec: "h264_qsv", args: q => ["-preset", "veryslow", "-global_quality", String(q + 2)] },
  amf: { codec: "h264_amf", args: q => ["-quality", "quality", "-rc", "cqp", "-qp_i", String(q + 2), "-qp_p", String(q + 4)] },
  cpu: { codec: "libx264", args: q => ["-preset", "slow", "-crf", String(q)] },
};

const works = name => {
  // 256x256 because some hardware encoders refuse very small frames
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.1",
    "-frames:v", "2", "-pix_fmt", "yuv420p", "-c:v", ENCODERS[name].codec, "-f", "null", "-"], { timeout: 15000 });
  return r.status === 0;
};

let picked = null;
export function encoder(want = process.env.MS_ENCODER || "auto") {
  if (want !== "auto") {
    if (!ENCODERS[want]) throw new Error(`unknown encoder "${want}" (auto | nvenc | qsv | amf | cpu)`);
    if (want !== "cpu" && !works(want)) throw new Error(`encoder ${want} (${ENCODERS[want].codec}) does not run on this machine`);
    return { name: want, ...ENCODERS[want] };
  }
  picked ??= ["nvenc", "qsv", "amf"].find(works) || "cpu";
  return { name: picked, ...ENCODERS[picked] };
}
