// `ms import <composition.html | dir> --id x`: bring a HyperFrames composition into the studio as a scene. The folder
// is copied as is (assets keep their relative paths), GSAP from a CDN is swapped for the vendored copy (renders must
// not depend on the network), and the runtime is loaded right after GSAP. The runtime adopts window.__timelines, so
// nothing in the composition has to change. Tweens in inline scripts have no file:line, so `ms edit` needs them
// moved into a .js file; everything else (studio, lint, sheet, critic, render) works on the composition directly.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./server.mjs";

const GSAP_CDN = /<script[^>]+src=["'][^"']*gsap(?:@[^/"']*)?\/dist\/gsap(?:\.min)?\.js["'][^>]*><\/script>/i;

export function importComposition(src, id) {
  src = path.resolve(src);
  const dir = fs.statSync(src).isDirectory() ? src : path.dirname(src);
  const entry = fs.statSync(src).isDirectory()
    ? ["index.html", "composition.html"].map(f => path.join(dir, f)).find(f => fs.existsSync(f))
    : src;
  if (!entry) throw new Error(`no index.html in ${dir}`);
  id = id || path.basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const out = path.join(ROOT, "scenes", id);
  if (fs.existsSync(out)) throw new Error(`scene "${id}" already exists`);
  fs.cpSync(dir, out, { recursive: true, filter: f => !/node_modules|[\\/]\.git$/.test(f) });
  if (path.basename(entry) !== "index.html") fs.renameSync(path.join(out, path.basename(entry)), path.join(out, "index.html"));

  let html = fs.readFileSync(path.join(out, "index.html"), "utf8");
  if (!/data-composition-id/.test(html) || !/__timelines/.test(html)) {
    throw new Error("not a HyperFrames composition (no data-composition-id / window.__timelines)");
  }
  const tags = `<script src="/vendor/gsap/gsap.min.js"></script>\n<script src="/core/runtime.js"></script>`;
  if (GSAP_CDN.test(html)) html = html.replace(GSAP_CDN, tags);
  else if (/<script/i.test(html)) html = html.replace(/<script/i, tags + "\n<script");
  else throw new Error("composition has no script");
  html = html.replace(/<script[^>]+src=["'][^"']*\/gsap[^"']*\/dist\/gsap(?:\.min)?\.js["'][^>]*><\/script>\s*/gi, "");
  fs.writeFileSync(path.join(out, "index.html"), html);
  if (!fs.existsSync(path.join(out, "brief.md"))) {
    fs.writeFileSync(path.join(out, "brief.md"), `# ${id}\n\nkind: film\nImported from a HyperFrames composition (${path.basename(dir)}).\n`);
  }
  return { id, dir: out };
}
