/**
 * =====================================================================
 * TEXT TOOL & FORMATTING MANAGER
 * Handles selection, formatting, and toolbar synchronization for:
 * 1. .etv-span (PDF text overlays)
 * 2. .redaction-label (redaction_lab box labels)
 * =====================================================================
 */

let lastSelectedTextItem = null;

const TEXT_SELECTORS  = '.etv-span, .redaction-label';
const TOOLBAR_SELECTORS = '#unified-options-bar-container, #fabric-options-bar';

function deselectAllText() {
    lastSelectedTextItem = null;
    document.querySelectorAll(TEXT_SELECTORS).forEach(el => {
        el.classList.remove('selected');
        el.contentEditable = 'false';
    });
    document.querySelectorAll('.redaction-overlay.selected').forEach(o => o.classList.remove('selected'));
}

function selectTextElement(el) {
    if (!el || lastSelectedTextItem === el) return;
    deselectAllText();
    lastSelectedTextItem = el;
    el.classList.add('selected');
    if (!el.classList.contains('redaction-label')) el.contentEditable = 'true'; // labels are read-only
    el.focus();

    const redactionParent = el.closest('.redaction-overlay');
    if (redactionParent) {
        redactionParent.classList.add('selected');
        const idx = parseInt(redactionParent.id.replace('redaction-idx-', ''));
        if (!isNaN(idx) && typeof selectRedaction === 'function') selectRedaction(idx);
    }
}

// Sync toolbar on focus — also ensures lastSelectedTextItem is always current.
// This covers the selectRedaction→label.focus() path where no mousedown fires.
document.addEventListener('focusin', (e) => {
    const el = e.target.closest(TEXT_SELECTORS);
    if (!el) return;
    if (lastSelectedTextItem !== el) {
        // Deselect the previous element without calling deselectAllText (which clears el too)
        if (lastSelectedTextItem) {
            lastSelectedTextItem.classList.remove('selected');
            lastSelectedTextItem.contentEditable = 'false';
        }
        lastSelectedTextItem = el;
        el.classList.add('selected');
        if (!el.classList.contains('redaction-label')) el.contentEditable = 'true'; // labels are read-only
    }
    syncBarToSpan(el);
});

// Deselect when focus leaves text elements (but not when moving to the toolbar)
document.addEventListener('focusout', (e) => {
    if (!e.target.closest(TEXT_SELECTORS)) return;
    const goingTo = e.relatedTarget;
    const stayingInText    = goingTo?.closest(TEXT_SELECTORS);
    const stayingInToolbar = goingTo?.closest(TOOLBAR_SELECTORS);
    if (!stayingInText && !stayingInToolbar) deselectAllText();
});

// Route clicks to the right element
document.addEventListener('mousedown', (e) => {
    const textEl = e.target.closest('.etv-span')
                || e.target.closest('.redaction-label')
                || e.target.closest('.redaction-overlay')?.querySelector('.redaction-label');
    const inToolbar = e.target.closest(TOOLBAR_SELECTORS);

    if (textEl) {
        const isNew = lastSelectedTextItem !== textEl;
        selectTextElement(textEl);
        // Prevent default on new selection to avoid unwanted cursor jumps into char children
        if (isNew && e.target !== textEl) e.preventDefault();
    } else if (!inToolbar) {
        deselectAllText();
    }
});

/**
 * SYNC: Update toolbar inputs to match the styles of the selected element.
 * Reads inline styles directly (not computed) so it works reliably with raw
 * PDF font names and before the browser font cascade resolves.
 */
