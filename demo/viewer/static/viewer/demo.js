// demo.js — minimal single-page viewer for the Recto demo.
//
// Same lazy model as Recto: opening a document returns metadata only
// (page count, geometry, sha256); each page raster is fetched on demand from
// /page-image/<hash>/<n> and cached forever by the browser. A tiny event bus
// (DemoHooks) keeps the three scripts decoupled the way Recto's PDFHooks
// does — same event names, so this code can back-port.

const DemoHooks = {
  _h: {},
  on(name, fn) { (this._h[name] ??= []).push(fn); },
  emit(name, payload) {
    for (const fn of this._h[name] || []) {
      try { fn(payload); } catch (e) { console.error(`hook ${name}:`, e); }
    }
  },
};

const demoState = {
  docHash: null,
  docName: null,
  numPages: 0,
  pageWidth: 816,
  pageHeight: 1056,
  pageImages: [],   // per-page raster URLs
  currentPage: 1,
  zoom: 1,
  seq: 0,           // document generation — supersedes stale async work
};

const $ = id => document.getElementById(id);

// ── Document loading ──────────────────────────────────────────

async function demoOpen(fetchPromise, name) {
  const seq = ++demoState.seq;
  try {
    const resp = await fetchPromise;
    if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText);
    const data = await resp.json();
    if (seq !== demoState.seq) return;   // user opened something newer
    demoState.docHash = data.sha256;
    demoState.docName = data.filename || name || 'document';
    demoState.numPages = data.num_pages || 1;
    demoState.pageWidth = data.page_width || 816;
    demoState.pageHeight = data.page_height || 1056;
    demoState.pageImages = Array.from({ length: demoState.numPages },
      (_, i) => `/page-image/${demoState.docHash}/${i + 1}`);

    $('doc-title').textContent = demoState.docName;
    $('page-count').textContent = `/ ${demoState.numPages}`;
    $('page-input').max = demoState.numPages;
    $('landing').hidden = true;
    $('viewer-container').hidden = false;
    $('nav-group').hidden = false;
    $('open-other').hidden = false;

    goToPage(1);
    DemoHooks.emit('document:loaded', { seq });
  } catch (e) {
    if (seq !== demoState.seq) return;
    alert(`Could not open the document: ${e.message}`);
  }
}

function openSample(name) {
  demoOpen(fetch(`/open-sample/${encodeURIComponent(name)}`), name);
}

function openUpload(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  demoOpen(fetch('/open-document', { method: 'POST', body: fd }), file.name);
}

// ── Page rendering ────────────────────────────────────────────

function goToPage(pageNum) {
  if (!demoState.pageImages.length) return;
  pageNum = Math.max(1, Math.min(pageNum, demoState.numPages));
  demoState.currentPage = pageNum;
  $('page-input').value = pageNum;

  const viewer = $('viewer');
  viewer.innerHTML = '';
  const pc = document.createElement('div');
  pc.className = 'page-container';
  pc.id = `pageContainer${pageNum}`;
  pc.style.setProperty('--page-width', `${demoState.pageWidth}px`);
  pc.style.setProperty('--page-height', `${demoState.pageHeight}px`);
  applyZoom(pc);

  const img = document.createElement('img');
  img.src = demoState.pageImages[pageNum - 1];
  img.draggable = false;
  pc.appendChild(img);
  viewer.appendChild(pc);

  DemoHooks.emit('page:rendered', { pageContainer: pc, pageNum });
}

function applyZoom(pc) {
  pc = pc || document.querySelector('.page-container');
  if (pc) pc.style.transform = `scale(${demoState.zoom})`;
  $('zoom-label').textContent = `${Math.round(demoState.zoom * 100)}%`;
}

function setZoom(z) {
  demoState.zoom = Math.max(0.25, Math.min(3, z));
  applyZoom();
}

// ── Wiring ────────────────────────────────────────────────────

$('prev-page').addEventListener('click', () => goToPage(demoState.currentPage - 1));
$('next-page').addEventListener('click', () => goToPage(demoState.currentPage + 1));
$('page-input').addEventListener('change', e => goToPage(Number(e.target.value) || 1));
$('zoom-in').addEventListener('click', () => setZoom(demoState.zoom + 0.25));
$('zoom-out').addEventListener('click', () => setZoom(demoState.zoom - 0.25));

$('upload-btn').addEventListener('click', () => $('pdf-file').click());
$('open-other').addEventListener('click', () => $('pdf-file').click());
$('pdf-file').addEventListener('change', e => { openUpload(e.target.files[0]); e.target.value = ''; });

for (const card of document.querySelectorAll('.sample-card')) {
  card.addEventListener('click', () => openSample(card.dataset.name));
}

// Drag & drop works on the whole window (landing or viewer alike).
window.addEventListener('dragover', e => {
  e.preventDefault();
  $('drop-zone')?.classList.add('drag');
});
window.addEventListener('dragleave', () => $('drop-zone')?.classList.remove('drag'));
window.addEventListener('drop', e => {
  e.preventDefault();
  $('drop-zone')?.classList.remove('drag');
  const f = e.dataTransfer?.files?.[0];
  if (f && f.name.toLowerCase().endsWith('.pdf')) openUpload(f);
});
