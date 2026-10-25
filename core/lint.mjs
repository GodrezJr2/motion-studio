// Motion lint: reads sampled curves (MS.sample) and the timeline's tweens (MS.tweens) and reports what makes motion
// look cheap. Pure function, no browser, so the studio and the CLI share it.
//
// Rules are about the curve the eye sees, not the code: a tween with a fine ease can still stop dead when another
// tween overwrites it, and two eased tweens chained can still jerk at the seam.

const CH = { x: 0, y: 1, w: 2, h: 3, opacity: 4, rotation: 5 };
// Smallest change that counts as motion per frame, and smallest total travel worth judging
const EPS = { x: 0.05, y: 0.05, w: 0.05, opacity: 0.002, rotation: 0.05 };
const MIN_TRAVEL = { x: 3, y: 3, w: 3, opacity: 0.05, rotation: 2 };
const UNIT = { x: "px", y: "px", w: "px", opacity: "", rotation: "°" };
const LAYOUT_PROPS = /^(left|top|right|bottom|width|height|margin.*|padding.*|fontSize|lineHeight|letterSpacing|borderWidth|inset|gap)$/;

const r2 = n => Math.round(n * 100) / 100;

function segmentsOf(values, eps) {
  const segs = [];
  let start = -1;
  for (let i = 1; i < values.length; i++) {
    const moving = Math.abs(values[i] - values[i - 1]) > eps;
    if (moving && start < 0) start = i - 1;
    if (!moving && start >= 0) { segs.push([start, i - 1]); start = -1; }
  }
  if (start >= 0) segs.push([start, values.length - 1]);
  // Merge gaps of one still frame: a seam between two tweens, not two separate moves
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s[0] - last[1] <= 1) last[1] = s[1];
    else merged.push([...s]);
  }
  return merged;
}

function looping(tweens, name, t0, t1) {
  return tweens.some(tw => tw.targets.includes(name) && tw.repeat !== 0 && tw.start <= t1 && tw.start + (tw.repeat < 0 ? 1e9 : tw.duration * (tw.repeat + 1)) >= t0);
}

// Defaults when MOTION.md is missing; the real values come from its `limits`
const LIMITS = { maxPxPerFrame: 25, overshoot: 0.07, textOvershoot: 0.005, maxLandings: 2, maxEases: 4, speedRange: 3,
  maxIdle: 1.2, endHold: [0.6, 1.4] };

