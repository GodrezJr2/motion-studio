// Motion Studio moves: the studio's After Effects presets. Each move is a function that returns a GSAP timeline built
// on the house eases ("ms.*") and MOTION.md's laws, so a scene places proven motion instead of re-deriving it:
//
//   tl.add(MS.moves.wordSwap(".box", ["Inspirations", "Illustration", "Design"]), 5.2)
//   tl.add(MS.moves.cameraPush(".world", ".pin-3", { scale: 2.2 }), "+=0.3")
//
// Load after runtime.js. Moves that measure layout (wordSwap, cameraPush, cardBurst, cursorTo) need the fonts in, so
// build the timeline inside MS.build(() => { ... MS.register(tl, ...) }). Every move is seek-safe: no timers, no
// rAF, nothing random that is not seeded, so studio, lint and render see the same frames. Moves were harvested from
// studied references (refs/study/<slug>/study.md lists which move came from where).
(function () {
  if (!window.MS || !window.gsap) { console.warn("moves.js: load gsap and runtime.js first"); return; }
  const $ = s => typeof s === "string" ? document.querySelector(s) : s;
  const $$ = s => typeof s === "string" ? [...document.querySelectorAll(s)] : Array.isArray(s) ? s : s instanceof NodeList ? [...s] : [s];
  const T = () => (window.MS_TOKENS && window.MS_TOKENS.timing) || {};
  const tl = () => gsap.timeline({ defaults: { ease: "ms.out" } });

  // Seeded random, so "random" rotations are the same on every seek and render
  function rand(seed = 1) {
    let s = seed >>> 0 || 1;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  // Stage size: the body is the frame
  const frame = () => [document.body.offsetWidth || innerWidth, document.body.offsetHeight || innerHeight];

  // Layout centre of el inside `root` (offset chain: ignores transforms, so tweens that already ran do not skew it)
  function centre(el, root = document.body) {
    el = $(el); root = $(root);
    let x = el.offsetWidth / 2, y = el.offsetHeight / 2;
    for (let n = el; n && n !== root; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
    return [x, y];
  }

  // Wrap words or chars in .ms-mask > .ms-w spans (mask reveals, typing). Returns the inner spans. Idempotent.
  function split(el, by = "words") {
    el = $(el);
    if (el.dataset.msSplit) return [...el.querySelectorAll(".ms-w")];
    const text = el.textContent;
    const parts = by === "chars" ? [...text] : text.split(/(\s+)/);
    el.innerHTML = parts.map(p => /^\s+$/.test(p) ? (by === "chars" ? '<span class="ms-w">&nbsp;</span>' : " ")
      : `<span class="ms-mask"><span class="ms-w">${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span></span>`).join("");
    el.dataset.msSplit = by;
    return [...el.querySelectorAll(".ms-w")];
  }

  // Styles the moves rely on (masks, the swap box), once
  const css = document.createElement("style");
  css.textContent = `.ms-mask{display:inline-block;overflow:hidden;vertical-align:top;padding-bottom:.08em;margin-bottom:-.08em}
.ms-w{display:inline-block;white-space:pre}
.ms-swap{position:relative;display:inline-block;vertical-align:top}
.ms-swap-bg{position:absolute;inset:0;transform-origin:0 50%}
.ms-swap-win{position:relative;overflow:hidden}
.ms-swap-track{display:flex;flex-direction:column}
.ms-swap-track>span{display:block;white-space:nowrap;width:max-content}`;
  document.head.appendChild(css);

  const moves = {
    // A mark arrives huge and snaps down to its rest size: logo openers. Fast, no overshoot (blur makes it read)
    snapScale(el, { from = 6, dur = 0.32, ease = "ms.out" } = {}) {
      return tl().from($(el), { scale: from, duration: dur, ease });
    },

    // Wipe an element in from one edge with a clip mask (wordmark sliding out of its logo, a line of type)
    wipeReveal(el, { dir = "right", dur = 0.5, ease = "ms.out", fade = true } = {}) {
      const from = { right: "inset(0 100% 0 0)", left: "inset(0 0 0 100%)", up: "inset(100% 0 0 0)", down: "inset(0 0 100% 0)" }[dir];
      const t = tl().fromTo($$(el), { clipPath: from }, { clipPath: "inset(0 0% 0 0%)", duration: dur, ease });
      if (fade) t.from($$(el), { x: dir === "right" ? -24 : dir === "left" ? 24 : 0, duration: dur, ease }, 0);
      return t;
    },

    // Words (or chars) rise out of their own masks, staggered: the house type entrance
    maskUp(el, { by = "words", dur, stagger, ease = "ms.out" } = {}) {
      const w = split(el, by);
      return tl().from(w, { yPercent: 110, duration: dur || T().word || 0.5, stagger: stagger ?? (by === "chars" ? 0.025 : T().wordStagger || 0.1), ease });
    },

    // Type on, char by char, with an optional caret that follows. cps = characters per second
    typeOn(el, { cps = 22, caret = false, jitter = 0.35, seed = 7 } = {}) {
      el = $(el);
      const chars = split(el, "chars");
      const r = rand(seed), t = tl();
      gsap.set(chars, { display: "none" });
      let at = 0;
      chars.forEach(c => { t.set(c, { display: "inline-block" }, at); at += (1 / cps) * (1 + (r() - 0.5) * jitter); });
      if (caret) {
        const k = document.createElement("span");
        k.className = "ms-caret";
        k.style.cssText = "display:inline-block;width:.06em;height:1em;background:currentColor;vertical-align:-.12em;margin-left:.04em";
        el.appendChild(k);
        t.to(k, { opacity: 0, duration: 0.01, repeat: Math.floor((at + 0.6) / 0.5), yoyo: true, repeatDelay: 0.24, ease: "none" }, 0);
      }
      t.to({}, { duration: 0.001 }, at);
      return t;
    },

    // A word inside a box rolls to the next word while the box resizes to fit it (box anchored left)
    // Markup: <span class="ms-swap" data-ms="swap"></span>, styled with background (via --bg) and padding.
    wordSwap(el, words, { hold = 0.7, first, dur = 0.42, ease = "ms.rest", bg = "currentColor", fg, pad = "0 .2em", start = 0 } = {}) {
      el = $(el);
      el.innerHTML = `<span class="ms-swap-bg" style="background:${bg}"></span><span class="ms-swap-win" style="padding:${pad};display:block;${fg ? `color:${fg}` : ""}"><span class="ms-swap-track">${words.map(w => `<span>${w}</span>`).join("")}</span></span>`;
      const bgEl = el.querySelector(".ms-swap-bg"), track = el.querySelector(".ms-swap-track"), win = el.querySelector(".ms-swap-win");
      const lines = [...track.children];
      const lh = lines[0].offsetHeight;
      const padX = win.offsetWidth - win.clientWidth + (parseFloat(getComputedStyle(win).paddingLeft) + parseFloat(getComputedStyle(win).paddingRight));
      const widths = lines.map(l => l.offsetWidth + padX);
      const max = Math.max(...widths);
      win.style.height = lh + "px";
      el.style.width = max + "px";
      // The window clips to the current word's width too, so the next word does not show beside a short one
      const clipFor = i => `inset(0 ${max - widths[i]}px 0 0)`;
      const t = tl();
      t.set(bgEl, { scaleX: widths[start] / max }, 0).set(track, { y: -lh * start }, 0).set(win, { clipPath: clipFor(start) }, 0);
      let at = first ?? hold;
      for (let i = start + 1; i < words.length; i++) {
        t.to(track, { y: -lh * i, duration: dur, ease }, at)
          .to(bgEl, { scaleX: widths[i] / max, duration: dur, ease }, at)
          .to(win, { clipPath: clipFor(i), duration: dur, ease }, at);
        at += dur + hold;
      }
      // Widths let a scene place what follows the last word (the box itself is as wide as the widest word)
      t.data = { widths, max };
      return t;
    },

    // Camera: move and scale `world` so `target` sits at `to` (frame centre by default) at `scale`.
    // world needs transform-origin 0 0 (set here). target may also be a point [x, y] in world coordinates.
    cameraPush(world, target, { scale = 1.6, dur = 1.1, ease = "ms.cam", to, offset = [0, 0] } = {}) {
      world = $(world);
      gsap.set(world, { transformOrigin: "0 0" });
      const [fw, fh] = frame();
      const [cx, cy] = Array.isArray(target) ? target : centre(target, world.offsetParent || document.body).map((v, i) => v - (i ? world.offsetTop : world.offsetLeft));
      const [tx, ty] = to || [fw / 2, fh / 2];
      return tl().to(world, { x: tx - scale * cx - world.offsetLeft + offset[0], y: ty - scale * cy - world.offsetTop + offset[1], scale, duration: dur, ease });
    },

    // Reset the camera to identity
    cameraReset(world, { dur = 0.9, ease = "ms.cam" } = {}) {
      return tl().to($(world), { x: 0, y: 0, scale: 1, duration: dur, ease });
    },

    // Cards burst out from a point (behind a word, a logo) to their own layout spots, slight seeded tilt, nearest first
    cardBurst(cards, { from, dur = 0.7, stagger = 0.04, tilt = 8, ease = "ms.out", seed = 3 } = {}) {
      const els = $$(cards);
      const parent = els[0].offsetParent || document.body;
      const [ox, oy] = from ? (Array.isArray(from) ? from : centre(from, parent)) : [parent.offsetWidth / 2, parent.offsetHeight / 2];
      const r = rand(seed);
      const order = els.map(el => { const [x, y] = centre(el, parent); return { el, dx: ox - x, dy: oy - y, d: Math.hypot(ox - x, oy - y), rot: (r() - 0.5) * 2 * tilt }; })
        .sort((a, b) => a.d - b.d);
      const t = tl();
      order.forEach((o, i) => {
        // tilt 0 keeps each card's own rotation (set in CSS) as the landing angle
        if (tilt) gsap.set(o.el, { rotation: o.rot });
        t.from(o.el, { x: o.dx, y: o.dy, scale: 0.2, rotation: 0, autoAlpha: 0, duration: dur, ease }, i * stagger);
      });
      return t;
    },

    // Masonry columns rise in turn and keep drifting against each other (parallax). Tiles fade up inside each column
    masonryRise(cols, { dist = 220, dur = 0.9, stagger = 0.07, drift = 60, driftDur = 2, fade = 0.24, tiles = ":scope > *" } = {}) {
      const els = $$(cols);
      const t = tl();
      t.from(els, { y: dist, duration: dur, stagger, ease: "ms.rest" }, 0);
      els.forEach((c, i) => {
        const kids = [...c.querySelectorAll(tiles)];
        t.from(kids, { autoAlpha: 0, duration: fade, stagger: 0.06, ease: "ms.smooth" }, i * stagger);
      });
      if (drift) els.forEach((c, i) => t.to(c, { y: i % 2 ? drift * 0.6 : -drift, duration: driftDur, ease: "ms.smooth" }, dur + i * stagger));
      return t;
    },

    // A cursor glides to a target on a slight arc (x and y on different eases), then optionally clicks it.
    // target may be a point [x, y] in the cursor's parent (when a camera has scaled the target); hit is then the
    // element that answers the click
    cursorTo(cursor, target, { dur = 0.75, click = true, tip = [0, 0], press = 0.88, hit } = {}) {
      cursor = $(cursor);
      const parent = cursor.offsetParent || document.body;
      const [x, y] = Array.isArray(target) ? target : centre(target, parent);
      const t = tl();
      t.to(cursor, { x: x - cursor.offsetLeft - tip[0], duration: dur, ease: "ms.rest" }, 0)
        .to(cursor, { y: y - cursor.offsetTop - tip[1], duration: dur, ease: "ms.glide" }, 0);
      if (click) t.add(moves.click(cursor, Array.isArray(target) ? hit : target, { press }), dur - 0.05);
      return t;
    },

    // Press: cursor and target dip together, the target releases a little later (the UI answering)
    click(cursor, target, { press = 0.88 } = {}) {
      const t = tl();
      t.to($(cursor), { scale: press, duration: 0.08, ease: "ms.ui" }, 0)
        .to($(cursor), { scale: 1, duration: 0.18, ease: "ms.out" }, 0.08);
      if (target) t.to($(target), { scale: 0.96, duration: 0.08, ease: "ms.ui" }, 0.02)
        .to($(target), { scale: 1, duration: 0.24, ease: "ms.out" }, 0.1);
      return t;
    },

    // A dialog arrives: scale up from slightly small, out of blur, with a soft rise
    modalIn(el, { dur = 0.45, blur = 12 } = {}) {
      return tl().from($(el), { scale: 0.9, y: 24, autoAlpha: 0, filter: `blur(${blur}px)`, duration: dur, ease: "ms.out" });
    },

    // A toast slides up into place, holds, and leaves down (leave = false keeps it)
    toast(el, { hold = 1.4, dist = 40, leave = true } = {}) {
      const t = tl().from($(el), { y: dist, autoAlpha: 0, duration: 0.4, ease: "ms.out" });
      if (leave) t.to($(el), { y: dist / 2, autoAlpha: 0, duration: 0.24, ease: "ms.exit" }, 0.4 + hold);
      return t;
    },

    // Blur-in type: words sharpen into place
    blurIn(el, { by = "words", dur = 0.6, stagger = 0.09, blur = 16, y = 24 } = {}) {
      const w = split(el, by);
      w.forEach(x => x.parentElement.style.overflow = "visible");
      return tl().from(w, { y, autoAlpha: 0, filter: `blur(${blur}px)`, duration: dur, stagger, ease: "ms.out" });
    },

    // Hard-cut staccato: shots shown one after another for the given lengths (end-of-ad punch). Visibility only
    cuts(shots, lengths) {
      const els = $$(shots), t = tl();
      let at = 0;
      els.forEach((el, i) => {
        t.set(el, { visibility: "visible" }, at);
        at += lengths[i] ?? lengths[lengths.length - 1];
        if (i < els.length - 1) t.set(el, { visibility: "hidden" }, at);
      });
      return t;
    },

    // Slow drift during a hold, so nothing freezes (MOTION.md: a reading hold drifts)
    drift(el, dur, vars = { y: -12 }) {
      return tl().to($$(el), { ...vars, duration: dur, ease: "ms.smooth" });
    },
  };

  // Build once the fonts are in (moves measure text)
  MS.build = fn => {
    const go = () => fn();
    document.fonts && document.fonts.ready ? document.fonts.ready.then(go) : go();
  };
  MS.split = split;
  MS.rand = rand;
  MS.centre = centre;
  MS.moves = moves;

  // Music grid from beats.js (ms beat): MS.beat(i) = i-th beat, MS.bar(n, b) = beat b of bar n (both 0-based),
  // MS.snap(t) = nearest beat. Without a beat map they fall back to the tempo in MS_BEATS or 120 BPM from 0.
  const B = () => window.MS_BEATS || { bpm: 120, period: 0.5, beats: [], downbeats: [] };
  const grid = (list, i, step) => list[i] ?? (list.length ? list.at(-1) + (i - list.length + 1) * step : i * step);
  MS.beat = i => grid(B().beats, i, B().period);
  MS.bar = (n, b = 0) => grid(B().downbeats, n, 4 * B().period) + b * B().period;
  MS.snap = t => B().beats.reduce((a, x) => Math.abs(x - t) < Math.abs(a - t) ? x : a, Math.round(t / B().period) * B().period);
})();
