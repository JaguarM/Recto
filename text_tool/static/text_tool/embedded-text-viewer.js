/* ==========================================================
   Embedded Text Viewer — overlay plugin for the main viewer
   ==========================================================
   Fetches all embedded PDF text spans (with coordinates
   already translated to the 816×1056 cropped-image pixel
   space) and renders them as absolutely-positioned DOM
   elements inside each page container.
   ========================================================== */

const etvState = {
  active: false,          // toggle on/off
  spans: [],              // raw span data from server
  fetched: false,         // whether we already fetched for the current PDF
  fetchingFile: null,     // File object of the PDF we fetched for
};

/* ---------- Helpers ----------------------------------------- */
function etvOptionsBar() {
  return document.getElementById('etv-options-bar');
}

/**
 * Normalize a raw PDF font name to a browser-renderable CSS font family.
 * PDF fonts often have subset prefixes ("ABCDEF+") and platform-specific
 * suffixes ("MT", "PS", "PSMT") that browsers don't recognize.
 */
function etvNormFont(name) {
  if (!name) return '';
  // Strip subset prefix (e.g. "ABCDEF+TimesNewRoman..." → "TimesNewRoman...")
  let n = name.replace(/^[A-Z]{6}\+/, '').replace(/["']/g, '').split(',')[0].trim();
  const lc = n.toLowerCase().replace(/[\s\-_]/g, '');
  if (lc.includes('times') || lc.includes('timesnew')) return 'Times New Roman';
  if (lc.includes('arial'))                             return 'Arial';
  if (lc.includes('courier'))                            return 'Courier New';
  if (lc.includes('verdana'))                            return 'Verdana';
  if (lc.includes('calibri'))                            return 'Calibri';
  if (lc.includes('segoe'))                              return 'Segoe UI';
  return n;
}

/* ---------- Toggle button wiring ------------------------------------ */
(function initETV() {
  const btn = document.getElementById('toggle-embedded-viewer');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    etvState.active = !etvState.active;
    btn.classList.toggle('active', etvState.active);

    const bar = etvOptionsBar();
    if (bar) bar.classList.toggle('hidden', !etvState.active);

    if (etvState.active) {
      const textToolBtn = document.getElementById('tool-text');
      const isTextToolActive = textToolBtn && textToolBtn.classList.contains('active');
      
      // If we haven't fetched spans yet for this document, do it now
      if (!etvState.fetched) {
        await etvFetchSpans(state.currentFile || null);
      }
      renderEmbeddedTextOverlay(
        document.getElementById(`pageContainer${state.currentPage}`),
        state.currentPage
      );

      if (isTextToolActive) {
        document.querySelectorAll('.etv-overlay').forEach(el => el.classList.add('active-tool'));
      }
    } else {
      clearEmbeddedTextOverlays();
    }
  });
})();


/* ---------- Sub-toolbar controls ------------------------------------ */
(function initETVControls() {
  const colorInput   = document.getElementById('etv-color');
  const opacityInput = document.getElementById('etv-opacity');
  const opacityDisp  = document.getElementById('etv-opacity-display');
  const modeSelect   = document.getElementById('etv-mode');
  if (!colorInput) return;

  /** Rebuild --etv-color and --etv-box-bg from the current picker + slider */
  function applyColorOpacity() {
    const hex = colorInput.value;           // '#rrggbb'
    const pct = parseInt(opacityInput.value, 10);
    const opacity = pct / 100;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    document.documentElement.style.setProperty('--etv-color',  `rgba(${r},${g},${b},${opacity})`);
    document.documentElement.style.setProperty('--etv-box-bg', `rgba(${r},${g},${b},${(opacity * 0.35).toFixed(3)})`);
  }

  colorInput.addEventListener('input', applyColorOpacity);

  opacityInput.addEventListener('input', () => {
    opacityDisp.textContent = `${opacityInput.value}%`;
    applyColorOpacity();
  });

  modeSelect.addEventListener('change', () => {
    document.getElementById('viewer').classList.toggle(
      'etv-boxes-mode',
      modeSelect.value === 'boxes'
    );
  });

  // Initialise CSS variables to match the default control values
  applyColorOpacity();
})();


