/* WebGL Mask Overlays extracted from pdf-viewer.js */
const webglContexts = new Map();
const maskBlobCache = new Map();

const webglObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    const pageNum = parseInt(entry.target.dataset.pageNum);
    const canvas = entry.target.querySelector('.webgl-overlay');

    if (entry.isIntersecting) {
      if (!webglContexts.has(pageNum) && canvas) {
        initWebGLOverlay(canvas, pageNum);
      }
    } else {
      if (webglContexts.has(pageNum)) {
        destroyWebGLOverlay(pageNum);
      }
    }
  });
}, { root: null, rootMargin: '100% 0px', threshold: 0 });

function setupWebGLOverlay(pageContainer, _webglCanvas, pageNum) {
  pageContainer.dataset.pageNum = pageNum;
  webglObserver.observe(pageContainer);
}

function clearWebGLContexts() {
  for (const [, ctx] of webglContexts.entries()) {
    if (ctx && ctx.gl) {
      const loseCtx = ctx.gl.getExtension('WEBGL_lose_context');
      if (loseCtx) loseCtx.loseContext();
    }
  }
  webglContexts.clear();
  maskBlobCache.clear();
  webglObserver.disconnect();
}

function destroyWebGLOverlay(pageNum) {
  const ctx = webglContexts.get(pageNum);
  if (!ctx) return;
  if (ctx.gl) {
    const loseCtx = ctx.gl.getExtension('WEBGL_lose_context');
    if (loseCtx) loseCtx.loseContext();
  }
  webglContexts.delete(pageNum);
}

async function initWebGLOverlay(canvas, pageNum) {
  try {
    webglContexts.set(pageNum, { loading: true });

    let blob;
    if (maskBlobCache.has(pageNum)) {
      blob = maskBlobCache.get(pageNum);
    } else {
      // Use inline mask data from the initial upload response
      const maskDataUrl = state.maskImages && state.maskImages[pageNum - 1];
      if (!maskDataUrl) {
        // May still be loading asynchronously
        webglContexts.delete(pageNum);
        return;
      }
      const res = await fetch(maskDataUrl);
      blob = await res.blob();
      maskBlobCache.set(pageNum, blob);
    }

    const img = new Image();
    img.onload = () => {
      if (!webglContexts.has(pageNum)) return; // Was destroyed before load

      const pageImg = document.getElementById(`page${pageNum}`);
      if (!pageImg) {
        webglContexts.delete(pageNum);
        return;
      }

      const proceed = () => {
        if (!webglContexts.has(pageNum)) return;

        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.style.mixBlendMode = 'normal';

        const gl = canvas.getContext('webgl', { antialias: false }) || canvas.getContext('experimental-webgl', { antialias: false });
        if (!gl) {
          webglContexts.delete(pageNum);
          return;
        }

        const vsSource = `
          attribute vec2 aPosition;
          varying vec2 vTexCoord;
          void main() {
            gl_Position = vec4(aPosition, 0.0, 1.0);
            vTexCoord = vec2((aPosition.x + 1.0) / 2.0, 1.0 - (aPosition.y + 1.0) / 2.0);
          }
        `;

        const fsSource = `
          precision mediump float;
          varying vec2 vTexCoord;
          uniform sampler2D uPage;
          uniform sampler2D uMask;
          uniform float uStrength;
          void main() {
            float page = texture2D(uPage, vTexCoord).r;
            float mask = texture2D(uMask, vTexCoord).r;
            float alpha = mask * uStrength;
            float result;
            if (mask > 0.999) {
              // Fully redacted interior (mask == 1.0): page ≈ 0 so division recovers nothing.
              // Original content is unrecoverable — just show white.
              result = uStrength;
            } else {
              // Anti-aliased border or clear pixel: invert the alpha blend multiplicatively.
              result = min(page / max(1.0 - alpha, 0.001), 1.0);
            }
            gl_FragColor = vec4(vec3(result), 1.0);
          }
        `;

        function createShader(gl, type, source) {
          const shader = gl.createShader(type);
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          return shader;
        }

        const vertexShader = createShader(gl, gl.VERTEX_SHADER, vsSource);
        const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fsSource);

        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        gl.useProgram(program);

        const positionLocation = gl.getAttribLocation(program, "aPosition");
        const positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
          -1, -1, 1, -1, -1, 1,
          -1, 1, 1, -1, 1, 1
        ]), gl.STATIC_DRAW);

        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

        const pageTexture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, pageTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, pageImg);

        const maskTexture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, maskTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, img);

        gl.uniform1i(gl.getUniformLocation(program, "uPage"), 0);
        gl.uniform1i(gl.getUniformLocation(program, "uMask"), 1);

        gl.disable(gl.BLEND);

        const uStrengthLoc = gl.getUniformLocation(program, "uStrength");

        webglContexts.set(pageNum, { gl, program, uStrengthLoc });

        requestAnimationFrame(() => {
          updateWebGLUniforms(pageNum);
          const isActive = document.getElementById('toggle-webgl')?.classList.contains('active');
          if (isActive) canvas.style.display = 'block';
        });
      };

      if (pageImg.complete) {
        proceed();
      } else {
        pageImg.addEventListener('load', proceed, { once: true });
      }
    };
    img.src = URL.createObjectURL(blob);
  } catch (e) {
    console.error("Could not load mask", e);
    canvas.remove();
    webglContexts.delete(pageNum);
  }
}



