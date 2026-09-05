// hypothesis.js — verify a candidate STRING against the page under a
// redaction bar. The reader's laws run forwards (render.js) with the bar
// composited over the drawing exactly as the redactor did (LAWS §8, bar
// last), then every page byte the bar did not destroy is compared.
//
// The premise (guide/plugins/redaction-refiner/pixel-evidence-plan.md): a
// half-exposed glyph is not a letter — the left two columns of A are the
// left two columns of Æ — so nothing here identifies a sliver. Given a SHORT
// list of names that already fit the bar by width, each one is drawn in full
// where the hidden name sits (the line's own set, baseline, y-phase and
// ¼-px pens), and the page outside the bar's black body either contradicts
// it or does not:
//
//   consistent    every judged pixel matches (to the line's own tolerance)
//                 and no page ink in the window is left unexplained, on at
//                 least minInk pixels of evidence
//   contradicted  a judged pixel differs, or page ink no glyph explains
//   no-evidence   the bar left nothing to compare (or the set lacks a glyph)
//
// Two consistent names are a tie, and the tie is the answer (METHOD rule 6).
//
// What is judged, per pixel of the window (the bar model of detectObjects'
// EDGE MODEL, mask._edge):
//   open page          predicted byte vs page byte
//   light edge (≥160)  (gb·k)>>8 with (255·k)>>8 = edge — the glyph's byte
//                      scaled by the bar's alpha, bar drawn last; linear sets
//                      use the product with one shift per light contributor
//                      and the producer's 1-lighter ambiguity, as scanLine does
//   body / dark edge   nothing — the ink is destroyed, and box compositors
//                      slip a byte on dark edges (LAWS §8)
// A white prediction under a light edge predicts the edge byte itself; page
// ink there that the candidate does not draw is hidden ink the candidate
// lacks — unexplained, hence contradicted.
//
// DOM-free like render.js: a browser global (root.OCRHypothesis) and a Node
// module. Called by Recto's adapter only; the reader never calls it, so the
// gate cannot move.
(function (root) {
  'use strict';

  const R = (typeof module !== 'undefined' && module.exports)
    ? require('./render.js')
    : root.OCRRender;

  // the bar's alpha complement(s) behind a light edge byte: (255·k)>>8 = edge
  function kRange(edge) {
    return [Math.ceil(edge * 256 / 255), Math.floor(((edge + 1) * 256 - 1) / 255)];
  }

  // page bytes a candidate byte gb may leave under an edge cell of byte ev,
  // bar drawn last. Standard law: one prediction per k. Linear law: the
  // product with the light-contributor shifts, and the producer's 1-lighter
  // junction ambiguity (scanLine accepts pred − page === 1).
  function edgePreds(gb, ev, lin) {
    if (lin) {
      const sB = ev >= 129 && ev !== 255 ? 1 : 0, sG = gb >= 129 && gb !== 255 ? 1 : 0;
      const p = (((gb - sG) * (ev - sB)) / 255 | 0) + sG + sB;
      return [p, p - 1];
    }
    const [kLo, kHi] = kRange(ev), out = [];
    for (let k = kLo; k <= kHi; k++) out.push((gb * k) >> 8);
    return out;
  }

  // distance of a predicted byte from the page at pOff, through the palette
  // map and the colour acceptance band when the page carries them (diffLine)
  function pageDist(page, pOff, pred, quant) {
    if (page.converted && page.converted[pOff] && page.bandLo) {
      const lo = page.bandLo[pOff], hi = page.bandHi[pOff];
      return pred < lo ? lo - pred : pred > hi ? pred - hi : 0;
    }
    return Math.abs(page.gray[pOff] - (quant ? quant[pred] : pred));
  }

  // testHypothesis(page, det, set, line, box, text, opts)
  //   page  {w, h, gray}          the whitened page the reader certified against
  //   det   detectObjects(page)   mask (+ _edge) and objects
  //   set   the line's glyph set  (the face that drew the neighbouring word)
  //   line  {baseline, phy, tol, spaceLine, penLeft, penRight, pen0?, top?, bot?, metrics?}
  //           metrics  = render.js pageMetrics over the document's read lines:
  //                      the producer's advances and kern pairs, measured
  //                      from its pens — a 2008 Times draws these outlines
  //                      at other advances, and "AT" kerns 1.75 px
  //           penLeft  = the left neighbour's last pen + advance (page px)
  //           penRight = the right neighbour's first pen; either may be null
  //           pen0     = where the name starts, when the caller knows it —
  //                      else it is ESTIMATED from the neighbours and the
  //                      line's space and SEARCHED on the lattice within
  //                      1¼ px (the space is a median; the true pen is a
  //                      ¼-px pen near it). Only the glyphs with visible
  //                      pixels can judge a pen — the first, under the
  //                      left edge, and the last, under the right — so the
  //                      first glyph's pen is searched here and the last
  //                      glyph's gets the reader's own quarter of slack
  //                      (testAtPen); the best verdict is returned with its pen
  //           top/bot  = the reader's band rows; page ink outside the
  //                      candidate's drawing is judged in these rows only
  //                      (a neighbouring line's descenders are not this line's)
  //   box   the detected box object over the bar (unused beyond its type —
  //         the mask and edge bytes come from det) — may be null
  //   text  the candidate string, exactly as it would be typeset
  //   opts  {quant, explained: [render windows whose ink is accounted for —
  //          the neighbour words, and the neighbouring LINES' glyphs where
  //          their rows overlap this window: at a tight pitch the line
  //          above's descenders share rows with this line's ascenders],
  //          minInk (default 12)}
  // → { verdict, reason?, missing?, pens, advanceW, penFit, open, edge,
  //     dark, unexplained, edgeOnly, window: {x0, y0, w, h}, mism, render }
  function testHypothesis(page, det, set, line, box, text, opts) {
    const quant = opts?.quant || null;
    const minInk = opts?.minInk ?? 12;
    const explained = opts?.explained || [];
    const tol = line.tol || 0, phy = line.phy || 0;
    const spaceLine = line.spaceLine ?? null;
    const none = (reason, extra) => ({ verdict: 'no-evidence', reason, ...extra,
      open: { ink: 0, match: 0, differ: 0 }, edge: { ink: 0, match: 0, differ: 0 }, dark: { ink: 0 },
      unexplained: 0, edgeOnly: false });

    // 1. layout: advance first (pen0 may hang on it), then at the real pen
    const lay0 = R.layoutLine(set, text, 0, { spaceAdv: spaceLine ?? undefined, metrics: line.metrics ?? null });
    if (lay0.missing.length) return none('missing', { missing: lay0.missing });
    let pens = [];
    if (line.pen0 != null) pens = [line.pen0];
    else {
      const est = [];
      if (line.penLeft != null && spaceLine != null) est.push(line.penLeft + spaceLine);
      if (line.penRight != null && spaceLine != null) est.push(line.penRight - spaceLine - lay0.advanceW);
      if (!est.length) return none('no-pen');
      const dist = p => Math.min(...est.map(e => Math.abs(p - e)));
      const seen = new Set();
      const origins = [];
      for (const e of est)
        for (let d = -5; d <= 5; d++) {                     // the ¼-px pens within 1¼ px
          const p = R.snapX(e) + d * 0.25;
          if (!seen.has(p)) { seen.add(p); origins.push(p); }
        }
      origins.sort((a, b) => dist(a) - dist(b));
      pens = origins;
    }
    // a pen the set cannot draw (a phase record it lacks) proves nothing and
    // ranks below every judged verdict, contradiction included
    const rank = v => v.reason === 'missing' ? 3 : { consistent: 0, 'no-evidence': 1, contradicted: 2 }[v.verdict];
    let best = null;
    for (const p of pens) {
      const v = testAtPen(page, det, set, line, text, p, lay0, { quant, minInk, explained, tol, phy, spaceLine, trace: opts?.trace });
      const key = [rank(v), v.open.differ + v.edge.differ + v.unexplained];
      if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1])) best = { v, key };
      if (v.verdict === 'consistent') break;                 // the nearest pen that fits wins
    }
    return best.v;
  }

  // one candidate at one pen
  function testAtPen(page, det, set, line, text, pen0, lay0, o) {
    const { quant, minInk, explained, tol, phy, spaceLine } = o;
    const none = (reason, extra) => ({ verdict: 'no-evidence', reason, ...extra,
      open: { ink: 0, match: 0, differ: 0 }, edge: { ink: 0, match: 0, differ: 0 }, dark: { ink: 0 },
      unexplained: 0, edgeOnly: false, pen0 });
    const lay = R.layoutLine(set, text, pen0, { spaceAdv: spaceLine ?? undefined, metrics: line.metrics ?? null });
    const advanceW = lay.advanceW;
    // the producer's own positioning: a PDF's text carries per-glyph
    // adjustments — kern pairs and advances the page has not shown
    // elsewhere, TJ arrays — so the name's LAST glyph, the one the right
    // edge judges, can sit off the accumulated advances (v3's "OPERATED":
    // the AT pair, 1.75 px). Its pen is searched on the lattice within
    // 1¼ px; the best fit is kept
    if (lay.glyphs.length >= 2 && !o.noSlack) {
      let best = null;
      for (const d of [0, -0.25, 0.25, -0.5, 0.5, -0.75, 0.75, -1, 1, -1.25, 1.25]) {
        const gl = lay.glyphs.map((g, i) => i === lay.glyphs.length - 1 ? { ...g, pen: g.pen + d } : g);
        const v = judge(page, det, set, line, text, pen0, { ...lay, glyphs: gl }, o);
        // a pen the set cannot draw proves nothing: it never beats a judged pen
        const key = v.reason === 'missing' ? Infinity : v.open.differ + v.edge.differ + v.unexplained;
        if (!best || key < best.key) best = { v, key };
        if (!key) break;
      }
      return best.v;
    }
    return judge(page, det, set, line, text, pen0, lay, o);
  }

  // the comparison itself, for one laid-out candidate
  function judge(page, det, set, line, text, pen0, lay, o) {
    const { quant, minInk, explained, tol, phy, spaceLine } = o;
    const none = (reason, extra) => ({ verdict: 'no-evidence', reason, ...extra,
      open: { ink: 0, match: 0, differ: 0 }, edge: { ink: 0, match: 0, differ: 0 }, dark: { ink: 0 },
      unexplained: 0, edgeOnly: false, pen0 });
    const advanceW = lay.advanceW;
    const penFit = line.penRight != null && spaceLine != null
      ? pen0 + advanceW + spaceLine - line.penRight : null;

    // 2. render the candidate at the line's baseline and y-phase
    const r = R.renderLine(set, lay.glyphs.map(g => ({ ch: g.ch, pen: g.pen })), line.baseline, { phy });
    if (r.missing.length) return none('missing', { missing: r.missing });
    if (!r.glyphs) return none('empty');

    // 3. the window: the name's columns ±2, the set's scan rows
    const yb = R.snapY(line.baseline);
    const wx0 = Math.max(0, Math.floor(pen0) - 2), wx1 = Math.min(page.w, Math.ceil(pen0 + advanceW) + 2);
    const wy0 = Math.max(0, yb - set.maxAsc), wy1 = Math.min(page.h, yb + set.maxDesc);
    const jTop = line.top != null ? Math.max(wy0, line.top) : wy0;   // rows judged for unexplained ink
    const jBot = line.bot != null ? Math.min(wy1, line.bot) : wy1;
    const W = wx1 - wx0, H = wy1 - wy0;
    const mism = new Uint8Array(Math.max(0, W * H));
    const mask = det?.mask || null, edgeMap = mask?._edge || null, edgeV = mask?._edgeV || null;
    // the columns and rows flush against a box body that the reader did NOT
    // mark (its constancy vote fails when the hidden glyphs shadow most of
    // the line — a bar no taller or wider than its text) are the bar's edge
    // all the same, with an alpha nobody measured: destroyed, never open page
    const boxes = (det?.objects || []).filter(o => o.type === 'box');
    // the bar's own byte in an edge column: the reader's mode is fooled when a
    // uniform stem shadows most of the column (an E's stem under the edge
    // leaves one composite value on 7 of 10 rows), but every composite is
    // DARKER than the bar's byte — (gb·k)>>8 ≤ (255·k)>>8 — so the bar's byte
    // is the column's maximum, among values seen on at least two rows
    // …taken over the rows of the box that owns the column (a touching bar's
    // corner in the same column must not vote)
    const colByte = new Map();
    const barByte = (x, y, ev) => {
      if (ev < 160) return ev;                              // a dark edge stays dark: no evidence, whatever the column's other cells show
      const b = boxes.find(o => y >= o.y0 && y < o.y1 && (x === o.x0 - 1 || x === o.x0 || x === o.x1 - 1 || x === o.x1));
      if (!b) return ev;
      const key = x + ':' + b.y0;
      if (colByte.has(key)) return colByte.get(key);
      const n = new Map();
      for (let yy = b.y0; yy < b.y1; yy++) {
        const i = yy * page.w + x;
        if (edgeV[i]) n.set(page.gray[i], (n.get(page.gray[i]) ?? 0) + 1);
      }
      let mx = -1;
      for (const [v, c] of n) if (c >= 2 && v > mx) mx = v;
      const out = mx >= 160 ? mx : ev;
      colByte.set(key, out);
      return out;
    };
    // (only where the box's own boundary column is body, not a marked edge:
    // a dark edge is inside the box's extent, and the column beside it is
    // the open page)
    const colEdge = i => !!(edgeV && edgeV[i]);                 // a marked column edge
    const rowEdge = i => !!(edgeMap && edgeMap[i] && !(edgeV && edgeV[i]));   // a marked row edge
    const flush = (x, y) => {
      for (const b of boxes) {
        if (y >= b.y0 && y < b.y1) {                            // beside the box: open only when
          if (x === b.x0 - 1 && !colEdge(y * page.w + b.x0)) return true;   // the box's own column is the (dark) edge
          if (x === b.x1 && !colEdge(y * page.w + b.x1 - 1)) return true;
        }
        if (x >= b.x0 - 1 && x <= b.x1) {                       // above/below: open only when
          const cx = Math.min(Math.max(x, b.x0), b.x1 - 1);     // the box's own row is the edge row
          if (y === b.y0 - 1 && !rowEdge(b.y0 * page.w + cx)) return true;
          if (y === b.y1 && !rowEdge((b.y1 - 1) * page.w + cx)) return true;
        }
      }
      return false;
    };
    // an edge cell whose page byte is pure black is destroyed too: two bars
    // that touch (the next line's bar starting on this one's bottom AA row,
    // stacked redactions of different widths) leave a row whose mode is the
    // edge byte while the page under the other bar is 0 — and a black glyph
    // pixel under a light edge composites to 0 as well, so black there can
    // never be told from the other bar's body. Evidence is lost, a candidate
    // is never contradicted by it.
    const lin = !!set.linear;
    const white = quant ? quant[255] : 255;
    const inkedBy = (x, y) => {
      for (const w of explained) {
        const rx = x - w.x0, ry = y - w.y0;
        if (rx >= 0 && ry >= 0 && rx < w.w && ry < w.h && w.gray[ry * w.w + rx] < 255) return true;
      }
      return false;
    };

    const open = { ink: 0, match: 0, differ: 0 }, edge = { ink: 0, match: 0, differ: 0 }, dark = { ink: 0 };
    let unexplained = 0;
    for (let y = wy0; y < wy1; y++) {
      for (let x = wx0; x < wx1; x++) {
        const pOff = y * page.w + x, pv = page.gray[pOff];
        const rx = x - r.x0, ry = y - r.y0;
        const inR = rx >= 0 && ry >= 0 && rx < r.w && ry < r.h;
        const g = inR ? r.gray[ry * r.w + rx] : 255, hits = inR ? r.hits[ry * r.w + rx] : 0;
        const mi = (y - wy0) * W + (x - wx0);
        const m = mask ? mask[pOff] : 0;
        // only the bar's left/right edge COLUMNS judge: its top/bottom rows
        // carry the neighbouring lines' descenders and ascender tips and the
        // corners where two bars meet (measured on report's bars and on the
        // bench), never the hidden name's own ink
        const ev = m && edgeMap && edgeV && edgeV[pOff] ? barByte(x, y, edgeMap[pOff]) : 0;
        const t = tol && hits > 1 ? 2 * tol : tol;
        if ((m && (ev < 160 || pv === 0)) || (!m && flush(x, y))) {   // body, dark edge, rule, dust, black under an edge, an unvoted edge column: destroyed
          if (g < 255) dark.ink++;
          continue;
        }
        if (m) {                                              // light edge: the composite is judged
          const ok = edgePreds(g, ev, lin).some(p => Math.abs((quant ? quant[p] : p) - pv) <= t);
          if (g < 255) { edge.ink++; if (ok) edge.match++; else { edge.differ++; mism[mi] = 1; if (o.trace) o.trace.push({ x, y, ev, g, pv, kind: 'edge' }); } }
          else if (!ok && y >= jTop && y < jBot && !inkedBy(x, y)) { unexplained++; mism[mi] = 1; if (o.trace) o.trace.push({ x, y, ev, g, pv, kind: 'edge-unexplained' }); }
          continue;
        }
        if (g < 255) {                                        // open page: the glyph's own byte
          open.ink++;
          if (pageDist(page, pOff, g, quant) <= t) open.match++;
          else { open.differ++; mism[mi] = 1; }
        } else if (pv !== white && y >= jTop && y < jBot && !inkedBy(x, y)) {
          unexplained++; mism[mi] = 1;                        // page ink nothing draws
        }
      }
    }
    const judged = open.ink + edge.ink;
    const verdict = open.differ || edge.differ || unexplained ? 'contradicted'
      : judged >= minInk ? 'consistent' : 'no-evidence';
    return { verdict, pens: lay.glyphs.map(g => g.pen), advanceW, penFit, pen0,
      open, edge, dark, unexplained, edgeOnly: open.ink === 0 && edge.ink > 0,
      window: { x0: wx0, y0: wy0, w: W, h: H }, mism, render: r,
      ...(verdict === 'no-evidence' ? { reason: judged ? 'below-floor' : 'destroyed' } : {}) };
  }

  const api = { testHypothesis, edgePreds, kRange };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OCRHypothesis = api;
})(typeof self !== 'undefined' ? self : this);
