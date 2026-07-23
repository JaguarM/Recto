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
//
// Two OCR realities shape the rules here (a wrapped attachment body is ONE
// file and must come out as one file):
// - Long base64 lines wrap, dropping the overflow (1–3 chars, e.g. a lone
//   "F") onto its own line. Such a fragment CONTINUES the current run —
//   requiring candidate length there would split the attachment at every
//   wrap.
// - '=' padding genuinely ends an attachment, but a misread can also plant
//   '=' mid-body. So padding only *closes* the run ("padEnded"); the split
//   happens when what follows is prose (normal flush) or base64 that decodes
//   to a recognizable NEW file header (two attachments back to back). Body
//   that decodes to noise means the '=' was a misread — the run continues,
//   because splitting one file in half destroys both halves while a merged
//   file survives a 1–2 byte corruption. (Trade-off: two adjacent
//   attachments with NO separator line where the second has no sniffable
//   magic — e.g. two text files — would merge; real emails always carry
//   MIME boundary lines between attachments, so prose-flush handles them.)
function b64FindBlocks(lines) {
  const blocks = [];
  let run = null;
  const flush = () => {
    if (run && run.strong && run.chars.length >= B64_MIN_BLOCK)
      blocks.push({ chars: run.chars, pages: [run.firstPage, run.lastPage] });
    run = null;
  };
  for (const line of lines) {
    const s = b64Stripped(line.text);
    if (run && !s) continue;                        // OCR hiccup: neutral
    const cand = b64IsCandidate(line.text);
    const frag = !cand && run && s.length < 4 && /^[A-Za-z0-9+/=]+$/.test(s);
    if (cand || frag) {
      const strong = b64IsStrong(line.text);
      if (run?.padEnded && b64StartsNewFile(s)) flush();   // next attachment starts
      if (!run) run = { chars: '', strong: false, firstPage: line.page, lastPage: line.page };
      run.chars += s;
      run.strong = run.strong || strong;
      run.lastPage = line.page;
      run.padEnded = s.endsWith('=');
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

// Would this base64 line open a NEW file? Decode its first bytes and look
// for magic. Text-ish and unknown results say "no" — after mid-stream
// padding, continuation noise must merge, and only a sniffable header is
// strong evidence of a second attachment.
function b64StartsNewFile(chars) {
  if (chars.length < 8) return false;
  try {
    const kind = b64Sniff(b64DecodeChars(chars.slice(0, 24)));
    return !['txt', 'bin', 'xml', 'json', 'html', 'eml'].includes(kind.ext);
  } catch { return false; }
}

function b64DecodeChars(chars) {
  // Strip only TRAILING padding; an '=' stuck mid-stream is an OCR misread —
  // deleting it would shift every later byte by 6 bits, so substitute a
  // placeholder char instead and keep the rest of the file byte-aligned
  // (cost: 1–2 wrong bytes at the misread, not a corrupted tail).
  let s = chars.replace(/=+$/, '').replace(/=/g, 'A');
  if (s.length % 4 === 1) s = s.slice(0, -1);
  s += '='.repeat((4 - s.length % 4) % 4);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Magic-byte type sniffing. Each entry: mime + correct filename extension +
// human label + how the View button may show it — 'inline' (browser renders
// the real mime: PDF, images, audio, video, plain text), 'text' (viewable,
// but forced to text/plain so decoded HTML/SVG/XML can never run script in
// our origin), or 'none' (archives / unknown binary: download only).
function b64Sniff(bytes) {
  const at = (i, ...vals) => vals.every((v, k) => bytes[i + k] === v);
  const str = (i, len) => String.fromCharCode(...bytes.slice(i, i + len));
  const has = (needle, limit) => str(0, Math.min(bytes.length, limit)).includes(needle);
  const t = (mime, ext, label, icon, view = 'inline') => ({ mime, ext, label, icon, view });

  // documents
  if (str(0, 4) === '%PDF') return t('application/pdf', 'pdf', 'PDF', '📄');
  if (str(0, 5) === '{\\rtf') return t('application/rtf', 'rtf', 'RTF document', '📄', 'text');
  if (at(0, 0xD0, 0xCF, 0x11, 0xE0)) return t('application/msword', 'doc', 'Office document (legacy)', '📄', 'none');

  // images
  if (at(0, 0x89, 0x50, 0x4E, 0x47)) return t('image/png', 'png', 'PNG image', '🖼️');
  if (at(0, 0xFF, 0xD8, 0xFF)) return t('image/jpeg', 'jpg', 'JPEG image', '🖼️');
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return t('image/gif', 'gif', 'GIF image', '🖼️');
  if (at(0, 0x42, 0x4D)) return t('image/bmp', 'bmp', 'BMP image', '🖼️');
  if (at(0, 0x00, 0x00, 0x01, 0x00)) return t('image/x-icon', 'ico', 'Icon', '🖼️');
  if (at(0, 0x49, 0x49, 0x2A, 0x00) || at(0, 0x4D, 0x4D, 0x00, 0x2A))
    return t('image/tiff', 'tif', 'TIFF image', '🖼️', 'none');   // browsers don't render TIFF

  // RIFF container: WebP / WAV / AVI
  if (str(0, 4) === 'RIFF') {
    const kind = str(8, 4);
    if (kind === 'WEBP') return t('image/webp', 'webp', 'WebP image', '🖼️');
    if (kind === 'WAVE') return t('audio/wav', 'wav', 'WAV audio', '🎵');
    if (kind === 'AVI ') return t('video/x-msvideo', 'avi', 'AVI video', '🎬', 'none');
    return t('application/octet-stream', 'riff', 'RIFF file', '📎', 'none');
  }

  // ISO media (ftyp box): m4a / mp4 / mov / heic
  if (str(4, 4) === 'ftyp') {
    const brand = str(8, 4);
    if (brand.startsWith('M4A')) return t('audio/mp4', 'm4a', 'M4A audio', '🎵');
    if (brand.startsWith('M4B')) return t('audio/mp4', 'm4b', 'M4B audiobook', '🎵');
    if (brand.startsWith('qt')) return t('video/quicktime', 'mov', 'QuickTime video', '🎬');
    if (brand.startsWith('hei') || brand === 'mif1') return t('image/heic', 'heic', 'HEIC image', '🖼️', 'none');
    return t('video/mp4', 'mp4', 'MP4 video', '🎬');
  }

  // audio
  if (str(0, 3) === 'ID3' || (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0))
    return t('audio/mpeg', 'mp3', 'MP3 audio', '🎵');
  if (str(0, 4) === 'OggS') return t('audio/ogg', 'ogg', 'Ogg audio', '🎵');
  if (str(0, 4) === 'fLaC') return t('audio/flac', 'flac', 'FLAC audio', '🎵');

  // video (EBML: webm or matroska)
  if (at(0, 0x1A, 0x45, 0xDF, 0xA3))
    return has('webm', 64) ? t('video/webm', 'webm', 'WebM video', '🎬')
      : t('video/x-matroska', 'mkv', 'Matroska video', '🎬', 'none');

  // archives
  if (str(0, 2) === 'PK') {
    // OOXML/EPUB are ZIPs — the member paths appear early in the stream
    const head = str(0, Math.min(bytes.length, 4096));
    if (head.includes('word/')) return t('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx', 'Word document', '📄', 'none');
    if (head.includes('xl/')) return t('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx', 'Excel spreadsheet', '📊', 'none');
    if (head.includes('ppt/')) return t('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx', 'PowerPoint', '📊', 'none');
    if (head.includes('mimetypeapplication/epub')) return t('application/epub+zip', 'epub', 'EPUB book', '📚', 'none');
    return t('application/zip', 'zip', 'ZIP archive', '🗜️', 'none');
  }
  if (at(0, 0x37, 0x7A, 0xBC, 0xAF)) return t('application/x-7z-compressed', '7z', '7-Zip archive', '🗜️', 'none');
  if (str(0, 4) === 'Rar!') return t('application/vnd.rar', 'rar', 'RAR archive', '🗜️', 'none');
  if (at(0, 0x1F, 0x8B)) return t('application/gzip', 'gz', 'Gzip archive', '🗜️', 'none');
  if (str(0, 3) === 'BZh') return t('application/x-bzip2', 'bz2', 'Bzip2 archive', '🗜️', 'none');
  if (str(257, 5) === 'ustar') return t('application/x-tar', 'tar', 'TAR archive', '🗜️', 'none');

  // text-ish (viewed as text/plain so markup can never execute)
  const n = Math.min(bytes.length, 512);
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 128) printable++;
  }
  if (n && printable / n > 0.9) {
    const head = str(0, n).trimStart().toLowerCase();
    if (head.startsWith('<?xml'))
      return has('<svg', 2048) ? t('image/svg+xml', 'svg', 'SVG image', '🖼️', 'text')
        : t('application/xml', 'xml', 'XML file', '📃', 'text');
    if (head.startsWith('<svg')) return t('image/svg+xml', 'svg', 'SVG image', '🖼️', 'text');
    if (head.startsWith('<!doctype html') || head.startsWith('<html'))
      return t('text/html', 'html', 'HTML file', '📃', 'text');
    if (head.startsWith('{') || head.startsWith('[')) {
      try { JSON.parse(str(0, bytes.length)); return t('application/json', 'json', 'JSON file', '📃', 'text'); }
      catch { /* not valid JSON — plain text */ }
    }
    if (/^(from|received|return-path|mime-version|date|subject):/.test(head))
      return t('message/rfc822', 'eml', 'Email message', '✉️', 'text');
    return t('text/plain', 'txt', 'Text file', '📃');
  }
  return t('application/octet-stream', 'bin', 'File', '📎', 'none');
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

function attBlockUrl(block, mimeOverride) {
  const url = URL.createObjectURL(new Blob([block.data], { type: mimeOverride || block.mime }));
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
        <button class="primary att-view"${block.view === 'none' ? ' disabled title="No browser preview for this type — use Download"' : ''}>View</button>
        <button class="att-dl">Download</button>
      </div>`;
    card.querySelector('.att-view').addEventListener('click', () => {
      // 'text' types (HTML/SVG/XML/…) open as text/plain: readable, but the
      // decoded markup can never run script in this page's origin.
      window.open(attBlockUrl(block, block.view === 'text' ? 'text/plain' : null), '_blank');
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
