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
//
// Voice-over, on the same timeline:
//   vo: [{ at: "hero", text: "Satu garis untuk semua trip.", voice: "id-ID-GadisNeural", gain: 0 }, { t: 4.2, text: "..." }]
// Speech starts on the cue (leading silence measured and skipped). Provider, voice and model default from MOTION.md
// `audio.vo`: edge (free Edge read-aloud voices, for drafts) or elevenlabs (paid, needs ELEVENLABS_API_KEY in the env
// or .env). Takes are cached in sounds/vo by provider + voice + model + text, so a line is paid for once. Music ducks
// under the voice with a sidechain compressor.
import fs from "node:fs";
import crypto from "node:crypto";
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
// earshot checked out next to this repo (../earshot) with its own venv, unless EARSHOT_PY points elsewhere
const earshotPy = () => process.env.EARSHOT_PY || path.join(ROOT, "..", "earshot", ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"] });
    if (input != null) p.stdin.end(input, "utf8");
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

// ---- voice-over ----
const VO_DIR = path.join(SOUNDS_DIR, "vo");
let dotenv;
function env(k) {
  if (process.env[k]) return process.env[k];
  if (!dotenv) {
    dotenv = {};
    const f = path.join(ROOT, ".env");
    if (fs.existsSync(f)) for (const l of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
      if (m) dotenv[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  return dotenv[k];
}

// What gets synthesised: everything here changes the take, so it is also the cache key
function voSpec(id, line) {
  const d = (tokensFor(id).audio || {}).vo || {};
  const provider = line.provider || d.provider || "edge";
  if (!line.text || !String(line.text).trim()) throw new Error(`voice-over line needs text: ${JSON.stringify(line)}`);
  if (provider === "edge") return { provider, voice: line.voice || d.voice || "id-ID-ArdiNeural", rate: line.rate || d.rate || "+0%",
    pitch: line.pitch || d.pitch || "+0Hz", text: line.text };
  if (provider === "elevenlabs") {
    const e = d.elevenlabs || {};
    return { provider, voice: line.voice || e.voice || "JBFqnCBsd6RMkjVDRZzb", model: line.model || e.model || "eleven_multilingual_v2",
      settings: { ...(e.settings || {}), ...(line.settings || {}) }, text: line.text };
  }
  throw new Error(`voice-over: unknown provider "${provider}" (edge | elevenlabs)`);
}

async function elevenlabs(spec, mp3) {
  const key = env("ELEVENLABS_API_KEY");
  if (!key) throw new Error("voice-over: provider elevenlabs needs ELEVENLABS_API_KEY (env, or .env in the repo root); provider edge is free");
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(spec.voice)}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST", headers: { "xi-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ text: spec.text, model_id: spec.model, ...(Object.keys(spec.settings).length ? { voice_settings: spec.settings } : {}) }),
  });
  if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  fs.writeFileSync(mp3, Buffer.from(j.audio_base64, "base64"));
  // Character alignment -> words
  const a = j.alignment || {}, words = [];
  let cur = null;
  (a.characters || []).forEach((ch, i) => {
    if (/\s/.test(ch)) { cur = null; return; }
    if (!cur) words.push(cur = { w: "", t: a.character_start_times_seconds[i], end: 0 });
    cur.w += ch;
    cur.end = a.character_end_times_seconds[i];
  });
  return words.map(w => ({ w: w.w, t: +w.t.toFixed(3), d: +(w.end - w.t).toFixed(3) }));
}

// Where speech starts and stops inside the file (under -45 dB for 50 ms counts as silence)
async function speechSpan(file) {
  const dur = +(await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file])).out.trim();
  const err = await ff(["-i", file, "-af", "silencedetect=n=-45dB:d=0.05", "-f", "null", "-"]);
  const starts = [...err.matchAll(/silence_start: ([\d.]+)/g)].map(m => +m[1]);
  const ends = [...err.matchAll(/silence_end: ([\d.]+)/g)].map(m => +m[1]);
  const onset = starts.length && starts[0] < 0.01 && ends.length ? ends[0] : 0;
  // ffmpeg closes a trailing silence at the end of the file, so a silence ending there is the tail
  const k = starts.length - 1;
  const end = k >= 0 && starts[k] > onset && (ends[k] == null || ends[k] >= dur - 0.02) ? starts[k] : dur;
  return { dur: +dur.toFixed(3), onset: +onset.toFixed(3), end: +end.toFixed(3) };
}

