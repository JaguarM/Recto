// =============================================================
// measure.js — Font Width Comparison Panel (HarfBuzz only)
//
// Talks to POST /compare to compare HarfBuzz measurements
// against the PDF's embedded text ground truth.
//
// Depends on viewer.js (state.currentZoom, state.pageWidth) and
// etv.js (etvState.spans) being loaded first.
// =============================================================


// ── Panel state ───────────────────────────────────────────────

const cmpState = {
  results:       [],   // current run results
  prevResults:   [],   // previous run results (for diff highlighting)
  selected:      null,
  showOnPage:    true,
  comparedSpans: [],   // spans sent to /compare, parallel index to results
};

let _rerunTimer = null;
function scheduleRerun() {
  clearTimeout(_rerunTimer);
  _rerunTimer = setTimeout(() => {
    if (cmpState.results.length) runComparison();
  }, 600);
}


// ── DOM refs ──────────────────────────────────────────────────

const cmpEls = {
  panel:          document.getElementById('cmp-panel'),
  toggleBtn:      document.getElementById('toggle-cmp'),
  closeBtn:       document.getElementById('cmp-close'),
  scale:          document.getElementById('cmp-scale'),
  correction:     document.getElementById('cmp-correction'),
  correctionVal:  document.getElementById('cmp-correction-val'),
  kerning:        document.getElementById('cmp-kerning'),
  ligatures:      document.getElementById('cmp-ligatures'),
  justify:        document.getElementById('fabric-justified'),
  runBtn:         document.getElementById('cmp-run'),
  autoBtn:        document.getElementById('cmp-auto-calibrate'),
  thead:          document.getElementById('cmp-thead'),
  tbody:          document.getElementById('cmp-tbody'),
  empty:          document.getElementById('cmp-empty'),
  inspector:      document.getElementById('cmp-inspector'),
  inspectorClose: document.getElementById('cmp-inspector-close'),
  inspectorText:  document.getElementById('cmp-inspector-text'),
  cropCanvas:     document.getElementById('cmp-crop-canvas'),
  inspectorRows:  document.getElementById('cmp-inspector-rows'),
  showOnPage:     document.getElementById('cmp-show-on-page'),
  status:         document.getElementById('cmp-status'),
};


// ── Globals ───────────────────────────────────────────────────

window.setHarfBuzzStatus = function(text) {
  if (cmpEls.status) cmpEls.status.textContent = text;
};

// ── Helpers ───────────────────────────────────────────────────

function errClass(pct) {
  const a = Math.abs(pct);
  if (a < 1)  return 'err-good';
  if (a < 3)  return 'err-warn';
  return 'err-bad';
}

function fmt(n, d = 2) {
  return typeof n === 'number' ? n.toFixed(d) : '—';
}


// ── Page overlay ─────────────────────────────────────────────

/** Remove all HarfBuzz accuracy overlays from the page view. */
function cmpClearPageOverlay() {
  document.querySelectorAll('.cmp-page-overlay').forEach(el => el.remove());
}

