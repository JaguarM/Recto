/* =========================================================
      PDF Viewer — single-page, PNG-based (no PDF.js)
      The server extracts the original 816×1056 px embedded
      image and returns it as base64.  All coordinates are in
      that pixel space throughout.
      ========================================================= */

// Maps a .ttf filename (from the server) to the CSS font family name used in
// the Fabric text-annotation toolbar.  Only the four supported fonts.
function ttfToFabricFont(ttfName) {
  const map = {
    'times.ttf': 'Times New Roman',
    'courier_new.ttf': 'Courier New',
    'arial.ttf': 'Arial',
    'calibri.ttf': 'Calibri',
    'segoe_ui.ttf': 'Segoe UI',
    'verdana.ttf': 'Verdana',
  };
  return map[ttfName] || null;
}

async function loadDocument(data, file) {
  state.pageImages = [];
  state.numPages = 0;
  if (typeof utbState !== 'undefined') {
    utbState.reset();
    if (typeof clearAllSVGLayers === 'function') clearAllSVGLayers();
  }
  const imgType = data.page_image_type || 'image/png';
  state.pageImages = (data.page_images || []).map(b64 => b64 ? `data:${imgType};base64,${b64}` : null);
  state.maskImages = (data.mask_images || []).map(b64 => b64 ? `data:image/png;base64,${b64}` : null);
  state.numPages = data.num_pages || state.pageImages.length || 1;
  state.pageWidth = data.page_width || GEO.PAGE_WIDTH_PX;
  state.pageHeight = data.page_height || GEO.PAGE_HEIGHT_PX;

  els.pageCountElem.textContent = `/ ${state.numPages}`;
  els.pageInputElem.value = 1;
  els.pageInputElem.max = state.numPages;

  await goToPage(1);
  renderThumbnails();

  const autoScale = data.suggested_scale || GEO.DEFAULT_SCALE;
  const autoSize = data.suggested_size || 12;  // points
  const autoFont = data.suggested_font || null;

  // Derive initial font family (CSS name)
  let initialFontFamily = 'Times New Roman';
  if (autoFont) {
    const fabricFont = ttfToFabricFont(autoFont);
    if (fabricFont) initialFontFamily = fabricFont;
  }

  // Sync fabric toolbar to the document's detected font/size. The font-size
  // input holds POINTS (the canonical unit) — no DPI conversion here.
  const fabricSel = document.getElementById('fabric-font-family');
  if (fabricSel && Array.from(fabricSel.options).find(o => o.value === initialFontFamily)) {
    fabricSel.value = initialFontFamily;
    if (typeof textOptions !== 'undefined') textOptions.fontFamily = initialFontFamily;
  }
  const fabricSizeInput = document.getElementById('fabric-font-size');
  if (fabricSizeInput) fabricSizeInput.value = autoSize;

  if (typeof renderAllTextLayers === 'function') renderAllTextLayers();

  // Lifecycle: let plugins react to a freshly loaded document. Plugins that add
  // their own boxes (redaction_lab) or overlays (webgl masks, embedded-text
  // spans) hang off this event. `file === null` on the auto-loaded sample doc;
  // `initialFontFamily`/`autoSize` are the document's detected typography, which
  // box-creating plugins use as their defaults.
  await PDFHooks.emit('document:loaded', {
    file,
    isDefault: !file,
    fontFamily: initialFontFamily,
    sizePt: autoSize,
  });

  if (typeof renderAllTextLayers === 'function') renderAllTextLayers();
}

async function handleFileUpload(e) {
  const file = els.pdfFile.files[0] || (e && e.dataTransfer && e.dataTransfer.files[0]);
  if (!file) return;
  state.hasPdf = (file.name || '').split('.').pop().toLowerCase() === 'pdf';
  state.currentFile = file;
  els.titleElem.textContent = file.name;

  // Premium: Show loader and hide placeholder icons
  const placeholder = document.getElementById('viewer-placeholder');
  const loader = document.getElementById('analysis-loader');
  const placeholderIcon = placeholder?.querySelector('.material-symbols-outlined');
  const placeholderText = document.getElementById('placeholder-text');
  
  if (loader) loader.classList.remove('hidden');
  if (placeholderText) placeholderText.classList.add('hidden');
  if (placeholderIcon) placeholderIcon.classList.add('hidden');

  try {
    const fd = new FormData();
    fd.append('file', file);
    const resp = await fetch('/open-document', { method: 'POST', body: fd });
    if (!resp.ok) throw new Error((await resp.json()).detail);
    await loadDocument(await resp.json(), file);

    // Hide placeholder entirely once loaded
    if (placeholder) placeholder.classList.add('hidden');
  } catch (e) {
    console.error('Error opening document:', e.message);
    if (loader) loader.classList.add('hidden');
    if (placeholderText) {
      placeholderText.textContent = `Error: ${e.message}`;
      placeholderText.classList.remove('hidden', 'error');
      placeholderText.style.color = '#f28b82';
    }
  }
}


async function goToPage(pageNum) {
  if (!state.pageImages.length) return;
  pageNum = Math.max(1, Math.min(pageNum, state.numPages));

  PDFHooks.emit('viewer:clear');

  state.currentPage = pageNum;
  els.pageInputElem.value = pageNum;
  els.viewer.innerHTML = '';
  els.viewerContainer.scrollTop = 0;
  updateCSSZoom();

  // Sync active thumbnail
  document.querySelectorAll('.thumbnail-container').forEach((c, i) => {
    c.classList.toggle('active', i + 1 === pageNum);
  });

  // Page container — dimensions match the uploaded image's pixel space
  const pageContainer = document.createElement('div');
  pageContainer.className = 'page-container';
  pageContainer.id = `pageContainer${pageNum}`;
  pageContainer.style.setProperty('--page-width', `${state.pageWidth}px`);
  pageContainer.style.setProperty('--page-height', `${state.pageHeight}px`);

  // Original embedded image as the page background
  const img = document.createElement('img');
  img.id = `page${pageNum}`;
  img.src = state.pageImages[pageNum - 1];
  img.draggable = false;
  img.style.display = 'block';
  img.style.width = '100%';
  img.style.height = '100%';
  pageContainer.appendChild(img);

  els.viewer.appendChild(pageContainer);

  // Lifecycle: plugins draw their per-page overlays (webgl mask canvas, SVG
  // text layer, …) in response to this event. The core owns no overlay DOM.
  PDFHooks.emit('page:rendered', { pageContainer, pageNum });
  PDFHooks.emit('pages:refresh');
}