/* ---------- Reset on new file --------------------------------------- */
function etvResetState() {
  etvState.spans = [];
  etvState.fetched = false;
  etvState.fetchingFile = null;
  clearEmbeddedTextOverlays();
  const bar = etvOptionsBar();
  if (bar) bar.classList.add('hidden');
}

/* ---------- Fetch spans from backend -------------------------------- */
async function etvFetchSpans(file) {
  // Avoid re-fetching for the same file
  if (etvState.fetched && etvState.fetchingFile === file) return;

  try {
    let resp;
    if (file) {
      // User-uploaded PDF: POST the file
      const fd = new FormData();
      fd.append('file', file);
      resp = await fetch('/embedded-text-viewer/api/extract-spans', {
        method: 'POST',
        body: fd,
      });
    } else {
      // Auto-loaded default PDF: GET (server reads the bundled default)
      resp = await fetch('/embedded-text-viewer/api/extract-spans');
    }
    if (!resp.ok) {
      console.error('ETV: fetch failed', resp.status);
      return;
    }
    const data = await resp.json();
    etvState.spans = data.spans || [];
    etvState.fetched = true;
    etvState.fetchingFile = file;
    connectRedactionsToETVLines();
  } catch (err) {
    console.error('ETV: fetch error', err);
  }
}

/* ---------- Char-level rendering helper ----------------------------- */
function etvRenderChars(el, span) {
  Array.from(el.childNodes).forEach(node => {
    if (!node.classList || !node.classList.contains('resizer')) el.removeChild(node);
  });
  for (const ch of span.chars) {
    const i = document.createElement('i');
    i.textContent = ch.c;
    i.style.setProperty('--ch-x', `${ch.x}px`);
    el.appendChild(i);
  }
  el.dataset.charMode = '1';
  delete el.dataset.origText;
}

