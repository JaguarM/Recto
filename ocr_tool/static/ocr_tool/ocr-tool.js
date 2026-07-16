// ocr-tool.js — Auto OCR plugin adapter (the only file of this app that is
// NOT synced from char_training). Runs the blind reader (engine/blindocr.js)
// on the page rasters the viewer already holds and feeds the results into the
// unified text box system exactly like embedded_text_viewer feeds embedded
// spans: one UnifiedTextBox per read line (type 'ocr'), with
// baseCharPositions at the reader's measured ¼-px pens, plus type 'redaction'
// boxes for detected redaction rectangles.
//
// The engine reads the SAME pixels the user is looking at (state.pageImages =
// the server-extracted, ratio-cropped page raster), so box coordinates line
// up with the viewer by construction. Coordinates are scaled from raster
// pixels into the 816×1056 viewBox space (sx = state.pageWidth / naturalWidth
// — 1.0 for the proven 96-dpi document family).

const ocrToolState = {
  engine: null,     // PageEngine (engine/ocr.js)
  sets: null,       // parsed glyph sets
  running: false,
  cancel: false,
  passHint: null,   // winning pass of the previous page (producer is stable)
};

const OCR_GLYPHS_BASE = '/static/ocr_tool/glyphs/';
const OCR_UNCLEAN_COLOR = 'rgba(230, 124, 0, 0.85)';   // non-byte-clean lines
const OCR_UNREAD_COLOR = 'rgba(217, 48, 37, 0.85)';    // □ marker boxes

function setOcrStatus(msg) {
  const el = document.getElementById('ocr-status');
  if (el) { el.textContent = msg; el.title = msg; }  // title: full text survives the ellipsis
}

async function ocrLoadSets() {
  if (ocrToolState.sets) return ocrToolState.sets;
  let names = [];
  try {
    const r = await fetch(OCR_GLYPHS_BASE + 'index.json', { cache: 'no-store' });
    if (r.ok) names = await r.json();
  } catch { /* fall through to the error below */ }
  if (!names.length) throw new Error('no glyph sets — run "npm run sync:recto" in char_training');
  const sets = await BlindOCR.loadSets(names.map(n => OCR_GLYPHS_BASE + n));
  if (!sets.length) throw new Error('glyph sets failed to load');
  ocrToolState.sets = sets;
  return sets;
}

// data-URL page raster -> loaded <img> (null when the page has no raster)
function ocrLoadPageImage(pageNum) {
  return new Promise((resolve, reject) => {
    const src = state.pageImages[pageNum - 1];
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`page ${pageNum} raster failed to load`));
    img.src = src;
  });
}

// Set name ('timesbdlin16', 'cour13', union 'a+b') -> family/bold/italic.
function ocrFontFromSetName(name) {
  const n = (name || '').split('+')[0].toLowerCase();
  const m = n.match(/^(times|tnr8?|cour|courier|arial|georgia)(bd|i)?(lin)?[\d_]/);
  const stem = m ? m[1] : '';
  const family =
    stem.startsWith('cour') ? 'Courier New' :
    stem === 'arial' ? 'Arial' :
    stem === 'georgia' ? 'Georgia' :
    'Times New Roman';                       // times* / tnr*
  return { family, bold: m?.[2] === 'bd', italic: m?.[2] === 'i' };
}

// Rebuild per-char positions from a line's entries + transcription, walking
// the text so inserted spaces and ligature expansions ('ﬁ'->"fi") line up
// exactly with lineEntries' construction. x values are relative to x0
// (raster px — caller applies the viewBox scale).
function ocrCharPositions(L, x0) {
  const byOffset = new Map();
  for (const e of L.entries) byOffset.set(e.i, e);
  const chars = [];
  let ti = 0, prevEnd = null, spaceStart = null;
  while (ti < L.text.length) {
    const e = byOffset.get(ti);
    if (!e) {                                  // inserted space run
      if (spaceStart === null) spaceStart = ti;
      ti++;
      continue;
    }
    if (spaceStart !== null) {
      const n = ti - spaceStart, gapStart = prevEnd ?? e.pen;
      const w = (e.pen - gapStart) / n;
      for (let s = 0; s < n; s++) chars.push({ c: ' ', x: gapStart + s * w - x0, w });
      spaceStart = null;
    }
    const two = L.text.slice(ti, ti + 2);
    const isLig = (e.ch === 'ﬁ' && two === 'fi') || (e.ch === 'ﬂ' && two === 'fl');
    if (isLig) {
      chars.push({ c: two[0], x: e.pen - x0, w: e.adv / 2 });
      chars.push({ c: two[1], x: e.pen + e.adv / 2 - x0, w: e.adv / 2 });
      ti += 2;
    } else {
      chars.push({ c: L.text[ti], x: e.pen - x0, w: e.adv });
      ti += 1;
    }
    prevEnd = e.pen + e.adv;
  }
  return chars;
}

// Remove everything a previous OCR run added to this page.
function ocrClearPage(pageNum) {
  utbState.boxes = utbState.boxes.filter(b => !(b.ocrSource && b.page === pageNum));
}