/** Render colored bounding boxes on each page for each compared span. */
async function cmpRenderOnPage() {
  cmpClearPageOverlay();
  if (!cmpState.showOnPage || !cmpState.results.length) return;

  const ttfForLoad = getFabricTtf();
  if (ttfForLoad && typeof etvLoadRenderFont === 'function') {
    try { await etvLoadRenderFont(ttfForLoad); } catch (_) { /* font unavailable — fall back to system font */ }
  }

  // Group items by page using the parallel comparedSpans array
  const byPage = {};
  cmpState.results.forEach((row, i) => {
    const span = cmpState.comparedSpans[i];
    if (!span) return;
    const page = span.page || 1;
    if (!byPage[page]) byPage[page] = [];
    byPage[page].push({ span, row, idx: i });
  });

  Object.entries(byPage).forEach(([page, items]) => {
    const pageEl = document.getElementById(`pageContainer${page}`);
    if (!pageEl) return;

    const overlay = document.createElement('div');
    overlay.className = 'cmp-page-overlay';

    items.forEach(({ span, row, idx }) => {
      const cls = row.error_pct != null ? errClass(row.error_pct) : 'err-bad';
      const el  = document.createElement('div');
      el.className = `cmp-span-marker ${cls}`;
      el.style.setProperty('--etv-x',  `${span.x}px`);
      el.style.setProperty('--etv-y',  `${span.y}px`);
      el.style.setProperty('--etv-w',  `${span.w}px`);
      el.style.setProperty('--etv-h',  `${span.h}px`);
      el.style.setProperty('--etv-fs', `${span.fontSize || span.sizePt * (4/3) || 16}px`);

      const ttfName = getFabricTtf();
      if (ttfName) el.style.fontFamily = `"etv_${ttfName}"`;
      el.style.setProperty('--cmp-text-color', 'rgba(74, 144, 226, 0.7)');

      // Per-character nodes (or whole-span fallback when no char data)
      if (row.chars && row.chars.length) {
        for (const ch of row.chars) {
          const chEl = document.createElement('i');
          chEl.textContent = ch.c === '\t' ? '' : ch.c;
          chEl.style.setProperty('--ch-x', `${ch.x}px`);
          el.appendChild(chEl);
        }
      } else {
        const chEl = document.createElement('i');
        chEl.textContent = row.text || span.text || '';
        chEl.style.setProperty('--ch-x', '0px');
        el.appendChild(chEl);
      }

      // PDF end-of-text vertical line (red)
      const pdfEndLine = document.createElement('div');
      pdfEndLine.className = 'cmp-end-line cmp-pdf-end';
      el.appendChild(pdfEndLine);

      // HarfBuzz end vertical line (green dashed)
      const hbW = row.width_px;
      if (hbW != null) {
        const hbEndLine = document.createElement('div');
        hbEndLine.className = 'cmp-end-line cmp-hb-end';
        hbEndLine.style.setProperty('--hb-w', `${hbW}px`);
        el.appendChild(hbEndLine);
      }

      // Tooltip
      const sizePt = span.sizePt ?? (span.fontSize ? (span.fontSize / (4/3)).toFixed(1) : '?');
      const fontRaw = span.font || '?';
      if (row.error_pct != null) {
        let hoverText = `${row.text}\nFont: ${fontRaw} | ${sizePt}pt`;
        hoverText += `\nError: ${row.error_pct >= 0 ? '+' : ''}${row.error_pct.toFixed(2)}%`;
        if (row.calibrated_px != null) {
          hoverText += `\nCalibrated: ${row.calibrated_px.toFixed(2)} px`;
        }
        hoverText += `\nHarfBuzz: ${row.width_px != null ? row.width_px.toFixed(2) : '?'} px\nActual: ${span.w.toFixed(2)} px`;
        el.title = hoverText;
      } else {
        el.title = `${row.text}: ${row.error || '?'}`;
      }

      el.dataset.cmpIdx = String(idx);
      el.addEventListener('click', () => selectRow(idx));
      overlay.appendChild(el);
    });

    pageEl.appendChild(overlay);
  });
}

/** Reset comparison state when a new document is loaded. */
function cmpReset() {
  cmpState.results       = [];
  cmpState.prevResults   = [];
  cmpState.comparedSpans = [];
  cmpState.selected      = null;
  cmpClearPageOverlay();
  cmpEls.thead.innerHTML = '';
  cmpEls.tbody.innerHTML = '';
  cmpEls.empty.textContent  = 'Load a PDF and click Run.';
  cmpEls.empty.style.display = '';
  cmpEls.inspector.classList.add('hidden');
}


// ── Build / update table ──────────────────────────────────────

