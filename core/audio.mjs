// Sound for a scene, declared next to its timeline:
//   MS.register(tl, { ..., audio: {
//     music: { src: "music.mp3", from: "end", gain: -3 },   // "end" back-times it so its own ending lands on ours
//     sfx: [{ at: "release", sound: "land" }, { t: 2.75, sound: "whoosh.short", gain: -8 },
//           { at: "dot-x", edge: "end", sound: "bell" }, { t: 3, sound: "ui_pop/soft", pitch: "A4" }, { t: 4, sound: "hit.wav" }],
//   } })
// `at` is a tween id (its start, or its end with edge: "end"). `sound` is, in this order:
//   a kit role    tick, tick.crisp, tock, hit, land, land.light, pop, whoosh.short, whoosh.long, drop, key, key.space,
//                 key.return, click, click.confirm, snap, bell, text: from the earshot kit named by MOTION.md
//                 `audio.kit` (a scene's own kit.json wins). Takes rotate cue by cue, bells climb the kit's scale.
//   a bank id     "ui_pop/soft", "mallet/glock", "shutter/snap" ... (`earshot sfx list`), with pitch / dur / apex knobs
//   a file        in the scene folder ("hit.wav")
//   synth:<name>  the old ffmpeg synth tick / pop / thud / whoosh (placeholder only: it sounds like code)
// Kit and bank sounds come from earshot (github.com/Leonxlnx/earshot, MIT): designed members and CC0 recordings fitted
// as code, each audited for clicks and cut tails, with measured onset / peak so the right point lands on the picture.
// Every sound leads its event by MOTION.md `limits.sfxLead`, unless its kit role sets its own offset_ms. The mix is
// normalised in two passes to `audio.lufs` / `audio.truePeak`.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { outDir, sceneDir } from "./session.mjs";
import { tokensFor } from "./tokens.mjs";
import { ROOT } from "./server.mjs";

// Placeholder sounds, synthesised with ffmpeg's aevalsrc. peak = seconds from the start to the loudest moment.
const SYNTH = {
  tick: { d: 0.06, peak: 0, expr: "0.5*sin(2*PI*2400*t)*exp(-t*120)", post: "highpass=f=800" },
  pop: { d: 0.25, peak: 0, expr: "0.7*sin(2*PI*(260*t+12*(1-exp(-t*40))))*exp(-t*22)" },
  thud: { d: 0.5, peak: 0, expr: "0.9*sin(2*PI*(52*t+2.5*(1-exp(-t*24))))*exp(-t*9)+0.25*(random(0)*2-1)*exp(-t*160)", post: "lowpass=f=900" },
  whoosh: { d: 0.7, peak: 0.32, expr: "(random(0)*2-1)*if(lt(t,0.32),pow(t/0.32,2),exp(-(t-0.32)*14))", post: "bandpass=f=1400:width_type=o:w=2,lowpass=f=5000" },
};
// Old names from before the kit, mapped to the kit role that does their job
const ALIAS = { thud: "land", whoosh: "whoosh.short" };
export const ROLES = ["tick", "tick.crisp", "tock", "hit", "land", "land.light", "pop", "whoosh.short", "whoosh.long",
  "suck", "riser", "drop", "key", "key.space", "key.return", "click", "click.confirm", "snap", "swell", "bell", "text"];
export const SOUNDS = ROLES;

const SOUNDS_DIR = path.join(ROOT, "sounds");
const earshotPy = () => process.env.EARSHOT_PY || "D:/Project/earshot/.venv/Scripts/python.exe";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", d => { out += d; });
    p.stderr.on("data", d => { err += d; });
    p.on("error", reject);
    p.on("close", code => code === 0 ? resolve({ out, err })
      : reject(new Error(`${path.basename(cmd)} exited ${code}: ${(err || out).trim().split("\n").slice(-4).join(" ")}`)));
  });
}
const ff = args => run("ffmpeg", ["-hide_banner", "-y", ...args]).then(r => r.err);
async function earshot(args) {
  if (!fs.existsSync(earshotPy())) throw new Error(`earshot not installed at ${earshotPy()} (set EARSHOT_PY, or use synth:<name>)`);
  return run(earshotPy(), ["-m", "earshot", ...args]);
}

async function synth(id, name) {
  const s = SYNTH[name];
  const file = path.join(outDir(id), "sfx", `${name}.wav`);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await ff(["-f", "lavfi", "-i", `aevalsrc='${s.expr}':s=48000:d=${s.d}`, ...(s.post ? ["-af", s.post] : []), "-ac", "2", file]);
  return file;
}