export function lint(sample, tweens = [], gaps = null, { tokens = {}, info = {} } = {}) {
  const { fps, frames, names, viewport } = sample;
  const roles = sample.roles || [];
  const L = { ...LIMITS, ...(tokens.limits || {}) };
  const film = /^(film|ad)$/.test(info.kind || "");
  let landings = 0;
  const dt = 1 / fps;
  const issues = [];
  const elements = [];
  const diag = Math.hypot(viewport[0], viewport[1]);
  const add = (severity, rule, el, t0, t1, message, fix) =>
    issues.push({ severity, rule, element: el, t0: r2(t0), t1: r2(t1), message, fix });

  // data-ms-role="demo": motion that is bad on purpose (the "before" of a before/after). Its curves are not judged,
  // only listed once, so a piece can show what it fixes without failing its own lint.
  const demo = new Set(names.filter((_, e) => roles[e] === "demo"));
  if (demo.size) add("info", "demo", `${demo.size} elements`, 0, sample.duration,
    `not judged, bad on purpose: ${[...demo].join(", ")}`, "Only for a deliberate before; everything else is judged.");

  names.forEach((name, e) => {
    if (demo.has(name)) return;
    const series = ch => frames.map(f => f[e][CH[ch]]);
    const report = { name, moves: [] };

    for (const ch of ["x", "y", "w", "opacity", "rotation"]) {
      const v = series(ch);
      for (const [a, b] of segmentsOf(v, EPS[ch])) {
        const vel = [];
        for (let i = a; i < b; i++) vel.push(v[i + 1] - v[i]);
        const travel = Math.abs(v[b] - v[a]);
        const path = vel.reduce((s, x) => s + Math.abs(x), 0);
        if (path < MIN_TRAVEL[ch]) continue;
        const peak = Math.max(...vel.map(Math.abs));
        const t0 = a * dt, t1 = b * dt, dur = t1 - t0;
        const loop = looping(tweens, name, t0, t1);
        report.moves.push({ channel: ch, t0: r2(t0), t1: r2(t1), travel: r2(travel), peakPerSec: r2(peak * fps) });

        // Overshoot: passes its rest value and comes back. Round trips (a press, a bob) are not overshoot
        if (ch !== "opacity" && travel > path * 0.3 && !loop) {
          const dir = Math.sign(v[b] - v[a]);
          let exc = 0;
          for (let i = a; i <= b; i++) exc = Math.max(exc, dir * (v[i] - v[b]));
          const ratio = exc / travel;
          if (ratio > 0.01) landings++;
          if (roles[e] === "text" && ratio > L.textOvershoot) {
            add("warn", "text-overshoot", name, t0, t1, `type overshoots its rest by ${r2(ratio * 100)}% on ${ch}`,
              "Type settles without overshoot: ms.outSoft / ms.out, no back or elastic ease.");
          } else if (ratio > L.overshoot) {
            add("warn", "bouncy", name, t0, t1, `${ch} overshoots ${r2(ratio * 100)}% of its travel`,
              `Keep overshoot under ${r2(L.overshoot * 100)}% and only on a true landing; otherwise ms.out / ms.rest.`);
          }
        }
        // Fade-out on an out ease: half the change lands in the first frame, it pops then drifts
        if (ch === "opacity" && v[b] < v[a] && vel.length >= 4 && Math.abs(vel[0]) / peak > 0.8) {
          add("warn", "fade-pop", name, t0, t1, `fades out fastest on its first frame (${r2(dur)}s)`,
            "Fade out on ms.smooth (or ms.exit into a cut), 0.17-0.24s.");
        }
        // Speed limit while it is on screen and readable
        if ((ch === "x" || ch === "y") && vel.length > 1) {
          let fast = 0;
          for (let i = 0; i < vel.length; i++) {
            const f = frames[a + i][e];
            if (f[6] && f[4] >= 0.5) fast = Math.max(fast, Math.abs(vel[i]));
          }
          if (fast > L.maxPxPerFrame) add("warn", "strobe", name, t0, t1, `${ch} hits ${r2(fast)}px per frame on screen`,
            `Stay under ${L.maxPxPerFrame}px/frame: longer duration, a softer start (ms.glide / ms.rest), or start it off screen.`);
        }

        // Teleport: the whole move happens between two frames
        if (vel.length <= 1 && ch !== "opacity" && (ch !== "x" && ch !== "y" || travel > diag * 0.05)) {
          add("error", "teleport", name, t0, t1, `${ch} jumps ${r2(travel)}${UNIT[ch]} in one frame`, "Give it a duration (0.2-0.5s) or hide the jump behind opacity 0.");
          continue;
        }
        if (loop || vel.length < 4) continue;

        // Stops dead: still moving fast on the last frame
        const endRatio = Math.abs(vel[vel.length - 1]) / peak;
        // ...unless it is gone by then: an exit that accelerates into opacity 0 or a cut is the house rule (ms.exit)
        const gone = frames[b][e][4] < 0.05 || frames[Math.min(b + 1, frames.length - 1)][e][4] < 0.05;
        if (endRatio > 0.3 && b < frames.length - 1 && !gone) {
          add("error", "hard-stop", name, t1 - 2 * dt, t1, `${ch} stops dead at ${r2(endRatio * 100)}% of its peak speed`,
            "Ease out (power3.out / expo.out / a spring) or check that a later tween is not overwriting this one.");
        }
        // Jerk: velocity kinks inside the move (chained linear tweens, overwrite, seams between keyframes)
        // A seam is a local spike in curvature; a short eased move (a 0.2 s fade) has a sharp but spread-out velocity
        // peak, so a kink must stand out against the curvature two frames either side
        const jk = vel.map((_, i) => i >= 2 && i < vel.length - 1 ? Math.abs(vel[i + 1] - 2 * vel[i] + vel[i - 1]) / peak : 0);
        let worst = 0, at = 0;
        for (let i = 2; i < vel.length - 1; i++) {
          const around = Math.max(jk[i - 2] || 0, jk[i + 2] || 0);
          if (jk[i] > worst && jk[i] > 2 * around) { worst = jk[i]; at = a + i; }
        }
        // Under 0.4 s the eye cannot read a kink, and a short eased move (a 0.2 s fade) peaks sharply by design
        if (worst > 0.35 && dur >= 0.4) {
          add("warn", "jerk", name, at * dt - dt, at * dt + dt, `${ch} velocity kinks at ${r2(at * dt)}s (${r2(worst * 100)}% of peak)`,
            "Merge the chained tweens into one, or use keyframes with a single ease across them.");
        }
        // Linear: constant speed from start to end reads as robotic
        const inner = vel.slice(1, -1).map(Math.abs);
        if (inner.length >= 8 && Math.abs(vel[0]) / peak > 0.8 && endRatio > 0.8) {
          const mean = inner.reduce((s, x) => s + x, 0) / inner.length;
          const sd = Math.sqrt(inner.reduce((s, x) => s + (x - mean) ** 2, 0) / inner.length);
          if (sd / mean < 0.05) add("warn", "linear", name, t0, t1, `${ch} moves at constant speed for ${r2(dur)}s`,
            "Use an ease (power2.inOut for travel, expo.out for entrances) unless this is a loop or a marquee.");
        }
        // Timing that the eye cannot follow, or that drags
        if ((ch === "x" || ch === "y") && travel > 40 && dur < 0.12) {
          add("warn", "too-fast", name, t0, t1, `${ch} travels ${r2(travel)}px in ${r2(dur * 1000)}ms`, "Give a long move at least 200ms.");
        }
        if ((ch === "x" || ch === "y" || ch === "w") && travel < 120 && dur > 0.9) {
          add("info", "sluggish", name, t0, t1, `${ch} takes ${r2(dur)}s for ${r2(travel)}px`, "UI moves this size usually sit at 200-500ms.");
        }
      }
    }

    // Ends cropped: visible at the end but over the frame edge
    const last = frames[frames.length - 1][e];
    const [cx, cy, w, h, op] = last;
    const over = cx - w / 2 < -1 || cy - h / 2 < -1 || cx + w / 2 > viewport[0] + 1 || cy + h / 2 > viewport[1] + 1;
    if (op > 0.05 && over && w < viewport[0] && h < viewport[1]) {
      add("warn", "cropped", name, sample.duration, sample.duration, "Ends partly outside the frame", "Keep resting elements inside the frame, or move them fully out.");
    }
    elements.push(report);
  });

  // Rhythm over the whole piece: dead time, end hold, everything at one speed
  const moving = frames.map((f, i) => i > 0 && f.some((el, e) => ["x", "y", "w", "opacity", "rotation"].some(ch =>
    Math.abs(el[CH[ch]] - frames[i - 1][e][CH[ch]]) > EPS[ch])));
  const first = moving.indexOf(true), last = moving.lastIndexOf(true);
  if (first >= 0) {
    let run = 0, worst = 0, at = 0;
    for (let i = first; i <= last; i++) {
      run = moving[i] ? 0 : run + 1;
      if (run > worst) { worst = run; at = i; }
    }
    if (worst / fps > L.maxIdle) add("warn", "dead-time", "page", (at - worst) / fps, at / fps,
      `nothing moves for ${r2(worst / fps)}s mid-piece`, "Overlap the next move, or let the hold drift 0.3-1px per frame.");
    const hold = (frames.length - 1 - last) / fps;
    if (film && (hold < L.endHold[0] || hold > L.endHold[1])) add("warn", "end-hold", "page", last / fps, sample.duration,
      `last motion to last frame is ${r2(hold)}s`, `End within ${L.endHold[0]}-${L.endHold[1]}s of the last event.`);
  }
  const travels = elements.flatMap(el => el.moves).filter(m => (m.channel === "x" || m.channel === "y") && m.travel > 40);
  if (travels.length >= 4) {
    const durs = travels.map(m => m.t1 - m.t0);
    const ratio = Math.max(...durs) / Math.max(1 / fps, Math.min(...durs));
    if (ratio < L.speedRange) add("info", "same-speed", `${travels.length} moves`, 0, sample.duration,
      `longest move is only ${r2(ratio)}x the shortest`, `Vary it: the longest at least ${L.speedRange}x the shortest (duration grows with distance).`);
  }
  if (landings > L.maxLandings) add("warn", "landings", `${landings} moves`, 0, sample.duration,
    `${landings} moves overshoot; a piece gets at most ${L.maxLandings} true landings`, "Settle the rest on ms.out / ms.rest.");
  const eases = new Set(tweens.filter(tw => tw.duration > 0 && tw.targets.length && tw.ease !== "none").map(tw => tw.ease));
  if (eases.size > L.maxEases) add("info", "ease-soup", `${eases.size} eases`, 0, sample.duration,
    `${eases.size} different eases (${[...eases].join(", ")})`, `About three characters carry a piece; at most ${L.maxEases}.`);
  if (tokens.eases) {
    const off = [...eases].filter(n => !n.startsWith("ms.") && !/^(linear|none)$/.test(n));
    if (off.length) add("info", "off-token", `${off.length} eases`, 0, sample.duration, `eases outside MOTION.md: ${off.join(", ")}`,
      "Use the house curves (ms.out, ms.rest, ms.smooth, ...) so motion reads as one system.");
  }

  // Tween-level: what the code does that the curves cannot show
  const starts = new Map();
  for (const tw of tweens) {
    const layout = tw.props.filter(p => LAYOUT_PROPS.test(p));
    if (layout.length) add("warn", "layout-prop", tw.targets[0] || tw.id || "?", tw.start, tw.start + tw.duration,
      `animates ${layout.join(", ")} (layout, repaints every frame)`, "Animate x / y / scale / clipPath instead.");
    if (/^(none|linear)$/.test(tw.ease) && tw.repeat === 0 && !demo.has(tw.targets[0]) && tw.duration > 0.2) add("warn", "linear-ease", tw.targets[0] || "?",
      tw.start, tw.start + tw.duration, `tween uses ease "${tw.ease}"`, "Pick an ease; linear only for loops and scrubbed scroll.");
    const key = Math.round(tw.start * fps);
    starts.set(key, (starts.get(key) || 0) + tw.targets.length);
  }
  for (const [frame, count] of starts) {
    if (count >= 6) add("info", "all-at-once", `${count} elements`, frame / fps, frame / fps,
      `${count} elements start on the same frame`, "Stagger 30-60ms so the eye can follow an order.");
  }

  // Real playback smoothness
  let perf = null;
  if (gaps && gaps.length) {
    const budget = 1000 / 60;
    const sorted = [...gaps].sort((a, b) => a - b);
    const dropped = gaps.filter(g => g > budget * 1.5).length;
    perf = { frames: gaps.length, p50: r2(sorted[Math.floor(sorted.length * 0.5)]), p95: r2(sorted[Math.floor(sorted.length * 0.95)]), droppedPct: r2(dropped / gaps.length * 100) };
    if (perf.droppedPct > 3) add("warn", "dropped-frames", "page", 0, sample.duration, `${perf.droppedPct}% of frames over budget (p95 ${perf.p95}ms)`,
      "Look for layout props, big blurs, filters or box-shadow animating; promote moving layers with will-change: transform.");
  }

  const weight = { error: 10, warn: 4, info: 1 };
  const score = Math.max(0, 100 - issues.reduce((s, i) => s + weight[i.severity], 0));
  issues.sort((a, b) => weight[b.severity] - weight[a.severity] || a.t0 - b.t0);
  return { score, issues, elements, perf };
}