function syncBarToSpan(el) {
    if (!el) return;

    // --- Font Family ---
    // etvNormFont (defined in embedded-text-viewer.js) converts raw PDF names
    // like "ABCDEF+TimesNewRomanPSMT" to browser-safe equivalents.
    const rawFont = el.style.fontFamily || '';
    const normFont = (typeof etvNormFont === 'function') ? etvNormFont(rawFont) : rawFont;
    const ff = document.getElementById('fabric-font-family');
    if (ff && normFont) {
        const opt = Array.from(ff.options).find(o =>
            o.value.toLowerCase() === normFont.toLowerCase() ||
            o.text.toLowerCase()  === normFont.toLowerCase()
        );
        if (opt) ff.value = opt.value;
    }

    // --- Font Size ---
    // Always stored unscaled in the --etv-fs CSS custom property.
    const fsInput = document.getElementById('fabric-font-size');
    if (fsInput) {
        const raw = el.style.getPropertyValue('--etv-fs');
        if (raw) fsInput.value = Math.round(parseFloat(raw));
    }

    // --- Bold / Italic / Underline / Strikethrough ---
    // renderEmbeddedTextOverlay already converts PDF font-name hints (e.g. "Times-Bold")
    // into real fontWeight/fontStyle inline styles, so reading them here is sufficient.
    const isBold      = el.style.fontWeight === 'bold' || el.style.fontWeight === '700';
    const isItalic    = el.style.fontStyle === 'italic';
    const decor       = el.style.textDecoration || '';
    const isUnderline = decor.includes('underline');
    const isStrike    = decor.includes('line-through');

    document.getElementById('fabric-bold')?.classList.toggle('active', isBold);
    document.getElementById('fabric-italic')?.classList.toggle('active', isItalic);
    document.getElementById('fabric-underline')?.classList.toggle('active', isUnderline);
    document.getElementById('fabric-strikethrough')?.classList.toggle('active', isStrike);

    // --- Letter Spacing ---
    const lsInput = document.getElementById('fabric-letter-spacing');
    if (lsInput) lsInput.value = (parseFloat(el.style.letterSpacing) || 0).toFixed(2);

    // --- Color ---
    const colorInput = document.getElementById('fabric-color');
    if (colorInput) {
        const src = el.style.getPropertyValue('--etv-color') || el.style.color;
        if (src) colorInput.value = _cssColorToHex(src);
    }
}