// The scene's kit, rendered once into takes with measured sync points (earshot keeps them cached by content).
// A scene's own kit.json renders into its .ms/kit; a preset renders into sounds/<preset>.
const kits = new Map();
async function kitFor(id) {
  const own = path.join(sceneDir(id), "kit.json");
  const preset = (tokensFor(id).audio || {}).kit || "crisp";
  const dir = fs.existsSync(own) ? path.join(outDir(id), "kit") : path.join(SOUNDS_DIR, preset);
  const json = fs.existsSync(own) ? own : path.join(dir, "kit.json");
  const lockFile = path.join(dir, "kit.lock.json");
  if (!kits.has(dir)) kits.set(dir, (async () => {
    if (!fs.existsSync(json)) { fs.mkdirSync(dir, { recursive: true }); await earshot(["kit", "init", "--preset", preset, "-o", json]); }
    if (!fs.existsSync(lockFile) || fs.statSync(lockFile).mtimeMs < fs.statSync(json).mtimeMs) await earshot(["kit", "render", json, "--out", dir]);
    return { dir, lock: JSON.parse(fs.readFileSync(lockFile, "utf8")) };
  })().catch(e => { kits.delete(dir); throw e; }));
  return kits.get(dir);
}

// The scene's kit for the studio's Sounds tab: every role with its takes as URLs and why that sound was chosen
export async function kitInfo(id) {
  const { dir, lock } = await kitFor(id);
  const kit = JSON.parse(fs.readFileSync(path.join(dir, "kit.json"), "utf8"));
  const base = "/" + path.relative(ROOT, dir).replace(/\\/g, "/") + "/";
  return {
    name: lock.name, note: kit.note || "", own: fs.existsSync(path.join(sceneDir(id), "kit.json")),
    roles: ROLES.map(role => {
      const r = lock.roles[role];
      const spec = (kit.roles || {})[role];
      if (!r) return { role, off: (kit.off || {})[role] || "off in this kit" };
      return { role, sound: r.sound, align: r.align || "onset", level: r.level_db || 0, note: spec && spec.note || "",
        takes: r.takes.map(t => ({ url: base + t.file, pitch: t.pitch || null, dur: t.dur_s })) };
    }),
  };
}