function updateWebGLUniforms(specificPage = null) {
  const edgeSlider = document.getElementById('edge-subtract');
  const strength = edgeSlider ? edgeSlider.value / 255.0 : 1.0;

  const pagesToUpdate = specificPage ? [specificPage] : Array.from(webglContexts.keys());

  pagesToUpdate.forEach(p => {
    const ctx = webglContexts.get(p);
    if (!ctx || !ctx.gl) return;
    const { gl, program, uStrengthLoc } = ctx;
    gl.useProgram(program);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uStrengthLoc, strength);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  });
}

async function fetchMasksAsync(file, isDefault = false) {
  try {
    let resp;
    if (isDefault) {
      resp = await fetch('/webgl/masks?default=true');
    } else {
      const fd = new FormData();
      fd.append('file', file);
      resp = await fetch('/webgl/masks', { method: 'POST', body: fd });
    }
    
    if (resp.ok) {
      const data = await resp.json();
      state.maskImages = (data.mask_images || []).map(b64 =>
        b64 ? `data:image/png;base64,${b64}` : null
      );
      refreshWebGLCanvases();
    }
  } catch (e) {
    console.error("Async mask fetch failed:", e);
  }
}

function refreshWebGLCanvases() {
  const webglActive = document.getElementById('toggle-webgl')?.classList.contains('active');

  document.querySelectorAll('.page-container').forEach(pageContainer => {
    const pageNum = parseInt(pageContainer.dataset.pageNum);
    const canvas = pageContainer.querySelector('.webgl-overlay');
    if (!canvas) return;

    if (!webglContexts.has(pageNum)) {
      initWebGLOverlay(canvas, pageNum);
    } else if (webglContexts.get(pageNum)?.gl) {
      updateWebGLUniforms(pageNum);
      canvas.style.display = webglActive ? 'block' : 'none';
    }
  });
}


/* ── Plugin lifecycle wiring ───────────────────────────────────
   Every integration point with the core viewer goes through PDFHooks, and
   this plugin owns its overlay canvas + toolbar wiring. Deleting the
   webgl_mask/ folder removes all of it with zero references left in the core. */

// Tear down GL contexts before the viewer swaps pages.
PDFHooks.on('viewer:clear', () => clearWebGLContexts());

// Build this plugin's overlay canvas when the core renders a page.
PDFHooks.on('page:rendered', ({ pageContainer, pageNum }) => {
  const canvas = document.createElement('canvas');
  canvas.id = `webgl-overlay-${pageNum}`;
  canvas.className = 'webgl-overlay';
  canvas.style.position = 'absolute';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.pointerEvents = 'none';
  canvas.width = state.pageWidth;
  canvas.height = state.pageHeight;
  const active = document.getElementById('toggle-webgl')?.classList.contains('active');
  canvas.style.display = active ? 'block' : 'none';
  pageContainer.appendChild(canvas);

  if (state.hasPdf) setupWebGLOverlay(pageContainer, canvas, pageNum);
});

PDFHooks.on('pages:refresh', () => refreshWebGLCanvases());

// Fetch the redaction masks for the freshly loaded document.
PDFHooks.on('document:loaded', ({ file, isDefault }) => fetchMasksAsync(file, isDefault));

// Attach the mask toggle + reveal-strength slider once the core toolbar exists.
PDFHooks.on('ui:ready', () => {
  const toggleBtn = document.getElementById('toggle-webgl');
  const optionsBar = document.getElementById('webgl-options-bar');
  const edgeSlider = document.getElementById('edge-subtract');

  if (toggleBtn) {
    window.registerSubtoolbar?.(toggleBtn);
    toggleBtn.addEventListener('click', () => {
      const isActive = toggleBtn.classList.contains('active');
      document.querySelectorAll('.webgl-overlay').forEach(c => {
        c.style.display = !isActive ? 'block' : 'none';
      });
      if (!isActive) {
        window.openSubtoolbar?.(optionsBar, toggleBtn);
        refreshWebGLCanvases();
      } else {
        window.openSubtoolbar?.(null, null);
      }
    });
  }

  if (edgeSlider) edgeSlider.addEventListener('input', () => updateWebGLUniforms());
});