function buildTable(results) {
  const hasCal = results.some(r => r.calibrated_px != null);

  // Header
  const hRow = document.createElement('tr');
  const headers = ['Text', 'Actual px', 'HarfBuzz px'];
  if (hasCal) headers.push('Calibrated px');
  headers.push('% Error', 'Font', 'TTF');
  
  headers.forEach(h => {
    const th = document.createElement('th');
    th.textContent = h;
    hRow.appendChild(th);
  });
  cmpEls.thead.innerHTML = '';
  cmpEls.thead.appendChild(hRow);

  // Body
  cmpEls.tbody.innerHTML = '';
  results.forEach((row, idx) => {
    const tr = document.createElement('tr');
    tr.dataset.idx = idx;
    if (idx === cmpState.selected) tr.classList.add('cmp-selected');

    // Text
    const tdText = document.createElement('td');
    tdText.textContent = row.text;
    tdText.title       = row.text;
    tr.appendChild(tdText);

    // Actual width
    const tdActual = document.createElement('td');
    tdActual.textContent = fmt(row.actual_px);
    tr.appendChild(tdActual);

    // HarfBuzz width
    const tdHB = document.createElement('td');
    tdHB.textContent = row.width_px != null ? fmt(row.width_px) : (row.error || '—');
    tr.appendChild(tdHB);

    // Calibrated width
    if (hasCal) {
      const tdCal = document.createElement('td');
      tdCal.textContent = row.calibrated_px != null ? fmt(row.calibrated_px) : '—';
      tr.appendChild(tdCal);
    }

    // % Error
    const tdErr = document.createElement('td');
    tdErr.classList.add('err-cell');
    if (row.error_pct != null) {
      const pct = row.error_pct;
      tdErr.textContent = `${pct >= 0 ? '+' : ''}${fmt(pct)}%`;
      tdErr.classList.add(errClass(pct));
      tdErr.title = `Error: ${fmt(row.error_px, 3)} px`;

      // Highlight if changed from previous run
      const prevRow = cmpState.prevResults[idx];
      if (prevRow?.width_px != null && row.width_px != null &&
          Math.abs(row.width_px - prevRow.width_px) > 0.005) {
        tdErr.classList.add('cmp-changed');
        tdErr.title += `  [was ${fmt(prevRow.width_px)} px]`;
      }
    } else {
      tdErr.textContent = row.error || '—';
      if (row.error) tdErr.classList.add('err-bad');
    }
    tr.appendChild(tdErr);

    // PDF font name
    const tdFont = document.createElement('td');
    tdFont.textContent = row.font || '';
    tdFont.title = row.font || '';
    tr.appendChild(tdFont);

    // Mapped TTF
    const tdTTF = document.createElement('td');
    tdTTF.textContent = row.mapped_ttf || '';
    tr.appendChild(tdTTF);

    tr.addEventListener('click', () => selectRow(idx));
    cmpEls.tbody.appendChild(tr);
  });

  cmpEls.empty.style.display = results.length ? 'none' : '';
}


// ── Row selection + inspector ─────────────────────────────────

function selectRow(idx) {
  cmpState.selected = idx;

  // Highlight row
  cmpEls.tbody.querySelectorAll('tr').forEach(tr => {
    tr.classList.toggle('cmp-selected', parseInt(tr.dataset.idx) === idx);
  });

  // Highlight page overlay marker
  document.querySelectorAll('.cmp-span-marker').forEach(m => {
    m.classList.toggle('cmp-selected', parseInt(m.dataset.cmpIdx) === idx);
  });

  const row  = cmpState.results[idx];
  const span = (etvState.spans || []).find(
    s => s.text === row.text && Math.abs(s.w - row.actual_px) < 0.5
  );

  // Show inspector
  cmpEls.inspector.classList.remove('hidden');
  cmpEls.inspectorText.textContent = `"${row.text}"  (${fmt(row.actual_px)} px actual)`;

  // Crop canvas
  if (span) {
    scrollToSpan(span);
    drawCrop(span, row);
  } else {
    cmpEls.cropCanvas.width = 0;
  }

  // Detail rows
  cmpEls.inspectorRows.innerHTML = '';
  if (row.width_px != null) {
    const pct   = row.error_pct ?? 0;
    const ratio = row.actual_px > 0 ? Math.min(row.width_px / row.actual_px, 2) : 0;

    const rowEl = document.createElement('div');
    rowEl.className = 'cmp-inspector-row';
    rowEl.innerHTML = `
      <span class="method-name">HarfBuzz</span>
      <div class="cmp-inspector-bar-wrap">
        <div class="cmp-inspector-bar ${errClass(pct)}"
          style="width:${(ratio * 50).toFixed(1)}%"></div>
      </div>
      <span class="${errClass(pct)}">${fmt(row.width_px)} px (${pct >= 0 ? '+' : ''}${fmt(pct)}%)</span>
    `;
    cmpEls.inspectorRows.appendChild(rowEl);

    // Font info
    if (row.mapped_ttf) {
      const infoEl = document.createElement('div');
      infoEl.className = 'cmp-inspector-row';
      infoEl.innerHTML = `
        <span class="method-name">Font</span>
        <span style="color:#9aa0a6">${row.font} → ${row.mapped_ttf}</span>
      `;
      cmpEls.inspectorRows.appendChild(infoEl);
    }

    // Justified space width info
    if (row.justified_space_w != null) {
      const jswEl = document.createElement('div');
      jswEl.className = 'cmp-inspector-row';
      jswEl.innerHTML = `
        <span class="method-name">Space W. (justify)</span>
        <span style="color:#81c995">${row.justified_space_w.toFixed(2)} px</span>
      `;
      cmpEls.inspectorRows.appendChild(jswEl);

      // Update the slider to reflect this span's computed value
      const spaceSlider = document.getElementById('fabric-space-width');
      const spaceDisp   = document.getElementById('fabric-space-width-display');
      if (spaceSlider) {
        spaceSlider.value = row.justified_space_w.toFixed(1);
        spaceSlider.dataset.exactValue = row.justified_space_w;
      }
      if (spaceDisp)   spaceDisp.textContent = row.justified_space_w.toFixed(1) + 'px';
    }
  }
}