export async function voTake(id, line) {
  const spec = voSpec(id, line);
  const hash = crypto.createHash("sha1").update(JSON.stringify(spec)).digest("hex").slice(0, 12);
  const mp3 = path.join(VO_DIR, `${spec.provider}-${hash}.mp3`), meta = mp3.replace(/\.mp3$/, ".json");
  if (!fs.existsSync(meta)) {
    fs.mkdirSync(VO_DIR, { recursive: true });
    let words;
    if (spec.provider === "edge") {
      const py = process.env.MS_PY || "python";
      const { out } = await run(py, [path.join(ROOT, "core", "tts_edge.py"), spec.voice, spec.rate, spec.pitch, mp3], spec.text)
        .catch(e => { throw new Error(`voice-over (edge): ${e.message}  (pip install edge-tts, or set MS_PY)`); });
      words = JSON.parse(out).words;
    } else words = await elevenlabs(spec, mp3);
    const span = await speechSpan(mp3);
    // Edge reports word offsets about 0.1 s ahead of the audio: pin the first word to the measured onset
    if (spec.provider === "edge" && words.length) {
      const shift = span.onset - words[0].t;
      words = words.map(w => ({ ...w, t: +(w.t + shift).toFixed(3) }));
    }
    fs.writeFileSync(meta, JSON.stringify({ spec, ...span, words }, null, 1));
  }
  return { file: mp3, ...JSON.parse(fs.readFileSync(meta, "utf8")) };
}

// A cue's time on the timeline: t, or a tween's start (its end with edge: "end"), plus offset
function cueTime(c, tweens, what) {
  let t = c.t;
  if (c.at != null) {
    const tw = tweens.find(x => x.id === c.at);
    if (!tw) throw new Error(`${what}: no tween with id "${c.at}" (ms tweens lists them)`);
    t = c.edge === "end" ? tw.start + tw.duration : tw.start;
  }
  if (typeof t !== "number") throw new Error(`${what} needs t or at: ${JSON.stringify(c)}`);
  return t + (c.offset || 0);
}

// Resolve every cue to a file and a start time on the timeline
export async function plan(id, info, tweens) {
  const a = info.audio;
  if (!a || (!a.music && !(a.sfx || []).length && !(a.vo || []).length)) return null;
  const lead = (tokensFor(id).limits || {}).sfxLead ?? 0.033;
  const events = (a.sfx || []).map(c => ({ c, t: cueTime(c, tweens, "audio cue") })).sort((x, y) => x.t - y.t);

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
      // A file's own sync point: seconds from its start to the onset (clicks) or peak (whooshes) that meets the event
      sync = c.sync || 0;
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
  const vo = [], warnings = [];
  for (const l of a.vo || []) {
    const t = cueTime(l, tweens, "voice-over line");
    const take = await voTake(id, l);
    const start = t - take.onset;
    vo.push({ text: l.text, provider: take.spec.provider, voice: take.spec.voice, event: +t.toFixed(3),
      start: +Math.max(0, start).toFixed(3), trim: +Math.max(0, -start).toFixed(3), gain: l.gain ?? 0, file: take.file,
      until: +(start + take.end).toFixed(3), words: take.words.map(w => ({ w: w.w, t: +(start + w.t).toFixed(3) })) });
  }
  vo.sort((x, y) => x.event - y.event);
  vo.forEach((v, i) => {
    const next = vo[i + 1];
    if (next && v.until > next.event) warnings.push(`vo "${v.text.slice(0, 32)}" runs to ${v.until}s, over the next line at ${next.event}s`);
    if (v.until > info.duration) warnings.push(`vo "${v.text.slice(0, 32)}" runs to ${v.until}s, past the end (${info.duration}s)`);
  });
  return { duration: info.duration, cues, music, vo, warnings,
    duck: ((tokensFor(id).audio || {}).vo || {}).duck ?? 3, voChain: ((tokensFor(id).audio || {}).vo || {}).chain || "" };
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
  const vo = p.vo || [];
  if (vo.length) {
    vo.forEach((v, k) => {
      const n = inputs.filter(x => x === "-i").length;
      inputs.push("-i", v.file);
      const trim = v.trim ? `atrim=start=${num(v.trim)},asetpts=PTS-STARTPTS,` : "";
      chains.push(`[${n}:a]${trim}${fmt},${p.voChain ? p.voChain + "," : ""}volume=${v.gain}dB,adelay=${Math.round(v.start * 1000)}:all=1[v${k}]`);
    });
    const vl = vo.map((_, k) => `[v${k}]`).join("");
    chains.push(vo.length > 1 ? `${vl}amix=inputs=${vo.length}:normalize=0:duration=longest[vo]` : `${vl}anull[vo]`);
    // Duck the music under the voice: the voice keys a compressor on the bed (MOTION.md audio.vo.duck = ratio, 0 = off).
    // The key is padded to full length: sidechaincompress stops when its shortest input does, which cut the music.
    if (p.music && p.duck) {
      chains.push(`[vo]asplit=2[vo1][vk];[vk]apad=whole_dur=${num(p.duration)}[vkey]`, `[m][vkey]sidechaincompress=threshold=0.05:ratio=${p.duck}:attack=25:release=450[md]`);
      labels[0] = "[md]";
      labels.push("[vo1]");
    } else labels.push("[vo]");
  }
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
    // No -shortest: the wav ends on the last frame's start, so it would cut the final frame or two
    "-movflags", "+faststart", out]);
  return out;
}
