# Motion Studio — working notes

## Goal
A studio where an AI can edit any motion until it is buttery, web first, then video from the same timeline.
Jay pins notes on (time, point) in the studio; the AI reads them, edits, checks with lint + contact sheet, replies.

## Status (25 Oct 2026) — v0 works end to end
- `core/runtime.js` window.MS (register/seek/play/tweens/sample/measure), `core/lint.mjs` curve + tween + perf rules,
  `core/sheet.mjs` contact sheet PNG, `core/render.mjs` MP4 (319 frames 1440×900 in ~13s), `core/server.mjs`
  static + notes API + lint API + SSE, `bin/ms.mjs` CLI, `studio/` UI.
- Verified: demo-hero lints 100; lint-fixture fires every rule (now 3E 9W 1I); pinned a note in the studio, edited the dot
  path from the CLI side, the studio live-reloaded at the same time, reply + resolve showed up.

## Decisions
- One GSAP timeline per scene is the source of truth (seekable → studio, lint, video all agree). Remotion later as
  an optional adapter, not the core.
- Studio talks to the scene iframe directly through `contentWindow.MS` (same origin); postMessage from the runtime
  is kept for future cross-origin use.
- Look: warm paper, ink, vermilion, Instrument Serif + IBM Plex Mono, hairlines, crop marks. Deliberately not the
  dark navy card dashboard Jay calls slop.
- Playwright uses system Chrome (`channel: "chrome"`): its bundled chromium-1140 is not installed
  ("Executable doesn't exist at ...chromium-1140\chrome-win\chrome.exe").

## Direction (Jay, 25 Oct 2026): production ads are made HERE, not in Remotion
Flow: "bikin ads X" -> agent opens the studio, works like an editor (lint, critic, render) -> MP4 or web version.
Remotion at most an adapter (audio). Visual skill routing must point ads at the studio (step 3).

## Done: taste + critic (step 1)
- `MOTION.md` (Jay approved): YAML tokens (eases ms.*, paces calm/crisp, limits, formats, audio, critic, banned) +
  prose laws. Sources: cinetic motion-tokens/timing-grid (eases, duration by distance, speed limit), motion-video-kit
  Gauntlet (builder != judge, verification round), motionmaxxing slop list, mortiflix gates, @0xMovez MOTION.md shape.
- `core/tokens.mjs` -> virtual `/scenes/<id>/tokens.js` registers CustomEase "ms.<name>". Scene MOTION.md deep-merges.
- Lint rules added: text-overshoot, bouncy, landings, fade-pop, strobe, dead-time, end-hold (film/ad), same-speed,
  ease-soup, off-token. Fixture baseline 3E 9W 1I.
- Jerk only on moves >= 0.4 s: ms.smooth's velocity peak is near-cusp, so 0.2 s fades (which MOTION.md prescribes)
  were flagged at ~40%. A locality test (spike vs curvature 2 frames away) did NOT fix it; the duration gate did.
- `core/critic.mjs` + `ms critic|review`: packet -> `claude -p` (Read, Bash(ffmpeg)) -> `.ms/review.json` ledger,
  verdict recomputed from scores.

## Critic findings on demo-hero (3 rounds, all REVISE, avg ~5/10)
- Real and fixed: LCD subpixel fringes on text (browser.mjs now `--disable-lcd-text --font-render-hinting=none`);
  dot over the label; back-card labels bleeding; CTA fill strip outside the pill (overflow hidden); dot speed trough
  (drop and sweep now overlap: one speed bump); identical card peaks; counters/tracked-caps chrome; small grey type.
- Misreads caused by us: round 1 judged a web hero as a film (-> `kind` + brief.md); round 3 got half-scale frames
  and called 17 px type "11 px" (-> critic frames now scale 1).
