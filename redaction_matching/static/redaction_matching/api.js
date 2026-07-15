/* =========================================================
       Inspection Logic — reads/writes utbState.boxes directly
       ========================================================= */

    /* ── Plugin-owned state & DOM ──────────────────────────────
       The core declares nothing plugin-specific: `state` holds only viewer
       state and `els` only core elements. So this plugin contributes its own
       fields onto both, here, at load time. Delete this folder and they go
       with it — which is exactly why the core no longer declares them.

       This file is a `scripts_before_viewer` entry, so it runs after state.js
       (which defines `state`/`els`) and before pdf-viewer.js — and the sidebar
       and Match-ribbon markup are already in the DOM at parse time.
       ───────────────────────────────────────────────────────── */
    Object.assign(state, {
      namesData: [],              // raw JSON entries from the candidate list
      customCandidates: [],       // names added manually (shared across all boxes)
      excludedPersons: new Set(), // indices into namesData that were deleted — global
      candidates: [],             // template/global union (template nameSettings ∪ custom)

      // Template name-format settings: edited when no box is selected, copied
      // onto each new redaction box. Per-box overrides live on box.nameSettings.
      nameSettings: {
        generateFull: true,
        generateFirstOnly: false,
        generateLastOnly: false,
        includePrefix: false,
        includeSuffix: false,
        expandFirstAliases: false,
        expandLastAliases: false,
        includeNickname: false,
        firstLetter: '',
        lastLetter: '',
      },

      // Candidates pagination/sort
      page: 1,
      perPage: 15,
      sortBy: 'name',
      sortDir: 'asc',
    });

    Object.assign(els, {
      // Match controls — live in text_tool's formatting ribbon (shared IDs).
      // Absent when text_tool isn't installed; every read/write guards for that.
      tol:   document.getElementById('tolerance'),
      kern:  document.getElementById('kerning'),
      upper: document.getElementById('force-uppercase'),

      // This plugin's own sidebar (templates/redaction_matching/sidebar_tools.html)
      nameInput:  document.getElementById('name-input'),
      pasteInput: document.getElementById('paste-input'),
      tableBody:  document.getElementById('names-body'),
      pageInfo:   document.getElementById('page-info'),

      allMatchesCard:    document.getElementById('all-matches-card'),
      allMatchesSummary: document.getElementById('all-matches-summary'),
      allMatchesBody:    document.getElementById('all-matches-body'),
    });

    // ── Helpers ─────────────────────────────────────────────────

    /** Get all redaction-type UTB boxes. */
    function getRedactionBoxes() {
      return typeof utbState !== 'undefined'
        ? utbState.boxes.filter(b => b.type === 'redaction')
        : [];
    }

    /**
     * Box width a candidate's measured width is compared against — simply box.w.
     * The candidate's measured width (box.widths[c]) already places the Space W.
     * value between its words (see calculateWidthsForRedaction), so a multi-word
     * name's width adds up to the full box width directly. No hidden per-candidate
     * trailing-space subtraction.
     */
    function candidateEW(box) {
      return box.w;
    }
    window.candidateEW = candidateEW;

    /** Median of an array of numbers (robust to a stray double space). */
    function _median(nums) {
      const s = [...nums].sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }

    // A line counts as "not justified" when its median detected space is within
    // this much of the font's natural HarfBuzz advance — then we use the precise
    // natural value instead of the measured one. Relative, with an absolute floor;
    // doubles as the max error accepted from that substitution.
    const JUSTIFY_SPACE_TOL_FRAC = 0.12;
    const JUSTIFY_SPACE_TOL_FLOOR_PX = 0.5;

    /** Get the currently selected redaction box (or null). */
    function getSelectedRedaction() {
      if (typeof utbState === 'undefined' || !utbState.selectedId) return null;
      const box = utbState.getBox(utbState.selectedId);
      return box && box.type === 'redaction' ? box : null;
    }

    // ── Name generation from JSON ─────────────────────────────

    // First/last-letter filter. A candidate passes when its first character equals
    // settings.firstLetter (if set) and its last character equals settings.lastLetter
    // (if set), case-insensitive. Applied to the rendered candidate string, so it
    // naturally adapts to the format: for a first-name-only candidate the "last
    // letter" comes from the first name; for a last-name-only candidate the "first
    // letter" comes from the last name. Empty fields impose no constraint.
    function matchesLetterFilter(str, settings) {
      const fl = (settings.firstLetter || '').trim().toLowerCase();
      const ll = (settings.lastLetter || '').trim().toLowerCase();
      if (!fl && !ll) return true;
      const s = (str || '').trim();
      if (!s) return false;
      if (fl && s[0].toLowerCase() !== fl) return false;
      if (ll && s[s.length - 1].toLowerCase() !== ll) return false;
      return true;
    }
    window.matchesLetterFilter = matchesLetterFilter;

    // opts.excluded — Set<personIndex> to skip entirely (deleted people).
    // opts.ownerMap — Map<string, Set<personIndex>>, populated if provided so a
    //                 displayed candidate can be traced back to the person(s) that
    //                 produced it (used by removeName to delete the whole name).
    function generateCandidatesFromData(namesData, settings, opts = {}) {
      const excluded = opts.excluded || null;
      const ownerMap = opts.ownerMap || null;
      const result = new Set();
      const add = (str, i) => {
        if (!matchesLetterFilter(str, settings)) return;
        result.add(str);
        if (ownerMap) {
          let owners = ownerMap.get(str);
          if (!owners) ownerMap.set(str, owners = new Set());
          owners.add(i);
        }
      };
      for (let i = 0; i < namesData.length; i++) {
        if (excluded && excluded.has(i)) continue;
        const person = namesData[i];
        const firsts = person.first.length > 0
          ? (settings.expandFirstAliases ? person.first : [person.first[0]])
          : [];
        const lasts = person.last.length > 0
          ? (settings.expandLastAliases ? person.last : [person.last[0]])
          : [];
        const pre = settings.includePrefix && person.prefix ? person.prefix + ' ' : '';
        const suf = settings.includeSuffix && person.suffix ? ' ' + person.suffix : '';

        if (settings.generateFull) {
          if (firsts.length > 0 && lasts.length > 0) {
            for (const f of firsts) for (const l of lasts) add(`${pre}${f} ${l}${suf}`.trim(), i);
          } else if (firsts.length > 0) {
            for (const f of firsts) add(`${pre}${f}${suf}`.trim(), i);
          } else if (lasts.length > 0) {
            for (const l of lasts) add(`${pre}${l}${suf}`.trim(), i);
          }
        }
        if (settings.generateFirstOnly) {
          for (const f of firsts) add(f, i);
        }
        if (settings.generateLastOnly) {
          for (const l of lasts) add(l, i);
        }
        if (settings.includeNickname && person.nickname) {
          add(person.nickname, i);
        }
      }
      return [...result];
    }

    // ── Per-box name settings ─────────────────────────────────
    //
    // The Name-format settings (Generate / Include / Expand aliases) are stored
    // per redaction box on box.nameSettings, with box.candidates holding that
    // box's generated list ∪ the shared custom names. The sidebar panel reflects
    // whichever scope is "active": the selected box, or — when nothing is
    // selected — state.nameSettings, the template copied onto each new box.

    /** Ensure a box has its own name settings (a copy of the template on first use). */
    function ensureBoxNameSettings(box) {
      if (!box.nameSettings) box.nameSettings = { ...state.nameSettings };
      return box.nameSettings;
    }

    /** The settings object the sidebar panel currently edits. */
    function getActiveNameSettings() {
      const box = getSelectedRedaction();
      return box ? ensureBoxNameSettings(box) : state.nameSettings;
    }

    /** Recompute a single box's candidate list: its format applied to the global
     *  people pool (minus deleted people) ∪ the shared custom names. Also caches an
     *  owner map (string → person indices) so a deleted row maps back to a person. */
    function rebuildBoxCandidates(box) {
      ensureBoxNameSettings(box);
      const ownerMap = new Map();
      const fromJson = generateCandidatesFromData(state.namesData, box.nameSettings, {
        excluded: state.excludedPersons,
        ownerMap,
      });
      box._candidateOwners = ownerMap;
      const customs = state.customCandidates.filter(c => matchesLetterFilter(c, box.nameSettings));
      box.candidates = [...new Set([...fromJson, ...customs])];
      return box.candidates;
    }

    /** A box's candidate list, computed lazily on first access. */
    function getBoxCandidates(box) {
      if (!box) return [];
      if (!box.candidates) rebuildBoxCandidates(box);
      return box.candidates;
    }

    function rebuildAllBoxCandidates() {
      for (const box of getRedactionBoxes()) rebuildBoxCandidates(box);
    }

    /** Maintain state.candidates: the template universe (template settings ∪ custom),
     *  used by the uppercase heuristic when snapping boxes to embedded text lines. */
    function rebuildTemplateUnion() {
      const fromJson = generateCandidatesFromData(state.namesData, state.nameSettings, {
        excluded: state.excludedPersons,
      });
      state.candidates = [...new Set([...fromJson, ...state.customCandidates])];
    }

    /** Push the active settings into the sidebar checkboxes + count. */
    function syncNameSettingsUI() {
      const s = getActiveNameSettings();
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
      set('ns-full',         s.generateFull);
      set('ns-first-only',   s.generateFirstOnly);
      set('ns-last-only',    s.generateLastOnly);
      set('ns-prefix',       s.includePrefix);
      set('ns-suffix',       s.includeSuffix);
      set('ns-nickname',     s.includeNickname);
      set('ns-expand-first', s.expandFirstAliases);
      set('ns-expand-last',  s.expandLastAliases);

      const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
      setVal('ns-first-letter', s.firstLetter);
      setVal('ns-last-letter',  s.lastLetter);

      // Tell the user which scope these controls currently edit.
      const scopeEl = document.getElementById('name-format-scope');
      if (scopeEl) {
        const box = getSelectedRedaction();
        scopeEl.textContent = box ? '· this box' : '· new boxes';
        scopeEl.title = box
          ? 'Applies to the selected redaction box only'
          : 'No box selected — these become the defaults for new redaction boxes';
      }
      updateNameSettingsCount();
    }
    window.syncNameSettingsUI = syncNameSettingsUI;

    function rebuildCandidates() {
      rebuildTemplateUnion();
      rebuildAllBoxCandidates();
      updateNameSettingsCount();
      calculateAllWidths();
    }

    function updateNameSettingsCount() {
      const el = document.getElementById('name-settings-count');
      if (!el) return;
      const active = getActiveNameSettings();
      const jsonCount = generateCandidatesFromData(state.namesData, active, {
        excluded: state.excludedPersons,
      }).length;
      // Counts reflect the active letter filter too.
      const customCount = state.customCandidates.filter(c => matchesLetterFilter(c, active)).length;
      el.textContent = customCount > 0
        ? `${jsonCount} from list + ${customCount} custom`
        : `${jsonCount} from list`;
    }

    function readNameSettings() {
      const s = getActiveNameSettings();
      s.generateFull        = document.getElementById('ns-full').checked;
      s.generateFirstOnly   = document.getElementById('ns-first-only').checked;
      s.generateLastOnly    = document.getElementById('ns-last-only').checked;
      s.includePrefix       = document.getElementById('ns-prefix').checked;
      s.includeSuffix       = document.getElementById('ns-suffix').checked;
      s.includeNickname     = document.getElementById('ns-nickname').checked;
      s.expandFirstAliases  = document.getElementById('ns-expand-first').checked;
      s.expandLastAliases   = document.getElementById('ns-expand-last').checked;
      s.firstLetter         = (document.getElementById('ns-first-letter')?.value || '').trim();
      s.lastLetter          = (document.getElementById('ns-last-letter')?.value || '').trim();
    }

    function onNameSettingChange() {
      readNameSettings();
      const box = getSelectedRedaction();
      if (box) {
        // Per-box edit: rebuild and re-measure just this box.
        rebuildBoxCandidates(box);
        updateNameSettingsCount();
        calculateWidthsForRedaction(box.id);
      } else {
        // No selection: we edited the template for future boxes. Keep the
        // global heuristic universe in sync; existing boxes are untouched.
        rebuildTemplateUnion();
        updateNameSettingsCount();
        renderCandidates();
      }
    }

    /** Surface a names-list load failure loudly instead of silently emptying the list. */
    function showNamesLoadError(msg) {
      const countEl = document.getElementById('name-settings-count');
      if (countEl) countEl.textContent = '⚠ names list failed to load';

      let banner = document.getElementById('names-load-error');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'names-load-error';
        banner.title = 'Click to dismiss';
        banner.style.cssText = [
          'position:fixed', 'top:12px', 'left:50%', 'transform:translateX(-50%)',
          'z-index:99999', 'max-width:90vw', 'padding:10px 14px',
          'background:#b00020', 'color:#fff', 'font:13px/1.4 system-ui,sans-serif',
          'border-radius:6px', 'box-shadow:0 2px 8px rgba(0,0,0,.35)',
          'cursor:pointer', 'white-space:pre-wrap'
        ].join(';');
        banner.addEventListener('click', () => banner.remove());
        document.body.appendChild(banner);
      }
      banner.textContent = `Names list failed to load — ${msg}`;
    }

    async function loadNamesData() {
      try {
        const resp = await fetch('/static/redaction_matching/names.json');
        if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText} fetching names file`);

        const raw = await resp.text();
        try {
          state.namesData = JSON.parse(raw);
        } catch (parseErr) {
          // Pinpoint the offending spot. Chrome reports "...position N...",
          // Firefox reports "line N column N"; fall back to the raw message otherwise.
          let where = '';
          const posM = /position (\d+)/.exec(parseErr.message);
          const lcM  = /line (\d+) column (\d+)/.exec(parseErr.message);
          if (posM) {
            const pos = +posM[1];
            const before = raw.slice(0, pos);
            where = ` (line ${before.split('\n').length}, column ${pos - before.lastIndexOf('\n')})`;
          } else if (lcM) {
            where = ` (line ${lcM[1]}, column ${lcM[2]})`;
          }
          throw new Error(`names file is not valid JSON${where}: ${parseErr.message}`);
        }

        rebuildCandidates();
      } catch (e) {
        console.error('Failed to load names list:', e);
        showNamesLoadError(e.message);
      }
    }

    document.addEventListener('DOMContentLoaded', loadNamesData);
    document.addEventListener('DOMContentLoaded', syncNameSettingsUI);

    // Enter in the name field adds the candidate. This binding used to live in
    // the core's app.js; it is plugin UI, so it lives with the plugin now.
    document.addEventListener('DOMContentLoaded', () => {
      els.nameInput?.addEventListener('keydown', e => {
        if (e.key === 'Enter') addName();
      });
    });

    // Candidates-sidebar toggle. The host <aside>, its toggle button, CSS and
    // this wiring all belong to this plugin — the core owns no right panel. The
    // panel starts open (button carries `active`); clicking collapses/expands.
    document.addEventListener('DOMContentLoaded', () => {
      const btn   = document.getElementById('toggle-tools');
      const panel = document.getElementById('tools-sidebar');
      btn?.addEventListener('click', () => {
        const nowHidden = panel?.classList.toggle('hidden');
        btn.classList.toggle('active', !nowHidden);
      });
    });

    // ── Candidate management ──────────────────────────────────

    function addName() {
      const v = els.nameInput.value.trim();
      if (v && !state.customCandidates.includes(v)) {
        state.customCandidates.push(v);
        els.nameInput.value = '';
        rebuildTemplateUnion();
        rebuildAllBoxCandidates();
        updateNameSettingsCount();
        calculateAllWidths();
      }
    }
    function processPaste() {
      const lines = els.pasteInput.value.split('\n').map(l => l.trim()).filter(l => l);
      let added = 0;
      lines.forEach(l => {
        if (!state.customCandidates.includes(l)) {
          state.customCandidates.push(l);
          added++;
        }
      });
      if (added > 0) {
        rebuildTemplateUnion();
        rebuildAllBoxCandidates();
        updateNameSettingsCount();
        calculateAllWidths();
      }
      els.pasteInput.value = '';
      document.getElementById('paste-area').style.display = 'none';
    }

    function clearAll() {
      if (confirm('Clear custom names and restore all deleted names?')) {
        state.customCandidates = [];
        state.excludedPersons.clear();
        rebuildCandidates();
      }
    }

    // Delete a candidate globally. Clicking a row (which may show just a first or
    // last name) removes the WHOLE person from the shared pool, so every variant
    // disappears from every box. Custom names are simply dropped from the list.
    function removeName(name) {
      const box = getSelectedRedaction();
      const owners = box && box._candidateOwners ? box._candidateOwners.get(name) : null;
      if (owners) for (const idx of owners) state.excludedPersons.add(idx);
      state.customCandidates = state.customCandidates.filter(c => c !== name);

      rebuildTemplateUnion();
      rebuildAllBoxCandidates();
      updateNameSettingsCount();
      calculateAllWidths();
    }

    // ── Width calculation ─────────────────────────────────────

    async function calculateAllWidths() {
        const boxes = getRedactionBoxes();
        if (boxes.length === 0) return;
        for (const box of boxes) {
            await calculateWidthsForRedaction(box.id);
        }
        updateAllMatchesView(null);
    }

    async function calculateWidthsForRedaction(boxId) {
      await document.fonts.ready;
      const box = typeof utbState !== 'undefined' ? utbState.getBox(boxId) : null;
      if (!box || box.type !== 'redaction') return;

      // Determine the inter-word space width for this redaction's line.
      //
      // The font's natural space advance (from HarfBuzz) is the truth for any
      // line that ISN'T justified — it's exact, while the on-page measurements
      // carry rounding and coverage noise. Justification only ever STRETCHES
      // spaces above that natural advance; it never compresses them. So:
      //
      //   1. Drop measured spaces that read clearly BELOW natural — those are
      //      artifacts: a space partly hidden under the redaction box reads
      //      small (e.g. the lone 2.7 among ~4.0s), it is not a real spacing.
      //   2. Look at the typical (median) of what remains:
      //        • clusters at / around natural  → line is NOT justified
      //          → snap to the precise HarfBuzz advance.
      //        • sits clearly ABOVE natural     → line IS justified
      //          → trust the measured median stretch.
      //
      // This is what lets the un-justified last lines (which sit in a sea of
      // justified text) be detected as un-justified and use the exact width.
      //
      // The natural advance is computed at the LINE's own font + size (from its
      // embedded spans), not the redaction's global defaults, so a size mismatch
      // can't skew the comparison.
      if (box.lineId && (box.spaceWidth == null || box.defaultSpaceWidth !== false)) {
        const lineSpans = utbState.boxes.filter(
          b => b.lineId === box.lineId && b.type === 'embedded' && b.baseCharPositions
        );
        const detected = lineSpans
          .flatMap(b => b.baseCharPositions.filter(cp => cp.c === ' '))
          .map(cp => cp.w || 0)
          .filter(w => w > 0);

        if (detected.length > 0) {
          // Source font sizes are clean whole points (12pt here); per-span
          // extraction adds sub-point noise (one line reads 11.8, the next 12.0)
          // which would otherwise leak straight into the natural space width and
          // make same-size lines disagree (3.9 vs 4.0). Snap the line's measured
          // size to the nearest whole point — per line, so a genuinely different
          // size (e.g. a heading) is still respected.
          //
          // sizePt stays in PDF POINTS: the /widths backend applies the 4/3
          // (96/72 DPI) scale itself, so 12pt already renders as the 16px-space.
          // Passing 16 here would over-size the space by 4/3.
          const lineSizePt = _median(lineSpans.map(b => b.sizePt).filter(s => s > 0));
          const rawSizePt = lineSizePt || box.sizePt;
          const sizePt = rawSizePt ? Math.round(rawSizePt) : rawSizePt;
          const lineFont = lineSpans[0]?.fontFamily || box.fontFamily;
          let natural = null;
          if (typeof getNaturalSpaceWidth === 'function') {
            natural = await getNaturalSpaceWidth({
              fontFamily: lineFont,
              sizePt: sizePt,
              kerning: box.kerning,
            });
          }

          let spaceW;
          if (natural != null) {
            const tol = Math.max(JUSTIFY_SPACE_TOL_FLOOR_PX, natural * JUSTIFY_SPACE_TOL_FRAC);
            // Ignore sub-natural artifacts (covered / truncated spaces), then
            // judge justification from what's left.
            const real = detected.filter(w => w >= natural - tol);
            const typical = real.length ? _median(real) : natural;
            spaceW = (typical > natural + tol) ? typical : natural;
          } else {
            // No HarfBuzz reference — fall back to the robust raw median.
            spaceW = _median(detected);
          }

          box.spaceWidth = spaceW;
          box.defaultSpaceWidth = false;
          box.nativeSpaceWidth = natural != null ? natural : _median(detected);
          if (typeof renderBox === 'function') renderBox(box);
          if (typeof syncToolbarToBox === 'function' && utbState.selectedId === box.id) {
            syncToolbarToBox(box);
          }
        }
      }

      const candidates = getBoxCandidates(box);
      if (candidates.length === 0) {
        box.widths = {};
        if (utbState.selectedId === boxId) {
            renderCandidates();
        }
        return;
      }

      // Find the actual SVG text element in the DOM to guarantee 100% parity
      let textEl = document.querySelector(`.utb-group[data-id="${box.id}"] .utb-text`);
      
      // If it's not rendered yet, force a render
      if (!textEl && typeof renderBox === 'function') {
        renderBox(box);
        textEl = document.querySelector(`.utb-group[data-id="${box.id}"] .utb-text`);
      }

      let isOffscreen = false;
      if (!textEl) {
        // Fallback: Page not rendered yet. Use offscreen SVG.
        textEl = _getMeasureTextEl();
        isOffscreen = true;
        
        textEl.setAttribute('font-size', GEO.docPtToPx(box.sizePt));
        let fontFamily = `"${box.fontFamily || 'Times New Roman'}"`;
        if (box.renderFont) fontFamily = `"etv_${box.renderFont}", ${fontFamily}`;
        textEl.setAttribute('font-family', fontFamily);
        
        if (box.bold) textEl.setAttribute('font-weight', 'bold');
        else textEl.removeAttribute('font-weight');
        
        if (box.italic) textEl.setAttribute('font-style', 'italic');
        else textEl.removeAttribute('font-style');
        
        if (box.letterSpacing) textEl.setAttribute('letter-spacing', `${box.letterSpacing}em`);
        else textEl.removeAttribute('letter-spacing');

        textEl.style.fontKerning = box.kerning ? 'normal' : 'none';
      }

      const originalText = textEl.textContent;
      box.widths = {};

      // When a manual Space W. is active, measure a multi-word candidate as
      // Σ(word widths) + (#spaces × Space W.): the slider sets the gap between
      // words directly, so the candidate's width adds up to the full box width.
      // (Default/native spacing renders the whole string in one pass.)
      const manualSpace = box.spaceWidth != null && box.defaultSpaceWidth === false;

      candidates.forEach(c => {
        const disp = box.uppercase ? c.toUpperCase() : c;
        if (manualSpace && disp.includes(' ')) {
          const segments = disp.split(' ');
          let total = (segments.length - 1) * box.spaceWidth;
          for (const seg of segments) {
            textEl.textContent = seg;
            total += textEl.getBBox().width;
          }
          box.widths[c] = total;
        } else {
          textEl.textContent = disp;
          box.widths[c] = textEl.getBBox().width;
        }
      });

      // Restore original text only if we modified the real DOM node
      if (!isOffscreen) {
        textEl.textContent = originalText;
      }

      if (utbState.selectedId === boxId) {
          renderCandidates();
          updateAllMatchesView(boxId);
      }
    }

    // Reusable hidden SVG text element for width measurement fallback
    let _measureSvg = null;
    let _measureTextEl = null;

    function _getMeasureTextEl() {
      if (!_measureSvg) {
        _measureSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        _measureSvg.style.position = 'absolute';
        _measureSvg.style.visibility = 'hidden';
        _measureSvg.style.pointerEvents = 'none';
        _measureSvg.style.width = '0';
        _measureSvg.style.height = '0';
        _measureTextEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        _measureSvg.appendChild(_measureTextEl);
        document.body.appendChild(_measureSvg);
      }
      return _measureTextEl;
    }

    // ── Pagination & sorting ──────────────────────────────────

    function changePage(delta) {
      state.page += delta;
      renderCandidates();
    }

    function setSort(f) {
      if (state.sortBy === f) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else { state.sortBy = f; state.sortDir = 'asc'; }
      state.page = 1;
      renderCandidates();
    }

    // ── Candidates table ──────────────────────────────────────

    function renderCandidates() {
      document.getElementById('sort-icon').textContent = state.sortDir === 'asc' ? '▲' : '▼';

      const box = getSelectedRedaction();
      const candidates = box ? getBoxCandidates(box) : state.candidates;
      const isUpper = box ? box.uppercase : false;

      const sorted = [...candidates].sort((a, b) => {
        let va = state.sortBy === 'width' && box ? (box.widths[a] || 0) : a.toLowerCase();
        let vb = state.sortBy === 'width' && box ? (box.widths[b] || 0) : b.toLowerCase();
        if (va < vb) return state.sortDir === 'asc' ? -1 : 1;
        if (va > vb) return state.sortDir === 'asc' ? 1 : -1;
        return 0;
      });

      const totalPages = Math.ceil(sorted.length / state.perPage) || 1;
      if (state.page > totalPages) state.page = totalPages;
      if (state.page < 1) state.page = 1;

      const start = (state.page - 1) * state.perPage;
      const slice = sorted.slice(start, start + state.perPage);
      els.pageInfo.textContent = `List: ${candidates.length} (${state.page}/${totalPages})`;

      const btnPrev = document.getElementById('btn-prev-page');
      const btnNext = document.getElementById('btn-next-page');
      if (btnPrev) btnPrev.disabled = state.page <= 1;
      if (btnNext) btnNext.disabled = state.page >= totalPages;

      els.tableBody.innerHTML = slice.map(n => {
        const w = box ? box.widths[n] : undefined;
        const isMatch = box && w !== undefined && Math.abs(w - candidateEW(box, n)) <= box.tolerance;
        const esc = n.replace(/'/g, "&apos;");
        const disp = isUpper ? n.toUpperCase() : n;
        const rowClass = isMatch ? 'best-match' : '';
        const fontStyle = box ? ` style="font-family:${box.fontFamily || 'inherit'};"` : '';

        return `
          <tr class="${rowClass}">
            <td${fontStyle}>
              ${disp}
            </td>
            <td class="col-right">${w !== undefined ? w.toFixed(2) : '-'}</td>
            <td class="col-del"><button class="btn-del" onclick="removeName('${esc.replace(/'/g, "\\'")}')">&times;</button></td>
          </tr>
        `;
      }).join('');
    }


    // ── Selection ─────────────────────────────────────────────

    async function selectRedaction(boxId) {
      const box = typeof utbState !== 'undefined' ? utbState.getBox(boxId) : null;
      if (!box || box.type !== 'redaction') return;

      // Navigate to the redaction's page first if not already there
      if (state.currentPage !== box.page) {
        await goToPage(box.page);
      }

      utbState.selectedId = box.id;

      // Redaction-specific controls — the Match controls live in text_tool's
      // formatting ribbon, so these els are absent when text_tool isn't loaded.
      // Guard each write (can't use ?. on an assignment target) so selection
      // still works standalone. Reads elsewhere already guard with ?..
      if (els.tol) els.tol.value = box.tolerance;
      if (els.kern) els.kern.checked = !!box.kerning;
      if (els.upper) els.upper.checked = !!box.uppercase;

      // Reflect this box's per-box name-format settings in the sidebar panel.
      syncNameSettingsUI();

      // Deselect all SVG groups, then select this one
      if (typeof selectBoxInSVG === 'function') selectBoxInSVG(box.id);

      // Sync the formatting toolbar
      if (typeof syncToolbarToBox === 'function') syncToolbarToBox(box);

      // Highlight the matching row in the All Matches table
      document.querySelectorAll('#all-matches-body tr').forEach(el => el.classList.remove('selected-row'));
      const rowEl = document.getElementById(`match-row-${box.id}`);
      if (rowEl) {
        rowEl.classList.add('selected-row');
        rowEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }

      // Scroll the SVG element into view within the viewer
      const svgGroup = document.querySelector(`.utb-group[data-id="${box.id}"]`);
      if (svgGroup) {
        const parentRect = els.viewerContainer.getBoundingClientRect();
        const targetRect = svgGroup.getBoundingClientRect();
        if (targetRect.top < parentRect.top || targetRect.bottom > parentRect.bottom) {
          els.viewerContainer.scrollTo({
            top: els.viewerContainer.scrollTop + (targetRect.top - parentRect.top) - (parentRect.height / 2),
            behavior: 'smooth'
          });
        }
      }

      renderCandidates();
      updateAllMatchesView(boxId);
    }

    // ── All Matches summary view ──────────────────────────────

    function updateAllMatchesView(onlyId = null) {
      const redactionBoxes = getRedactionBoxes();

      if (!redactionBoxes.length) {
        els.allMatchesCard.style.display = 'none';
        return;
      }

      els.allMatchesCard.style.display = 'block';
      let matchCount = 0;

      els.allMatchesBody.innerHTML = redactionBoxes.map(box => {
        const tol = box.tolerance;
        const isUpper = box.uppercase;
        const fontStyle = `font-family: ${box.fontFamily || 'inherit'}; font-feature-settings: "kern" ${box.kerning ? 1 : 0}; text-transform: ${isUpper ? 'uppercase' : 'none'};`;

        const matches = getBoxCandidates(box).filter(c => {
          const w = box.widths[c];
          return w !== undefined && Math.abs(w - candidateEW(box, c)) <= tol;
        });

        // Sort matches by closest width difference
        matches.sort((a, b) => {
          const diffA = Math.abs(box.widths[a] - candidateEW(box, a));
          const diffB = Math.abs(box.widths[b] - candidateEW(box, b));
          return diffA - diffB;
        });

        if (matches.length) matchCount++;

        // Label text is always driven by the best match
        if (onlyId === null || onlyId === box.id) {
          const newLabel = matches.length > 0 ? (isUpper ? matches[0].toUpperCase() : matches[0]) : '';
          box.text = newLabel;
          box.labelText = newLabel;
          if (typeof renderBox === 'function') renderBox(box);
        }

        const matchHtml = matches.length
          ? `<span style="color:#81c995; ${fontStyle}">${matches.map(m => isUpper ? m.toUpperCase() : m).join(', ')}</span>`
          : `<span class="no-match">No obvious matches</span>`;

        const isSelected = utbState.selectedId === box.id ? 'selected-row' : '';

        return `
          <tr id="match-row-${box.id}" class="${isSelected}" style="cursor: pointer;" onclick="selectRedaction('${box.id}')" title="Click to view on document">
            <td>${box.page}</td>
            <td class="col-right">${box.w.toFixed(2)}</td>
            <td>${matchHtml}</td>
          </tr>
        `;
      }).join('');

      els.allMatchesSummary.textContent = `${matchCount} of ${redactionBoxes.length} redactions have potential matches.`;

      const progress = redactionBoxes.length ? (matchCount / redactionBoxes.length) * 100 : 0;
      const progressBar = document.getElementById('match-progress-bar');
      if (progressBar) progressBar.style.width = `${progress}%`;
    }


    // ── Redaction creation ────────────────────────────────────

    function handleManualAddBox(pageNum, pxX, pxY) {
      const nearestLine = typeof utbFindNearestLine === 'function'
        ? utbFindNearestLine(pageNum, pxY, 2.0) : null;

      const finalY      = nearestLine ? nearestLine.y      : pxY;
      const finalH      = nearestLine ? nearestLine.h      : 20;
      const finalLineId = nearestLine ? nearestLine.lineId : null;
      const lineFont    = nearestLine?.font;
      const lineSizePt  = nearestLine?.sizePt;

      createNewRedaction(pageNum, pxX - 50, finalY, 100, finalH, finalLineId, lineFont, lineSizePt);
    }

    function createNewRedaction(pageNum, x, y, width, height, lineId = null, lineFont = null, lineSizePt = null) {
      const normFn = typeof normUtbFont === 'function' ? normUtbFont : (n => n);
      const fontFamily = (lineFont ? normFn(lineFont) : null)
                      || document.getElementById('fabric-font-family')?.value
                      || 'Times New Roman';
      // Font-size input is in POINTS — no DPI conversion.
      const sizePt     = lineSizePt
                      || parseFloat(document.getElementById('fabric-font-size')?.value)
                      || 12;

      const newBox = utbState.addBox(new UnifiedTextBox({
        type:       'redaction',
        page:       pageNum,
        text:       '',
        lineId:     lineId,
        x: x, y: y, w: width, h: height,
        fontFamily:   fontFamily,
        sizePt:       sizePt,
        kerning:      els.kern?.checked ?? true,
        uppercase:    els.upper?.checked ?? false,
        tolerance:    parseFloat(els.tol?.value) || 0,
        widths:       {},
        labelText:    '',
        manualLabel:  false,
        nameSettings: { ...state.nameSettings },  // inherit current template
      }));

      if (typeof renderBox === 'function') renderBox(newBox);

      selectRedaction(newBox.id);
      calculateWidthsForRedaction(newBox.id);
    }

    function fontFamilyToTtf(fontFamily) {
      const map = {
        'Times New Roman': 'times.ttf',
        'Courier New': 'courier_new.ttf',
        'Arial': 'arial.ttf',
        'Calibri': 'calibri.ttf',
        'Segoe UI': 'segoe_ui.ttf',
        'Verdana': 'verdana.ttf',
      };
      return map[fontFamily] || 'times.ttf';
    }