// text-tool.js
// Tool actions and OCR integration for the Unified Text Box system.
// Span fetching and embedded-text lifecycle are handled by etv-fetch.js (embedded_text_viewer).


// ── Tool: add redaction box ───────────────────────────────────

window.handleManualAddBox = function (pageNum, x, y) {
  if (typeof createNewRedaction === 'function') {
    const nearestLine = window._utbFindNearestLine?.(pageNum, y, 2.0);
    const finalY = nearestLine ? nearestLine.y : y - 10;
    const finalH = nearestLine ? nearestLine.h : 20;
    const finalLineId = nearestLine ? nearestLine.lineId : null;
    const lineFont = nearestLine?.font;
    const lineSizePt = nearestLine?.sizePt;
    createNewRedaction(pageNum, x - 50, finalY, 100, finalH, finalLineId, lineFont, lineSizePt);
    return;
  }

  // Fallback: pure UTB creation, when no plugin supplies createNewRedaction()
  const nearest = window._utbFindNearestLine?.(pageNum, y);
  const defaultFF = document.getElementById('fabric-font-family')?.value || 'Times New Roman';
  // Font-size input is in POINTS — no DPI conversion.
  const defaultSizePt = parseFloat(document.getElementById('fabric-font-size')?.value) || 12;

  const newBox = utbState.addBox(new UnifiedTextBox({
    type: 'redaction',
    page: pageNum,
    text: '',
    lineId: nearest ? nearest.lineId : null,
    x: x,
    y: nearest ? nearest.y : y - 10,
    w: nearest ? nearest.w : 100,
    h: nearest ? nearest.h : 20,
    fontFamily: nearest ? nearest.fontFamily : defaultFF,
    sizePt: nearest ? nearest.sizePt : defaultSizePt,
  }));

  renderBox(newBox);
  utbState.selectedId = newBox.id;
  selectBoxInSVG(newBox.id);
  if (typeof syncToolbarToBox === 'function') syncToolbarToBox(newBox);
};


// ── Tool: add editable text box ───────────────────────────────
// Creates a UnifiedTextBox of type 'embedded' at the click point and drops
// straight into inline-edit mode so the user can type immediately. This is the
// UTB-native replacement for the legacy etvState-based addEmbeddedTextSpan,
// which depended on the embedded-text-viewer overlay UI that isn't present here.

window.handleManualAddText = function (pageNum, x, y) {
  const nearest = window.utbFindNearestLine?.(pageNum, y);
  const defaultFF = document.getElementById('fabric-font-family')?.value || 'Times New Roman';
  // Font-size input is in POINTS — no DPI conversion.
  const defaultSizePt = parseFloat(document.getElementById('fabric-font-size')?.value) || 12;

  const newBox = utbState.addBox(new UnifiedTextBox({
    type: 'embedded',
    page: pageNum,
    text: 'Text',
    lineId: nearest ? nearest.lineId : null,
    x: x,
    y: nearest ? nearest.y : y - 10,
    w: nearest ? nearest.w : 100,
    h: nearest ? nearest.h : 20,
    fontFamily: nearest ? (nearest.font || nearest.fontFamily) : defaultFF,
    sizePt: nearest ? nearest.sizePt : defaultSizePt,
    autoWidth: true,  // size to text content; no manual resize handles
  }));

  renderBox(newBox);
  utbState.selectedId = newBox.id;
  selectBoxInSVG(newBox.id);
  if (typeof syncToolbarToBox === 'function') syncToolbarToBox(newBox);

  // Drop into inline edit so the placeholder is selected and ready to overwrite.
  if (typeof enterInlineEdit === 'function') enterInlineEdit(newBox);
};
