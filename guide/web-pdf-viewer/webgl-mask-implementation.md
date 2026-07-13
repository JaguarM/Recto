# WebGL Mask: Implementation Overview

The WebGL mask system provides a high-performance 60FPS overlay for visualizing the blacked-out regions of a PDF dynamically.

## 1. Backend: Mask Generation (`webgl_mask/logic/artifact_visualizer.py`)

The pipeline begins by analyzing raw PDF bytes using `fitz` (PyMuPDF).

- **Image extraction:** Each page's embedded image is extracted natively as a grayscale PNG, bypassing ICC profile issues from PIL JPEG loading.
- **Black-bar detection:** OpenCV pipeline:
  1. Threshold pixels ≤ 0 → `black_mask`
  2. Hough Circle Transform removes hole punches
  3. Contour filtering removes thin lines (bbox width < 17 or height < 10, or area/perimeter < 2)
- **Mask synthesis (`build_mask_array`):**
  - Interior pixels → `255` (fully masked)
  - Two border rings computed via `dilate()`:
    - Ring 1 (`border1 = dilate(black_mask) & ~black_mask`)
    - Ring 2 (`border2 = dilate(outer1) & ~outer1`)
  - Both top/bottom and left/right edges use both rings
  - Each border pixel → `255 - max(rendered[run])`, encoding the anti-aliasing blend factor
- **Sparse optimization:** Pages with no masked regions return `None` — no PNG generated.

## 2. API Layer (`webgl_mask/views.py`)

- `POST /webgl/masks` — accepts PDF, returns JSON with `mask_images` array of base64-encoded PNGs (or `null` per page if no masked regions found).
- Masks are generated asynchronously after the main `/open-document` response, so the UI is not blocked.

## 3. Frontend: GPU Rendering (`webgl-mask.js`)

A secondary `<canvas class="webgl-overlay">` is positioned over the primary PDF canvas.

### Lazy Instantiation
Browsers limit ~16 simultaneous WebGL contexts. An `IntersectionObserver` ensures contexts are only created for visible pages that have a mask. `refreshWebGLCanvases()` triggers once async mask data arrives.

### Textures
- **`uPage`** — the PDF page image, `LUMINANCE`, `LINEAR` filtering
- **`uMask`** — the generated mask PNG, `LUMINANCE`, `NEAREST` filtering (no blur on edges)

### Fragment Shader
```glsl
float page = texture2D(uPage, vTexCoord).r;
float mask = texture2D(uMask, vTexCoord).r;
if (mask > 0.999) {
  result = uStrength;                              // interior: show white
} else {
  result = min(page / max(1.0 - mask * uStrength, 0.001), 1.0); // border: multiplicative recovery
}
```

Anti-aliasing blends edge pixels as `P_edge = (1 - α) × P_orig`. Dividing by `(1 - α)` recovers `P_orig` exactly — dark text stays dark, white background returns to white. The additive approach (`page + mask`) would wash out dark pixels.

### Real-Time Updates
`updateWebGLUniforms()` pipes `els.edgeSubtract.value / 255.0` into the `uStrength` uniform — no texture re-upload, instant 60fps response.
