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
export function applyEdits(id, tweens, ops, { dry = false } = {}) {
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
    if (!dry) fs.writeFileSync(full, next);
  }
  return changes;
}
