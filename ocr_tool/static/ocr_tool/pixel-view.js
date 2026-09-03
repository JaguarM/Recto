// pixel-view.js — MuPDF pixel view (Recto-owned adapter, like ocr-tool.js).
//
// Draws every text box the way mupdf would have rasterized it onto this page:
// the reader's own glyph bitmaps (glyphs.bin — already downloaded for OCR),
// on mupdf's ¼-px pen lattice, on a whole-pixel baseline, composited through
// the certified blend law. The laws live in engine/render.js (synced verbatim
// from tol0, where `npm run certify:render` proves them against real mupdf).
// This file only decides WHICH set draws a box, WHERE its pens are, and how
// the raster is tinted and diffed.
//
// Two toggles in the Auto OCR bar:
//   MuPDF pixels (#ocr-pixel-view)  raster instead of SVG text, tinted like
//                                   the SVG text would be, alpha = ink darkness
//   Diff         (#ocr-pixel-diff)  matching ink pixels faint, pixels that
//                                   DIFFER from the page solid red — zero red
//                                   means the text IS the page here
//
// The Diff compares exactly what the reader compared: the viewer's page
// raster through the same PageEngine buffer and colour whitening, through
// the page's palette map when the line was read with a palette pass, and
// NEVER under the reader's object mask or box halos (redaction boxes, rules,
// their padded rows and the ±2-column halo around a box — a descender dipping
// into a box's padding, or a glyph half-swallowed by the redactor, is
// `masked`, not a mismatch). So "0 differ" here means what "byte-clean" means in the reader.
//
// Attaches to text_tool through ONE guarded seam: svg-renderer.js calls
// window.utbPixelRender(box, xs, baseline) for every box it draws and shows
// the returned raster instead of its <text>; null means "draw as always".
// Nothing in text_tool or the core knows this file exists.

const pixelView = {
  on: false,
  diff: false,
  loading: false,     // glyph sets being fetched (the cache-hit path never loads them)
  pages: new Map(),   // `${docHash}|${page}` -> { page: whitened {w,h,gray}, mask, quant } | null
  results: new Map(), // box.id -> { set, ink, count, masked, outside, glyphs }
  cache: new Map(),   // render key -> { href, x, y, w, h, advanceW, ink, count, masked, outside }
  notes: new Map(),   // box.id -> why it fell back to SVG
  lastNote: null,
  canvas: null,
};

const PV_TYPE_TINT = { embedded: [0, 100, 255], redaction: [80, 180, 110], harfbuzz: [255, 140, 0], ocr: [0, 200, 255] };
const PV_DIFF_RGB = [217, 48, 37];
const PV_MATCH_ALPHA = 0.32;   // diff mode: matching ink pixels are drawn this faint

// Family/size lookup for boxes that were NOT read by the OCR (embedded text,
// hand-added text): a set name is `<stem><style?><lin?><size>`; anything else
// (g23 gray ink, 102mid, law, _page cuts) is a producer-specific variant and
// is never picked by family — OCR boxes reach those through box.ocr.font.
const PV_STEMS = [
  ['segoeui', 'Segoe UI'], ['georgia', 'Georgia'], ['verdana', 'Verdana'], ['calibri', 'Calibri'],
  ['cambria', 'Cambria'], ['tahoma', 'Tahoma'], ['times', 'Times New Roman'], ['tnr8', 'Times New Roman'],
  ['tnr', 'Times New Roman'], ['arial', 'Arial'], ['cour', 'Courier New'],
];
// approximate space advances as a fraction of the em, used only when no
// page-calibrated space (box.ocr.spaceAdv) is available for the box's set
const PV_SPACE_EM = { 'Times New Roman': 0.25, 'Courier New': 0.6, 'Arial': 0.278, 'Georgia': 0.241,
  'Tahoma': 0.313, 'Segoe UI': 0.274, 'Verdana': 0.352, 'Calibri': 0.226, 'Cambria': 0.22 };

