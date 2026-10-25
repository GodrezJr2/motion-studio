// Demo hero: masked headline, card fan, a dot that leaves the velocity curve and presses the button.
// House curves from MOTION.md: ms.out for arrivals, ms.rest for travel, ms.smooth for drawing, ms.land for the one
// true landing (the button taking the press). x and y use different eases so the dot's path curves.
const tl = gsap.timeline({ defaults: { ease: "ms.out" } });
const curve = document.querySelector(".card.c .curve");
const len = curve.getTotalLength();
gsap.set(curve, { strokeDasharray: len, strokeDashoffset: len });
gsap.set(".dot", { x: 1066, y: 282, scale: 0 });

tl.from(".bar", { autoAlpha: 0, y: -8, duration: 0.22, ease: "ms.smooth" }, 0)
  // Lines 1 and 3 set the frame; the line carrying the idea word lands last, as the punchline
  .from("[data-ms=line-1]", { yPercent: 105, duration: 0.9 }, 0.15)
  .from("[data-ms=line-3]", { yPercent: 105, duration: 0.9 }, 0.25)
  .from("[data-ms=line-2]", { yPercent: 105, duration: 1.1 }, 0.55)
  .from(".rule", { scaleX: 0, duration: 1.0, ease: "ms.smooth" }, 0.7)
  .from(".lede", { autoAlpha: 0, y: 14, duration: 0.8 }, 0.9)
  .from(".cta", { autoAlpha: 0, y: 16, duration: 0.7 }, 1.15)

  // The front card leads with the full rise; the back cards travel less, later, and fan wider
  .from(".card.c", { y: 560, duration: 1.4, ease: "ms.rest" }, 0.35)
  .from(".card.b", { y: 440, duration: 1.25, ease: "ms.rest" }, 0.47)
  .from(".card.a", { y: 360, duration: 1.1, ease: "ms.rest" }, 0.57)
  .to(".card.a", { x: -52, y: -20, rotation: -7, duration: 0.9, ease: "ms.rest" }, 1.75)
  .to(".card.b", { x: -18, y: -6, rotation: -4, duration: 0.9, ease: "ms.rest" }, 1.85)
  .to(".card.c", { x: 22, y: 10, rotation: 0, duration: 0.9, ease: "ms.rest" }, 1.95) // rests square: its small type stays crisp
  .to(curve, { strokeDashoffset: 0, duration: 1.2, ease: "ms.smooth" }, 2.1)

  // Dot: appears on the curve's peak, drops out of the card and sweeps left onto the button's own dot.
  // One gesture: the drop and the sweep overlap so the speed never falls to a trough mid-flight.
  .to(".dot", { scale: 1, duration: 0.45 }, 2.45)
  .to(".dot", { y: 792, duration: 1.5, ease: "ms.smooth", id: "dot-drop" }, 2.75)
  .to(".dot", { x: 102, duration: 2.4, ease: "ms.rest", id: "dot-sweep" }, 2.95)
  .to(".dot", { scale: 0.3, autoAlpha: 0, duration: 0.25, ease: "ms.smooth" }, 5.2)

  // Press: quick squash, one landing on release, fill sweeps behind the label (clipped by the pill)
  .to(".cta", { scale: 0.955, duration: 0.14, id: "press" }, 5.25)
  .to(".cta", { scale: 1, duration: 0.6, ease: "ms.land", id: "release" }, 5.39)
  .fromTo(".cta .fill", { scaleX: 0 }, { scaleX: 1, duration: 0.8 }, 5.29)

  // Hold the last frame
  .to({}, { duration: 0.7 }, 5.99);

const tc = document.querySelector(".bar .tc");
tl.eventCallback("onUpdate", () => {
  const f = Math.round(tl.time() * 60);
  tc.textContent = `00:${String(Math.floor(f / 60)).padStart(2, "0")}:${String(f % 60).padStart(2, "0")}`;
});

MS.register(tl, {
  width: 1440, height: 900, fps: 60, kind: "web",
  // Sound for the video cut only: a pop as the dot appears, air at the sweep's fastest point, a click on the press (earshot crisp kit)
  audio: { sfx: [
    { t: 2.45, sound: "pop", gain: -4 },
    { at: "dot-sweep", offset: 0.9, sound: "whoosh.short", gain: -4 },
    { at: "press", sound: "click" },
  ] },
});
