/* =========================================================
   redaction_lab — redaction analysis as a plugin
   =========================================================
   The core opens and renders the document, then emits 'document:loaded'.
   We take it from there: ask our own endpoint where the black bars are, and
   turn each one into an editable UnifiedTextBox sized to the bar.

   The core knows nothing about any of this. Delete this folder and the app is
   a PDF editor with no notion of redactions.
   ========================================================= */
(function () {
  const els = {
    tol:   () => document.getElementById('tolerance'),
    kern:  () => document.getElementById('kerning'),
    upper: () => document.getElementById('force-uppercase'),
  };

  /* ── Ingest detected bars ──────────────────────────────── */

  PDFHooks.on('document:loaded', async ({ file, isDefault, fontFamily, sizePt }) => {
    if (typeof utbState === 'undefined' || typeof UnifiedTextBox === 'undefined') {
      return;  // text_tool absent — nothing to draw boxes with
    }

    let data;
    try {
      if (isDefault) {
        const resp = await fetch('/redaction/analyze-default');
        if (!resp.ok) return;
        data = await resp.json();
      } else {
        if (!file) return;
        const fd = new FormData();
        fd.append('file', file);
        const resp = await fetch('/redaction/analyze', { method: 'POST', body: fd });
        if (!resp.ok) throw new Error((await resp.json()).detail);
        data = await resp.json();
      }
    } catch (e) {
      console.error('[redaction_lab] detection failed:', e.message);
      return;
    }

    (data.redactions || []).forEach(r => {
      utbState.addBox(new UnifiedTextBox({
        type:       'redaction',
        page:       r.page,
        text:       '',
        lineId:     null,
        x: r.x, y: r.y, w: r.width, h: r.height,
        fontFamily: fontFamily,
        sizePt:     sizePt,
        kerning:    els.kern()?.checked ?? false,
        uppercase:  els.upper()?.checked ?? false,
        tolerance:  parseFloat(els.tol()?.value) || 0,
        widths:     {},
        labelText:  '',
        manualLabel: false,
      }));
    });

    if (typeof renderAllTextLayers === 'function') renderAllTextLayers();
  });

  /* ── Match controls ────────────────────────────────────── */
  // Tolerance / Kerning / Uppercase tune how a candidate's rendered width is
  // compared against the bar. They apply to the selected redaction box only.

  PDFHooks.on('ui:ready', () => {
    [els.kern(), els.upper(), els.tol()].filter(Boolean).forEach(el =>
      el.addEventListener('change', () => {
        if (typeof utbState === 'undefined' || !utbState.selectedId) return;
        const box = utbState.getBox(utbState.selectedId);
        if (!box || box.type !== 'redaction') return;

        box.tolerance = parseFloat(els.tol()?.value) || 0;
        box.kerning   = els.kern()?.checked ?? box.kerning;
        box.uppercase = els.upper()?.checked ?? box.uppercase;

        if (el === els.tol()) {
          // Width is unchanged by tolerance — only which candidates pass.
          if (typeof updateAllMatchesView === 'function') updateAllMatchesView(box.id);
        } else {
          // Re-render first so the live SVG element carries the updated
          // font-kerning style before anything measures it via getBBox().
          if (typeof renderBox === 'function') renderBox(box);
          if (typeof calculateWidthsForRedaction === 'function') calculateWidthsForRedaction(box.id);
        }
      })
    );
  });
})();
