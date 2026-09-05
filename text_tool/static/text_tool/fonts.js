// fonts.js — the font catalogue on the browser side.
//
// Fetches /fonts-list (assets/fonts/fonts.json + which files are installed),
// then does the three things every face needs done once:
//   1. @font-face rules for every installed style, so SVG text in
//      font-family "Nimbus Roman" is drawn with the actual URW file — the
//      face MuPDF rendered the scan with — instead of whatever the OS picks;
//   2. the toolbar's font menu (#fabric-font-family), one option per family,
//      MuPDF's own faces first;
//   3. window.FontCatalog for everyone else: has(), familyForPdfName(),
//      select(family, sizePt).
//
// Two generic events choose the default face, so no plugin is named here:
//   document:loaded   — the core's declared PDF fonts (pdfFonts) and sampled
//                       body size (sizePt) set the initial selection;
//   typography:detected ({ fontFamily, sizePt, source }) — an analysis plugin
//                       that measured the page (an OCR read, say) overrides it.
(function () {
  const catalog = { families: [], byFamily: new Map(), default: 'Times New Roman', staticBase: '/static/fonts/', ready: null };

  const WEIGHT = { regular: 400, bold: 700, italic: 400, bolditalic: 700 };
  const STYLE = { regular: 'normal', bold: 'normal', italic: 'italic', bolditalic: 'italic' };
  const format = f => /\.otf$/i.test(f) ? 'opentype' : 'truetype';

  function injectFontFaces() {
    let css = '';
    for (const fam of catalog.families)
      for (const [style, file] of Object.entries(fam.files))
        if (fam.present[style])
          css += `@font-face { font-family: "${fam.family}"; src: url("${catalog.staticBase}${file}") format("${format(file)}"); ` +
                 `font-weight: ${WEIGHT[style]}; font-style: ${STYLE[style]}; font-display: block; }\n`;
    let el = document.getElementById('tt-font-faces');
    if (!el) { el = document.createElement('style'); el.id = 'tt-font-faces'; document.head.appendChild(el); }
    el.textContent = css;
  }

  function fillMenu() {
    const sel = document.getElementById('fabric-font-family');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '';
    for (const fam of catalog.families) {
      const opt = document.createElement('option');
      opt.value = fam.family;
      opt.textContent = fam.present.regular ? fam.family : `${fam.family} (not installed)`;
      opt.disabled = !fam.present.regular;
      if (fam.class === 'mupdf') opt.title = fam.note || 'one of MuPDF\'s own faces';
      sel.appendChild(opt);
    }
    if (current && catalog.byFamily.has(current)) sel.value = current;
    else sel.value = catalog.default;
  }

  function has(family) { return catalog.byFamily.has(family); }

  // 'ABCDEF+TimesNewRomanPSMT-Bold' → 'Times New Roman'; longest alias wins
  function familyForPdfName(name) {
    if (!name) return null;
    const key = String(name).split('+').pop().replace(/[\s,-]/g, '').toLowerCase();
    let best = null, bestLen = 0;
    for (const fam of catalog.families)
      for (const alias of fam.pdfNames || []) {
        const a = alias.replace(/[\s,-]/g, '').toLowerCase();
        if (key.startsWith(a) && a.length > bestLen) { best = fam.family; bestLen = a.length; }
      }
    return best;
  }

  // set the toolbar's font (and size) — the default for the next added box
  function select(family, sizePt) {
    const sel = document.getElementById('fabric-font-family');
    if (sel && family) {
      if (!Array.from(sel.options).some(o => o.value === family)) {
        const opt = document.createElement('option');
        opt.value = family; opt.textContent = `${family} (not installed)`;
        sel.appendChild(opt);
      }
      sel.value = family;
      if (typeof textOptions !== 'undefined') textOptions.fontFamily = family;
    }
    const size = document.getElementById('fabric-font-size');
    if (size && sizePt > 0) size.value = Math.round(sizePt * 100) / 100;
  }

  catalog.ready = (async () => {
    try {
      const r = await fetch('/fonts-list', { cache: 'no-store' });
      const data = await r.json();
      catalog.families = Array.isArray(data) ? [] : (data.families || []);
      catalog.default = data.default || catalog.default;
      catalog.staticBase = data.static || catalog.staticBase;
      catalog.byFamily = new Map(catalog.families.map(f => [f.family, f]));
      injectFontFaces();
      fillMenu();
    } catch (e) {
      console.warn('font catalogue unavailable:', e);
    }
    return catalog;
  })();

  PDFHooks.on('document:loaded', async e => {
    await catalog.ready;
    const declared = (e?.pdfFonts || []).map(familyForPdfName).find(Boolean);
    select(declared || catalog.default, e?.sizePt);
  });
  PDFHooks.on('typography:detected', async e => {
    await catalog.ready;
    if (e?.fontFamily) select(e.fontFamily, e.sizePt);
  });

  window.FontCatalog = { has, familyForPdfName, select,
    families: () => catalog.families, get ready() { return catalog.ready; }, get default() { return catalog.default; } };
})();
