# Tool Expansion Guide

A reference for adding new plugins to Recto. Read the architecture section first — it explains the conventions every plugin relies on.

> **The two ribbon slots.** `options_bar` is a *contextual* bar: `openSubtoolbar()` shows one
> at a time and hides the rest. `ribbon_bar` is *persistent* — always visible, never hidden.
> Set where your bar sits in the ribbon's reading order with `order:` in your own stylesheet;
> the core deliberately never names a plugin's bar in its CSS. No *baseline* plugin fills the
> `ribbon_bar` slot — see [Optional Plugins](./plugins/) for a worked example.

---

## Architecture Overview

### The Plugin System

Plugins are standard Django apps that register themselves with the **PDFTool registry**. Each plugin defines a `tool.py` containing a class that inherits from `PDFTool` and is decorated with `@register_tool`:

```python
# my_tool/tool.py
from pdf_core.base import PDFTool
from pdf_core.registry import register_tool

@register_tool
class MyTool(PDFTool):
    name = 'my_tool'
    toolbar_button = 'my_tool/toolbar_button.html'
    # ... override only the fields you need
```

The plugin's `apps.py` triggers registration with a single import:

```python
# my_tool/apps.py
from django.apps import AppConfig

class MyToolConfig(AppConfig):
    name = 'my_tool'

    def ready(self):
        import my_tool.tool  # noqa: F401 — registers MyTool
```

`pdf_core/templates/pdf_core/index.html` iterates the registry to inject each tool's styles, toolbar buttons, options bars, sidebars, and scripts. **No manual edits to `index.html` are needed.**

URL routes declared on the PDFTool class are auto-discovered by `recto/urls.py`. **No manual edits to `urls.py` are needed.**

`settings.py` dynamically scans the project directory for folders containing `apps.py` and auto-appends them to `INSTALLED_APPS`. **Dropping a plugin folder in enables it; deleting it disables it. No `settings.py` edits needed.**

### PDFTool Base Class

All available fields with their defaults (`pdf_core/base.py`):

```python
class PDFTool:
    name = None                       # Required — e.g. 'my_tool'

    # URL routing
    url_prefix = ''                   # path prefix for include()
    url_module = None                 # dotted path to urls.py, or None

    # Template slots
    styles = ()                       # tuple/list of {'path': '...'} dicts
    toolbar_button = None             # template path for toolbar button
    options_bar = None                # contextual ribbon bar — one at a time,
                                      #   switched by openSubtoolbar()
    ribbon_bar = None                 # persistent ribbon bar — always visible
    sidebar = None                    # template path for sidebar panel
    has_sidebar_toggle = False        # contributes a sidebar toggle button

    # Script injection
    scripts_before_viewer = ()        # scripts loaded before pdf-viewer.js
    scripts_after_app = ()            # scripts loaded after app.js
```

Base class uses **tuples** for sequence defaults to avoid the mutable-default-on-a-class-attribute trap. Subclasses can safely assign lists.

### Global JavaScript Objects

These globals are available to all plugin scripts:

