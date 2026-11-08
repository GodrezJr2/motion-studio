// Structured edits: change a tween by what it is (duration, ease, start, stagger) instead of hand-editing source.
// The runtime records where every tween was written (MS.tweens()[i].src = "scene.js:12:4", the .to/.from call), so
// an op can address a tween by its id, its src, or its #index in `ms tweens`. The call is found with acorn and only
// the touched text is rewritten: comments, formatting and everything else in the file stay as they were.
//
//   { tween: "dot-sweep" | "scene.js:12:4" | "#7", dur: 0.6, ease: "ms.out", at: 1.2, shift: 0.1, stagger: 0.05, id: "x" }
//   { after: 2.0, shift: 0.3 }   every tween starting at or after 2.0 s moves by 0.3 s
import fs from "node:fs";
import path from "node:path";
import * as acorn from "acorn";
import { sceneDir } from "./session.mjs";

const num = v => String(+(+v).toFixed(3));
const lit = v => typeof v === "number" ? num(v) : JSON.stringify(String(v));

function findTween(tweens, ref) {
  ref = String(ref);
  const m = ref.match(/^#(\d+)$/);
  const tw = m ? tweens[+m[1]] : tweens.find(t => t.id === ref || t.src === ref);
  if (!tw) throw new Error(`no tween "${ref}" (use an id, a src like scene.js:12:4, or #index from ms tweens)`);
  if (!tw.src) throw new Error(`tween "${ref}" has no source location (built outside a scene .js file)`);
  return tw;
}

// The CallExpression whose method name (.to/.from/...) starts at line:col (1-based, as V8 reports it)
function callAt(ast, line, col) {
  let hit = null;
  (function walk(n) {
    if (!n || typeof n.type !== "string" || hit) return;
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && !n.callee.computed) {
      const p = n.callee.property.loc.start;
      if (p.line === line && p.column + 1 === col) { hit = n; return; }
    }
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === "string") walk(v);
    }
  })(ast);
  return hit;
}

const keyName = p => p.key && (p.key.name || p.key.value);

// Text splices for one op on one call
function opSplices(src, call, tw, op) {
  const method = call.callee.property.name;
  const varsArg = call.arguments[method === "fromTo" ? 2 : 1];
  const posIdx = method === "fromTo" ? 3 : 2;
  if (!varsArg || varsArg.type !== "ObjectExpression") throw new Error(`${tw.src}: vars is not an object literal`);
  const out = [];
  const setProp = (key, value) => {
    const p = varsArg.properties.find(q => q.type === "Property" && keyName(q) === key);
    if (p) out.push([p.value.start, p.value.end, value]);
    else if (varsArg.properties.length) out.push([varsArg.properties.at(-1).end, varsArg.properties.at(-1).end, `, ${key}: ${value}`]);
    else out.push([varsArg.start, varsArg.end, `{ ${key}: ${value} }`]);
  };
  // { add: { x: 40, y: -12 } }: move a value in this call's vars (the end state of to/fromTo, the start state of from),
  // as dragged on the stage. Numbers and "+=n" / "-=n" strings shift in place; anything computed is refused.
  if (op.add) for (const [key, d] of Object.entries(op.add)) {
    if (!d) continue;
    const p = varsArg.properties.find(q => q.type === "Property" && keyName(q) === key);
    if (!p) throw new Error(`${tw.src}: this tween does not set ${key}`);
    const v = p.value;
    if (v.type === "Literal" && typeof v.value === "number") out.push([v.start, v.end, num(v.value + d)]);
    else if (v.type === "UnaryExpression" && v.operator === "-" && v.argument.type === "Literal" && typeof v.argument.value === "number")
      out.push([v.start, v.end, num(-v.argument.value + d)]);
    else if (v.type === "Literal" && typeof v.value === "string" && /^[+-]=-?[\d.]+$/.test(v.value)) {
      const n = (v.value[0] === "-" ? -1 : 1) * parseFloat(v.value.slice(2)) + d;
      out.push([v.start, v.end, lit((n < 0 ? "-=" : "+=") + +Math.abs(n).toFixed(2))]);
    } else throw new Error(`${tw.src}: ${key} is computed (${src.slice(v.start, v.end).slice(0, 40)}); edit it in code`);
  }
  if (op.dur != null) setProp("duration", num(op.dur));
  if (op.ease != null) setProp("ease", lit(op.ease));
  if (op.stagger != null) setProp("stagger", num(op.stagger));
  if (op.id != null) setProp("id", lit(op.id));
  if (op.at != null || op.shift != null) {
    const pos = call.arguments[posIdx];
    let to;
    if (op.at != null) to = +op.at;
    else if (!pos) to = tw.start + +op.shift; // no position: it was sequenced; pin it where it now starts, shifted
    else if (pos.type === "Literal" && typeof pos.value === "number") to = pos.value + +op.shift;
    else if (pos.type === "Literal" && typeof pos.value === "string" && /^([<>]?)(?:([-+])=?)?([\d.]*)$/.test(pos.value)) {
      // relative ("<", "<0.2", "-=0.3"): stays relative, the offset moves by the shift
      const m = pos.value.match(/^([<>]?)(?:([-+])=?)?([\d.]*)$/);
      const v = (m[2] === "-" ? -1 : 1) * (+m[3] || 0) + +op.shift;
      const mag = num(Math.abs(v));
      const rel = m[1] ? m[1] + (Math.abs(v) < 5e-4 ? "" : (v < 0 ? "-" : "") + mag) : (v < 0 ? "-=" : "+=") + mag;
      out.push([pos.start, pos.end, JSON.stringify(rel)]);
      return out;
    } else if (pos) throw new Error(`${tw.src}: position ${src.slice(pos.start, pos.end)} is a label or expression; use --at`);
    to = Math.max(0, to);
    if (pos) out.push([pos.start, pos.end, num(to)]);
    else out.push([varsArg.end, varsArg.end, `, ${num(to)}`]);
  }
  return out;
}

