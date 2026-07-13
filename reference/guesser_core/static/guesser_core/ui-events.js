/* UTB span element lookup — used for Redaction → text span sync */
function getUTBGroupEl(box) {
  return document.querySelector(`.utb-group[data-id="${box.id}"]`) || null;
}

/* Zoom Handlers */
function updateZoomLevelText() { els.zoomInputElem.value = `${Math.round(state.currentZoom * 100)}%`; }

function updateCSSZoom() {
  els.viewer.style.setProperty('--scale-factor', state.currentZoom);
  els.viewer.classList.toggle('zoom-in', state.currentZoom > 1.0);
  updateZoomLevelText();
  PDFHooks.emit('zoom:changed', { zoom: state.currentZoom });
}

function processZoomFromText(newZoom, mouseX = null, mouseY = null) {
  const constrainedZoom = Math.min(Math.max(newZoom, state.minZoom), state.maxZoom);
  if (constrainedZoom !== state.currentZoom) {
    const prevZoom = state.currentZoom;
    state.currentZoom = constrainedZoom;

    if (mouseX !== null && mouseY !== null) {
      const docX = (els.viewerContainer.scrollLeft + mouseX) / prevZoom;
      const docY = (els.viewerContainer.scrollTop + mouseY) / prevZoom;

      updateCSSZoom();
      els.viewerContainer.scrollLeft = (docX * state.currentZoom) - mouseX;
      els.viewerContainer.scrollTop = (docY * state.currentZoom) - mouseY;
    } else {
      updateCSSZoom();
    }
  } else {
    updateZoomLevelText();
  }
}

// No canvas re-render needed — the page is a static <img> that scales via CSS.

// initResize() and initDragRedaction() removed —
// SVG-native drag and resize is now handled entirely by drag-resize.js.

/* Thumbnails */
function renderThumbnails() {
  els.thumbnailView.innerHTML = '';

  for (let i = 1; i <= state.numPages; i++) {
    const thumbCont = document.createElement('div');
    thumbCont.className = 'thumbnail-container' + (i === state.currentPage ? ' active' : '');

    const img = document.createElement('img');
    img.src = state.pageImages[i - 1];
    img.className = 'thumbnail';
    img.draggable = false;
    img.style.width = '180px';
    img.style.height = 'auto';
    img.style.display = 'block';

    const lbl = document.createElement('div');
    lbl.className = 'thumbnail-page-num';
    lbl.textContent = i;

    thumbCont.appendChild(img);
    thumbCont.appendChild(lbl);
    els.thumbnailView.appendChild(thumbCont);

    thumbCont.addEventListener('click', () => goToPage(i));
  }
}