- **`PDFHooks`** (`pdf_core/static/pdf_core/hooks.js`) — the lifecycle event bus, loaded first before everything else. Plugins call `PDFHooks.on(event, handler)`; the core calls `PDFHooks.emit(event, payload)`. This is the primary frontend integration point — see [Frontend Lifecycle](#frontend-lifecycle--the-pdfhooks-bus) below.
- **`state`** (`state.js`) — **core** application state only (page images, current page, zoom, the open file). Plugin state lives in the plugin; the core state object holds nothing plugin-specific.
- **`els`** (`state.js`) — cached DOM references for **core** elements only (viewer, page controls, sidebar). Plugins look up their own DOM with `document.getElementById(...)`; the core `els` no longer holds plugin elements.

### Script Load Order

Scripts load in this order, controlled by the `scripts_before_viewer` and `scripts_after_app` fields on each PDFTool:

```
hooks.js                  ← defines window.PDFHooks (loaded first)
  → state.js
  → [tool.scripts_before_viewer for each registered tool]
  → pdf-viewer.js
  → ui-events.js
  → app.js                ← defines window.openSubtoolbar, window.registerSubtoolbar, window.openRightPanel; emits 'ui:ready'
  → [tool.scripts_after_app for each registered tool]
```

`PDFHooks` exists before any plugin script, so a plugin can call `PDFHooks.on(...)` at module scope regardless of which bucket it loads in. Subscribing is order-independent for the *runtime* events (page render, document load, zoom, …) — the core emits those long after every script has loaded.

**Exception — `ui:ready`:** it is emitted *during* `app.js` execution, i.e. after the `scripts_before_viewer` bucket but **before the `scripts_after_app` bucket has even parsed**, and the bus does not replay past events to late subscribers. A `ui:ready` handler registered from `scripts_after_app` never fires. The rule:

- `scripts_before_viewer` — cannot touch `app.js` globals at module scope; do UI wiring inside a `PDFHooks.on('ui:ready', …)` handler.
- `scripts_after_app` — wire the UI **at module scope** (the DOM and `app.js` globals already exist); do not use `ui:ready`. This is what `text_tool/toolbar.js` does.

### Frontend Lifecycle — the PDFHooks Bus

The core viewer never calls plugin functions by name; it **emits events** and plugins **subscribe**. Register handlers at module scope:

```js
PDFHooks.on('page:rendered', ({ pageContainer, pageNum }) => {
  // draw your per-page overlay into pageContainer
});
```

Events emitted by the core:

| Event | When | Payload |
|-------|------|---------|
| `ui:ready` | core toolbar wired (mid-`app.js`, BEFORE `scripts_after_app` parse — only `scripts_before_viewer` can catch it) | — |
| `viewer:clear` | viewer torn down before a page change | — |
| `page:rendered` | a page container was added to the DOM | `{ pageContainer, pageNum }` |
| `pages:refresh` | re-sync per-page overlays | — |
| `document:loaded` | a document finished loading | `{ file, isDefault }` |
| `zoom:changed` | viewer zoom factor changed | `{ zoom }` |

Handlers may be `async` (the core awaits them in registration order), and a throwing handler is caught so it can't break the core or other plugins. Because subscriptions live in the plugin's own script, deleting the plugin folder removes them automatically.

### Two UI Patterns

There are two distinct plugin UI patterns. Choose one based on what your tool needs:

| Pattern | Used by | Adds |
|---|---|---|
| **Subtoolbar** | `webgl_mask`, `embedded_text_viewer` | A toolbar button that swaps the options bar row |
| **Right Panel** | (e.g. a matching sidebar) | A toolbar button that opens a full-height side panel |

---

## Pattern A — Subtoolbar Plugin

Use this when your tool needs a row of controls (sliders, selects, checkboxes) rather than a persistent panel. Examples: `webgl_mask`, `embedded_text_viewer` formatting bar.

The subtoolbar row is mutually exclusive — only one bar is visible at a time. This is enforced by `window.openSubtoolbar`, defined in `app.js`.

### File Structure

```
my_tool/
  apps.py                  ← AppConfig with ready() importing tool.py
  tool.py                  ← PDFTool subclass with @register_tool
  templates/my_tool/
    toolbar_button.html    ← button injected into #toolbar-right
    options_bar.html       ← bar injected into #text-toolbar-row
  static/my_tool/
    my-tool.js             ← toggle logic + tool behaviour
  views.py, urls.py, ...
```

### Step 1 — Define Your Tool

```python
# my_tool/tool.py
from pdf_core.base import PDFTool
from pdf_core.registry import register_tool

@register_tool
class MyTool(PDFTool):
    name = 'my_tool'
    url_module = 'my_tool.urls'        # omit if no backend routes
    toolbar_button = 'my_tool/toolbar_button.html'
    options_bar = 'my_tool/options_bar.html'
    scripts_after_app = [
        {'path': 'my_tool/my-tool.js', 'version': 'v=1'},
    ]
```

### Step 2 — AppConfig

```python
# my_tool/apps.py
from django.apps import AppConfig

class MyToolConfig(AppConfig):
    name = 'my_tool'

    def ready(self):
        import my_tool.tool  # noqa: F401
```

### Step 3 — Toolbar Button

```html
<!-- templates/my_tool/toolbar_button.html -->
<button id="toggle-my-tool" class="icon-button" title="My Tool">
  <span class="material-symbols-outlined">your_icon_name</span>
</button>
```

### Step 4 — Options Bar

Start with `class="options-bar hidden"`. The bar must be hidden by default; `openSubtoolbar` manages visibility from here.

```html
<!-- templates/my_tool/options_bar.html -->
<div id="my-tool-bar" class="options-bar hidden">
  <div class="options-divider"></div>
  <div class="options-group">
    <div class="options-group-header">My Setting</div>
    <div class="options-group-controls">
      <input type="range" id="my-slider" min="0" max="100" value="50">
    </div>
  </div>
</div>
```

### Step 5 — JavaScript Toggle (module scope + `registerSubtoolbar`)

Put your tool script in `scripts_after_app` and wire the toggle **at module scope** — the toolbar DOM and the core's `openSubtoolbar`/`registerSubtoolbar` already exist by then. Do **not** wrap the wiring in `PDFHooks.on('ui:ready', …)`: that event fires before `scripts_after_app` scripts parse and is never replayed, so the handler would silently never run (see the load-order note above; `text_tool/toolbar.js` wires exactly this way). Call `registerSubtoolbar(button)` once so the core can deactivate your button generically when another subtoolbar opens. **You never edit `app.js`.**

```js
// static/my_tool/my-tool.js  (a scripts_after_app entry)

(function wireMyTool() {
  const btn = document.getElementById('toggle-my-tool');
  const bar = document.getElementById('my-tool-bar');
  if (!btn || !bar) return;

  // Let the core manage this button without naming the plugin.
  window.registerSubtoolbar?.(btn);

  btn.addEventListener('click', () => {
    if (bar.classList.contains('hidden')) {
      window.openSubtoolbar?.(bar, btn);   // open my bar (closes the others)
    } else {
      window.openSubtoolbar?.(null, null); // back to the default text bar
    }
  });
})();
```

(Only a `scripts_before_viewer` script should use the `ui:ready` handler pattern for UI wiring — it is the one bucket that runs early enough to catch the event.)

`openSubtoolbar` hides every element with class `options-bar` and deactivates every registered toggle, then shows the one you pass. Because it operates by class + registry, **no core edit is required** — that is the whole point of the pattern.

That's it. No changes to `index.html`, `urls.py`, `settings.py`, or `app.js` — the registry, dynamic discovery, and hook bus handle everything.

---

## Pattern B — Right Panel Plugin

Use this when your tool needs a persistent, scrollable side panel. The right panel area is mutually exclusive with the tools sidebar — opening one closes the other.

### File Structure

```
my_panel/
  apps.py                  ← AppConfig with ready() importing tool.py
  tool.py                  ← PDFTool subclass with @register_tool
  templates/my_panel/
    toolbar_button.html    ← button injected into #toolbar-right
    panel.html             ← <aside> injected as sidebar
  static/my_panel/
    my-panel.js            ← open/close logic + panel behaviour
  views.py, urls.py, ...
```

### Step 1 — Define Your Tool

```python
# my_panel/tool.py
from pdf_core.base import PDFTool
from pdf_core.registry import register_tool

@register_tool
class MyPanel(PDFTool):
    name = 'my_panel'
    toolbar_button = 'my_panel/toolbar_button.html'
    sidebar = 'my_panel/panel.html'
    has_sidebar_toggle = True    # if this tool should control sidebar visibility
    scripts_after_app = [
        {'path': 'my_panel/my-panel.js', 'version': 'v=1'},
    ]
```

### Step 2 — AppConfig

```python
# my_panel/apps.py
from django.apps import AppConfig

class MyPanelConfig(AppConfig):
    name = 'my_panel'

    def ready(self):
        import my_panel.tool  # noqa: F401
```

### Step 3 — Toolbar Button

```html
<!-- templates/my_panel/toolbar_button.html -->
<button id="toggle-my-panel" class="icon-button" title="My Panel">
  <span class="material-symbols-outlined">your_icon_name</span>
</button>
```

### Step 4 — Panel HTML

The panel is included inside `#tools-sidebar` via the `sidebar` field. The template auto-includes it when iterating registered tools.

```html
<!-- templates/my_panel/panel.html -->
<div id="my-panel">
  <div id="my-panel-header">
    <span>My Panel</span>
  </div>
  <!-- panel content -->
</div>
```

### Step 5 — JavaScript Toggle

Right panels manage their own open/close. When **opening**, close other sidebars to enforce mutual exclusivity:

```js
// static/my_panel/my-panel.js

function openMyPanel() {
  // Mutual exclusivity: close the tools sidebar if open
  document.getElementById('tools-sidebar')?.classList.add('hidden');
  document.getElementById('toggle-tools')?.classList.remove('active');

  document.getElementById('my-panel').classList.remove('hidden');
  document.getElementById('toggle-my-panel').classList.add('active');
}

function closeMyPanel() {
  document.getElementById('my-panel').classList.add('hidden');
  document.getElementById('toggle-my-panel').classList.remove('active');
}

document.getElementById('toggle-my-panel')?.addEventListener('click', () => {
  document.getElementById('my-panel').classList.contains('hidden')
    ? openMyPanel()
    : closeMyPanel();
});
```

### Step 6 — Make `#tools-sidebar` Aware of Your Panel

When `#tools-sidebar` opens, it should close your panel. Add your panel to the `openRightPanel` function in `app.js`:

```js
// pdf_core/static/pdf_core/app.js — inside openRightPanel()
document.getElementById('my-panel')?.classList.add('hidden');
document.getElementById('toggle-my-panel')?.classList.remove('active');
```

That's it. No changes to `index.html`, `urls.py`, or `settings.py`.

---

## Adding a Backend API Endpoint

If your plugin needs to process data server-side, define your URL routing on the PDFTool class:

**`tool.py`** — set `url_prefix` and `url_module`:
```python
@register_tool
class MyTool(PDFTool):
    name = 'my_tool'
    url_prefix = 'my-tool/'           # routes will be prefixed: /my-tool/...
    url_module = 'my_tool.urls'       # points to your urls.py
    # ... other fields
```

**`views.py`** — write your view, returning `JsonResponse`:
```python
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

@csrf_exempt
def my_endpoint(request):
    if request.method != 'POST':
        return JsonResponse({'detail': 'Method not allowed'}, status=405)
    # ... your logic ...
    return JsonResponse({'result': ...})
```

**`urls.py`** — register the route:
```python
from django.urls import path
from . import views

urlpatterns = [
    path('my-endpoint', views.my_endpoint, name='my_endpoint'),
]
```

The route is auto-discovered from `tool.url_module` — no need to edit `recto/urls.py`.

> **Note for logic-only modules** (no UI, no PDFTool, no routes): Apps like `extracted_text` that only provide Python logic imported by other apps require neither a PDFTool class nor URL routing — simply omit `url_prefix` and `url_module` from the `AppConfig`. The dynamic discovery in `settings.py` will still install the app (making its modules importable), but nothing will be mounted in `urls.py`.

---

## Existing Plugins — Quick Reference

| App | Type | PDFTool class | Toggle Button ID | Bar / Panel ID |
|---|---|---|---|---|
| `text_tool` | Subtoolbar | `TextTool` | `toggle-fmt` | `fabric-options-bar` |
| `webgl_mask` | Subtoolbar | `WebglMaskTool` | `toggle-webgl` | `webgl-options-bar` |
| `embedded_text_viewer` | Subtoolbar | `EmbeddedTextViewerTool` | `toggle-embedded-text` | `etv-bar` |
| `extracted_text` | Logic-only | *(none)* | — | — |
| `pdf_core` | Core (always on) | *(none)* | — | `text-options-bar` |

---

## Checklist — Adding a New Tool

1. **Create the Django app directory** (`my_tool/`)
2. **Write `my_tool/tool.py`** — subclass `PDFTool`, decorate with `@register_tool`, override only what you need
3. **Write `my_tool/apps.py`** — `ready()` does `import my_tool.tool`
4. **Create templates** — `toolbar_button.html`, `options_bar.html`, and/or `sidebar.html`
5. **Create static assets** — JS and CSS files referenced in your tool class
6. **Wire runtime behaviour through `PDFHooks`** — subscribe to lifecycle events (`page:rendered`, `document:loaded`, …); for a subtoolbar in `scripts_after_app`, call `registerSubtoolbar(btn)` and add your click handlers at module scope (NOT inside `ui:ready` — it has already fired)
7. *(Right panel only)* add your panel to the `openRightPanel()` hide list in `app.js` (the right-panel pattern is not yet fully hook-driven)

**Zero changes needed to**: `index.html`, `recto/urls.py`, `settings.py`, `app.js` (for subtoolbars), or any other plugin's code.

**To disable a plugin**: delete its folder. Django's dynamic discovery in `settings.py` won't find it and the app simply won't load.

---

## Best Practices

- **Never use `display: block` directly.** Always toggle the `.hidden` class. Sidebars use CSS transitions keyed on `.hidden`; bypassing it breaks animations.
- **Use optional chaining (`?.`) on all `getElementById` calls** in plugin JS. This ensures your script doesn't throw if the plugin is removed.
- **Guard `openSubtoolbar` calls** with `typeof openSubtoolbar === 'function'` when your script is in `scripts_before_viewer`. Scripts in `scripts_after_app` can reference it directly.
- **Integrate through `PDFHooks`, not by name.** Subscribe to lifecycle events instead of having the core call your functions, and look up your own DOM with `document.getElementById`. A subtoolbar plugin's only core touchpoints are the generic `registerSubtoolbar` + `openSubtoolbar`; the right-panel pattern still has a small `openRightPanel` touchpoint in `app.js`.
- **Keep plugin logic self-contained.** Views, URLs, business logic, and DOM all belong in the plugin app.
- **Disable by deleting the folder.** `settings.py` dynamically scans for plugin directories — removing the folder is the off-switch. No manual `INSTALLED_APPS` edits needed.
- **Use tuples or lists for tool config fields.** The base class uses tuples for immutable defaults, but subclasses can safely assign lists. Both work in Django template iteration.