function pvSetStyle(name) {
  const n = (name || '').toLowerCase();
  for (const [stem, family] of PV_STEMS) {
    if (!n.startsWith(stem)) continue;
    const m = n.slice(stem.length).match(/^(bd|b|i|z)?(lin)?_?(\d+)$/);
    if (!m) return null;                                   // a variant set
    return { family, bold: m[1] === 'bd' || m[1] === 'b' || m[1] === 'z',
      italic: m[1] === 'i' || m[1] === 'z', linear: !!m[2] };
  }
  return null;
}

function pvSetByName(name) {
  return ocrToolState.sets?.find(s => s.name === name) || null;
}

// The set(s) that draw a box: the reader's pick for OCR lines (a union name
// 'a+b' resolves per glyph through baseCharPositions[i].src), else the
// family/size match for everything else. Returns {primary, byName, label} or null.
function pvSetsForBox(box) {
  const sets = ocrToolState.sets;
  if (!sets) return null;
  if (box.ocr?.font) {
    // a union-pool line ('bold label + regular value') reports one font
    // label but each glyph carries the set that actually drew it (src, from
    // the engine's L.glyphs) — every set named anywhere on the line is needed
    const names = new Set(box.ocr.font.split('+'));
    for (const cp of box.baseCharPositions || []) if (cp.src) names.add(cp.src);
    const found = [...names].map(pvSetByName).filter(Boolean);
    if (!found.length) return null;
    const primary = pvSetByName(box.ocr.font.split('+')[0]) || found[0];
    return { primary, byName: new Map(found.map(s => [s.name, s])),
      label: found.length > 1 ? found.map(s => s.name).join('+') : found[0].name };
  }
  const sizePx = box.sizePt * GEO.docPxPerPt();
  const want = { family: box.fontFamily, bold: !!box.bold, italic: !!box.italic };
  const hit = sets.find(s => {
    const st = pvSetStyle(s.name);
    return st && !st.linear && st.family === want.family && st.bold === want.bold &&
      st.italic === want.italic && Math.abs(s.sizePx - sizePx) < 0.02;
  });
  return hit ? { primary: hit, byName: new Map([[hit.name, hit]]), label: hit.name } : null;
}

function pvSpaceAdv(box, set) {
  if (box.ocr?.spaceAdv) return box.ocr.spaceAdv;
  // another OCR line on this page read with the same set carries the
  // page-calibrated space
  for (const b of utbState.boxes)
    if (b.page === box.page && b.ocr?.spaceAdv && b.ocr.font === set.name) return b.ocr.spaceAdv;
  const family = pvSetStyle(set.name)?.family || box.fontFamily;
  return (PV_SPACE_EM[family] ?? 0.25) * set.sizePx;
}