/** Scroll the viewer to a span's page and position. */
function scrollToSpan(span) {
  const pageEl = document.getElementById(`pageContainer${span.page}`);
  if (pageEl) pageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** Draw a zoomed crop of the span's bounding box onto the inspector canvas. */
function drawCrop(span, row) {
  const pageEl = document.getElementById(`pageContainer${span.page}`);
  if (!pageEl) { cmpEls.cropCanvas.width = 0; return; }

  const img   = pageEl.querySelector('img');
  if (!img || !img.complete) { cmpEls.cropCanvas.width = 0; return; }

  // Natural image size
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  // Span coords are in image-pixel space (816 wide typically)
  const scaleToNat = nw / (state.pageWidth || 816);

  const pad  = 8;  // padding in image pixels
  const sx   = Math.max(0, (span.x - pad) * scaleToNat);
  const sy   = Math.max(0, (span.y - pad) * scaleToNat);
  const sw   = Math.min((span.w + pad * 2) * scaleToNat, nw - sx);
  const sh   = Math.min((span.h + pad * 2) * scaleToNat, nh - sy);

  const zoom = 2;
  const canvas = cmpEls.cropCanvas;
  canvas.width  = sw * zoom;
  canvas.height = sh * zoom;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw * zoom, sh * zoom);

  // Ruler: actual width (red) vs HarfBuzz estimate (green)
  const actualPx = span.w * scaleToNat * zoom;
  ctx.strokeStyle = '#f28b82';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(pad * scaleToNat * zoom, sh * zoom - 3);
  ctx.lineTo(pad * scaleToNat * zoom + actualPx, sh * zoom - 3);
  ctx.stroke();

  if (row?.width_px != null) {
    const estPx = row.width_px * scaleToNat * zoom;
    ctx.strokeStyle = '#81c995';
    ctx.beginPath();
    ctx.moveTo(pad * scaleToNat * zoom, sh * zoom - 7);
    ctx.lineTo(pad * scaleToNat * zoom + estPx, sh * zoom - 7);
    ctx.stroke();
  }
}


// ── Run comparison ────────────────────────────────────────────

function getFabricTtf() {
  const familySel = document.getElementById('fabric-font-family');
  if (!familySel) return 'times.ttf';
  const lc = familySel.value.toLowerCase().replace(/[\s\-_]/g, '');
  if (lc.includes('times')) return 'times.ttf';
  if (lc.includes('arial')) return 'arial.ttf';
  if (lc.includes('calibri')) return 'calibri.ttf';
  if (lc.includes('segoe')) return 'segoe_ui.ttf';
  if (lc.includes('courier')) return 'courier_new.ttf';
  if (lc.includes('verdana')) return 'verdana.ttf';
  return 'times.ttf';
}

