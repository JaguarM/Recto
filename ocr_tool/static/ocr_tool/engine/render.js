// render.js — the reader's laws run FORWARDS: given a glyph set, a string and
// a pen, produce the page bytes mupdf would have produced. Everything in
// ocr-engine.js inverts these laws one glyph at a time; this file is the only
// place that applies them in the drawing direction, so a rendered line is
// something the reader can certify (render → readPage → clean, transcript
// equal) and something a page can be diffed against pixel by pixel.
//
// DOM-free and asset-free like ocr-engine.js: works as a browser global
// (root.OCRRender) and as a Node module. Glyph records are the exact shape
// tools/glyph-bundle.mjs / blindocr.js materializeSet produce ({ch, adv, phx,
// w, h, dx, dy, bytes, alpha, ink, …}); sets are {byPhy, linear, sizePx, …}.
//
// The laws, each measured rather than assumed (docs/LAWS.md):
//   §1 pen lattice   x snaps to the nearest ¼ px, y to the nearest whole px,
//                    both rounding half up — certified against mupdf fillText
//                    at every 1/64 phase by ftclone/certify-render.mjs
//   §2 blend         e = cov + (cov>>7); dst = (dst·(256−e))>>8, applied once
//                    per glyph in drawing order (repeated draws compose)
//   §4 linear law    raw bytes composite multiplicatively in 255-space with
//                    floor; the page byte carries +1 per contributing light
//                    pixel — the same arithmetic scanLine's accept step uses
//   y-phase          mupdf rounds y to an integer (phy 0). Some legacy sets
//                    also carry ½-phase rasters and the reader may pin a line
//                    to them (L.phy = 0.5; docs/FONTS.md) — pass that phy in
//                    so the line is re-drawn with the records the reader
//                    matched; placement is the same, row = baseline + dy
//
// Pixel placement is scanLine's, verbatim: a glyph accepted at pen p sits at
// column floor(p) + dx + col, row baseline + dy + row, with phx = p − floor(p).
(function (root) {
  'use strict';

  // ---- the lattice (LAWS §1) ----
  // mupdf holds the pen as a 32-bit float (fz_matrix), so the value that gets
  // rounded is fround(x), not x: a double just under a tie (45.87499999999999,
  // reached by accumulating a non-dyadic advance) IS the tie in mupdf and
  // rounds up. certify-render.mjs caught exactly that on Nimbus Mono at 791.
  // In float32 the arithmetic fround(x)·4 + 0.5 is exact for any page-sized
  // pen, so computing it in doubles on fround(x) reproduces mupdf bit for bit.
  const snapX = x => Math.floor(Math.fround(x) * 4 + 0.5) / 4;   // nearest ¼ px, half up
  const snapY = y => Math.floor(Math.fround(y) + 0.5);           // nearest whole px, half up

  // ---- set index: (ch, ¼-px phase) -> record, per y-phase (phy 0 default) ----
  function glyphIndex(set, phy = 0) {
    const cache = set._rix ??= new Map();
    let m = cache.get(phy);
    if (m) return m;
    m = new Map();
    for (const g of set.byPhy.get(phy) ?? []) {
      const k = g.ch + '|' + (Math.round(g.phx * 4) & 3);
      if (!m.has(k)) m.set(k, g);                     // first record wins (bundle order)
    }
    cache.set(phy, m);
    return m;
  }

  // advance of a character in px, from any phase record (the advance is per
  // char, phase-independent); null when the set has no record for it
  function advanceOf(set, ch) {
    for (const phy of set.byPhy.keys()) {
      const idx = glyphIndex(set, phy);
      for (let p = 0; p < 4; p++) {
        const g = idx.get(ch + '|' + p);
        if (g) return g.adv;
      }
    }
    return null;
  }

  // ---- layout ----
  // Accumulates advances in FLOAT from x0 — PDF glyph positions are absolute,
  // the producer never snapped between glyphs — and snaps each pen to the
  // lattice only for drawing. Returns {glyphs:[{ch, pen, penRaw, adv}],
  // advanceW, missing:[ch]}. Spaces take opts.spaceAdv (the sets carry no
  // space glyph; the reader calibrates it from the page — spaceCalib). A
  // missing space advance or a character the set does not have is reported in
  // `missing` and contributes nothing; the caller decides what that means.
  function layoutLine(set, text, x0, opts) {
    const spaceAdv = opts?.spaceAdv ?? null;
    const glyphs = [], missing = [];
    let x = x0;
    for (const ch of text) {
      if (ch === ' ') {
        if (spaceAdv == null) { if (!missing.includes(' ')) missing.push(' '); continue; }
        x += spaceAdv;
        continue;
      }
      const adv = advanceOf(set, ch);
      if (adv == null) { if (!missing.includes(ch)) missing.push(ch); continue; }
      glyphs.push({ ch, pen: snapX(x), penRaw: x, adv });
      x += adv;
    }
    return { glyphs, advanceW: x - x0, missing };
  }

  // ---- compositing ----
  // glyphs: [{ch, pen, set?}] in DRAWING order (text order — the blend is
  // integer arithmetic and not commutative on composite pixels). opts.phy
  // selects the y-phase records (the reader's L.phy; 0 = mupdf's own).
  // Returns the smallest window holding every glyph: {x0, y0, w, h, gray,
  // hits, missing, baseline}. gray = predicted page byte per pixel, 255 where
  // nothing was drawn; hits = how many glyphs inked each pixel (>1 =
  // composite — the reader judges those at double tolerance).
  // A fresh (white) pixel takes the record's stored byte outright — exactly
  // the reader's fresh-canvas fast path, so a lone glyph reproduces its
  // bundle bytes for EVERY set kind (standard, linear, gray-ink srcover);
  // only composite pixels go through the law.
  function renderLine(set, glyphs, baseline, opts) {
    const phy = opts?.phy ?? 0;
    const idx = glyphIndex(set, phy);
    const lin = !!set.linear;
    const yb = snapY(baseline);
    const placed = [], missing = [];
    for (const g of glyphs) {
      // a glyph may name its own set (a union-pool line mixes faces); the
      // record's own law flag wins, then that set's
      const gs = g.set || set, gidx = gs === set ? idx : glyphIndex(gs, phy);
      const pen = snapX(g.pen), pi = Math.floor(pen);
      const rec = gidx.get(g.ch + '|' + (Math.round((pen - pi) * 4) & 3));
      if (!rec) { if (!missing.includes(g.ch)) missing.push(g.ch); continue; }
      placed.push({ rec, gx: pi + rec.dx, gy: yb + rec.dy, pen, lin: rec.lin ?? !!gs.linear });
    }
    if (!placed.length)
      return { x0: 0, y0: 0, w: 0, h: 0, gray: new Uint8Array(0), hits: new Uint8Array(0), missing, baseline: yb, glyphs: 0 };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of placed) {
      if (p.gx < x0) x0 = p.gx;
      if (p.gy < y0) y0 = p.gy;
      if (p.gx + p.rec.w > x1) x1 = p.gx + p.rec.w;
      if (p.gy + p.rec.h > y1) y1 = p.gy + p.rec.h;
    }
    const w = x1 - x0, h = y1 - y0;
    const gray = new Uint8Array(w * h).fill(255);
    const hits = new Uint8Array(w * h);
    // linear law: the page byte carries +1 per contributing light pixel, so
    // the canvas keeps a per-pixel shift count (scanLine's `shifts`)
    const anyLin = placed.some(p => p.lin);
    const shifts = anyLin ? new Uint8Array(w * h) : null;
    for (const { rec, gx, gy, lin: linG } of placed) {
      const { bytes, alpha, ink } = rec, rw = rec.w;
      for (const p of ink) {
        const i = (gy - y0 + ((p / rw) | 0)) * w + (gx - x0 + (p % rw));
        const cv = gray[i], gb = bytes[p], a = alpha[p];
        if (hits[i] < 255) hits[i]++;
        const sh = linG && gb >= 129 && gb !== 255 ? 1 : 0;
        if (cv === 255) gray[i] = gb;                    // fresh pixel: the stored byte, any law
        else if (linG) {
          const s0 = shifts[i];
          gray[i] = (((cv - s0) * a) / 255 | 0) + s0 + sh;
        } else {
          const e = a + (a >> 7);
          gray[i] = (cv * (256 - e)) >> 8;
        }
        if (sh) shifts[i] += sh;
      }
    }
    return { x0, y0, w, h, gray, hits, missing, baseline: yb, glyphs: placed.length };
  }

  // ---- the reader's don't-care zone ----
  // detectObjects' mask plus the box HALOS readPage draws around every
  // redaction box (and thin box slices typed 'rule'): rect ±2 columns, ±3
  // rows. The reader forgives residue that touches a halo as the box's own
  // clipped content (a glyph half-swallowed by the redactor), so a glyph
  // pixel in that zone is never evidence either way — diffLine takes this
  // mask so its verdict means what the reader's does. det = detectObjects(page).
  function objectMask(det, w, h) {
    const mask = new Uint8Array(w * h);
    if (det?.mask) mask.set(det.mask.subarray(0, w * h));
    const objects = det?.objects || [];
    const isBoxSlice = o => o.type === 'rule' && objects.some(b => b.type === 'box' &&
      o.y1 >= b.y0 - 2 && o.y0 <= b.y1 + 2 && Math.min(o.x1, b.x1) > Math.max(o.x0, b.x0));
    for (const o of objects) {
      if (!(o.type === 'box' || isBoxSlice(o))) continue;
      const x0 = Math.max(0, o.x0 - 2), x1 = Math.min(w, o.x1 + 2);
      const y0 = Math.max(0, o.y0 - 3), y1 = Math.min(h, o.y1 + 3);
      for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + x1);
    }
    return mask;
  }

  // ---- the diff ----
  // Compares a rendered window with the page on the window's ink pixels
  // (rendered gray < 255). quant: a palette map (ocr-engine quantMap) for
  // producers that quantized the final page, else null. mask: the reader's
  // object mask (detectObjects — redaction boxes, rules and their padding),
  // else null: a glyph pixel under it is what the reader never compared (a
  // descender dipping into a box's padded rows), so it is counted as
  // `masked`, never as a mismatch — the certificate means the same thing here
  // as in scanLine. tol: the reader's per-pixel tolerance for the line (0 =
  // byte-exact; a tolerant rung allows |Δ| ≤ tol, 2·tol on composite pixels
  // where two glyphs' rasterizer deviations compound — scanLine's rule).
  // Returns {count, ink, outside, masked, within, mism} — mism is a w·h
  // Uint8Array, 1 where the page disagrees beyond tolerance; within counts
  // pixels off by 1..tol. count === 0 with ink > 0 is the certificate: this
  // text IS the page here (to the reader's own standard for the line).
  function diffLine(r, page, quant, mask, tol) {
    const mism = new Uint8Array(r.w * r.h);
    const T = tol || 0;
    let count = 0, ink = 0, outside = 0, masked = 0, within = 0;
    for (let y = 0; y < r.h; y++) {
      const py = r.y0 + y;
      for (let x = 0; x < r.w; x++) {
        const i = y * r.w + x, g = r.gray[i];
        if (g === 255) continue;
        ink++;
        const px = r.x0 + x;
        if (px < 0 || py < 0 || px >= page.w || py >= page.h) { outside++; continue; }
        if (mask && mask[py * page.w + px]) { masked++; continue; }
        const pred = quant ? quant[g] : g;
        const d = Math.abs(page.gray[py * page.w + px] - pred);
        if (!d) continue;
        const t = T && r.hits && r.hits[i] > 1 ? 2 * T : T;
        if (d > t) { mism[i] = 1; count++; } else within++;
      }
    }
    return { count, ink, outside, masked, within, mism };
  }

  // Paste a rendered window onto a page buffer as the producer would have —
  // fresh pixels take the render, composite pixels re-apply the law over
  // whatever the page already holds (used by the synthetic round-trip test,
  // and by any future burn-in). Returns the page.
  function paste(page, r, set) {
    const lin = !!set?.linear;
    for (let y = 0; y < r.h; y++) {
      const py = r.y0 + y;
      if (py < 0 || py >= page.h) continue;
      for (let x = 0; x < r.w; x++) {
        const g = r.gray[y * r.w + x];
        if (g === 255) continue;
        const px = r.x0 + x;
        if (px < 0 || px >= page.w) continue;
        const i = py * page.w + px, cv = page.gray[i];
        if (cv === 255 || lin) { page.gray[i] = g; continue; }
        // standard law over an inked page: recover the coverage that yields g
        // over white, then apply it over cv
        let cov = 0;
        for (let c = 255; c >= 0; c--) { const e = c + (c >> 7); if (((255 * (256 - e)) >> 8) === g) { cov = c; break; } }
        const e = cov + (cov >> 7);
        page.gray[i] = (cv * (256 - e)) >> 8;
      }
    }
    return page;
  }

  const api = { snapX, snapY, glyphIndex, advanceOf, layoutLine, renderLine, objectMask, diffLine, paste };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OCRRender = api;
})(typeof self !== 'undefined' ? self : this);
