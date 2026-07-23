// ocr-adapter.js — runs the char_training blind reader page by page and
// makes the reading *visible*: a progress pill, a scanning shimmer on the
// page, and per-line highlights as lines are recognized.
//
// The engine files (BlindOCR, PageEngine) are served verbatim from
// ocr_tool/static — synced from the external char_training repo, never edited
// here. This adapter emits the same event names Recto plans to use
// (ocr:started / ocr:progress / ocr:page-done / ocr:done) so consumers stay
// decoupled from the runner.

const demoText = {
  pages: [],      // pages[pageNum] = [{ page, text }] in reading order
  geo: [],        // geo[pageNum] = [{ x, y, w, h }] scaled line rects (for highlights)
  done: 0,
  total: 0,
  finished: false,
};

const GLYPHS_BASE = '/static/ocr_tool/glyphs/';

const ocrState = { sets: null, engine: null, passHint: null, seq: 0 };

async function ocrSets() {
  if (ocrState.sets) return ocrState.sets;
  const r = await fetch(GLYPHS_BASE + 'index.json', { cache: 'no-store' });
  if (!r.ok) throw new Error('glyph sets missing');
  const names = await r.json();
  const sets = await BlindOCR.loadSets(names.map(n => GLYPHS_BASE + n));
  if (!sets.length) throw new Error('glyph sets failed to load');
  ocrState.sets = sets;
  return sets;
}

function loadPageImage(pageNum) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`page ${pageNum} failed to load`));
    img.src = demoState.pageImages[pageNum - 1];
  });
}

// ── Progress pill ─────────────────────────────────────────────

function pillShow(text) {
  const pill = $('ocr-pill');
  pill.classList.remove('hidden', 'done', 'fade');
  $('pill-text').textContent = text;
}

function pillProgress(text, frac) {
  $('pill-text').textContent = text;
  $('pill-fill').style.width = `${Math.round(frac * 100)}%`;
}

function pillFinish(text) {
  const pill = $('ocr-pill');
  pill.classList.add('done');
  $('pill-text').textContent = text;
  $('pill-fill').style.width = '100%';
  setTimeout(() => pill.classList.add('fade'), 2500);
  setTimeout(() => pill.classList.add('hidden'), 3000);
}

// ── Page shimmer + line highlights ────────────────────────────

let ocrReadingPage = 0;   // page the engine is currently on (0 = none)

function shimmerSync() {
  const pc = document.querySelector('.page-container');
  if (!pc) return;
  pc.classList.toggle('ocr-reading', ocrReadingPage === demoState.currentPage);
}

function pageDoneFlash(pageNum) {
  const pc = document.getElementById(`pageContainer${pageNum}`);
  if (!pc) return;
  pc.classList.remove('ocr-reading');
  pc.classList.add('ocr-read-flash');
  setTimeout(() => pc.classList.remove('ocr-read-flash'), 900);
  // line highlights sweep in with a slight stagger — the "it read this" moment
  const rects = demoText.geo[pageNum] || [];
  rects.forEach((r, i) => {
    setTimeout(() => {
      const el = document.createElement('div');
      el.className = 'ocr-line';
      el.style.left = `${r.x}px`;
      el.style.top = `${r.y}px`;
      el.style.width = `${r.w}px`;
      el.style.height = `${r.h}px`;
      pc.appendChild(el);
      setTimeout(() => el.remove(), 1500);
    }, i * 40);
  });
}

DemoHooks.on('page:rendered', ({ pageNum }) => {
  shimmerSync();
  // replay this page's highlights if it was read while off-screen? No —
  // keep it calm: highlights only play live, the attachments are the payoff.
});

// ── The run ───────────────────────────────────────────────────

async function ocrRunAll() {
  const seq = ++ocrState.seq;
  const live = () => seq === ocrState.seq;

  demoText.pages = [];
  demoText.geo = [];
  demoText.done = 0;
  demoText.total = demoState.numPages;
  demoText.finished = false;
  ocrState.passHint = null;
  ocrState.engine = null;

  pillShow('Loading the reader…');
  DemoHooks.emit('ocr:started', { pages: demoText.total });

  try {
    const sets = await ocrSets();
    if (!live()) return;
    const carry = {};
    for (let p = 1; p <= demoText.total; p++) {
      if (!live()) return;
      const img = await loadPageImage(p);
      if (!live()) return;
      ocrReadingPage = p;
      shimmerSync();
      ocrState.engine ??= new PageEngine();
      const page = BlindOCR.whitenColored(ocrState.engine._pageFor(img),
        ocrState.engine.pageRGBA(img));
      const { res, pass } = await BlindOCR.readPageAuto(page, sets, {
        passHint: ocrState.passHint,
        carry,
        progress: (pl, d, t) => {
          if (!live()) return;
          pillProgress(`Reading page ${p}/${demoText.total} — line ${d}/${t}`,
            (p - 1 + (t ? d / t : 0)) / demoText.total);
          DemoHooks.emit('ocr:progress', { page: p, done: p - 1, total: demoText.total, band: d, bands: t });
        },
      });
      if (!live()) return;
      ocrState.passHint = pass;

      const sx = demoState.pageWidth / img.naturalWidth;
      const sy = demoState.pageHeight / img.naturalHeight;
      const lines = [], rects = [];
      for (const L of res.lines) {
        if (!L.set || !L.entries?.length) continue;   // unreadable band
        lines.push({ page: p, text: L.text });
        const first = L.entries[0], last = L.entries[L.entries.length - 1];
        rects.push({
          x: first.pen * sx,
          y: L.top * sy,
          w: Math.max(8, (last.pen + last.adv - first.pen) * sx),
          h: Math.max(4, (L.bot - L.top) * sy),
        });
      }
      demoText.pages[p] = lines;
      demoText.geo[p] = rects;
      demoText.done = p;

      ocrReadingPage = 0;
      pageDoneFlash(p);
      pillProgress(`Read page ${p}/${demoText.total}`, p / demoText.total);
      DemoHooks.emit('ocr:page-done', { page: p, done: p, total: demoText.total });
    }
    demoText.finished = true;
    const lineCount = demoText.pages.flat().filter(Boolean).length;
    pillFinish(`Read ${demoText.total} page${demoText.total > 1 ? 's' : ''} · ${lineCount} lines`);
    DemoHooks.emit('ocr:done', { cancelled: false });
  } catch (e) {
    if (!live()) return;
    console.error('OCR:', e);
    ocrReadingPage = 0;
    shimmerSync();
    pillFinish(`Reader error: ${e.message}`);
    demoText.finished = true;
    DemoHooks.emit('ocr:done', { cancelled: true, error: e.message });
  }
}

DemoHooks.on('document:loaded', () => { ocrRunAll(); });
