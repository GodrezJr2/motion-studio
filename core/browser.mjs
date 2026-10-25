// Opens a scene in headless Chrome in capture mode and waits for MS.register.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Grayscale text antialiasing: LCD subpixel AA paints blue/orange fringes on glyphs in stills and renders
const ARGS = ["--disable-lcd-text", "--font-render-hinting=none"];

// System Chrome first; Playwright's cached Chromium as a fallback
export async function launch() {
  try {
    return await chromium.launch({ channel: "chrome", args: ARGS });
  } catch {
    const cache = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
    const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort().reverse() : [];
    for (const d of dirs) {
      const exe = path.join(cache, d, "chrome-win64", "chrome.exe");
      if (fs.existsSync(exe)) return chromium.launch({ executablePath: exe, args: ARGS });
    }
    return chromium.launch({ args: ARGS });
  }
}

export async function openScene(url, { width, height, scale = 1 } = {}) {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: width || 1440, height: height || 900 }, deviceScaleFactor: scale });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => m.type() === "error" && errors.push(m.text()));
  await page.goto(url + (url.includes("?") ? "&" : "?") + "ms=capture", { waitUntil: "load" });
  await page.waitForFunction(() => window.MS && window.MS.ready, null, { timeout: 15000 }).catch(() => {
    throw new Error(`scene never called MS.register()${errors.length ? ": " + errors.join("; ") : ""}`);
  });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  const info = await page.evaluate(() => MS.info());
  // The scene states its own stage size; match it so layout is the one it was designed for
  if (!width && (info.width !== 1440 || info.height !== 900)) {
    await page.setViewportSize({ width: info.width, height: info.height });
  }
  return { browser, page, info, errors };
}