async function runComparison() {
  const spans = typeof etvState !== 'undefined' ? etvState.spans : [];
  if (!spans || !spans.length) {
    cmpEls.empty.textContent = 'No spans loaded — open a PDF first.';
    cmpEls.empty.style.display = '';
    return;
  }

  const fontName   = getFabricTtf();
  const scale      = parseFloat(cmpEls.scale.value) || (4 / 3);
  const correction = parseFloat(cmpEls.correction.value) || 1.0;
  const kerning    = cmpEls.kerning.checked;
  const ligatures  = cmpEls.ligatures.checked;
  // The UI checkbox and slider are now strictly PER-SPAN. We do not send their current state
  // as the global fallback, because their current state reflects the currently selected span!
  // Instead, the global defaults are fixed: by default everything is justified, and space_width is auto.
  const justify    = true; 
  const space_width   = null;
  const pageFilter = typeof state !== 'undefined' ? state.currentPage : 1;
  const forceUpperEl  = document.getElementById('force-uppercase');
  const force_uppercase = forceUpperEl ? forceUpperEl.checked : false;

  // Filter spans
  let toCompare = spans;
  if (pageFilter > 0) {
    toCompare = spans.filter(s => s.page === pageFilter);
  } else {
    // If scanning the entire document, cap at 800 spans to avoid huge payload/DOM freezing
    toCompare = spans.slice(0, 800);
  }

  cmpEls.runBtn.disabled    = true;
  cmpEls.runBtn.textContent = 'Running…';
  cmpEls.empty.textContent  = 'Running…';
  cmpEls.empty.style.display = '';
  cmpEls.thead.innerHTML = '';
  cmpEls.tbody.innerHTML = '';

  try {
    const resp = await fetch('/embedded-text-viewer/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spans: toCompare, font: fontName,
        scale, kerning, ligatures, justify, correction,
        space_width, force_uppercase,
        use_calibration: calState.loaded,
      }),
    });
    if (!resp.ok) throw new Error(`Server error ${resp.status}`);
    const data = await resp.json();

    cmpState.prevResults   = cmpState.results;
    cmpState.results       = data.results || [];
    cmpState.comparedSpans = toCompare;
    cmpState.selected      = null;
    cmpEls.inspector.classList.add('hidden');

    buildTable(cmpState.results);
    cmpRenderOnPage();

    // When justify is active, update the Space W. slider to show the computed value
    if (justify && spaceWidthEl) {
      const sel = cmpState.selected;
      const src = sel != null ? cmpState.results[sel] : cmpState.results.find(r => r.justified_space_w != null);
      if (src?.justified_space_w != null) {
        spaceWidthEl.value = src.justified_space_w.toFixed(1);
        spaceWidthEl.dataset.exactValue = src.justified_space_w;
        const disp = document.getElementById('fabric-space-width-display');
        if (disp) disp.textContent = src.justified_space_w.toFixed(1) + 'px';
      }
    }
  } catch (err) {
    cmpEls.empty.textContent = `Error: ${err.message}`;
    cmpEls.empty.style.display = '';
  }

  cmpEls.runBtn.disabled    = false;
  cmpEls.runBtn.textContent = 'Run';
}


// ── Calibration (font groups + per-char ratios) ───────────────

const calState = {
  groups: [],     // from /calibrate response
  loaded: false,
};
window.calState = calState;

