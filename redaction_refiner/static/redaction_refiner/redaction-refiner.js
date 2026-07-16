// redaction-refiner.js — Redaction Refiner (optional plugin)
//
// Redraws each detected redaction bar to the true extent of the hidden word by
// reading the text that surrounds it on its line:
//
//   • Find the embedded/OCR word immediately left and right of the box (same
//     text line — the same surrounding-word lookup the uppercase heuristic in
//     embedded_text_viewer's utbConnectRedactionsToLines already uses).
//   • Look at the character on that word that faces the box (its last char on
//     the left, its first char on the right):
//       – punctuation  → it abuts the hidden word with no space, so the box edge
//         is redrawn flush to where that neighbour word ends/begins.
//       – anything else → a real inter-word space sits in the gap, so the box
//         edge is redrawn one space-width in from where the neighbour word
//         begins, back toward the redaction. The space is sized from the
//         NEIGHBOUR word's own font + size (via the HarfBuzz /widths path that
//         getNaturalSpaceWidth already exposes) — "a space width based on the
//         font size of the surrounding word".
//
// Because both edges are rebuilt from the neighbours (not nudged from the
// painted ink), the result can be narrower OR wider than the original bar —
// we redraw it. Mirrors the reference SurroundingWordWidth pipeline
// (expected edge = neighbour near-edge ∓ one space).
//
// Optional plugin: it attaches only through the PDFHooks bus
// ('redactions:connected') and guarded globals (renderBox, calculateAllWidths,
// getNaturalSpaceWidth). Delete this folder and nothing dangles.

(function () {
  'use strict';

  // A neighbour edge is treated as punctuation-abutting (no inter-word space)
  // when the facing character is a Unicode punctuation mark: . , ; : ! ? ' " )
  // ( - – — / … etc. Symbols ($, %) keep a space, so \p{P} only.
  const PUNCT_RE = /\p{P}/u;

  // How far a neighbour word may sit under the box edge and still count as the
  // left/right word rather than text hidden by the bar. We split left/right at
  // the box centre, so this only guards the degenerate zero-width case.
  const MIN_REFINED_WIDTH_PX = 4;

  const isPunct = (ch) => !!ch && PUNCT_RE.test(ch);

  // First / last non-space char of a span's text — the character that faces the
  // redaction from that side.
  function firstMeaningfulChar(text) {
    const t = (text || '').replace(/^\s+/, '');
    return t ? t[0] : '';
  }
  function lastMeaningfulChar(text) {
    const t = (text || '').replace(/\s+$/, '');
    return t ? t[t.length - 1] : '';
  }

  // Absolute near/far edge of a span, refined to the actual glyph run when the
  // span carries per-character positions ([{c, x, w}] relative to span.x).
  //  - 'right' → the span's right-hand ink edge (faces a box on its right)
  //  - 'left'  → the span's left-hand ink edge  (faces a box on its left)
  function spanInkEdge(span, side) {
    const cps = span.baseCharPositions;
    if (Array.isArray(cps) && cps.length) {
      if (side === 'right') {
        for (let i = cps.length - 1; i >= 0; i--) {
          const cp = cps[i];
          if (cp.c && cp.c.trim()) return span.x + cp.x + (cp.w || 0);
        }
      } else {
        for (let i = 0; i < cps.length; i++) {
          const cp = cps[i];
          if (cp.c && cp.c.trim()) return span.x + cp.x;
        }
      }
    }
    return side === 'right' ? span.x + span.w : span.x;
  }

  // The text-line spans (embedded or OCR words) that share the box's line.
  function lineSpansFor(box) {
    return utbState.boxes.filter((b) => {
      if (b.page !== box.page) return false;
      if (b.type !== 'embedded' && b.type !== 'ocr') return false;
      if (box.lineId != null) return b.lineId === box.lineId;
      // No line association: fall back to vertical overlap on the page.
      const overlap = Math.min(box.y + box.h, b.y + b.h) - Math.max(box.y, b.y);
      return overlap >= box.h * 0.5;
    });
  }

  // Nearest word on each side of the box, split at the box's horizontal centre
  // so a span mostly hidden under the bar is never mistaken for a neighbour.
  function neighboursFor(box) {
    const spans = lineSpansFor(box);
    const centre = box.x + box.w / 2;
    let left = null;
    let right = null;
    for (const s of spans) {
      const sRight = s.x + s.w;
      const sCentre = s.x + s.w / 2;
      if (sCentre <= centre) {
        if (!left || sRight > left.x + left.w) left = s;
      } else {
        if (!right || s.x < right.x) right = s;
      }
    }
    return { left, right };
  }

  // Natural space advance (image px) for a neighbour word's own font + size.
  // Uses the shared HarfBuzz path when present; otherwise a 0.25em estimate.
  async function spaceWidthForSpan(span) {
    if (typeof getNaturalSpaceWidth === 'function') {
      try {
        const w = await getNaturalSpaceWidth({
          fontFamily: span.fontFamily,
          sizePt: span.sizePt,
          kerning: false,
        });
        if (w != null && w > 0) return w;
      } catch { /* fall through to the estimate */ }
    }
    const pxPerPt = (window.GEO && GEO.docPxPerPt) ? GEO.docPxPerPt() : (96 / 72);
    return span.sizePt * pxPerPt * 0.25;
  }

  // Refine one redaction box in place. Returns true when its geometry changed.
  async function refineRedaction(box) {
    if (!box || box.type !== 'redaction') return false;

    const { left, right } = neighboursFor(box);
    if (!left && !right) return false;  // isolated bar — nothing to measure against

    let newX0 = box.x;
    let newX1 = box.x + box.w;

    if (left) {
      const abuts = isPunct(lastMeaningfulChar(left.text));
      const space = abuts ? 0 : await spaceWidthForSpan(left);
      newX0 = spanInkEdge(left, 'right') + space;
    }
    if (right) {
      const abuts = isPunct(firstMeaningfulChar(right.text));
      const space = abuts ? 0 : await spaceWidthForSpan(right);
      newX1 = spanInkEdge(right, 'left') - space;
    }

    if (newX1 - newX0 < MIN_REFINED_WIDTH_PX) return false;  // would collapse — leave it

    if (newX0 === box.x && newX1 === box.x + box.w) return false;  // no change

    box.x = newX0;
    box.w = newX1 - newX0;
    box.refined = true;
    if (typeof renderBox === 'function') renderBox(box);
    return true;
  }

  // Refine every eligible redaction box, then re-measure candidate widths once.
  async function refineAllRedactions() {
    if (typeof utbState === 'undefined') return;
    const boxes = utbState.boxes.filter((b) => b.type === 'redaction');
    let changed = false;
    for (const box of boxes) {
      // Don't fight a box the user is actively editing/selecting.
      if (utbState.selectedId === box.id || utbState.editingId === box.id) continue;
      try {
        if (await refineRedaction(box)) changed = true;
      } catch (e) {
        console.warn('[redaction_refiner] refine failed for', box.id, e);
      }
    }
    // Widths depend on box.w — recompute matches for the redrawn bars.
    if (changed && typeof calculateAllWidths === 'function') calculateAllWidths();
  }

  // Run whenever redactions have just been (re)connected to their text lines —
  // this fires on both the span-load path and after an OCR pass.
  if (window.PDFHooks) {
    PDFHooks.on('redactions:connected', () => { refineAllRedactions(); });
  }

  // Guarded globals for manual re-runs / tooling.
  window.refineRedaction = refineRedaction;
  window.refineAllRedactions = refineAllRedactions;
})();