function pvTint(box) {
  const c = box.color;
  if (typeof c === 'string') {
    let m = c.match(/^#([0-9a-f]{6})$/i);
    if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
    m = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return [+m[1], +m[2], +m[3]];
  }
  return PV_TYPE_TINT[box.type] || [0, 0, 255];
}

// A layer the user (or the auto layer choice) hid is not drawn — its groups
// are display:none anyway, and a hidden box must not count in the verdicts.
function pvLayerHidden(box) {
  const cl = document.body.classList;
  return (box.type === 'embedded' && cl.contains('hide-embedded-text')) ||
         (box.type === 'ocr' && cl.contains('hide-ocr-text'));
}

// The page the Diff compares against: the viewer's own <img> for the page,
// through the same PageEngine buffer + colour whitening the reader used, plus
// the reader's object mask, so a zero diff here means the same thing as the
// reader's byte-clean.
function pvPageInfo(pageNum) {
  const key = `${state.docHash}|${pageNum}`;
  if (pixelView.pages.has(key)) return pixelView.pages.get(key);
  const img = document.getElementById(`page${pageNum}`);
  if (!img) return null;
  if (!img.complete || !img.naturalWidth) {
    if (!img._pvHooked) {                                  // draw again once the raster is in
      img._pvHooked = true;
      img.addEventListener('load', () => { if (pixelView.on) window.renderAllTextLayers?.(); }, { once: true });
    }
    return null;
  }
  if (img.naturalWidth !== state.pageWidth || img.naturalHeight !== state.pageHeight) {
    pixelView.pages.set(key, null);                        // raster not 1:1 with the viewBox
    return null;
  }
  if (typeof PageEngine === 'undefined' || typeof BlindOCR === 'undefined') return null;
  ocrToolState.engine ??= new PageEngine();
  const raw = ocrToolState.engine._pageFor(img);
  const page = BlindOCR.whitenColored(raw, ocrToolState.engine.pageRGBA(img));
  const info = { page, mask: null, quant: null };
  // the reader's don't-care zone: object mask + box halos (render.js objectMask)
  try { info.mask = OCRRender.objectMask(BlindOCR.detectObjects(page), page.w, page.h); }
  catch (e) { console.warn('pixel view: detectObjects', e); }
  pixelView.pages.set(key, info);
  return info;
}
function pvQuant(info) {
  if (!info.quant) info.quant = BlindOCR.quantMap(info.page);
  return info.quant;
}

function pvNote(box, why) {
  pixelView.notes.set(box.id, why);
  if (why !== pixelView.lastNote) {
    pixelView.lastNote = why;
    setOcrStatus(`MuPDF pixels: ${why} — box drawn as SVG`);
  }
}

// Render the window as RGBA: tint with alpha = ink darkness; in Diff mode
// matching (and masked) ink faint, mismatching solid red.
function pvPaint(r, d, tint, diffMode) {
  const c = pixelView.canvas ??= document.createElement('canvas');
  c.width = r.w; c.height = r.h;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(r.w, r.h), px = id.data;
  for (let i = 0; i < r.w * r.h; i++) {
    const g = r.gray[i];
    if (g === 255) continue;
    const o = i * 4;
    if (diffMode && d && d.mism[i]) {
      px[o] = PV_DIFF_RGB[0]; px[o + 1] = PV_DIFF_RGB[1]; px[o + 2] = PV_DIFF_RGB[2]; px[o + 3] = 255;
    } else {
      px[o] = tint[0]; px[o + 1] = tint[1]; px[o + 2] = tint[2];
      px[o + 3] = diffMode ? Math.round((255 - g) * PV_MATCH_ALPHA) : 255 - g;
    }
  }
  ctx.putImageData(id, 0, 0);
  return c.toDataURL('image/png');
}

// ── the seam ──────────────────────────────────────────────────
// svg-renderer.js: utbPixelRender(box, xs, baseline) → {href, x, y, w, h,
// advanceW} | null. xs are the SVG's absolute per-character x positions
// (measured pens + nudges + space overrides) or [box.x] without per-char data.
function utbPixelRender(box, xs, baseline) {
  if (!pixelView.on || typeof OCRRender === 'undefined') return null;
  if (!ocrToolState.sets) { pvEnsureSets(); return null; }
  if (!box.text || box.ocr?.unread || pvLayerHidden(box)) { pixelView.results.delete(box.id); return null; }
  const setInfo = pvSetsForBox(box);
  if (!setInfo) {
    pixelView.results.delete(box.id);
    pvNote(box, box.ocr?.font ? `set ${box.ocr.font} is not loaded`
      : `no glyph set for ${box.fontFamily}${box.bold ? ' bold' : ''}${box.italic ? ' italic' : ''} ` +
        `${Math.round(box.sizePt * 100) / 100} pt (${(box.sizePt * GEO.docPxPerPt()).toFixed(2)} px) — generate it in tol0 (fontgen) and sync`);
    return null;
  }
  const { primary, byName } = setInfo;

  // pens: the measured ones when the box has them, else a fresh layout
  const glyphs = [];
  let advanceW = 0;
  if (box.baseCharPositions?.length && xs.length === box.baseCharPositions.length) {
    for (let i = 0; i < xs.length; i++) {
      const cp = box.baseCharPositions[i];
      if (cp.ligTail) continue;
      const ch = cp.lig || cp.c;
      if (ch === ' ' || ch === '□') continue;
      glyphs.push({ ch, pen: xs[i], set: (cp.src && byName.get(cp.src)) || primary });
    }
  } else {
    const lay = OCRRender.layoutLine(primary, box.text, box.x, { spaceAdv: pvSpaceAdv(box, primary) });
    if (lay.missing.length) {
      pixelView.results.delete(box.id);
      pvNote(box, `no glyph for "${lay.missing.join('')}" in ${primary.name}`);
      return null;
    }
    for (const g of lay.glyphs) glyphs.push({ ch: g.ch, pen: g.pen, set: primary });
    advanceW = lay.advanceW;
  }
  if (!glyphs.length) { pixelView.results.delete(box.id); return null; }

  const yb = OCRRender.snapY(baseline);
  const info = pvPageInfo(box.page);
  const tint = pvTint(box);
  // the reader's own terms for this line: which y-phase records it pinned
  // the line to, and the per-pixel tolerance of the rung it was read on
  const phy = box.ocr?.phy || 0, tol = box.ocr?.tol || 0;
  const key = [setInfo.label, box.text, glyphs.map(g => Math.round(g.pen * 4)).join(','), yb, phy, tol,
    pixelView.diff ? 'd' : 'p', info ? 'pg' : 'nopg', tint.join('.'), box.ocr?.quant ? 'q' : ''].join('|');
  let out = pixelView.cache.get(key);
  if (!out) {
    const r = OCRRender.renderLine(primary, glyphs, yb, { phy });
    if (r.missing.length) {
      pixelView.results.delete(box.id);
      pvNote(box, `no glyph for "${r.missing.join('')}" in ${setInfo.label}${phy ? ` at y-phase ${phy}` : ''}`);
      return null;
    }
    const d = info ? OCRRender.diffLine(r, info.page, box.ocr?.quant ? pvQuant(info) : null, info.mask, tol) : null;
    out = { href: pvPaint(r, d, tint, pixelView.diff), x: r.x0, y: r.y0, w: r.w, h: r.h, advanceW,
      ink: d?.ink ?? null, count: d?.count ?? null, within: d?.within ?? 0, masked: d?.masked ?? 0,
      outside: d?.outside ?? 0, glyphs: r.glyphs };
    pixelView.cache.set(key, out);
  }
  pixelView.notes.delete(box.id);
  pixelView.results.set(box.id, { set: setInfo.label, ink: out.ink, count: out.count, within: out.within,
    masked: out.masked, outside: out.outside, glyphs: out.glyphs, phy, tol });
  return { href: out.href, x: out.x, y: out.y, w: out.w, h: out.h, advanceW };
}
window.utbPixelRender = utbPixelRender;

// ── toggles, status, lifecycle ────────────────────────────────

async function pvEnsureSets() {
  if (ocrToolState.sets || pixelView.loading) return;
  pixelView.loading = true;
  setOcrStatus('MuPDF pixels: loading glyph sets…');
  try {
    await ocrLoadSets();
    setOcrStatus(`MuPDF pixels: ${ocrToolState.sets.length} glyph sets loaded`);
  } catch (e) {
    setOcrStatus(`MuPDF pixels: ${e.message}`);
    pvSetOn(false);
  } finally {
    pixelView.loading = false;
  }
  if (pixelView.on) { window.renderAllTextLayers?.(); pvReportPage(); }
}

function pvInvalidate() {
  pixelView.cache.clear();
  pixelView.results.clear();
  pixelView.notes.clear();
  pixelView.lastNote = null;
}

function pvSetOn(on) {
  pixelView.on = !!on;
  if (!pixelView.on) pixelView.diff = false;
  pvInvalidate();
  document.getElementById('ocr-pixel-view')?.classList.toggle('active', pixelView.on);
  const diffBtn = document.getElementById('ocr-pixel-diff');
  if (diffBtn) { diffBtn.disabled = !pixelView.on; diffBtn.classList.toggle('active', pixelView.diff); }
  if (pixelView.on && !ocrToolState.sets) pvEnsureSets();
  window.renderAllTextLayers?.();
  if (pixelView.on && ocrToolState.sets) pvReportPage();
  else if (!pixelView.on) setOcrStatus('MuPDF pixels off');
}

function pvSetDiff(diff) {
  if (!pixelView.on) return;
  pixelView.diff = !!diff;
  pvInvalidate();
  document.getElementById('ocr-pixel-diff')?.classList.toggle('active', pixelView.diff);
  window.renderAllTextLayers?.();
  pvReportPage();
}

// verdicts for the current page, split the way they should be read: lines
// the reader certified byte-clean must reproduce the page exactly; anything
// else (embedded text, hand-added boxes, tolerant reads) is drawn where its
// box says and compared, but a difference there is information, not a fault
function pvPageVerdict(pageNum) {
  const rows = [...pixelView.results.entries()]
    .map(([id, r]) => ({ box: utbState.getBox(id), r }))
    .filter(x => x.box && x.box.page === pageNum);
  const cert = rows.filter(x => x.box.ocr?.clean), other = rows.filter(x => !x.box.ocr?.clean);
  const exact = xs => xs.filter(x => x.r.count === 0 && x.r.ink > 0).length;
  const fallbacks = [...pixelView.notes.keys()].filter(id => utbState.getBox(id)?.page === pageNum).length;
  return { drawn: rows.length, cert: cert.length, certExact: exact(cert),
    other: other.length, otherExact: exact(other), fallbacks };
}

function pvReportPage() {
  const v = pvPageVerdict(state.currentPage);
  setOcrStatus(`MuPDF pixels: ${v.drawn} boxes as pixels` +
    (v.cert ? ` · OCR lines ${v.certExact}/${v.cert} exact` : '') +
    (v.other ? ` · other boxes ${v.otherExact}/${v.other} exact` : '') +
    (v.fallbacks ? ` · ${v.fallbacks} as SVG (no set)` : '') +
    (pixelView.diff ? ' · diff on' : ''));
}

function pvReportSelection() {
  const id = utbState.selectedId;
  const box = id && utbState.getBox(id);
  if (!box) return;
  const short = (box.text || '').length > 28 ? box.text.slice(0, 28) + '…' : box.text;
  const r = pixelView.results.get(id);
  if (!r) { setOcrStatus(`MuPDF pixels: "${short}" drawn as SVG (${pixelView.notes.get(id) || 'no glyph set'})`); return; }
  setOcrStatus(`MuPDF pixels: "${short}" · ${r.set} · ${r.ink ?? '?'} ink px · ` +
    (r.count === null ? 'page raster not loaded'
      : r.count === 0 ? (r.tol ? `matches the page within ±${r.tol}` : 'matches the page exactly')
      : `${r.count} differ${r.tol ? ` beyond ±${r.tol}` : ''}`) +
    (r.within ? ` · ${r.within} within tolerance` : '') +
    (r.masked ? ` · ${r.masked} under a box/rule` : '') +
    (r.phy ? ` · y-phase ${r.phy}` : '') +
    (r.outside ? ` · ${r.outside} off page` : ''));
}

(function wirePixelView() {
  document.getElementById('ocr-pixel-view')?.addEventListener('click', () => pvSetOn(!pixelView.on));
  document.getElementById('ocr-pixel-diff')?.addEventListener('click', () => pvSetDiff(!pixelView.diff));
  // selection → per-box verdict (drag-resize sets utbState.selectedId on
  // mousedown; report after the click settles)
  document.addEventListener('click', e => {
    if (!pixelView.on || !e.target.closest?.('.utb-group')) return;
    setTimeout(pvReportSelection, 0);
  });
  // a layer shown or hidden (the OCR/embedded toggles, the auto layer choice)
  // changes which boxes are drawn: redraw when the body classes flip
  new MutationObserver(() => {
    if (!pixelView.on) return;
    pixelView.results.clear();
    window.renderAllTextLayers?.();
    pvReportPage();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
})();

PDFHooks.on('document:loaded', () => {
  pixelView.pages.clear();
  pvInvalidate();
});

// Programmatic entry point (headless tests): report() lists every box drawn
// as pixels with its diff verdict; verdict(page) sums them up per page.
window.PixelView = {
  state: pixelView, setOn: pvSetOn, setDiff: pvSetDiff, verdict: pvPageVerdict,
  report() {
    return [...pixelView.results.entries()].map(([id, r]) => {
      const b = utbState.getBox(id);
      return { id, page: b?.page ?? null, text: b?.text ?? '', clean: b?.ocr?.clean ?? null,
        quant: !!b?.ocr?.quant, union: !!b?.ocr?.union, ...r };
    });
  },
  fallbacks(pageNum) {
    return [...pixelView.notes.entries()]
      .filter(([id]) => pageNum == null || utbState.getBox(id)?.page === pageNum)
      .map(([id, why]) => ({ id, why }));
  },
};
