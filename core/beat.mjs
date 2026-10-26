// Beat map of a song: tempo, beats, bars, drops. So a piece can be cut to real music: shots change on downbeats,
// hits land on kicks, the big reveal sits on the drop. Pure JS on ffmpeg's PCM (no Python): spectral-flux onsets,
// tempo by autocorrelation, beats by dynamic programming (Ellis 2007), downbeats from where the low end hits hardest.
//
//   ms beat <song> [--scene id] [--from s] [--length s]
//
// With --scene the song is copied into scenes/<id>/audio/ and beats.js is written next to index.html:
// window.MS_BEATS, read through MS.beat(i), MS.bar(n, beat), MS.snap(t) (core/moves.js). Times are seconds into the
// piece (the song starts at `from`), so a scene places tweens straight on them.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { sceneDir } from "./session.mjs";

const SR = 22050, N = 1024, HOP = 256, FPS = SR / HOP;

function pcm(file, from = 0, length) {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", ...(from ? ["-ss", String(from)] : []), "-i", file, ...(length ? ["-t", String(length)] : []),
      "-vn", "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"];
    const ff = spawn("ffmpeg", args);
    const chunks = [];
    let err = "";
    ff.stdout.on("data", d => chunks.push(d));
    ff.stderr.on("data", d => { err += d; });
    ff.on("error", reject);
    ff.on("close", code => {
      if (code) return reject(new Error(`ffmpeg: ${err.trim()}`));
      const b = Buffer.concat(chunks);
      resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)));
    });
  });
}

// In-place radix-2 FFT
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

// Per hop: spectral flux (all bands), low-band flux (kick, under ~150 Hz) and RMS
function features(x) {
  const frames = Math.max(0, Math.floor((x.length - N) / HOP));
  const win = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  const lowBin = Math.round(150 / (SR / N));
  let prev = new Float32Array(N / 2);
  const flux = new Float32Array(frames), low = new Float32Array(frames), rms = new Float32Array(frames);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = 0; i < N; i++) { const s = x[f * HOP + i]; re[i] = s * win[i]; im[i] = 0; e += s * s; }
    rms[f] = Math.sqrt(e / N);
    fft(re, im);
    const mag = new Float32Array(N / 2);
    let fl = 0, lo = 0;
    for (let k = 1; k < N / 2; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const d = mag[k] - prev[k];
      if (d > 0) { fl += d; if (k <= lowBin) lo += d; }
    }
    flux[f] = fl; low[f] = lo; prev = mag;
  }
  return { flux, low, rms };
}

// Onset envelope: flux minus its local mean, rectified, unit peak
function envelope(flux) {
  const w = Math.round(FPS * 0.5), out = new Float32Array(flux.length);
  let sum = 0;
  for (let i = 0; i < flux.length; i++) {
    sum += flux[i] - (i >= 2 * w ? flux[i - 2 * w] : 0);
    const mean = sum / Math.min(i + 1, 2 * w);
    out[i] = Math.max(0, flux[i] - mean);
  }
  const peak = Math.max(1e-9, ...out);
  return out.map(v => v / peak);
}

// Tempo: autocorrelation of the envelope over 70-180 BPM, weighted toward ~120 (people tap there)
function tempo(env) {
  let best = 0, bestLag = 0;
  const score = lag => { let s = 0; for (let i = lag; i < env.length; i++) s += env[i] * env[i - lag]; return s / (env.length - lag); };
  const lo = Math.floor(FPS * 60 / 180), hi = Math.ceil(FPS * 60 / 70);
  const sc = [];
  for (let lag = lo; lag <= hi; lag++) {
    const bpm = 60 * FPS / lag;
    const w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    sc[lag] = score(lag) * w;
    if (sc[lag] > best) { best = sc[lag]; bestLag = lag; }
  }
  // Parabolic refinement of the peak lag
  const a = sc[bestLag - 1] ?? best, c = sc[bestLag + 1] ?? best;
  const d = a - 2 * best + c;
  const lag = d ? bestLag + 0.5 * (a - c) / d : bestLag;
  return 60 * FPS / lag;
}

// Beats: dynamic programming that trades onset strength against keeping the period
function track(env, bpm, tight = 100) {
  const P = 60 * FPS / bpm;
  const n = env.length, score = new Float64Array(n), from = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let best = 0, arg = -1;
    for (let p = Math.max(0, Math.round(t - 2 * P)); p <= t - Math.round(P / 2); p++) {
      const v = score[p] - tight * Math.log((t - p) / P) ** 2;
      if (v > best) { best = v; arg = p; }
    }
    score[t] = env[t] + best; from[t] = arg;
  }
  // Start from the best score in the last beat period
  let t = n - 1;
  for (let i = Math.max(0, n - Math.round(P)); i < n; i++) if (score[i] > score[t]) t = i;
  const out = [];
  for (; t >= 0; t = from[t]) out.push(t);
  return out.reverse();
}

