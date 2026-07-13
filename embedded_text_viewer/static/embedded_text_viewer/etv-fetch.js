// etv-fetch.js — Embedded Text Viewer: span fetching and lifecycle hooks.
// Cross-module calls into text_tool (utbState, spanToUnified, renderAllTextLayers, etc.)
// only happen inside event handlers and timeouts, so the fact that text_tool scripts
// load after this one is safe.

const _utbFetchState = {
  fetched: false,
  currentFile: null,
};

async function utbFetchSpans(file) {
  if (_utbFetchState.fetched && _utbFetchState.currentFile === file) return;

  try {
    let resp;
    if (file) {
      const fd = new FormData();
      fd.append('file', file);
      resp = await fetch('/embedded-text-viewer/api/extract-spans', { method: 'POST', body: fd });
    } else {
      resp = await fetch('/embedded-text-viewer/api/extract-spans');
    }
    if (!resp.ok) return;

    const data = await resp.json();
    const spans = data.spans || [];

    if (spans.length > 0) {
      // Font size is in POINTS (the canonical unit); normalize sizePt directly.
      const ptSizes = spans.map(s => s.sizePt).sort((a, b) => a - b);
      const medianPt = ptSizes[Math.floor(ptSizes.length / 2)];
      const documentBasePt = Math.round(medianPt);

      const fontCounts = {};
      let maxCount = 0;
      let mostUsedFont = 'Times New Roman';

      spans.forEach(span => {
        const pt = span.sizePt;
        let normalizedPt;
        if (Math.abs(pt - documentBasePt) <= 1.0) {
          normalizedPt = documentBasePt;
        } else {
          normalizedPt = Math.round(pt);
        }
        span.sizePt = normalizedPt;

        const f = typeof normUtbFont === 'function' ? normUtbFont(span.font) : (span.font || 'Times New Roman');
        if (f) {
          fontCounts[f] = (fontCounts[f] || 0) + 1;
          if (fontCounts[f] > maxCount) {
            maxCount = fontCounts[f];
            mostUsedFont = f;
          }
        }
      });

      const fabricSel = document.getElementById('fabric-font-family');
      if (fabricSel && Array.from(fabricSel.options).find(o => o.value === mostUsedFont)) {
        fabricSel.value = mostUsedFont;
        if (typeof textOptions !== 'undefined') textOptions.fontFamily = mostUsedFont;
      }

      utbState.boxes.filter(b => b.type === 'redaction').forEach(box => {
        const pt = box.sizePt;
        let normalizedPt;
        if (Math.abs(pt - documentBasePt) <= 1.0) {
          normalizedPt = documentBasePt;
        } else {
          normalizedPt = Math.round(pt);
        }

        let changed = false;
        if (box.sizePt !== normalizedPt) {
          box.sizePt = normalizedPt;
          changed = true;
        }
        if (box.fontFamily !== mostUsedFont) {
          box.fontFamily = mostUsedFont;
          changed = true;
        }

        if (changed && typeof renderBox === 'function') renderBox(box);
      });
    }

    utbState.boxes = utbState.boxes.filter(b => b.type !== 'embedded');

    spans.forEach(span => utbState.addBox(spanToUnified(span)));

    _utbFetchState.fetched = true;
    _utbFetchState.currentFile = file;

    renderAllTextLayers();
    utbConnectRedactionsToLines();

    if (typeof calculateAllWidths === 'function') {
      calculateAllWidths();
    }

  } catch (err) {
    console.warn('UTB: span fetch error', err);
  }
}


// ── Connect redaction boxes to embedded text lines ────────────

