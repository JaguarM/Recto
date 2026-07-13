# WebGL Mask — `webgl-mask.js`

[webgl-mask.js](https://github.com/JaguarM/EpsteinTool/blob/main/webgl_mask/static/webgl_mask/webgl-mask.js) renders GPU-accelerated redaction mask overlays.

## Integration — fully hook-driven

`webgl-mask.js` is a self-contained plugin: it touches the core only through the [`PDFHooks`](../tool-expansion-guide.md#frontend-lifecycle--the-pdfhooks-bus) bus and owns its own DOM. Deleting the `webgl_mask/` folder removes every webgl reference from the running app.

| PDFHooks event | Handler does |
|----------------|--------------|
| `ui:ready` | wires the `#toggle-webgl` button + `#edge-subtract` slider; calls `registerSubtoolbar(toggleBtn)` |
| `page:rendered` | **creates** the `.webgl-overlay` `<canvas>` for that page and appends it (the core no longer owns this DOM), then `setupWebGLOverlay(...)` |
| `pages:refresh` | `refreshWebGLCanvases()` |
| `viewer:clear` | `clearWebGLContexts()` |
| `document:loaded` | `fetchMasksAsync(file, isDefault)` |

## Architecture

```
document:loaded event  →  fetchMasksAsync(file, isDefault)
    ↓
POST /webgl/masks
    ↓
`state.maskImages` populated with all base64 masks
    ↓
`refreshWebGLCanvases()`
    ↓
`initWebGLOverlay()` (for visible pages via IntersectionObserver)
    ↓
Two LUMINANCE textures: uPage (LINEAR) + uMask (NEAREST)
    ↓
Fragment shader: multiplicative alpha recovery → grayscale output
    ↓
CSS mix-blend-mode: normal — canvas composited directly over PDF
```

## Functions

### `fetchMasksAsync(file, isDefault)`
Asynchronously requests all masks from `/webgl/masks`. Stores results in `state.maskImages` and calls `refreshWebGLCanvases()`.

### `setupWebGLOverlay(pageContainer, canvas, pageNum)`
Registers a page container with the `IntersectionObserver`. When a page becomes visible, `initWebGLOverlay(canvas, pageNum)` is called. Pages with no mask data are skipped until `refreshWebGLCanvases()` triggers after async load.

**Texture setup:**
- Format: `gl.LUMINANCE` (single-channel grayscale)
- Page texture: `gl.LINEAR` filtering
- Mask texture: `gl.NEAREST` filtering (preserves hard pixel boundaries)
- Wrapping: `gl.CLAMP_TO_EDGE`

### `clearWebGLContexts()`
Destroys all active WebGL contexts. Subscribed to the `viewer:clear` event (fired before each page change).

### `updateWebGLUniforms(specificPage?)`
Reads `#edge-subtract` value `/ 255.0` → `uStrength` uniform and redraws. No texture re-upload needed — instant 60fps updates. (The slider element is looked up directly by the plugin; the core `els` cache no longer holds it.)

## Shaders

### Vertex Shader
Draws a full-screen quad; maps clip-space coords to UV with Y-flip.

### Fragment Shader
```glsl
float page = texture2D(uPage, vTexCoord).r;
float mask = texture2D(uMask, vTexCoord).r;
float alpha = mask * uStrength;
float result;
if (mask > 0.999) {
  // Interior: fully covered, original unrecoverable — show white
  result = uStrength;
} else {
  // Border/clear: invert anti-aliasing multiplication
  result = min(page / max(1.0 - alpha, 0.001), 1.0);
}
gl_FragColor = vec4(vec3(result), 1.0);
```

**Three pixel cases:**

| Pixel type | `mask` | Behaviour |
|---|---|---|
| Interior | 1.0 | Outputs `uStrength` (white at full slider) |
| Border | 0 < m < 1 | `page / (1 - mask × strength)` — recovers original via division |
| Clear | 0.0 | `page / 1.0` — passes through unchanged |

The multiplicative recovery correctly reverses anti-aliasing: dark text under a border pixel stays dark; a white background pixel is scaled back to white.

## UI Controls

| Control | ID | Effect |
|---------|-----|--------|
| Reveal strength | `edge-subtract` | 0–255 → `uStrength` uniform |
| WebGL toggle | `toggle-webgl` | Shows/hides all `.webgl-overlay` canvases |

## Context Limits

Browsers enforce ~16 simultaneous WebGL contexts. The lazy `IntersectionObserver` strategy ensures contexts are only allocated for pages with actual redactions, preventing `CONTEXT_LOST_WEBGL` crashes on large documents.