// Apply ops against the live tween list (MS.tweens() with src). Returns the changed lines per file.
export function applyEdits(id, tweens, ops, { dry = false, log = null } = {}) {
  const targets = [];
  for (const op of ops) {
    if (op.after != null) {
      for (const tw of tweens) if (tw.src && tw.start >= +op.after - 1e-6) targets.push([tw, { shift: op.shift }]);
    } else targets.push([findTween(tweens, op.tween), op]);
  }
  const byFile = new Map();
  for (const [tw, op] of targets) {
    const [file, line, col] = tw.src.split(":");
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ tw, op, line: +line, col: +col });
  }
  const changes = [];
  for (const [file, list] of byFile) {
    const full = path.join(sceneDir(id), path.basename(file));
    const src = fs.readFileSync(full, "utf8");
    const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", locations: true, allowReturnOutsideFunction: true });
    const splices = [];
    for (const { tw, op, line, col } of list) {
      const call = callAt(ast, line, col);
      if (!call) throw new Error(`${tw.src}: no .to/.from call there (source changed since the scene loaded?)`);
      splices.push(...opSplices(src, call, tw, op));
    }
    splices.sort((a, b) => b[0] - a[0]);
    for (let i = 1; i < splices.length; i++) if (splices[i][1] > splices[i - 1][0]) throw new Error("two ops touch the same text");
    let next = src;
    for (const [s, e, text] of splices) next = next.slice(0, s) + text + next.slice(e);
    const before = src.split("\n"), after = next.split("\n");
    for (let i = 0; i < after.length; i++) if (before[i] !== after[i]) changes.push({ file, line: i + 1, before: before[i], after: after[i] });
    if (!dry) { fs.writeFileSync(full, next); if (log) log.push({ full, before: src, after: next }); }
  }
  return changes;
}