// One page's read result -> UnifiedTextBoxes. Returns per-page tallies.
function ocrAddBoxes(pageNum, img, res, pass) {
  const sx = (state.pageWidth || img.naturalWidth) / img.naturalWidth;
  const sy = (state.pageHeight || img.naturalHeight) / img.naturalHeight;
  const tally = { lines: 0, clean: 0, unread: 0, boxes: 0 };

  let n = 0;
  for (const L of res.lines) {
    n++;
    if (!L.set || !L.entries?.length) {
      // unreadable band — an honest red □ marker at the band's ink start
      const x = (L.fails?.[0] ?? 0) * sx;
      const box = utbState.addBox(new UnifiedTextBox({
        type: 'ocr', page: pageNum, text: '□',
        lineId: `ocr_p${pageNum}_l${n}`,
        x, y: L.top * sy, w: 40 * sx, h: Math.max(8, (L.bot - L.top)) * sy,
        sizePt: 12, color: OCR_UNREAD_COLOR,
      }));
      box.ocrSource = true;
      box.ocr = { clean: false, unread: true };
      tally.unread++;
      continue;
    }

    const set = L.set;
    const { family, bold, italic } = ocrFontFromSetName(L.font);

    // invert svg-renderer's computeBaseline (y + h·0.85 − 1.3) so the SVG
    // text sits on the MEASURED baseline exactly
    const h = (set.maxAsc + set.maxDesc) * sy;
    const y = L.baseline * sy - (h * 0.85 - 1.3);

    // A redaction box interrupting the line splits it into separate text
    // boxes, each anchored at its own measured pen (the segment after a box
    // must not ride as trailing chars of the segment before it). Same gap
    // predicate the engine used to insert the separator space in lineEntries.
    const rects = L.boxes ?? [];
    const segs = [[L.entries[0]]];
    for (let i = 1; i < L.entries.length; i++) {
      const a = L.entries[i - 1].pen + L.entries[i - 1].adv, b = L.entries[i].pen;
      if (rects.some(bx => bx[0] >= a - 2 && bx[1] <= b + 2)) segs.push([]);
      segs[segs.length - 1].push(L.entries[i]);
    }

    for (const seg of segs) {
      const first = seg[0], last = seg[seg.length - 1];
      const txLen = ch => (ch === 'ﬁ' || ch === 'ﬂ') ? 2 : 1;   // ligatures transcribe as 2 chars
      const startOff = first.i, endOff = last.i + txLen(last.ch);
      const segLine = { text: L.text.slice(startOff, endOff),
        entries: seg.map(e => ({ ...e, i: e.i - startOff })) };
      const x0 = first.pen;
      const chars = ocrCharPositions(segLine, x0).map(cp => ({ c: cp.c, x: cp.x * sx, w: cp.w * sx }));

      const box = utbState.addBox(new UnifiedTextBox({
        type: 'ocr', page: pageNum, text: segLine.text,
        lineId: `ocr_p${pageNum}_l${n}`,      // segments share the line — redactions connect to it
        x: x0 * sx, y, w: (last.pen + last.adv - x0) * sx, h,
        fontFamily: family, bold, italic,
        sizePt: set.sizePx * 0.75 * sx,
        baseCharPositions: chars,
        color: L.clean ? null : OCR_UNCLEAN_COLOR,
      }));
      box.ocrSource = true;
      box.ocr = { clean: !!L.clean, tol: pass.tol || 0, quant: !!pass.quant,
        union: !!pass.union, font: L.font, baseline: L.baseline, fails: L.fails.length };
    }
    tally.lines++;
    if (L.clean) tally.clean++;
  }

  // detected redaction rectangles -> redaction boxes (the same kind the Add
  // Box tool creates; the matching suite picks them up when installed)
  for (const ob of (res.objects || []).filter(o => o.type === 'box')) {
    const box = utbState.addBox(new UnifiedTextBox({
      type: 'redaction', page: pageNum, text: '',
      x: ob.x0 * sx, y: ob.y0 * sy,
      w: (ob.x1 - ob.x0 + 1) * sx, h: (ob.y1 - ob.y0 + 1) * sy,
    }));
    box.ocrSource = true;
    tally.boxes++;
  }

  return tally;
}

async function ocrReadOnePage(pageNum, label, carry) {
  const img = await ocrLoadPageImage(pageNum);
  if (!img) return null;
  ocrToolState.engine ??= new PageEngine();
  const page = BlindOCR.whitenColored(ocrToolState.engine._pageFor(img),
    ocrToolState.engine.pageRGBA(img));
  const sets = await ocrLoadSets();
  const { res, pass } = await BlindOCR.readPageAuto(page, sets, {
    passHint: ocrToolState.passHint,
    carry,      // Read-all-pages only: cross-page baseline hints (per run)
    progress: (p, d, t) => setOcrStatus(`${label}${BlindOCR.passLabel(p)}: ${d}/${t} bands…`),
  });
  ocrToolState.passHint = pass;
  return { img, res, pass };
}

