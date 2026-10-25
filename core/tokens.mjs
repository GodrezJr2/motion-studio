// Taste tokens: the YAML front matter of MOTION.md (house), deep-merged with scenes/<id>/MOTION.md (brand).
// Lint reads the limits, the critic reads banned/critic, and each scene page gets the eases as "ms.<name>".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function frontMatter(file) {
  if (!fs.existsSync(file)) return {};
  const m = fs.readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? YAML.parse(m[1]) || {} : {};
}

const isObj = v => v && typeof v === "object" && !Array.isArray(v);
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  return out;
}

export function tokensFor(id) {
  const house = frontMatter(path.join(ROOT, "MOTION.md"));
  const t = id ? merge(house, frontMatter(path.join(ROOT, "scenes", id, "MOTION.md"))) : house;
  t.pace = t.pace || "calm";
  t.timing = (t.paces || {})[t.pace] || {};
  return t;
}

// Prose part of MOTION.md, for the critic prompt
export function motionProse(id) {
  const read = f => fs.existsSync(f) ? fs.readFileSync(f, "utf8").replace(/^---[\s\S]*?\n---\r?\n/, "").trim() : "";
  return [read(path.join(ROOT, "MOTION.md")), id && read(path.join(ROOT, "scenes", id, "MOTION.md"))].filter(Boolean).join("\n\n");
}

// Served at /scenes/<id>/tokens.js: registers the eases with CustomEase (load it first) and exposes the tokens
export function tokensScript(id) {
  const t = tokensFor(id);
  return `// generated from MOTION.md
window.MS_TOKENS = ${JSON.stringify(t)};
(function (E) {
  if (!window.gsap || !window.CustomEase) { console.warn("tokens.js: load gsap and CustomEase before it"); return; }
  gsap.registerPlugin(CustomEase);
  for (const k in E) CustomEase.create("ms." + k, "M0,0 C" + E[k].join(",") + " 1,1");
})(window.MS_TOKENS.eases || {});
`;
}
