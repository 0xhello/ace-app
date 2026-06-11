"use client";

/**
 * ACE Homepage v5 — "The Living Market".
 * Implemented from the Claude Design handoff (ace/project/ACE Homepage v5.html
 * + v5/scene.js + v5/style.css). One particle market that morphs through the
 * scroll: SPHERE → STREAMS → RECEIPT FIELD → SPLIT → SPHERE, scroll-scrubbed and
 * cursor-reactive. The Three.js scene runs in a fully-torn-down effect; styling
 * is scoped under .v5 (see v5-homepage.css). Fonts via next/font.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import * as THREE from "three";
import { Outfit, JetBrains_Mono } from "next/font/google";
import "./v5-homepage.css";

const outfit = Outfit({ subsets: ["latin"], weight: ["300", "400", "500", "600", "700"], display: "swap", variable: "--v5-outfit" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], display: "swap", variable: "--v5-mono" });

const KICKOFF_ISO = "2026-06-11T21:00:00-04:00";

export default function HomePage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [wcLabel, setWcLabel] = useState("WC2026");

  // Live WC chip (compute client-side to avoid hydration mismatch).
  useEffect(() => {
    const days = Math.max(0, Math.ceil((new Date(KICKOFF_ISO).getTime() - Date.now()) / 86_400_000));
    setWcLabel(days <= 0 ? "WC2026 · LIVE" : `WC2026 · ${days} DAY${days === 1 ? "" : "S"}`);
  }, []);

  const watchClick = () => {
    const el = document.getElementById("s-move");
    if (el) window.scrollTo({ top: el.offsetTop + window.innerHeight * 0.6, behavior: "smooth" });
  };

  // ── The Living Market scene ──────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isMobile = window.innerWidth < 700;
    const N = isMobile ? 2200 : 4600;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 60);
    camera.position.set(0, 0, 4.4);
    const group = new THREE.Group();
    scene.add(group);

    function makeDotTexture() {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const g = c.getContext("2d")!;
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.4, "rgba(255,255,255,0.7)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    }

    const GREEN = [0.24, 0.94, 0.55], WHITE = [0.62, 0.66, 0.64], DIMW = [0.34, 0.37, 0.36], RED = [0.94, 0.3, 0.3];
    const rand = (a: number, b: number) => a + Math.random() * (b - a);

    const posSphere = new Float32Array(N * 3);
    {
      const phi = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < N; i++) {
        const y = 1 - (i / (N - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        const th = phi * i;
        const R = 1.62 + rand(-0.025, 0.025);
        posSphere[i * 3] = Math.cos(th) * r * R;
        posSphere[i * 3 + 1] = y * R;
        posSphere[i * 3 + 2] = Math.sin(th) * r * R;
      }
    }

    const laneY = new Float32Array(N), laneZ = new Float32Array(N), laneSpeed = new Float32Array(N), lanePhase = new Float32Array(N);
    const SPAN = 14;
    {
      const LANES = 26;
      for (let i = 0; i < N; i++) {
        const li = i % LANES;
        laneY[i] = -2.2 + (li / (LANES - 1)) * 4.4 + rand(-0.05, 0.05);
        laneZ[i] = rand(-2.5, 1.2);
        laneSpeed[i] = rand(0.25, 1.4) * (li % 2 ? 1 : 0.7);
        lanePhase[i] = rand(0, SPAN);
      }
    }
    const posStreams = new Float32Array(N * 3);

    const posField = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      posField[i * 3] = rand(-4.4, 4.4);
      posField[i * 3 + 1] = rand(-2.6, 2.6);
      posField[i * 3 + 2] = rand(-7, 3.4);
    }

    const posSplit = new Float32Array(N * 3);
    const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 0.9;
    for (let i = 0; i < N; i++) {
      const left = i % 2 === 0;
      posSplit[i * 3] = (left ? -1.9 : 1.9) + gauss() * 0.75;
      posSplit[i * 3 + 1] = gauss() * 0.95;
      posSplit[i * 3 + 2] = gauss() * 0.8 - 0.4;
    }

    function buildColors(fn: (i: number) => number[]) {
      const a = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) { const c = fn(i); a[i * 3] = c[0]; a[i * 3 + 1] = c[1]; a[i * 3 + 2] = c[2]; }
      return a;
    }
    const colSphere = buildColors((i) => (i % 5 === 0 ? GREEN : i % 3 === 0 ? WHITE : DIMW));
    const colStreams = buildColors((i) => (i % 4 === 0 ? GREEN : WHITE));
    const colField = buildColors((i) => { const r = i % 10; return r < 5 ? GREEN : r < 8 ? RED : DIMW; });
    const colSplit = buildColors((i) => (i % 2 === 0 ? GREEN : DIMW));
    const colCalm = buildColors((i) => (i % 6 === 0 ? GREEN : DIMW));

    const STATES: Record<string, { pos: Float32Array; col: Float32Array }> = {
      sphere: { pos: posSphere, col: colSphere },
      streams: { pos: posStreams, col: colStreams },
      field: { pos: posField, col: colField },
      split: { pos: posSplit, col: colSplit },
      sphere2: { pos: posSphere, col: colCalm },
    };

    const geom = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(new Float32Array(posSphere), 3);
    const colAttr = new THREE.BufferAttribute(new Float32Array(colSphere), 3);
    geom.setAttribute("position", posAttr);
    geom.setAttribute("color", colAttr);
    const dotTex = makeDotTexture();
    const mat = new THREE.PointsMaterial({
      size: isMobile ? 0.026 : 0.02, map: dotTex, vertexColors: true, transparent: true,
      opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    const points = new THREE.Points(geom, mat);
    group.add(points);

    const arcGroup = new THREE.Group();
    group.add(arcGroup);
    const arcMats: THREE.LineBasicMaterial[] = [];
    const arcGeoms: THREE.BufferGeometry[] = [];
    {
      const ARCS = isMobile ? 36 : 80;
      for (let a = 0; a < ARCS; a++) {
        const i1 = Math.floor(Math.random() * N), i2 = Math.floor(Math.random() * N);
        const p1 = new THREE.Vector3(posSphere[i1 * 3], posSphere[i1 * 3 + 1], posSphere[i1 * 3 + 2]);
        const p2 = new THREE.Vector3(posSphere[i2 * 3], posSphere[i2 * 3 + 1], posSphere[i2 * 3 + 2]);
        if (p1.distanceTo(p2) < 0.8 || p1.distanceTo(p2) > 2.6) { a--; continue; }
        const mid = p1.clone().add(p2).multiplyScalar(0.5).normalize().multiplyScalar(1.62 * rand(1.12, 1.38));
        const curve = new THREE.QuadraticBezierCurve3(p1, mid, p2);
        const g = new THREE.BufferGeometry().setFromPoints(curve.getPoints(28));
        const m = new THREE.LineBasicMaterial({
          color: a % 3 === 0 ? 0x3ef08b : 0x9ab0a4, transparent: true,
          opacity: rand(0.06, 0.2), blending: THREE.AdditiveBlending, depthWrite: false,
        });
        m.userData = { base: m.opacity, phase: rand(0, Math.PI * 2), speed: rand(0.4, 1.4) };
        arcMats.push(m); arcGeoms.push(g);
        arcGroup.add(new THREE.Line(g, m));
      }
    }

    const el = (id: string) => document.getElementById(id);
    const S = { hero: el("s-hero"), move: el("s-move"), rec: el("s-receipts"), split: el("s-split"), thesis: el("s-thesis"), cta: el("s-cta") };
    let KEYS: Array<{ y: number; s: string; z: number }> = [];
    function buildKeys() {
      const vh = window.innerHeight;
      const top = (e: HTMLElement | null) => e?.offsetTop ?? 0;
      const stickySpan = (e: HTMLElement | null) => Math.max((e?.offsetHeight ?? vh) - vh, 1);
      const maxY = Math.max(document.body.scrollHeight - vh, 1);
      KEYS = [
        { y: 0, s: "sphere", z: 4.4 },
        { y: top(S.move) - vh * 0.4, s: "sphere", z: 4.2 },
        { y: top(S.move) + stickySpan(S.move) * 0.3, s: "streams", z: 3.5 },
        { y: top(S.move) + stickySpan(S.move) * 0.95, s: "streams", z: 3.3 },
        { y: top(S.rec) + stickySpan(S.rec) * 0.22, s: "field", z: 3.8 },
        { y: top(S.rec) + stickySpan(S.rec) * 1.0, s: "field", z: 0.4 },
        { y: top(S.split) + stickySpan(S.split) * 0.3, s: "split", z: 4.7 },
        { y: top(S.split) + stickySpan(S.split) * 1.0, s: "split", z: 4.7 },
        { y: top(S.thesis) + stickySpan(S.thesis) * 0.45, s: "sphere2", z: 4.8 },
        { y: maxY, s: "sphere2", z: 4.3 },
      ];
    }

    const smooth = (t: number) => t * t * (3 - 2 * t);
    const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

    let mx = 0, my = 0, tmx = 0, tmy = 0;
    const onPointer = (e: PointerEvent) => { tmx = (e.clientX / window.innerWidth) * 2 - 1; tmy = (e.clientY / window.innerHeight) * 2 - 1; };
    window.addEventListener("pointermove", onPointer, { passive: true });

    let scrollSmooth = window.scrollY;
    const sectionProgress = (sec: HTMLElement | null) => {
      if (!sec) return 0;
      const span = Math.max(sec.offsetHeight - window.innerHeight, 1);
      return clamp01((scrollSmooth - sec.offsetTop) / span);
    };

    const beatLines = [
      '<span class="dim">News breaks.</span> A starter is ruled out.',
      'Sharp money hits. <span class="grn">Pinnacle moves in seconds.</span>',
      'Retail books lag. <span class="grn">For 24 seconds, the gap is open.</span>',
    ];
    const clockStamps = ["23:42:07", "23:42:09", "23:42:31"];
    let lastBeat = -1;
    const beatLineEl = el("beat-line"), clockEl = el("beat-clock"), bigOddsEl = el("big-odds-num");
    const bookEls = Array.from(document.querySelectorAll<HTMLElement>("#s-move .bk"));
    const bookData = [
      { from: -118, to: -176, at: 0.32 }, { from: -118, to: -172, at: 0.4 }, { from: -116, to: -158, at: 0.55 },
      { from: -118, to: -150, at: 0.66 }, { from: -115, to: -148, at: 0.78 }, { from: -118, to: -142, at: 0.9 },
    ];
    function updateMove(p: number) {
      const beat = p < 0.34 ? 0 : p < 0.62 ? 1 : 2;
      if (beat !== lastBeat) {
        lastBeat = beat;
        if (beatLineEl) beatLineEl.innerHTML = beatLines[beat];
        if (clockEl) clockEl.innerHTML = "T · <em>" + clockStamps[beat] + "</em> ET";
      }
      if (bigOddsEl) bigOddsEl.textContent = String(Math.round(-118 - smooth(clamp01((p - 0.25) / 0.6)) * 60));
      bookEls.forEach((b, i) => {
        const d = bookData[i]; const moved = p > d.at;
        const val = moved ? Math.round(d.from + (d.to - d.from) * smooth(clamp01((p - d.at) / 0.12))) : d.from;
        const v = b.querySelector(".v"); if (v) v.textContent = String(val);
        b.classList.toggle("moved", moved && i < 2);
        b.classList.toggle("lag", !moved && p > 0.5 && i >= 2);
      });
    }

    const rcards = Array.from(document.querySelectorAll<HTMLElement>(".receipt-card")).map((e) => ({ el: e, a: reduceMotion ? 1 : 0 }));
    function updateReceipts(p: number) {
      rcards.forEach((c, i) => {
        const target = p > 0.28 + i * 0.16 ? 1 : 0;
        c.a += (target - c.a) * (reduceMotion ? 1 : 0.09);
        const drift = reduceMotion ? 0 : (p - 0.5) * (i % 2 ? -50 : 38);
        c.el.style.opacity = c.a.toFixed(3);
        c.el.style.transform = "translateY(" + (18 * (1 - c.a) + drift).toFixed(1) + "px)";
      });
    }

    const gapEl = el("gap-val"), sharpEl = el("sharp-price"), softEl = el("soft-price");
    function updateSplit(p: number) {
      const t = smooth(clamp01((p - 0.2) / 0.5));
      if (gapEl) gapEl.textContent = "+" + (t * 6.2).toFixed(1) + "%";
      if (sharpEl) sharpEl.textContent = String(Math.round(-148 - t * 24));
      if (softEl) softEl.textContent = "-148";
    }

    const chips = Array.from(document.querySelectorAll<HTMLElement>(".odds-chip"));
    let chipInterval: ReturnType<typeof setInterval> | null = null;
    if (!reduceMotion) {
      chipInterval = setInterval(() => {
        const c = chips[Math.floor(Math.random() * chips.length)];
        if (!c) return;
        const v = c.querySelector(".val")!; let n = parseInt(v.textContent || "0", 10);
        n += Math.random() > 0.5 ? 2 : -2; v.textContent = n > 0 ? "+" + n : String(n);
        const mv = c.querySelector(".mv")!; const up = Math.random() > 0.45;
        mv.textContent = up ? "▲" : "▼"; mv.className = "mv " + (up ? "mv-up" : "mv-dn");
        c.classList.remove("flash"); void c.offsetWidth; c.classList.add("flash");
      }, 1700);
    }

    const rvItems = Array.from(document.querySelectorAll<HTMLElement>(".v5 .rv")).map((e) => ({ el: e, start: 0, done: false }));
    function updateReveals(now: number) {
      if (reduceMotion) return;
      const limit = window.innerHeight - 8;
      let started = 0;
      for (const it of rvItems) {
        if (it.done) continue;
        if (!it.start) {
          const r = it.el.getBoundingClientRect();
          if (r.top < limit && r.bottom > 0) { it.start = now + started * 90; started++; }
          continue;
        }
        const k = Math.min(1, (now - it.start) / 750);
        if (k <= 0) continue;
        const e = 1 - Math.pow(1 - k, 3);
        it.el.style.opacity = e.toFixed(3);
        it.el.style.transform = "translateY(" + (26 * (1 - e)).toFixed(1) + "px)";
        if (k >= 1) it.done = true;
      }
    }
    updateReveals(performance.now());

    function resize() {
      const w = window.innerWidth, h = window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      buildKeys();
    }
    window.addEventListener("resize", resize);

    let time = 0, frame = 0, rafId = 0;
    const posArr = posAttr.array as Float32Array;
    const colArr = colAttr.array as Float32Array;
    function fillStreams(t: number) {
      for (let i = 0; i < N; i++) {
        posStreams[i * 3] = ((lanePhase[i] + t * laneSpeed[i]) % SPAN) - SPAN / 2;
        posStreams[i * 3 + 1] = laneY[i] + Math.sin(t * 0.6 + i) * 0.02;
        posStreams[i * 3 + 2] = laneZ[i];
      }
    }
    function tick() {
      rafId = requestAnimationFrame(tick);
      time += 0.016; frame++;
      scrollSmooth += (window.scrollY - scrollSmooth) * (reduceMotion ? 1 : 0.085);

      let a = KEYS[0], b = KEYS[KEYS.length - 1];
      for (let i = 0; i < KEYS.length - 1; i++) {
        if (scrollSmooth >= KEYS[i].y && scrollSmooth <= KEYS[i + 1].y) { a = KEYS[i]; b = KEYS[i + 1]; break; }
        if (scrollSmooth > KEYS[KEYS.length - 1].y) { a = b = KEYS[KEYS.length - 1]; }
      }
      const t = a === b ? 0 : smooth(clamp01((scrollSmooth - a.y) / Math.max(b.y - a.y, 1)));
      if (a.s === "streams" || b.s === "streams") fillStreams(time);

      const A = STATES[a.s], B = STATES[b.s];
      const pa = A.pos, pb = B.pos, ca = A.col, cb = B.col;
      for (let i = 0; i < N * 3; i++) {
        posArr[i] = pa[i] + (pb[i] - pa[i]) * t;
        colArr[i] = ca[i] + (cb[i] - ca[i]) * t;
      }
      posAttr.needsUpdate = true; colAttr.needsUpdate = true;
      camera.position.z = a.z + (b.z - a.z) * t;

      const wA = a.s === "sphere" || a.s === "sphere2" ? 1 : 0;
      const wB = b.s === "sphere" || b.s === "sphere2" ? 1 : 0;
      const sphereW = wA + (wB - wA) * t;
      if (!reduceMotion) {
        group.rotation.y += 0.0016 * sphereW + 0.0002;
        mx += (tmx - mx) * 0.04; my += (tmy - my) * 0.04;
        group.rotation.x = my * 0.12 * sphereW;
        group.rotation.z = mx * 0.04 * sphereW;
        camera.position.x = mx * 0.18; camera.position.y = -my * 0.12;
        camera.lookAt(0, 0, 0);
      }
      arcGroup.visible = sphereW > 0.02;
      if (arcGroup.visible) {
        for (let i = 0; i < arcMats.length; i++) {
          const m = arcMats[i];
          const pulse = reduceMotion ? 1 : 0.6 + 0.4 * Math.sin(time * m.userData.speed + m.userData.phase);
          m.opacity = m.userData.base * sphereW * pulse;
        }
      }
      updateReveals(performance.now());
      if (frame % 2 === 0) {
        updateMove(sectionProgress(S.move));
        updateReceipts(sectionProgress(S.rec));
        updateSplit(sectionProgress(S.split));
      }
      renderer.render(scene, camera);
    }

    resize();
    const keyTimer = setTimeout(buildKeys, 400);
    const onLoad = () => buildKeys();
    window.addEventListener("load", onLoad);
    tick();

    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(keyTimer);
      if (chipInterval) clearInterval(chipInterval);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("resize", resize);
      window.removeEventListener("load", onLoad);
      geom.dispose(); mat.dispose(); dotTex.dispose();
      arcMats.forEach((m) => m.dispose());
      arcGeoms.forEach((g) => g.dispose());
      renderer.dispose();
    };
  }, []);

  return (
    <div className={`v5 ${outfit.variable} ${mono.variable}`}>
      <canvas id="market-canvas" ref={canvasRef} />
      <div className="vignette" />

      <nav className="v5-nav">
        <div className="nav-left">
          <Link className="brand" href="/">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/ace-logo.png" alt="ACE" />
            <span>ACE</span>
          </Link>
          <div className="links">
            <a href="#s-move">The Market</a>
            <a href="#s-receipts">Receipts</a>
            <a href="#s-split">Sharp vs Soft</a>
            <a href="#s-thesis">Thesis</a>
          </div>
        </div>
        <div className="nav-right">
          <span className="wc-chip mono"><span className="dot" />{wcLabel}</span>
          <Link className="login" href="/login">Log in</Link>
          <Link className="btn-cta" href="/register">Enter ACE</Link>
        </div>
      </nav>

      <main>
        {/* HERO */}
        <section id="s-hero" data-screen-label="Hero — The Living Market">
          <div className="hero-inner">
            <div className="hero-kicker rv">A WINDOW INTO THE SPORTS MARKET ITSELF</div>
            <h1 className="rv">The market<br />is <span className="alive">alive.</span></h1>
            <p className="hero-sub rv">
              Forty-three sportsbooks. One living organism. ACE watches every price,
              every move, every signal — so you see the market think before you bet into it.
            </p>
            <div className="hero-ctas rv">
              <Link className="btn-cta" href="/register">Enter ACE →</Link>
              <button className="btn-ghost" id="watch-btn" onClick={watchClick}>Watch it move ↓</button>
            </div>
            <div className="hero-note rv">NO CREDIT CARD · FREE TIER LIVE · NOT A SPORTSBOOK</div>
          </div>

          <div className="odds-chip" style={{ top: "24vh", left: "9vw" }}><span className="lg">WC</span><span>ARG/MEX</span><span className="val">-148</span><span className="mv mv-up">▲</span></div>
          <div className="odds-chip" style={{ top: "33vh", right: "8vw" }}><span className="lg">NBA</span><span>BOS/MIA</span><span className="val">-110</span><span className="mv mv-dn">▼</span></div>
          <div className="odds-chip" style={{ top: "56vh", left: "13vw" }}><span className="lg">WC</span><span>BRA/SRB</span><span className="val">-245</span><span className="mv mv-up">▲</span></div>
          <div className="odds-chip" style={{ top: "62vh", right: "12vw" }}><span className="lg">MLB</span><span>LAD/SF</span><span className="val">+115</span><span className="mv mv-up">▲</span></div>
          <div className="odds-chip" style={{ top: "18vh", right: "26vw" }}><span className="lg">WC</span><span>FRA/DEN</span><span className="val">-132</span><span className="mv mv-dn">▼</span></div>

          <div className="scroll-hint mono">SCROLL<span className="bar" /></div>
        </section>

        {/* S2 · THE MARKET MOVES FIRST */}
        <section id="s-move" data-screen-label="The Market Moves First">
          <div className="sticky-frame">
            <div className="beat-stage">
              <div className="kicker" style={{ justifyContent: "center" }}>01 · THE MARKET MOVES FIRST</div>
              <div className="clock mono" id="beat-clock" style={{ marginTop: 26 }}>T · <em>23:42:07</em> ET</div>
              <div className="beat-line" id="beat-line"><span className="dim">News breaks.</span> A starter is ruled out.</div>

              <div className="big-odds">
                <span className="pair mono">BOS&nbsp;ML</span>
                <span className="num mono" id="big-odds-num">-118</span>
                <span className="pair mono">43&nbsp;BOOKS</span>
              </div>

              <div className="bookrow">
                <div className="bk mono"><span>PIN</span><span className="v">-118</span></div>
                <div className="bk mono"><span>CIR</span><span className="v">-118</span></div>
                <div className="bk mono"><span>DK</span><span className="v">-116</span></div>
                <div className="bk mono"><span>FD</span><span className="v">-118</span></div>
                <div className="bk mono"><span>MGM</span><span className="v">-115</span></div>
                <div className="bk mono"><span>CZR</span><span className="v">-118</span></div>
              </div>

              <p className="beat-caption">
                Information becomes price. ACE watches it happen in real time —
                so you see the move, not the aftermath.
              </p>
            </div>
          </div>
        </section>

        {/* S3 · RECEIPTS */}
        <section id="s-receipts" data-screen-label="Every Signal Leaves a Receipt">
          <div className="sticky-frame">
            <div className="rcp-head">
              <div className="kicker" style={{ justifyContent: "center" }}>02 · EVERY SIGNAL LEAVES A RECEIPT</div>
              <h2>14,382 signals.<br /><span className="grn">All public.</span></h2>
              <p className="rcp-sub">
                Every call ACE has ever made is graded and kept — wins in green,
                losses in red. Fly through them. Nothing is deleted.
              </p>
              <div className="rcp-stats">
                <div className="stat-chip"><div className="n grn">68.4%</div><div className="l">L10K ACCURACY</div></div>
                <div className="stat-chip"><div className="n grn">+4.8%</div><div className="l">AVG CLV CLOSED</div></div>
                <div className="stat-chip"><div className="n">0</div><div className="l">RECEIPTS DELETED</div></div>
              </div>
            </div>

            <div className="receipt-card win" style={{ top: "16vh", left: "6vw" }}>
              <div className="rc-top"><span>SIG-13208</span><span className="rc-result">WIN ✓</span></div>
              <div className="rc-pick">ARG ML −142 → closed −178</div>
              <div className="rc-meta"><span className="k">CLV</span><span className="rc-result">+6.1%</span></div>
            </div>
            <div className="receipt-card loss" style={{ top: "30vh", right: "5vw" }}>
              <div className="rc-top"><span>SIG-13391</span><span className="rc-result">LOSS ×</span></div>
              <div className="rc-pick">MIL −6.5 −110 → lost by 3</div>
              <div className="rc-meta"><span className="k">CLV</span><span style={{ color: "var(--green)" }}>+2.2%</span></div>
            </div>
            <div className="receipt-card win" style={{ bottom: "14vh", left: "12vw" }}>
              <div className="rc-top"><span>SIG-14005</span><span className="rc-result">WIN ✓</span></div>
              <div className="rc-pick">U 8.5 −108 → final 7</div>
              <div className="rc-meta"><span className="k">CLV</span><span className="rc-result">+3.4%</span></div>
            </div>
          </div>
        </section>

        {/* S4 · SHARP VS SOFT */}
        <section id="s-split" data-screen-label="Sharp vs Soft Books">
          <div className="sticky-frame">
            <div className="split-stage">
              <div className="split-head">
                <div className="kicker" style={{ justifyContent: "center" }}>03 · SHARP VS SOFT</div>
                <h2>Two markets. <span className="dim">One price is wrong.</span></h2>
              </div>
              <div className="split-cols">
                <div className="side-panel sharp">
                  <div className="sp-tag mono">SHARP CONSENSUS · PINNACLE / CIRCA</div>
                  <div className="sp-price mono" id="sharp-price">-148</div>
                  <div className="sp-note">Where professional money sets the real number. Moves in seconds.</div>
                </div>
                <div className="gap-core">
                  <div className="gp-label mono">THE GAP</div>
                  <div className="gp-val mono" id="gap-val">+0.0%</div>
                  <div className="gp-sub mono">THE GAP IS THE EDGE</div>
                </div>
                <div className="side-panel soft">
                  <div className="sp-tag mono">RETAIL BOOKS · DK / FD / MGM</div>
                  <div className="sp-price mono" id="soft-price">-148</div>
                  <div className="sp-note">Where the public bets. Lags the sharp number — sometimes by minutes.</div>
                </div>
              </div>
              <p className="split-caption">
                When retail lags sharp, a window opens. ACE measures that gap on
                every market, every minute — <span className="grn">and shows you where it&apos;s widest.</span>
              </p>
            </div>
          </div>
        </section>

        {/* S5 · THESIS */}
        <section id="s-thesis" data-screen-label="The ACE Thesis">
          <div className="sticky-frame">
            <div className="thesis-stage">
              <div className="kicker rv" style={{ justifyContent: "center" }}>04 · THE THESIS</div>
              <div className="th-line1 rv" style={{ marginTop: 28 }}>Sportsbooks sell action.</div>
              <div className="th-line2 rv">ACE measures <span className="grn">markets.</span></div>
              <div className="th-creed">
                <div className="creed-row rv"><span className="no">PICKS-GURU THEATER</span><span className="idx">01</span></div>
                <div className="creed-row rv"><span className="no">FAKE CERTAINTY</span><span className="idx">02</span></div>
                <div className="creed-row rv"><span className="no">LUCKY LOCKS OF THE DAY</span><span className="idx">03</span></div>
                <div className="creed-row rv"><span className="yes">ONLY EVIDENCE</span><span className="idx">04</span></div>
                <div className="creed-row rv"><span className="yes">ONLY RECEIPTS</span><span className="idx">05</span></div>
                <div className="creed-row rv"><span className="yes">ONLY WHAT CHANGED</span><span className="idx">06</span></div>
              </div>
            </div>
          </div>
        </section>

        {/* S6 · CTA */}
        <section id="s-cta" data-screen-label="Final CTA">
          <div className="cta-inner">
            <div className="kicker rv" style={{ justifyContent: "center" }}>— READY —</div>
            <h2 className="rv" style={{ marginTop: 28 }}>Understand the market<br /><span className="grn">before you bet into it.</span></h2>
            <p className="cta-sub rv">
              Free tier is live. No card, two minutes to set up — and the
              World Cup market opens tomorrow.
            </p>
            <div className="cta-btns rv">
              <Link className="btn-cta" href="/register">Enter ACE →</Link>
              <Link className="btn-ghost" href="/dashboard">See the live board</Link>
            </div>
            <div className="cta-note rv">21+ · GAMBLE RESPONSIBLY · 1-800-GAMBLER</div>
          </div>

          <footer className="v5-footer">
            <div className="f-brand">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/ace-logo.png" alt="ACE" />
              <span className="f-legal">© 2026 ACE INTELLIGENCE</span>
            </div>
            <div className="f-links">
              <a href="#s-move">Product</a>
              <a href="#s-thesis">Manifesto</a>
              <Link href="/register">Pricing</Link>
              <a href="#">Privacy</a>
            </div>
            <div className="f-legal">NOT A SPORTSBOOK · NEVER PLACED A BET</div>
          </footer>
        </section>
      </main>
    </div>
  );
}