/* ---------- Render overlay spans onto a page container --------------- */
function renderEmbeddedTextOverlay(pageContainer, pageNum) {
  if (!pageContainer || !etvState.active) return;

  // Remove any existing overlay for this page first
  const existing = pageContainer.querySelector('.etv-overlay');
  if (existing) existing.remove();

  const pageSpans = etvState.spans.filter(s => s.page === pageNum);
  if (!pageSpans.length) return;

  // Create a container div that sits over the page image
  const overlay = document.createElement('div');
  overlay.className = 'etv-overlay';
  
  // Apply active-tool class if the formatting tool is already open
  const textToolBtn = document.getElementById('tool-text');
  if (textToolBtn && textToolBtn.classList.contains('active')) {
    overlay.className += ' active-tool';
  }

  for (let i = 0; i < pageSpans.length; i++) {
    const span = pageSpans[i];
    const el = document.createElement('span');
    el.className = 'etv-span';
    if (span.chars?.length) {
      etvRenderChars(el, span);
    } else {
      el.textContent = span.text;
    }
    el.dataset.index = i;
    el.dataset.lineId = span.lineId; // Used for grouped vertical dragging

    // Position and size in image-pixel space — CSS calc(var * --scale-factor) handles zoom
    el.style.setProperty('--etv-x',  `${span.x}px`);
    el.style.setProperty('--etv-y',  `${span.y}px`);
    el.style.setProperty('--etv-fs', `${span.fontSize}px`);
    el.style.setProperty('--etv-h',  `${span.h}px`);
    el.style.setProperty('--etv-w',  `${span.w}px`);

    // Styling
    if (span.font) {
      el.style.fontFamily = etvNormFont(span.font);
      // Detect bold/italic encoded in the raw PDF font name (e.g. "Times-Bold", "Times-BoldItalic")
      // and store them as real inline styles so syncBarToSpan can read them reliably.
      if (!span.fontWeight && /bold/i.test(span.font))            el.style.fontWeight = 'bold';
      if (!span.fontStyle  && /italic|oblique/i.test(span.font))  el.style.fontStyle  = 'italic';
    }
    if (span.color) {
      el.style.color = span.color;
      el.style.setProperty('--etv-color', span.color);
    }
    if (span.fontWeight)    el.style.fontWeight     = span.fontWeight;
    if (span.fontStyle)     el.style.fontStyle      = span.fontStyle;
    if (span.textDecoration) el.style.textDecoration = span.textDecoration;
    if (span.letterSpacing) el.style.letterSpacing  = span.letterSpacing;

    // Drag and resize functionality (kept locally as it's specialized)
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.classList.contains('resizer')) return;
      
      // We start the drag here. selectTextElement is handled by the global listener in text-tool.js
      initDragETV(e, span, el);
    });

    el.addEventListener('keydown', (e) => {
      e.stopPropagation(); // prevent Delete/Backspace from triggering other handlers
      if (e.key === 'Enter') {
        e.preventDefault();
        el.blur();
      } else if (e.key === 'Escape') {
        if (span.chars?.length) {
          etvRenderChars(el, span);
        } else {
          el.textContent = span.text;
        }
        el.blur();
      }
    });

    el.addEventListener('focus', () => {
      // Record origText for change-detection in blur, but don't flatten chars yet.
      // Flattening only happens in beforeinput — right before the user actually types.
      if (el.dataset.charMode && span.chars?.length) {
        el.dataset.origText = span.chars.map(ch => ch.c).join('');
      }
    });

    el.addEventListener('beforeinput', () => {
      // Flatten <i> char children to plain text on the first actual keystroke.
      if (el.dataset.charMode) {
        const text = el.dataset.origText || span.chars.map(ch => ch.c).join('');
        el.dataset.origText = text;
        Array.from(el.childNodes).forEach(node => {
          if (!node.classList || !node.classList.contains('resizer')) el.removeChild(node);
        });
        el.insertBefore(
          document.createTextNode(text),
          el.querySelector('.resizer') || null
        );
        delete el.dataset.charMode;
      }
    });

    el.addEventListener('blur', () => {
      el.contentEditable = 'false';
      const txt = el.textContent.trim();

      if (!txt) {
        // Empty → remove span and disconnect any linked redactions
        el.remove();
        etvState.spans.splice(etvState.spans.indexOf(span), 1);
        if (span.lineId && typeof state !== 'undefined' && state.redactions) {
          const lineGone = !etvState.spans.some(s => s.lineId === span.lineId && s.page === span.page);
          if (lineGone) state.redactions.forEach(r => {
            if (r.lineId === span.lineId && r.page === span.page) r.lineId = null;
          });
        }
        return;
      }

      span.text = txt;

      if (el.dataset.charMode) {
        // User never typed — <i> chars still intact
        delete el.dataset.origText;
      } else if (span.chars?.length) {
        // beforeinput fired: chars were flattened for editing
        txt === el.dataset.origText
          ? etvRenderChars(el, span)  // unchanged → restore char rendering
          : (span.chars = []);        // changed → positions stale, keep plain text
      }
    });

    // Add resizers for left and right only
    ['l', 'r'].forEach(edge => {
      const resizer = document.createElement('div');
      resizer.className = `resizer resizer-${edge}`;
      resizer.onmousedown = (e) => {
        e.stopPropagation();
        e.preventDefault();
        selectETVBox(el);
        initResizeETV(e, span, el, edge);
      };
      el.appendChild(resizer);
    });

    overlay.appendChild(el);
  }

  pageContainer.appendChild(overlay);
}

function selectETVBox(el) {
  document.querySelectorAll('.etv-span.selected').forEach(s => s.classList.remove('selected'));
  el.classList.add('selected');
}

/* ---------- Redaction ↔ ETV connection helpers ----------------------- */

// After ETV spans are loaded, assign lineId to any redaction that sits on a text line
// and snap the redaction's Y/height to match the ETV span exactly.
// Uses maximum vertical overlap (not a probe-Y heuristic) to find the correct line.
function connectRedactionsToETVLines() {
  if (!state || !state.redactions) return;
  state.redactions.forEach((r, redIdx) => {
    if (r.lineId !== null) return;

    const pageSpans = etvState.spans.filter(s => s.page === r.page);
    let bestSpan = null;
    let bestOverlap = 0;

    for (const s of pageSpans) {
      const overlap = Math.min(r.y + r.height, s.y + s.h) - Math.max(r.y, s.y);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSpan = s;
      }
    }

    // Require at least 30% of the redaction height to overlap before connecting
    if (!bestSpan || bestOverlap < r.height * 0.3) return;

    r.lineId   = bestSpan.lineId;
    r.y        = bestSpan.y;
    r.height   = bestSpan.h;

    const lineSpans = etvState.spans.filter(s => s.page === r.page && s.lineId === bestSpan.lineId);
    let hasUpper = false;
    if (typeof state !== 'undefined' && state.candidates && state.candidates.length > 0) {
      const lineUpper = lineSpans.map(s => s.text || '').join(' ').toUpperCase();
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
      r.uppercase = true;
    }

    const overlay = document.getElementById(`redaction-idx-${redIdx}`);
    if (overlay) {
      overlay.style.setProperty('--px-y',      `${r.y}px`);
      overlay.style.setProperty('--px-height', `${r.height}px`);
    }
  });
}

