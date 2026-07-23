// attachments.js — base64 attachment extraction, incremental.
//
// Detection/decoding logic is ported from Recto's base64_tool
// (base64-tool.js): a block is a run of consecutive base64-looking lines with
// at least one "strong" line; decoded bytes are type-sniffed by magic number.
// Here the scan re-runs after every OCR'd page over the prefix of pages read
// so far — pages complete strictly in order, so a run still open at the last
// read page is shown as a shimmering "still reading…" partial card and only
// becomes actionable once it closes (padding, a non-base64 line, or the end
// of the document).

const attState = {
  blocks: [],     // finalized: { data, mime, ext, label, pages, chars }
  partial: null,  // { pages, chars } — open run at the frontier, not decodable yet
  urls: [],
  autoOpened: false,
  userClosed: false,
};

// ── Detection (ported from base64_tool) ───────────────────────

const B64_CONTENT = /^[A-Za-z0-9+/]+={0,2}$/;
const B64_MIN_BLOCK = 80;

function b64Stripped(text) {
  return (text || '').replace(/^\s*(?:>\s*)+/, '').replace(/\s+/g, '');
}

function b64IsCandidate(text) {
  const s = b64Stripped(text);
  return s.length >= 4 && B64_CONTENT.test(s);
}

function b64IsStrong(text) {
  const s = b64Stripped(text);
  return s.length >= 40 && B64_CONTENT.test(s) &&
    /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9+/]/.test(s);
}

// Reading-order lines -> { blocks: [...closed...], open: run|null }.
// The open run is the tail candidate that never flushed — a possible
// attachment continuing onto pages not yet read.
function b64FindBlocks(lines) {
  const blocks = [];
  let run = null;
  const flush = () => {
    if (run && run.strong && run.chars.length >= B64_MIN_BLOCK)
      blocks.push({ chars: run.chars, pages: [run.firstPage, run.lastPage] });
    run = null;
  };
  for (const line of lines) {
    if (run && !b64Stripped(line.text)) continue;   // OCR hiccup: neutral
    if (b64IsCandidate(line.text)) {
      const s = b64Stripped(line.text);
      if (!run) run = { chars: '', strong: false, firstPage: line.page, lastPage: line.page };
      run.chars += s;
      run.strong = run.strong || b64IsStrong(line.text);
      run.lastPage = line.page;
      if (s.endsWith('=')) flush();   // padding closes the attachment body
    } else {
      flush();
    }
  }
  const open = (run && run.strong && run.chars.length >= B64_MIN_BLOCK) ? run : null;
  flush();
  // NOTE: flush() just pushed the open run as a closed block too; when the
  // document isn't finished we report it as open INSTEAD — the caller decides.
  return { blocks, open };
}

function b64DecodeChars(chars) {
  let s = chars.replace(/=+/g, '');
  if (s.length % 4 === 1) s = s.slice(0, -1);
  s += '='.repeat((4 - s.length % 4) % 4);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64Sniff(bytes) {
  const at = (i, ...vals) => vals.every((v, k) => bytes[i + k] === v);
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return { mime: 'application/pdf', ext: 'pdf', label: 'PDF', icon: '📄' };
  if (at(0, 0x89, 0x50, 0x4E, 0x47)) return { mime: 'image/png', ext: 'png', label: 'PNG image', icon: '🖼️' };
  if (at(0, 0xFF, 0xD8, 0xFF)) return { mime: 'image/jpeg', ext: 'jpg', label: 'JPEG image', icon: '🖼️' };
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return { mime: 'image/gif', ext: 'gif', label: 'GIF image', icon: '🖼️' };
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return { mime: 'image/webp', ext: 'webp', label: 'WebP image', icon: '🖼️' };
  if (at(0, 0x50, 0x4B)) return { mime: 'application/zip', ext: 'zip', label: 'ZIP archive', icon: '🗜️' };
  const n = Math.min(bytes.length, 256);
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++;
  }
  if (n && printable / n > 0.9) return { mime: 'text/plain', ext: 'txt', label: 'Text file', icon: '📃' };
  return { mime: 'application/octet-stream', ext: 'bin', label: 'File', icon: '📎' };
}