/** Convert any CSS color string to a #rrggbb hex value. */
function _cssColorToHex(color) {
    if (!color || color === 'initial' || color === 'inherit') return '#000000';
    if (/^#[0-9a-f]{6}$/i.test(color)) return color;
    const m = color.match(/\d+/g);
    if (m && m.length >= 3) {
        return '#' + ((1 << 24) + (+m[0] << 16) + (+m[1] << 8) + +m[2]).toString(16).slice(1);
    }
    return '#000000';
}

/**
 * ACTIONS: Apply Ribbon changes to the selected object.
 */
function applyFormatting() {
    const el = lastSelectedTextItem;
    if (!el) return;

    const bold      = document.getElementById('fabric-bold')?.classList.contains('active');
    const italic    = document.getElementById('fabric-italic')?.classList.contains('active');
    const underline = document.getElementById('fabric-underline')?.classList.contains('active');
    const strike    = document.getElementById('fabric-strikethrough')?.classList.contains('active');
    
    el.style.fontWeight = bold ? 'bold' : 'normal';
    el.style.fontStyle = italic ? 'italic' : 'normal';
    el.style.textDecoration = [underline && 'underline', strike && 'line-through'].filter(Boolean).join(' ') || 'none';

    persistChangesToState(el);
    broadcastChange(el);
}

/**
 * PERSISTENCE: Save UI changes back to the underlying data model.
 */
function persistChangesToState(el) {
    if (!el) return;
    
    // ETV Spans
    if (el.classList.contains('etv-span')) {
        const pageNum = parseInt(el.closest('.page-container')?.id.replace('pageContainer','') || 1);
        const pageSpans = etvState.spans.filter(s => s.page === pageNum);
        const spanIdx = parseInt(el.dataset.index);
        const s = pageSpans[spanIdx];
        if (s) {
            s.font = el.style.fontFamily;
            s.fontSize = parseInt(el.style.getPropertyValue('--etv-fs')) || s.fontSize;
            s.fontWeight = el.style.fontWeight;
            s.fontStyle = el.style.fontStyle;
            s.textDecoration = el.style.textDecoration;
            s.letterSpacing = el.style.letterSpacing;
            s.color = el.style.getPropertyValue('--etv-color');
        }
    } 
    // Redaction Labels
    else if (el.classList.contains('redaction-label')) {
        const parent = el.closest('.redaction-overlay');
        const idx = parent ? parseInt(parent.id.replace('redaction-idx-', '')) : null;
        if (idx !== null && typeof state !== 'undefined' && state.redactions[idx]) {
            const r = state.redactions[idx];
            r.settings.fontFamily = el.style.fontFamily;
            r.settings.fontSize = parseInt(el.style.getPropertyValue('--etv-fs')) || r.settings.fontSize;
            // Re-run width calculation with the updated font settings
            if (typeof calculateWidthsForRedaction === 'function') calculateWidthsForRedaction(idx);
        }
    }
}

/**
 * UI EVENT: Toggle Ribbon Overlay
 */
document.getElementById('tool-text')?.addEventListener('click', () => {
    const bar = document.getElementById('fabric-options-bar');
    if (!bar) return;
    const isVisible = !bar.classList.toggle('hidden');
    document.getElementById('tool-text').classList.toggle('active', isVisible);

    // Context Cursor / Visibility
    document.querySelectorAll('.etv-overlay').forEach(el => el.classList.toggle('active-tool', isVisible));
});

/**
 * UI EVENT: Add Text Tool Mode
 */
document.getElementById('etv-add-text-btn')?.addEventListener('click', (e) => {
    const isActive = e.currentTarget.classList.toggle('active');
    state.activeTool = isActive ? 'text' : null;
    els.viewer.style.cursor = isActive ? 'text' : 'default';
    if (isActive && els.toolAddBoxBtn) els.toolAddBoxBtn.classList.remove('active');
});

/**
 * WIRE-UP: Control Listenners
 */
document.getElementById('fabric-font-family')?.addEventListener('change', (e) => {
    if (lastSelectedTextItem) {
        lastSelectedTextItem.style.fontFamily = e.target.value;
        persistChangesToState(lastSelectedTextItem);
        broadcastChange(lastSelectedTextItem);
    }
});

document.getElementById('fabric-font-size')?.addEventListener('change', (e) => {
    const px = Math.max(4, parseInt(e.target.value) || 12);
    if (lastSelectedTextItem) {
        lastSelectedTextItem.style.setProperty('--etv-fs', `${px}px`);
        // If it's a redaction, we also need to update the calc font size
        if (lastSelectedTextItem.classList.contains('redaction-label')) {
            lastSelectedTextItem.style.fontSize = `calc(${px}px * var(--scale-factor, 1))`;
        }
        persistChangesToState(lastSelectedTextItem);
        broadcastChange(lastSelectedTextItem);
    }
});

['fabric-bold', 'fabric-italic', 'fabric-underline', 'fabric-strikethrough'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', () => {
        document.getElementById(id).classList.toggle('active');
        applyFormatting();
    });
});

document.getElementById('fabric-letter-spacing')?.addEventListener('change', (e) => {
    if (lastSelectedTextItem) {
        const em = parseFloat(e.target.value) || 0;
        lastSelectedTextItem.style.letterSpacing = em ? `${em}em` : '';
        persistChangesToState(lastSelectedTextItem);
        broadcastChange(lastSelectedTextItem);
    }
});

document.getElementById('fabric-color')?.addEventListener('input', (e) => {
    if (lastSelectedTextItem) {
        lastSelectedTextItem.style.setProperty('--etv-color', e.target.value);
        lastSelectedTextItem.style.color = e.target.value;
        persistChangesToState(lastSelectedTextItem);
        broadcastChange(lastSelectedTextItem);
    }
});

function broadcastChange(el) {
    const event = new CustomEvent('text-format-changed', {
        detail: {
            element: el,
            styles: {
                fontFamily: el.style.fontFamily,
                fontSize: el.style.getPropertyValue('--etv-fs'),
                fontWeight: el.style.fontWeight,
                fontStyle: el.style.fontStyle,
                color: el.style.getPropertyValue('--etv-color')
            }
        }
    });
    document.dispatchEvent(event);
}
