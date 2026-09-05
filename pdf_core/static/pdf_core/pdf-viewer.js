/* =========================================================
      PDF Viewer — single-page, PNG-based (no PDF.js)
      The server stores the opened document by content hash and
      serves each page's original 816×1056 px embedded image on
      demand from /page-image/<hash>/<n> — the open response is
      metadata only, so huge documents open instantly and the
      browser only ever holds the pages it shows. All
      coordinates are in that pixel space throughout.
      ========================================================= */

async function loadDocument(data, file) {
  state.pageImages = [];
  state.numPages = 0;
  if (typeof utbState !== 'undefined') {
    utbState.reset();
    if (typeof clearAllSVGLayers === 'function') clearAllSVGLayers();
  }
  state.numPages = data.num_pages || 1;
  state.pageWidth = data.page_width || GEO.PAGE_WIDTH_PX;
  state.pageHeight = data.page_height || GEO.PAGE_HEIGHT_PX;
  state.docHash = data.sha256 || null;
  // Per-page raster URLs — the browser fetches (and caches) a page only when
  // something shows it: the viewer, a thumbnail scrolled into view, an OCR
  // pass reading that page. Same bytes the old inline payload carried.
  state.pageImages = state.docHash
    ? Array.from({ length: state.numPages }, (_, i) => `/page-image/${state.docHash}/${i + 1}`)
    : [];

  els.pageCountElem.textContent = `/ ${state.numPages}`;
  els.pageInputElem.value = 1;
  els.pageInputElem.max = state.numPages;

  await goToPage(1);
  renderThumbnails();

  const autoSize = data.suggested_size || 12;  // points, sampled by the server

  if (typeof renderAllTextLayers === 'function') renderAllTextLayers();

  // Lifecycle: let plugins react to a freshly loaded document. Plugins that add
  // their own boxes or overlays hang off this event — the core names none of
  // them. `file === null` on the auto-loaded sample doc; `pdfFonts` are the
  // document's declared BaseFont names (most used first) and `sizePt` its
  // sampled body size — the facts a typography plugin turns into a default
  // face (the core keeps no font list of its own).
  await PDFHooks.emit('document:loaded', {
    file,
    isDefault: !file,
    pdfFonts: data.pdf_fonts || [],
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