function ocrSetButtons(running) {
  document.getElementById('ocr-run-page')?.toggleAttribute('disabled', running);
  document.getElementById('ocr-run-all')?.toggleAttribute('disabled', running);
  document.getElementById('ocr-cancel')?.classList.toggle('hidden', !running);
}

async function ocrRun(allPages) {
  if (ocrToolState.running) return;
  if (typeof utbState === 'undefined' || typeof BlindOCR === 'undefined') {
    setOcrStatus('OCR: text_tool and the synced engine are required');
    return;
  }
  if (!state.pageImages?.length) {
    setOcrStatus('OCR: no document loaded');
    return;
  }
  ocrToolState.running = true;
  ocrToolState.cancel = false;
  ocrSetButtons(true);
  try {
    const nums = allPages
      ? Array.from({ length: state.numPages }, (_, i) => i + 1)
      : [state.currentPage];
    const totals = { lines: 0, clean: 0, unread: 0, boxes: 0 };
    // sequential whole-document read: pages share one hint carry (same as
    // char_training's blindOcrDocument); single-page reads stay stateless
    const carry = allPages ? {} : null;
    let lastPass = null, fonts = new Set();
    for (const p of nums) {
      if (ocrToolState.cancel) break;
      const label = allPages ? `OCR ${p}/${state.numPages}` : `OCR p${p}`;
      const out = await ocrReadOnePage(p, label, carry);
      if (!out) continue;
      ocrClearPage(p);
      const t = ocrAddBoxes(p, out.img, out.res, out.pass);
      totals.lines += t.lines; totals.clean += t.clean;
      totals.unread += t.unread; totals.boxes += t.boxes;
      lastPass = out.pass;
      for (const L of out.res.lines) if (L.font) fonts.add(L.font);
    }
    window.utbConnectRedactionsToLines?.();
    if (typeof renderAllTextLayers === 'function') renderAllTextLayers();
    if (typeof calculateAllWidths === 'function') calculateAllWidths();
    if (lastPass) {
      const cert = lastPass.tol ? `clean@±${lastPass.tol}` : 'byte-clean';
      // a union pool's set name is 'a+b+…' — too noisy for the status line;
      // 'mixed fonts' already conveys what the (mixed-font) pass label would
      const shownFonts = [...new Set([...fonts].map(f => f.includes('+') ? 'mixed fonts' : f))];
      setOcrStatus(`${totals.lines} lines, ${totals.clean} ${cert}` +
        (totals.unread ? `, ${totals.unread} unread (□)` : '') +
        (totals.boxes ? ` · ${totals.boxes} redaction boxes` : '') +
        ` · ${shownFonts.join(' ') || '—'}` +
        (lastPass.quant ? ' · palette producer' : '') +
        (ocrToolState.cancel ? ' · cancelled' : ''));
    } else {
      setOcrStatus('OCR: no readable page rasters');
    }
  } catch (e) {
    console.warn('OCR:', e);
    setOcrStatus(`OCR: ${e.message}`);
  } finally {
    ocrToolState.running = false;
    ocrSetButtons(false);
  }
}

// ── Wiring ────────────────────────────────────────────────────
// At module scope, NOT in a 'ui:ready' handler: the core emits 'ui:ready'
// before scripts_after_app parse and the hook bus does not replay, so a
// late subscription never fires. This script loads after app.js, so the DOM
// and window.registerSubtoolbar/openSubtoolbar already exist (same pattern
// as text_tool's toolbar.js).

(function wireOcrToolbar() {
  const btn = document.getElementById('toggle-ocr-tool');
  const bar = document.getElementById('ocr-tool-bar');
  if (!btn || !bar) return;
  window.registerSubtoolbar?.(btn);
  btn.addEventListener('click', () => {
    if (bar.classList.contains('hidden')) window.openSubtoolbar?.(bar, btn);
    else window.openSubtoolbar?.(null, null);
  });
  document.getElementById('ocr-run-page')?.addEventListener('click', () => ocrRun(false));
  document.getElementById('ocr-run-all')?.addEventListener('click', () => ocrRun(true));
  document.getElementById('ocr-cancel')?.addEventListener('click', () => { ocrToolState.cancel = true; });
  // Show/hide the OCR text overlay globally — same pattern as text_tool's
  // toggle-embedded-text (body class + data-type CSS rule in styles.css).
  document.getElementById('ocr-toggle-text')?.addEventListener('click', () => {
    const btn = document.getElementById('ocr-toggle-text');
    const active = btn.classList.toggle('active');
    document.body.classList.toggle('hide-ocr-text', !active);
  });
})();

// New document: boxes were already reset by the core; drop page-derived state.
PDFHooks.on('document:loaded', () => {
  ocrToolState.passHint = null;
  ocrToolState.engine = null;
  ocrToolState.cancel = false;
  setOcrStatus('idle');
});

// Programmatic entry point (used by the headless smoke test).
window.OCRTool = { run: ocrRun, state: ocrToolState };
