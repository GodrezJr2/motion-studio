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
    // SVG elements have no offset chain: fall back to the boxes on screen
    if (!("offsetLeft" in el)) {
      const r = el.getBoundingClientRect(), o = root.getBoundingClientRect();
      return [r.left - o.left + r.width / 2, r.top - o.top + r.height / 2];
    }
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
      // An <svg> cursor has no offsetLeft/offsetTop (x - undefined is NaN and the cursor lands at 0,0): read its CSS
      const css = getComputedStyle(cursor);
      const [left, top] = "offsetLeft" in cursor ? [cursor.offsetLeft, cursor.offsetTop] : [parseFloat(css.left) || 0, parseFloat(css.top) || 0];
      const t = tl();
      t.to(cursor, { x: x - left - tip[0], duration: dur, ease: "ms.rest" }, 0)
        .to(cursor, { y: y - top - tip[1], duration: dur, ease: "ms.glide" }, 0);
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

    // 3D camera: tween a world inside a perspective stage (MS.stage3D) to a pose. x/y/z move the world (z toward the
    // viewer = dolly in), rx/ry/rz turn it. Poses are absolute, so camera moves chain without drift
    camera3D(world, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, dur = 1.2, ease = "ms.cam" } = {}) {
      return tl().to($(world), { x, y, z, rotationX: rx, rotationY: ry, rotation: rz, duration: dur, ease });
    },

    // Cards float in z-depth around a point (EarnEdits): each flies in from deeper and lower to a seeded spot on one
    // of the depth layers; deeper cards are dimmer. Later cards land in front, so a stack builds toward the viewer.
    // spots: optional [[x, y, z, rot], ...] relative to `at`, else seeded inside `spread`
    cardStack3D(cards, { at = [0, 0], depths = [0, -260, -560], spread = [520, 300], spots, from = 900, dur = 0.8, stagger = 0.35, seed = 5, dim = 0.45, fade = true } = {}) {
      const els = $$(cards), r = rand(seed), t = tl();
      els.forEach((el, i) => {
        const [x, y, z, rot] = spots?.[i] ?? [(r() - 0.5) * spread[0], (r() - 0.5) * spread[1], depths[(els.length - 1 - i) % depths.length], (r() - 0.5) * 6];
        gsap.set(el, { x: at[0] + x, y: at[1] + y, z, rotation: rot, filter: `brightness(${1 - dim * (-z / Math.max(1, -Math.min(...depths)))})` });
        // fade false: the cards are on screen from the first frame (a cut into a stack already landing)
        t.from(el, { z: z - from, y: at[1] + y + 260, ...(fade && { autoAlpha: 0 }), duration: dur, ease: "ms.rest" }, i * stagger);
      });
      return t;
    },

    // A long row of cards in perspective (EarnEdits 18 s): laid along x inside a world turned by ry/rx, they fly up
    // into the row one after another; pair with camera3D to track along it
    cardRow3D(cards, { gap = 40, ry = -38, rx = 12, z = 0, rise = 500, dur = 0.7, stagger = 0.05 } = {}) {
      const els = $$(cards), t = tl();
      let x = 0;
      els.forEach((el, i) => {
        gsap.set(el, { x, y: 0, z: z - i * 30, rotationY: ry, rotationX: rx });
        x += el.offsetWidth * Math.cos(ry * Math.PI / 180) * 0.62 + gap;
        t.from(el, { y: rise, autoAlpha: 0, duration: dur, ease: "ms.rest" }, i * stagger);
      });
      t.data = { length: x };
      return t;
    },

    // A laptop (MS.laptop) flies in from depth, tilted back, and settles square to camera with its lid opening
    laptopReveal(el, { dur = 1.1, from = -1400, tilt = 32, lid = true, fade = true } = {}) {
      el = $(el);
      const t = tl().from(el, { z: from, rotationX: tilt, y: 120, ...(fade && { autoAlpha: 0 }), duration: dur, ease: "ms.rest" }, 0);
      const l = el.querySelector(".ms-lid");
      if (lid && l) t.from(l, { rotationX: -70, duration: dur * 0.9, ease: "ms.rest" }, dur * 0.15);
      return t;
    },

    // Push through: the camera dives into an element until it fills the frame (and past it, `over`), so it becomes
    // the next scene. `reveal` fades in over the last part of the push
    pushThrough(world, target, { over = 1.15, dur = 1.1, ease = "ms.cam", reveal, revealAt = 0.6 } = {}) {
      world = $(world);
      const el = $(target), [fw, fh] = frame();
      const scale = over * Math.max(fw / el.offsetWidth, fh / el.offsetHeight);
      const t = tl().add(moves.cameraPush(world, el, { scale, dur, ease }), 0);
      if (reveal) t.from($(reveal), { autoAlpha: 0, duration: dur * (1 - revealAt), ease: "ms.smooth" }, dur * revealAt);
      return t;
    },

    // Display type glitches (EarnEdits 16 s): an RGB split of the word jitters sideways and slices for `dur`, then
    // settles clean. Stepped on a seeded 15 fps grid like an AE wiggle with posterize time, so every seek is the same
    glitchType(el, { dur = 0.5, amp = 26, fps = 15, seed = 9, colors = ["#ff2a55", "#2ad8ff"] } = {}) {
      el = $(el);
      if (!el.querySelector(".ms-gl")) {
        // Only a static element needs a containing block; forcing relative on an absolute one turns it into a full-width block
        if (getComputedStyle(el).position === "static") el.style.position = "relative";
        const txt = el.innerHTML;
        el.insertAdjacentHTML("beforeend", colors.map(c => `<span class="ms-gl" aria-hidden="true" style="position:absolute;inset:0;color:${c};mix-blend-mode:screen;opacity:0;pointer-events:none">${txt}</span>`).join(""));
      }
      const layers = [...el.querySelectorAll(".ms-gl")], r = rand(seed), t = tl();
      const n = Math.max(1, Math.round(dur * fps));
      for (let k = 0; k < n; k++) {
        const a = amp * (1 - k / n);
        layers.forEach((l, j) => {
          const top = Math.floor(r() * 70), h = 10 + Math.floor(r() * 40);
          t.set(l, { opacity: 0.9, x: (j ? -1 : 1) * a * (0.3 + r()), clipPath: `inset(${top}% 0 ${Math.max(0, 100 - top - h)}% 0)` }, k / fps);
        });
        t.set(el, { skewX: (r() - 0.5) * a * 0.4, scaleX: 1 + (r() - 0.3) * a / 120 }, k / fps);
      }
      t.set(layers, { opacity: 0, x: 0, clipPath: "inset(0% 0 0% 0)" }, dur).set(el, { skewX: 0, scaleX: 1 }, dur);
      return t;
    },

    // Smear swap: the text stretches sideways into a blur and comes back as the next text (EarnEdits "Stop spending").
    // A cut hidden inside a smear; text is swapped at the widest point
    smearSwap(el, next, { dur = 0.32, stretch = 1.9, blur = 10 } = {}) {
      el = $(el);
      // A set records the old text, so seeking back restores it
      return tl()
        .to(el, { scaleX: stretch, filter: `blur(${blur}px)`, autoAlpha: 0.5, duration: dur / 2, ease: "ms.exit" }, 0)
        .set(el, { innerHTML: next }, dur / 2)
        .to(el, { scaleX: 1, filter: "blur(0px)", autoAlpha: 1, duration: dur / 2, ease: "ms.out" }, dur / 2);
    },

    // A file tree builds line by line (EarnEdits "Effects & Presets"): the guide line draws down, rows slide in.
    // at: optional start times per row (seconds into the move), else every `step`
    folderTree(el, { rows = ":scope > *", step = 0.5, at } = {}) {
      el = $(el);
      const items = [...el.querySelectorAll(rows)], t = tl();
      items.forEach((it, i) => t.from(it, { x: -18, autoAlpha: 0, duration: 0.45, ease: "ms.outSoft" }, at?.[i] ?? i * step));
      const guide = el.querySelector(".ms-guide");
      if (guide) t.from(guide, { scaleY: 0, transformOrigin: "50% 0", duration: 0.6, ease: "ms.smooth" }, 0);
      return t;
    },

    // Dust: seeded specks drifting through a dark field (texture under the type). Creates them inside `field`
    dust(field, { n = 60, dur = 10, seed = 21, color = "rgba(160,255,170,.55)", size = [1.5, 3.5], travel = 120 } = {}) {
      field = $(field);
      const r = rand(seed), [fw, fh] = [field.offsetWidth || frame()[0], field.offsetHeight || frame()[1]], t = tl();
      for (let i = 0; i < n; i++) {
        const d = document.createElement("i"), s = size[0] + r() * (size[1] - size[0]);
        d.style.cssText = `position:absolute;left:${r() * fw}px;top:${r() * fh}px;width:${s}px;height:${s}px;border-radius:50%;background:${color};opacity:${0.25 + r() * 0.6}`;
        field.appendChild(d);
        t.to(d, { x: (r() - 0.5) * travel, y: -travel * (0.3 + r()), duration: dur, ease: "none" }, 0);
      }
      return t;
    },

    // Warp: streaks fly out of a point like stars at lightspeed (EarnEdits "Introducing"): each one leaves the centre
    // along its own angle and stretches as it speeds up, then restarts. Creates them inside `field`; seeded, so seek-safe
    warp(field, { n = 140, dur = 2, life = 0.7, seed = 31, from, color = "rgba(190,255,200,.8)", len = [30, 170], reach = 1300 } = {}) {
      field = $(field);
      const r = rand(seed), [fw, fh] = frame(), [cx, cy] = from || [fw / 2, fh / 2], t = tl();
      for (let i = 0; i < n; i++) {
        const a = r() * Math.PI * 2, l = len[0] + r() * (len[1] - len[0]), d = document.createElement("i"), r0 = 40 + r() * 260;
        d.style.cssText = `position:absolute;left:${cx}px;top:${cy}px;width:${l}px;height:2px;border-radius:1px;background:linear-gradient(90deg,transparent,${color});transform-origin:0 50%`;
        field.appendChild(d);
        const k = life * (0.7 + r() * 0.6), cos = Math.cos(a), sin = Math.sin(a), p = r(), rot = a * 180 / Math.PI;
        // Already in flight on the first frame (a cut lands mid-warp): the first pass starts at phase p
        const at = q => ({ x: cos * (r0 + (reach - r0) * q * q), y: sin * (r0 + (reach - r0) * q * q), rotation: rot, scaleX: 0.2 + 1.2 * q, opacity: Math.min(1, q * 3) });
        t.fromTo(d, at(p), { ...at(1), duration: k * (1 - p), ease: "none" }, 0);
        t.fromTo(d, at(0), { ...at(1), duration: k, ease: "power2.in", repeat: Math.max(0, Math.floor((dur - k * (1 - p)) / k) - 1), immediateRender: false }, k * (1 - p));
      }
      return t;
    },
  };

  // A perspective stage: <div class="ms-stage3d"><div class="ms-world3d">...</div></div>, children positioned from
  // the stage centre (left/top 50%) so x/y/z read as offsets from the frame centre
  MS.stage3D = (el, { perspective = 1400 } = {}) => {
    el = $(el);
    el.style.cssText += `;position:absolute;inset:0;perspective:${perspective}px;perspective-origin:50% 50%;overflow:hidden`;
    const w = el.querySelector(".ms-world3d");
    if (w) w.style.cssText += ";position:absolute;left:50%;top:50%;width:0;height:0;transform-style:preserve-3d";
    for (const c of w ? w.children : []) c.style.cssText += ";position:absolute;transform-style:preserve-3d";
    return w;
  };

  // Laptop mock in CSS (base + lid with a screen): fill .ms-screen with the app UI or a screenshot
  MS.laptop = (el, { w = 900, screen = "" } = {}) => {
    el = $(el);
    const h = w * 0.62;
    el.style.cssText += `;width:${w}px;height:${h + 30}px;transform-style:preserve-3d`;
    el.innerHTML = `<div class="ms-lid" style="position:absolute;left:0;top:0;width:${w}px;height:${h}px;border-radius:${w * 0.03}px ${w * 0.03}px 6px 6px;background:#0d0f0e;border:${w * 0.012}px solid #2a2d2c;transform-origin:50% 100%;box-shadow:0 30px 80px rgba(0,0,0,.6)"><div class="ms-screen" style="position:absolute;inset:${w * 0.012}px;overflow:hidden;border-radius:4px;background:#111">${screen}</div></div>
      <div class="ms-base" style="position:absolute;left:${-w * 0.06}px;top:${h}px;width:${w * 1.12}px;height:${w * 0.022}px;border-radius:0 0 ${w * 0.03}px ${w * 0.03}px;background:linear-gradient(#3a3d3c,#1b1d1c)"></div>`;
    return el.querySelector(".ms-screen");
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