function fmtSize(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

// ── Scanning ──────────────────────────────────────────────────

function attGatherLines(maxPage) {
  const lines = [];
  for (let p = 1; p <= maxPage; p++) {
    for (const l of demoText.pages[p] || []) lines.push(l);
  }
  return lines;
}

function attScan() {
  const maxPage = demoText.done;
  const finished = demoText.finished;
  const { blocks: raw, open } = b64FindBlocks(attGatherLines(maxPage));

  for (const u of attState.urls) URL.revokeObjectURL(u);
  attState.urls = [];
  attState.blocks = [];
  attState.partial = null;

  for (const r of raw) {
    // While reading, a run that reaches the frontier page may continue onto
    // the next page — hold it back as "partial" rather than serving a
    // truncated file.
    const isFrontier = !finished && open && r.chars === open.chars;
    if (isFrontier) { attState.partial = { pages: [r.pages[0], r.pages[1]], chars: r.chars.length }; continue; }
    let data;
    try { data = b64DecodeChars(r.chars); } catch { continue; }
    if (!data.length) continue;
    const kind = b64Sniff(data);
    attState.blocks.push({ data, ...kind, pages: r.pages, chars: r.chars.length });
  }
  if (!finished && !attState.partial && open && !raw.some(r => r.chars === open.chars)) {
    attState.partial = { pages: [open.firstPage, open.lastPage], chars: open.chars.length };
  }
  attRender();
}

// ── UI ────────────────────────────────────────────────────────

function attPageRange(pages) {
  return pages[0] === pages[1] ? `p. ${pages[0]}` : `p. ${pages[0]}–${pages[1]}`;
}

function attBlockUrl(block) {
  const url = URL.createObjectURL(new Blob([block.data], { type: block.mime }));
  attState.urls.push(url);
  return url;
}

function attFileName(block) {
  const doc = (demoState.docName || 'document').replace(/\.[^.]+$/, '');
  const idx = attState.blocks.indexOf(block) + 1;
  return `${doc}-attachment-${idx}.${block.ext}`;
}

function attRender() {
  const cards = $('att-cards');
  cards.innerHTML = '';
  const count = attState.blocks.length;

  if (!count && !attState.partial) {
    const empty = document.createElement('div');
    empty.className = 'att-empty';
    empty.textContent = demoText.finished
      ? 'No base64 attachments found in this document.'
      : 'Attachments found in the document appear here.';
    cards.appendChild(empty);
  }

  for (const block of attState.blocks) {
    const card = document.createElement('div');
    card.className = 'att-card';
    card.innerHTML = `
      <div class="att-card-top">
        <span class="att-type-icon">${block.icon}</span>
        <div>
          <div class="att-label">${block.label}</div>
          <div class="att-meta">${fmtSize(block.data.length)} · ${attPageRange(block.pages)}</div>
        </div>
      </div>
      <div class="att-actions">
        <button class="primary att-view">View</button>
        <button class="att-dl">Download</button>
      </div>`;
    card.querySelector('.att-view').addEventListener('click', () => {
      window.open(attBlockUrl(block), '_blank');
    });
    card.querySelector('.att-dl').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = attBlockUrl(block);
      a.download = attFileName(block);
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
    cards.appendChild(card);
  }

  if (attState.partial) {
    const card = document.createElement('div');
    card.className = 'att-card partial';
    card.innerHTML = `
      <div class="att-card-top">
        <span class="att-type-icon">📎</span>
        <div>
          <div class="att-label">Attachment</div>
          <div class="att-meta">${attPageRange(attState.partial.pages)}</div>
        </div>
      </div>
      <div class="att-actions">
        <button class="primary" disabled>View</button>
        <button disabled>Download</button>
      </div>`;
    cards.appendChild(card);
  }

  // status line
  const status = $('att-status');
  if (!demoText.total) status.textContent = 'Waiting for a document…';
  else if (!demoText.finished)
    status.textContent = `Reading the document — page ${demoText.done}/${demoText.total}…`
      + (count ? ` ${count} attachment${count > 1 ? 's' : ''} so far.` : '');
  else status.textContent = count
    ? `${count} attachment${count > 1 ? 's' : ''} found.`
    : 'Reading finished.';

  // badge on the floating toggle
  const badge = $('att-badge');
  badge.textContent = String(count);
  badge.classList.toggle('hidden', !count);

  // auto-open once, the first time something (even partial) shows up
  if ((count || attState.partial) && !attState.autoOpened && !attState.userClosed) {
    attState.autoOpened = true;
    attSetOpen(true);
  }
}

function attSetOpen(open) {
  $('att-panel').classList.toggle('hidden', !open);
  $('att-toggle').classList.toggle('hidden', open || !demoState.docHash);
}

// ── Wiring ────────────────────────────────────────────────────

$('att-close').addEventListener('click', () => { attState.userClosed = true; attSetOpen(false); });
$('att-toggle').addEventListener('click', () => attSetOpen(true));
$('att-rescan').addEventListener('click', attScan);

DemoHooks.on('document:loaded', () => {
  for (const u of attState.urls) URL.revokeObjectURL(u);
  attState.urls = [];
  attState.blocks = [];
  attState.partial = null;
  attState.autoOpened = false;
  attState.userClosed = false;
  attSetOpen(false);
  attRender();
});

DemoHooks.on('ocr:page-done', () => attScan());
DemoHooks.on('ocr:done', () => attScan());