- Still open (round limit hit, Jay's call): front card rests rotated so its small text aliases (rest it at 0 deg);
  back cards enter from below the frame; deck-template layout; second serif line on the card; long dot tail.

## Done: sound (step 2) and formats (step 3)
- `core/audio.mjs`: cues in `MS.register(... audio)`, `at` = tween id, synth tick/pop/thud/whoosh via aevalsrc
  (cached in .ms/sfx), music `from: "end"` back-timed with -sseof, amix normalize=0, two-pass loudnorm, mux aac.
  demo-hero: 3 cues, MP4 h264+aac. SFX-only mix lands -15.7 LUFS at TP -1 (peak-bound, reported as such);
  with a music bed -14.8. Not listened to by a human yet.
- `core/scaffold.mjs` + `ms new --format`: sizes from MOTION.md, safe-area vars per format, brief.md template.
- ~/.claude/skills/visual/SKILL.md now routes ads/promo/web motion to the studio (backup SKILL.md.bak-2026-10-25).

## Done: reference shelf (step 4)
- `core/shelf.mjs` + `ms refs "<q>"`, `ms refs <scene> --pull "<q>"` (-> .ms/refs/refs.md + images), `ms capture <url>
  [--clip N] [--note] [--scene]` (Playwright still + scroll clip into refs/<slug>/, pushed to the library inbox).
- Library search floor 0.45 cosine: below it the nearest hit is noise. Capture clip trimmed with -sseof (the
  recording also holds page load: 10.2 s for a 4 s ask before).
- Critic prompt includes pulled refs ("references that set the bar").
- memory-core routes `POST /api/v1/library/capture`, `GET /api/v1/library/ref?id=` deployed (commit 0b75b84).
  Verified: pull brings ref images, capture of linear.app landed as library ref #1073 in Jay's inbox.
- Strata: Jay said no, never install.

## Studio: sound + files (25 Oct 2026, Jay asked)
- Sound plays in the studio: server builds the same mix as the render (`GET /api/scenes/:id/audio`, cached in
  .ms/audio.json until the scene changes), studio loads it as a blob, starts picture when the sound clock moves,
  then eases timeline speed (+-20 %) toward the sound clock; hard resync only > 250 ms. Measured drift ~15 ms.
  Silent below 1/4x. `M` toggles. Cue marks on the ruler. Fixed MS.playing() (isActive() is false on frame 1).
- Files tab: renders/output, source, assets, refs; viewer for image/video/audio/text; upload (media only, never
  code) by button or drag-drop; Render MP4 button; "+ New" scene (format picker) in the left column.
- Static server answers Range requests (media seeking).

## Projects home + real sounds (25 Oct 2026, Jay asked)
- Projects home before the editor (posters rendered on demand, chips, hover plays render, duplicate, new form).
  Hash routing: `#id` = editor, empty = home, browser Back works. Tested desktop + phone (scratchpad home_test.mjs).
- Jay: "get the sound effect that we starred on repo, so it dont look slop sound" -> earshot (Leonxlnx/earshot,
  MIT) cloned to D:\Project\earshot, venv with CPU torch. audio.mjs resolves kit role > bank id > scene file >
  synth: placeholder. MOTION.md `audio.kit: crisp`. Studio Sounds tab auditions every role + copies a cue.
- demo-hero mix: earshot timeline hears pop 2.42 / whoosh 3.66 / key click 5.22 = the cues. -16.1 LUFS (sparse,
  peak-limited). Measured only; Jay has not listened yet.
- Next level for music-led ads: earshot real-sound skill (Freesound/Mixkit recordings + licence audit).

## Done: edit ops (step 6) and ms make (step 5) (25 Oct 2026, Jay: "finish it")
- Runtime wraps Timeline.to/from/fromTo/set, reads the caller's line:col from the stack, keyed by the vars object
  -> MS.tweens()[i].src. core/edit.mjs (acorn) finds that call and splices only duration/ease/stagger/id/position.
  Relative positions stay relative. `ms edit`, POST /api/scenes/:id/edit, studio inspector (double-click a bar).
  Tested: inspector edit rewrote scene.js and the stage reloaded with the new duration/ease.
- Judge on a cheap fast model: MOTION.md critic.model haiku, effort low (Jay asked).
- core/make.mjs + `ms make`: claude -p stream-json builder (progress lines), critic rounds, builder resumed by
  session id to fix, render. Studio New form: description -> "Make with AI" -> card shows "AI · <stage>".
- demo-hero round 3 default taken: front card rests at 0 deg (lint 100). Other round-3 items still Jay's call.

## Next
- Make: watch the first real runs; tune the builder prompt from what the critic keeps flagging.
- Optional: critic ledger panel in studio UI (`/api/scenes/:id/review` + SSE "review" exist; studio.js ignores them).

## Done (25 Oct 2026, later)
- Builder model: MOTION.md `builder: { model: opus, effort: medium }` (Jay: builder = his chat model); critic stays
  haiku/low. `ms make --model` overrides the builder.
- `ms make --resume <id>`: skips a finished build, redoes an interrupted fix, judges once more. ms-vertical-ad round 2
  (haiku) REVISE 7/6/8/7/6, rendered.
- HyperFrames: runtime adopts `window.__timelines` + `.clip` windows; `ms import` (core/importer.mjs). Tested on
  scratchpad hf-launch -> scenes/hf-launch, lint 95.
- Lint: opacity is seen opacity (ancestors multiply, hidden = 0); a hard stop into a vanished element is skipped.
- Render bug fixed: CDP captureScreenshot without a clip came out cropped by the headless window insets
  (1920x1080 -> 1904x984, 1080x1920 -> 1064x1824). Now clip + captureBeyondViewport. Earlier MP4s were cropped.
- README film `scenes/ms-readme` (41 s, 8 shots, real UI shots in shots/): lint 83, 0E 0W (sluggish infos = drifts).
  Dead-time warnings come back shot by shot: untracked children (rows, words, svg paths) do not count as motion,
  so each shot needs a tracked drift from its entrance on.
- README.md + media/ (gif poster linking to mp4). refs/ ignored (third-party site screenshots).

## Next
- GitHub repo GodrezJr2/motion-studio (created private; Jay flips to public). Drag media/motion-studio.mp4 into the
  README on github.com for an inline player (<=10 MB).