function utbConnectRedactionsToLines() {
  // OCR-read lines are text lines too — a redaction connects to whichever
  // kind sits on its row (scanned pages only ever have 'ocr' lines)
  const embeddedBoxes = utbState.boxes.filter(b => b.type === 'embedded' || b.type === 'ocr');
  const redactionBoxes = utbState.boxes.filter(b => b.type === 'redaction');

  redactionBoxes.forEach(rb => {
    if (rb.lineId !== null) return;

    const pageEmbedded = embeddedBoxes.filter(b => b.page === rb.page);
    let bestBox = null;
    let bestOverlap = 0;

    for (const eb of pageEmbedded) {
      const overlap = Math.min(rb.y + rb.h, eb.y + eb.h) - Math.max(rb.y, eb.y);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestBox = eb;
      }
    }

    if (!bestBox || bestOverlap < rb.h * 0.3) return;

    rb.lineId = bestBox.lineId;
    rb.y = bestBox.y;
    rb.h = bestBox.h;

    const lineBoxes = embeddedBoxes.filter(b => b.page === rb.page && b.lineId === bestBox.lineId);
    let hasUpper = false;
    if (typeof state !== 'undefined' && state.candidates && state.candidates.length > 0) {
      const lineUpper = lineBoxes.map(lb => lb.text || '').join(' ').toUpperCase();
      for (const c of state.candidates) {
        const words = c.toUpperCase().trim().split(/\s+/).filter(Boolean);
        // Skip trivially short names (e.g. "Al", "Ed") — too ambiguous to force uppercase
        if (words.join('').replace(/[^A-Z]/g, '').length < 3) continue;
        // Escape regex metacharacters per word; tolerate variable whitespace between name parts
        const phrasePattern = new RegExp('\\b' + words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+') + '\\b');
        if (phrasePattern.test(lineUpper)) {
          hasUpper = true;
          break;
        }
      }
    }
    if (hasUpper) {
      rb.uppercase = true;
    }

    renderBox(rb);
  });
}


// ── Nearest-line helper (exposed so text-tool.js can use it) ──

window._utbFindNearestLine = function (pageNum, y, thresholdMultiplier = 2.0) {
  const pageBoxes = utbState.boxes.filter(b => b.page === pageNum &&
    (b.type === 'embedded' || b.type === 'ocr'));
  if (!pageBoxes.length) return null;

  let nearest = null;
  let minDist = Infinity;
  for (const b of pageBoxes) {
    const cy = b.y + b.h / 2;
    const d = Math.abs(cy - y);
    if (d < minDist) { minDist = d; nearest = b; }
  }
  return nearest && minDist < nearest.h * thresholdMultiplier ? nearest : null;
};


// ── Tool: add embedded text span ──────────────────────────────

window.addEmbeddedTextSpan = function (pageNum, x, y) {
  const nearest = window._utbFindNearestLine(pageNum, y);

  const newBox = utbState.addBox(new UnifiedTextBox({
    type: 'embedded',
    page: pageNum,
    text: 'Click to edit',
    lineId: nearest ? nearest.lineId : `manual_${Date.now()}`,
    x: x,
    y: nearest ? nearest.y : y - 10,
    w: 120,
    h: nearest ? nearest.h : 20,
    fontFamily: nearest ? nearest.fontFamily : (document.getElementById('fabric-font-family')?.value || 'Times New Roman'),
    // Font-size input is in POINTS — no DPI conversion.
    sizePt: nearest ? nearest.sizePt : (parseFloat(document.getElementById('fabric-font-size')?.value) || 12),
  }));

  renderBox(newBox);

  utbState.selectedId = newBox.id;
  selectBoxInSVG(newBox.id);
  if (typeof syncToolbarToBox === 'function') syncToolbarToBox(newBox);
};


// ── Lifecycle hooks ───────────────────────────────────────────
// Subscribe to the core's document lifecycle instead of monkey-patching
// window.loadDocument. The core already resets utbState and the SVG layers at
// the top of loadDocument, so this handler only (re)fetches the embedded spans.
if (window.PDFHooks) {
  PDFHooks.on('document:loaded', ({ file }) => {
    _utbFetchState.fetched = false;
    utbFetchSpans(file);
  });
}

// Clear stale overlays the moment the user picks a new file, before analysis returns.
document.getElementById('pdf-file')?.addEventListener('change', () => {
  _utbFetchState.fetched = false;
  utbState.reset();
  clearAllSVGLayers?.();
});


window.utbFetchSpans = utbFetchSpans;
window.utbConnectRedactionsToLines = utbConnectRedactionsToLines;