async function runCalibrate() {
  const spans = etvState.spans || [];
  if (!spans.length) return;

  const fontName = getFabricTtf();
  const scale    = parseFloat(cmpEls.scale.value) || (4 / 3);

  const btn = cmpEls.autoBtn;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  try {
    const resp = await fetch('/embedded-text-viewer/api/calibrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spans, font: fontName, scale }),
    });
    if (!resp.ok) throw new Error(`Server error ${resp.status}`);
    const data = await resp.json();
    calState.groups = data.groups || [];
    calState.loaded = true;

    // Show summary
    const summaryEl = document.getElementById('cmp-cal-summary');
    if (summaryEl) {
      summaryEl.innerHTML = calState.groups.map((g, i) =>
        `<div class="cal-group${i === 0 ? ' cal-primary' : ''}">` +
        `<strong>${g.family}/${g.weight}</strong> ~${g.size_class.toFixed(1)}pt ` +
        `<span class="cal-meta">${g.span_count} spans, ` +
        `${g.char_count} chars, ratio=${g.global_ratio.toFixed(4)}</span></div>`
      ).join('');
      summaryEl.style.display = '';
    }

    // Also set the correction slider to the primary group's global ratio
    if (calState.groups.length && cmpEls.correction) {
      const ratio = calState.groups[0].global_ratio;
      cmpEls.correction.value = ratio;
      cmpEls.correctionVal.textContent = ratio.toFixed(4);
    }

    // Clear ETV cache and re-run comparison
    etvState.charPosCache = {};
    await runComparison();
  } catch (err) {
    console.error('Calibrate failed:', err);
  }

  if (btn) { btn.disabled = false; btn.textContent = 'Calibrate'; }
}


// ── Toggle panel open/close ───────────────────────────────────

function openPanel()  {
  // Mutual exclusivity: close tools-sidebar when cmp panel opens
  document.getElementById('tools-sidebar')?.classList.add('hidden');
  document.getElementById('toggle-tools')?.classList.remove('active');
  cmpEls.panel.classList.remove('hidden');
  cmpEls.toggleBtn.classList.add('active');
}
function closePanel() {
  cmpEls.panel.classList.add('hidden');
  cmpEls.toggleBtn.classList.remove('active');
}

cmpEls.toggleBtn?.addEventListener('click', () => {
  cmpEls.panel.classList.contains('hidden') ? openPanel() : closePanel();
});
cmpEls.closeBtn?.addEventListener('click', closePanel);
cmpEls.inspectorClose?.addEventListener('click', () => {
  cmpEls.inspector.classList.add('hidden');
  cmpState.selected = null;
  cmpEls.tbody.querySelectorAll('tr').forEach(tr => tr.classList.remove('cmp-selected'));
});

cmpEls.runBtn?.addEventListener('click', runComparison);
cmpEls.autoBtn?.addEventListener('click', runCalibrate);

cmpEls.correction?.addEventListener('input', () => {
  cmpEls.correctionVal.textContent = parseFloat(cmpEls.correction.value).toFixed(4);
});

// Auto-rerun when these settings change (after a short debounce)
cmpEls.kerning?.addEventListener('change',   scheduleRerun);
cmpEls.ligatures?.addEventListener('change', scheduleRerun);
document.getElementById('fabric-font-family')?.addEventListener('change', () => {
  // Only change the HarfBuzz Accuracy Inspector calculation if NO individual span is selected,
  // and the inspector button/panel is actively open.
  if ((typeof selectedSpan === 'undefined' || !selectedSpan) && !cmpEls.panel.classList.contains('hidden')) {
    scheduleRerun();
  }
});

// Justify checkbox — toggle slider disabled state and rerun
cmpEls.justify?.addEventListener('change', () => {
  const spaceSlider = document.getElementById('fabric-space-width');
  if (spaceSlider) {
    spaceSlider.disabled = cmpEls.justify.checked;
    if (!cmpEls.justify.checked) {
      // Option B (Bake In): Slider retains the computed justified value. 
      // Fire change event to sync this baked-in value with text-tool state.
      spaceSlider.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  scheduleRerun();
});
// Set initial slider state from the default checked value
(function initJustifySlider() {
  const spaceSlider = document.getElementById('fabric-space-width');
  if (spaceSlider && cmpEls.justify?.checked) {
    spaceSlider.disabled = true;
  }
})();

// Rerun when text_tool settings that affect width change
document.getElementById('fabric-space-width')?.addEventListener('change', scheduleRerun);
document.getElementById('force-uppercase')?.addEventListener('change', scheduleRerun);

// Show-on-page overlay toggle
cmpEls.showOnPage?.addEventListener('change', e => {
  cmpState.showOnPage = e.target.checked;
  cmpState.showOnPage ? cmpRenderOnPage() : cmpClearPageOverlay();
});