// Return all redactions (with their global index) whose lineId matches the given line.
function getConnectedRedactions(lineId, page) {
  if (!lineId || !state || !state.redactions) return [];
  return state.redactions
    .map((r, idx) => ({ r, idx }))
    .filter(({ r }) => r.lineId === lineId && r.page === page);
}

/* ---------- Dragging logic ------------------------------------------ */
function initDragETV(e, span, el) {
  const startX = e.clientX;
  const startY = e.clientY;
  const startPtsX = span.x;
  const scaleFactor = state.currentZoom || 1.0;

  // Grouped vertical move: find all spans in the SAME LINE on the same page
  const lineSpans = etvState.spans.filter(s => s.lineId === span.lineId && s.page === span.page);
  const startYs = lineSpans.map(s => s.y);
  
  const pageOverlay = el.parentElement;
  const lineEls = lineSpans.map(s => {
    const pageSpans = etvState.spans.filter(sp => sp.page === s.page);
    const idx = pageSpans.indexOf(s);
    return pageOverlay.querySelector(`.etv-span[data-index="${idx}"]`);
  });

  // Capture connected redactions and their start Y positions for live sync
  const connectedReds = getConnectedRedactions(span.lineId, span.page);
  const redStartYs = connectedReds.map(({ r }) => r.y);

  function onMouseMove(moveEvent) {
    const dx = (moveEvent.clientX - startX) / scaleFactor;
    const dy = (moveEvent.clientY - startY) / scaleFactor;

    // 1. Move DRAGGED span horizontally
    span.x = startPtsX + dx;
    el.style.setProperty('--etv-x', `${span.x}px`);

    // 2. Move ALL spans in the line vertically
    for (let i = 0; i < lineSpans.length; i++) {
      lineSpans[i].y = startYs[i] + dy;
      if (lineEls[i]) lineEls[i].style.setProperty('--etv-y', `${lineSpans[i].y}px`);
    }

    // 3. Sync connected redaction overlays vertically
    for (let i = 0; i < connectedReds.length; i++) {
      const { r, idx } = connectedReds[i];
      r.y = redStartYs[i] + dy;
      const ov = document.getElementById(`redaction-idx-${idx}`);
      if (ov) ov.style.setProperty('--px-y', `${r.y}px`);
    }
  }

  function onMouseUp() {
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

/* ---------- Resizing logic ------------------------------------------ */
function initResizeETV(e, span, el, edge) {
  const startX = e.clientX;
  const startY = e.clientY;
  const startPtsX = span.x;
  const startPtsY = span.y;
  const startPtsW = span.w || 0;
  const startPtsH = span.h || 0;
  const scaleFactor = state.currentZoom || 1.0;

  // Capture connected redactions for vertical-edge sync (t/b)
  const connectedReds = getConnectedRedactions(span.lineId, span.page);
  const redStartYs = connectedReds.map(({ r }) => r.y);
  const redStartHs = connectedReds.map(({ r }) => r.height);

  function onMouseMove(moveEvent) {
    const dx = (moveEvent.clientX - startX) / scaleFactor;
    const dy = (moveEvent.clientY - startY) / scaleFactor;

    if (edge === 'r') {
      span.w = Math.max(1, startPtsW + dx);
    } else if (edge === 'l') {
      const actualDx = Math.min(dx, startPtsW - 1);
      span.x = startPtsX + actualDx;
      span.w = startPtsW - actualDx;
    } else if (edge === 'b') {
      span.h = Math.max(1, startPtsH + dy);
    } else if (edge === 't') {
      const actualDy = Math.min(dy, startPtsH - 1);
      span.y = startPtsY + actualDy;
      span.h = startPtsH - actualDy;
    }

    el.style.setProperty('--etv-x', `${span.x}px`);
    el.style.setProperty('--etv-y', `${span.y}px`);
    el.style.setProperty('--etv-w', `${span.w}px`);
    el.style.setProperty('--etv-h', `${span.h}px`);

    // Sync connected redaction overlays for vertical resize
    for (let i = 0; i < connectedReds.length; i++) {
      const { r, idx } = connectedReds[i];
      if (edge === 't') {
        const actualDy = Math.min(dy, redStartHs[i] - 1);
        r.y = redStartYs[i] + actualDy;
        r.height = redStartHs[i] - actualDy;
      } else if (edge === 'b') {
        r.height = Math.max(1, redStartHs[i] + dy);
      } else {
        continue;
      }
      const ov = document.getElementById(`redaction-idx-${idx}`);
      if (ov) {
        ov.style.setProperty('--px-y',      `${r.y}px`);
        ov.style.setProperty('--px-height', `${r.height}px`);
      }
    }
  }

  function onMouseUp() {
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  }

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

/* ---------- Remove all overlays from the DOM ------------------------ */
function clearEmbeddedTextOverlays() {
  document.querySelectorAll('.etv-overlay').forEach(el => el.remove());
}

/* ---------- Utility for manual box tool snapping ------------------- */
function findNearestETVLine(pageNum, pxY, thresholdFactor = 2.0) {
  const pageSpans = etvState.spans.filter(s => s.page === pageNum);
  if (!pageSpans.length) return null;

  let nearest = null;
  let minDist = Infinity;

  for (const s of pageSpans) {
    // Distance from the horizontal center of the line
    const lineCenter = s.y + (s.h / 2);
    const dist = Math.abs(pxY - lineCenter);
    
    // threshold = factor * height of the current line
    if (dist < (s.h * thresholdFactor)) {
      if (dist < minDist) {
        minDist = dist;
        nearest = s;
      }
    }
  }
  return nearest;
}

// Expose to other scripts
window.findNearestETVLine = findNearestETVLine;
window.selectETVBox = selectETVBox;

function addEmbeddedTextSpan(pageNum, x, y) {
  if (!etvState.active) {
    document.getElementById('toggle-embedded-viewer')?.click();
  }

  // 1. Snapping Logic: Find the nearest line on this page
  const neat = findNearestETVLine(pageNum, y);
  
  // 2. Derive defaults from the snapped line or toolbar
  // If we snap to a line, we use its Y coordinate, height, and font size.
  const snapY  = neat ? neat.y        : y - (12);
  const snapH  = neat ? neat.h        : 20;
  const snapFS = neat ? neat.fontSize : (parseInt(document.getElementById('fabric-font-size')?.value) || 16);
  const snapFF = neat ? neat.font     : (document.getElementById('fabric-font-family')?.value || 'serif');
  const lineId = neat ? neat.lineId   : `manual_${Date.now()}`;

  const newSpan = {
    page: pageNum,
    lineId: lineId,
    text: 'Click to edit',
    x: x,
    y: snapY,
    w: 100,
    h: snapH,
    fontSize: snapFS,
    font: snapFF,
    manual: true
    // No 'color' set here means it will inherit the global var(--etv-color)
  };

  etvState.spans.push(newSpan);
  
  const pageContainer = document.getElementById(`pageContainer${pageNum}`);
  if (pageContainer) {
    renderEmbeddedTextOverlay(pageContainer, pageNum);
    
    setTimeout(() => {
        const overlay = pageContainer.querySelector('.etv-overlay');
        const els = overlay.querySelectorAll('.etv-span');
        const lastEl = els[els.length - 1];
        if (lastEl) {
            selectETVBox(lastEl);
            lastEl.contentEditable = 'true';
            lastEl.focus();
            const range = document.createRange();
            range.selectNodeContents(lastEl);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }
    }, 50);
  }
}
window.addEmbeddedTextSpan = addEmbeddedTextSpan;

/* ---------- Hook: call on every pdf-file change to reset ------------ */
(function hookFileUpload() {
  const pdfInput = document.getElementById('pdf-file');
  if (!pdfInput) return;

  pdfInput.addEventListener('change', () => {
    etvResetState();
  });

  // Also hook drag-and-drop resets
  window.addEventListener('drop', () => {
    etvResetState();
  });
})();
