// One headless look at a scene: start a private server, open the scene in capture mode, hand the page to `fn`.
import fs from "node:fs";
import path from "node:path";
import { startServer, SCENES } from "./server.mjs";
import { openScene } from "./browser.mjs";
import { lint } from "./lint.mjs";
import { tokensFor } from "./tokens.mjs";

export function sceneDir(id) {
  const dir = path.join(SCENES, id);
  if (!fs.existsSync(path.join(dir, "index.html"))) throw new Error(`no scene "${id}" (looked in ${dir})`);
  return dir;
}

export function outDir(id) {
  const dir = path.join(sceneDir(id), ".ms");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function withScene(id, fn, { scale = 1 } = {}) {
  sceneDir(id);
  const { server, url } = await startServer();
  let opened;
  try {
    opened = await openScene(`${url}/scenes/${id}/`, { scale });
    return await fn(opened);
  } finally {
    if (opened) await opened.browser.close();
    server.close();
  }
}

// Sample curves, read tweens, measure real playback, lint. Writes .ms/report.json for the studio.
export async function analyze(id, { fps = 60, perf = true } = {}) {
  return withScene(id, async ({ page, info, errors }) => {
    const tweens = await page.evaluate(() => MS.tweens());
    const sample = await page.evaluate(f => MS.sample(f), fps);
    const gaps = perf ? await page.evaluate(() => MS.measure()) : null;
    const result = lint(sample, tweens, gaps, { tokens: tokensFor(id), info });
    const report = { scene: id, at: new Date().toISOString(), info, errors, tweens, ...result };
    const dir = outDir(id);
    fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(dir, "sample.json"), JSON.stringify(sample));
    return { report, sample };
  });
}

// Stills at given times, as PNG buffers
export async function stills(page, times, { clip } = {}) {
  const out = [];
  for (const t of times) {
    await page.evaluate(x => MS.seek(x), t);
    out.push(await page.screenshot({ type: "png", clip }));
  }
  await page.evaluate(() => MS.seek(0));
  return out;
}