const r3 = v => +v.toFixed(3);

export async function beatMap(file, { from = 0, length } = {}) {
  if (!fs.existsSync(file)) throw new Error(`no audio file ${file}`);
  const x = await pcm(file, from, length);
  if (x.length < SR) throw new Error(`${file}: under a second of audio`);
  const { flux, low, rms } = features(x);
  const env = envelope(flux), lowEnv = envelope(low);
  const bpm = tempo(env);
  const idx = track(env, bpm);
  const beats = idx.map(i => i / FPS);
  // Downbeat phase: of the 4 positions in a bar, the one where the low end hits hardest
  const phase = [0, 1, 2, 3].map(p => idx.reduce((s, i, k) => s + (k % 4 === p ? lowEnv[i] : 0), 0));
  const p0 = phase.indexOf(Math.max(...phase));
  const downbeats = beats.filter((_, k) => k % 4 === p0);
  // Loudness per bar (RMS, 0..1) and drops: a bar much louder than the two before it
  const at = t => Math.min(rms.length - 1, Math.max(0, Math.round(t * FPS)));
  const barEnergy = downbeats.map((t, k) => {
    const a = at(t), b = at(downbeats[k + 1] ?? t + 4 * 60 / bpm);
    let s = 0; for (let i = a; i < b; i++) s += rms[i];
    return s / Math.max(1, b - a);
  });
  const top = Math.max(1e-9, ...barEnergy);
  const bars = barEnergy.map(e => e / top);
  const drops = downbeats.filter((_, k) => k >= 2 && bars[k] > 0.75 && bars[k] > 1.5 * Math.max(bars[k - 1], bars[k - 2]) - 0.05
    && bars[k] - Math.min(bars[k - 1], bars[k - 2]) > 0.25);
  // Strong hits: envelope peaks well above the rest (accents worth a snap or a cut)
  const hits = [];
  for (let i = 1; i < env.length - 1; i++) if (env[i] > 0.45 && env[i] >= env[i - 1] && env[i] > env[i + 1]) hits.push(i / FPS);
  const duration = x.length / SR;
  return {
    src: path.basename(file), from, duration: r3(duration), bpm: +bpm.toFixed(1), period: r3(60 / bpm),
    beats: beats.map(r3), downbeats: downbeats.map(r3), bars: bars.map(r3), drops: drops.map(r3), hits: hits.map(r3),
  };
}

// The window of `length` s that puts the song's first drop `lead` s into the piece, starting on a downbeat
export function bestWindow(map, length, lead = length * 0.4) {
  const drop = map.drops[0] ?? map.downbeats[map.bars.indexOf(Math.max(...map.bars))];
  if (drop == null) return 0;
  const start = map.downbeats.filter(t => t <= drop - lead).at(-1) ?? 0;
  return Math.min(start, Math.max(0, map.duration - length));
}

// How well a piece's cuts sit on the music: share of cuts within `tol` s of a beat
export function onBeat(cuts, beats, tol = 0.07) {
  if (!cuts.length || !beats.length) return null;
  return cuts.filter(c => beats.some(b => Math.abs(b - c) <= tol)).length / cuts.length;
}

// ms beat: analyse, optionally re-window to put the drop where it reads, and wire it into a scene
export async function beat(file, { scene, from, length } = {}) {
  let map = await beatMap(file);
  if (from == null && length && map.duration > length + 1) from = bestWindow(map, length);
  if (from || length) {
    const whole = map;
    map = await beatMap(file, { from: from || 0, length });
    map.song = { duration: whole.duration, drops: whole.drops };
  }
  let out = null;
  if (scene) {
    const dir = sceneDir(scene);
    if (!fs.existsSync(dir)) throw new Error(`no scene ${scene}`);
    fs.mkdirSync(path.join(dir, "audio"), { recursive: true });
    const name = path.basename(file);
    if (path.resolve(file) !== path.resolve(dir, "audio", name)) fs.copyFileSync(file, path.join(dir, "audio", name));
    fs.writeFileSync(path.join(dir, "beats.js"), `// generated by ms beat from ${name}: times in seconds into the piece\nwindow.MS_BEATS = ${JSON.stringify(map)};\n`);
    out = { dir, music: { src: `audio/${name}`, from: map.from || 0 } };
  }
  return { ...map, scene: out };
}