// How a call's position argument places it, in GSAP's terms: "abs" (a number), "prevStart" ("<", "<0.2"),
// "prevEnd" (">", ">0.1"), "end" (absent, "+=0.1", "-=0.3": the timeline's end when the call ran), "label" (a label
// or an expression)
function posKind(call) {
  const method = call.callee.property.name;
  const pos = call.arguments[method === "fromTo" ? 3 : 2];
  if (!pos) return "none";
  if (pos.type === "Literal" && typeof pos.value === "number") return "abs";
  if (pos.type === "Literal" && typeof pos.value === "string") {
    if (pos.value.startsWith("<")) return "prevStart";
    if (pos.value.startsWith(">")) return "prevEnd";
    if (/^[-+]=/.test(pos.value)) return "end";
  }
  return "label";
}

// Timeline edits the way an editor means them: the selected tweens move by `shift` (and/or get a new `dur`), and
// nothing else moves. In code a relative position follows what was written before it ("<" the previous start, ">"
// the previous end, none or "+=" the timeline's end so far), so moving or stretching one call drags its followers,
// and a moved follower must not be shifted twice. Replay each timeline's calls in source order (the order GSAP placed
// them) under the old and the new layout, and give every call the position change that puts it where it is meant
// to be. The stage reloads from the rewritten source, so whatever this model misses shows at once (and undoes).
//   items: [{ tween: src | id | "#i", shift?: s, dur?: d }]
export function applyMoves(id, tweens, items, opts = {}) {
  const want = new Map();
  for (const it of items) {
    const tw = findTween(tweens, it.tween);
    if (!want.has(tw.src)) want.set(tw.src, { shift: +it.shift || 0, dur: it.dur != null ? +it.dur : null });
  }
  // One entry per source call (a call in a loop makes several tweens: they move together)
  const calls = new Map();
  for (const tw of tweens) if (tw.src && !calls.has(tw.src)) calls.set(tw.src, tw);
  const asts = new Map();
  const astOf = file => {
    if (!asts.has(file)) asts.set(file, acorn.parse(fs.readFileSync(path.join(sceneDir(id), path.basename(file)), "utf8"),
      { ecmaVersion: "latest", sourceType: "script", locations: true, allowReturnOutsideFunction: true }));
    return asts.get(file);
  };
  const key = src => { const [f, l, c] = src.split(":"); return [f, +l, +c]; };
  const order = [...calls.values()].sort((a, b) => {
    const [fa, la, ca] = key(a.src), [fb, lb, cb] = key(b.src);
    return (a.par ?? 0) - (b.par ?? 0) || fa.localeCompare(fb) || la - lb || ca - cb;
  });
  const ops = [];
  let par, o, n; // running layout of the current timeline, old (o) and new (n): previous start, previous end, end
  for (const tw of order) {
    if (tw.par !== par || !o) { par = tw.par; o = { ps: 0, pe: 0, end: 0 }; n = { ...o }; }
    const w = want.get(tw.src);
    const desired = w ? w.shift : 0;
    const d0 = tw.duration * ((tw.repeat > 0 ? tw.repeat : 0) + 1);
    const d1 = w && w.dur != null ? w.dur * ((tw.repeat > 0 ? tw.repeat : 0) + 1) : d0;
    const [file, line, col] = key(tw.src);
    const call = callAt(astOf(file), line, col);
    const kind = call ? posKind(call) : "abs";
    const ref = kind === "prevStart" ? "ps" : kind === "prevEnd" ? "pe" : kind === "end" || kind === "none" ? "end" : null;
    const inherent = ref ? n[ref] - o[ref] : 0;
    const op = { tween: tw.src };
    if (Math.abs(desired - inherent) > 1e-4) {
      if (kind === "none" || kind === "label") op.at = Math.max(0, tw.start + desired); // pin it absolute
      else op.shift = desired - inherent;
    }
    if (w && w.dur != null && Math.abs(w.dur - tw.duration) > 1e-4) op.dur = Math.max(0.01, w.dur);
    if (Object.keys(op).length > 1) ops.push(op);
    const s0 = tw.start, s1 = tw.start + desired;
    o = { ps: s0, pe: s0 + d0, end: Math.max(o.end, s0 + d0) };
    n = { ps: s1, pe: s1 + d1, end: Math.max(n.end, s1 + d1) };
  }
  return { ops, changes: ops.length ? applyEdits(id, tweens, ops, opts) : [] };
}