// One bank sound with its knobs, cached under sounds/bank by id + knobs, with its measured onset / peak / end
async function bankTake(sound, c) {
  const knobs = [["pitch", c.pitch], ["dur", c.dur], ["apex", c.apex], ["seed", c.seed]].filter(([, v]) => v != null);
  const name = [sound.replace(/\//g, "_"), ...knobs.map(([k, v]) => k + v)].join("_").replace(/[^\w.-]/g, "");
  const file = path.join(SOUNDS_DIR, "bank", name + ".wav"), meta = file.replace(/\.wav$/, ".json");
  if (!fs.existsSync(meta)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { out } = await earshot(["sfx", "render", sound, "-o", file, ...knobs.flatMap(([k, v]) => ["--" + k, String(v)]), "--json"]);
    const m = JSON.parse(out.slice(out.indexOf("{")));
    fs.writeFileSync(meta, JSON.stringify(m.meta || m));
  }
  return { file, take: JSON.parse(fs.readFileSync(meta, "utf8")) };
}

// Resolve every cue to a file and a start time on the timeline
export async function plan(id, info, tweens) {
  const a = info.audio;
  if (!a || (!a.music && !(a.sfx || []).length)) return null;
  const lead = (tokensFor(id).limits || {}).sfxLead ?? 0.033;
  const events = (a.sfx || []).map(c => {
    let t = c.t;
    if (c.at != null) {
      const tw = tweens.find(x => x.id === c.at);
      if (!tw) throw new Error(`audio cue: no tween with id "${c.at}" (ms tweens lists them)`);
      t = c.edge === "end" ? tw.start + tw.duration : tw.start;
    }
    if (typeof t !== "number") throw new Error(`audio cue needs t or at: ${JSON.stringify(c)}`);
    return { c, t: t + (c.offset || 0) };
  }).sort((x, y) => x.t - y.t);

  const cues = [], used = {};
  for (const { c, t } of events) {
    const raw = String(c.sound || "");
    const role = ALIAS[raw] || raw;
    let file, sync = 0, gain = c.gain ?? 0, offset = -lead, from = "file";
    if (raw.startsWith("synth:") && SYNTH[raw.slice(6)]) {
      file = await synth(id, raw.slice(6));
      sync = SYNTH[raw.slice(6)].peak;
      from = "synth";
    } else if (ROLES.includes(role)) {
      const { dir, lock } = await kitFor(id);
      const r = lock.roles[role];
      if (!r) throw new Error(`audio cue: kit "${lock.name}" has "${role}" off${lock.off && lock.off[role] ? ": " + lock.off[role] : ""}`);
      const n = used[role] || 0;
      used[role] = n + 1;
      // Bells: the cue's pitch if the kit has it, else the next rung of the kit's scale, so a run of steps climbs
      const take = (c.pitch && r.takes.find(x => x.pitch === c.pitch)) || r.takes[n % r.takes.length];
      file = path.join(dir, take.file);
      sync = take[`${r.align || "onset"}_s`] || 0;
      gain += r.level_db || 0;
      if (r.offset_ms != null) offset = r.offset_ms / 1000;
      from = `kit:${lock.name}`;
    } else if (/^[a-z_]+\/[\w.]+$/i.test(raw)) {
      const b = await bankTake(raw, c);
      file = b.file;
      sync = (c.align === "peak" || /whoosh|swish|swell/.test(raw) ? b.take.peak_s : b.take.onset_s) || 0;
      from = "bank";
    } else {
      file = path.join(sceneDir(id), raw);
      if (!fs.existsSync(file)) throw new Error(`audio cue: no sound "${raw}" (a kit role: ${ROLES.join(", ")}; a bank id like ui_pop/soft; a file in the scene folder; or synth:tick|pop|thud|whoosh)`);
    }
    const start = t + offset - sync;
    cues.push({ sound: raw, from, event: +t.toFixed(3), start: +Math.max(0, start).toFixed(3), trim: +Math.max(0, -start).toFixed(3),
      gain: +gain.toFixed(2), file });
  }
  let music = null;
  if (a.music) {
    const m = typeof a.music === "string" ? { src: a.music } : a.music;
    const file = path.join(sceneDir(id), m.src);
    if (!fs.existsSync(file)) throw new Error(`audio: no music file ${file}`);
    music = { file, from: m.from ?? "start", gain: m.gain ?? 0, fadeOut: m.fadeOut ?? (m.from === "end" ? 0 : 0.8) };
  }
  return { duration: info.duration, cues, music };
}

const num = v => Number(v).toFixed(3);

// Mix, then two-pass loudnorm to the house target. Returns the wav and its measured loudness.
export async function mix(id, p) {
  const tokens = tokensFor(id);
  const I = (tokens.audio || {}).lufs ?? -14, TP = (tokens.audio || {}).truePeak ?? -1;
  const dir = outDir(id);
  const pre = path.join(dir, `${id}.premix.wav`), out = path.join(dir, `${id}.wav`);
  const inputs = [], chains = [], labels = [];
  const fmt = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
  if (p.music) {
    const seek = p.music.from === "end" ? ["-sseof", `-${num(p.duration)}`] : ["-ss", num(+p.music.from || 0)];
    inputs.push(...seek, "-i", p.music.file);
    const fade = p.music.fadeOut ? `,afade=t=out:st=${num(Math.max(0, p.duration - p.music.fadeOut))}:d=${num(p.music.fadeOut)}` : "";
    chains.push(`[0:a]${fmt},volume=${p.music.gain}dB,atrim=0:${num(p.duration)}${fade}[m]`);
    labels.push("[m]");
  }
  p.cues.forEach((c, k) => {
    const n = inputs.filter(x => x === "-i").length;
    inputs.push("-i", c.file);
    const ms = Math.round(c.start * 1000);
    // A sound whose sync point falls before 0 starts part-way in
    const trim = c.trim ? `atrim=start=${num(c.trim)},asetpts=PTS-STARTPTS,` : "";
    chains.push(`[${n}:a]${trim}${fmt},volume=${c.gain}dB,adelay=${ms}:all=1[s${k}]`);
    labels.push(`[s${k}]`);
  });
  const graph = [...chains, `${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest,apad=whole_dur=${num(p.duration)},atrim=0:${num(p.duration)}[mix]`].join(";");
  await ff([...inputs, "-filter_complex", graph, "-map", "[mix]", "-c:a", "pcm_s24le", pre]);

  const ln = `loudnorm=I=${I}:TP=${TP}:LRA=11`;
  const m = loudness(await ff(["-i", pre, "-af", `${ln}:print_format=json`, "-f", "null", "-"]));
  await ff(["-i", pre, "-af", `${ln}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`,
    "-c:a", "pcm_s24le", out]);
  const f = loudness(await ff(["-i", out, "-af", `${ln}:print_format=json`, "-f", "null", "-"]));
  fs.rmSync(pre, { force: true });
  return { file: out, lufs: +f.input_i, truePeak: +f.input_tp, target: { lufs: I, truePeak: TP } };
}

function loudness(stderr) {
  const j = stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1);
  return JSON.parse(j);
}

export async function mux(video, wav, out) {
  await ff(["-i", video, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-shortest", "-movflags", "+faststart", out]);
  return out;
}
