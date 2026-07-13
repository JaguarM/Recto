/* =========================================================
       Initialization
       ========================================================= */
    (async function init() {
      // 1. Event Listeners for Viewer functionality
      els.toggleSidebarBtn.addEventListener('click', () => {
        els.sidebar.classList.toggle('hidden');
        els.toggleSidebarBtn.classList.toggle('active');
      });

      // Right sidebars are mutually exclusive: tools-sidebar vs cmp-panel
      function openRightPanel(panelToShow, btnToActivate) {
        const cmpPanel   = document.getElementById('cmp-panel');
        const toggleCmp  = document.getElementById('toggle-cmp');
        els.toolsSidebar?.classList.add('hidden');
        cmpPanel?.classList.add('hidden');
        els.toggleToolsBtn?.classList.remove('active');
        toggleCmp?.classList.remove('active');
        if (panelToShow) {
          panelToShow.classList.remove('hidden');
          btnToActivate?.classList.add('active');
        }
      }

      if (els.toggleToolsBtn) {
        els.toggleToolsBtn.addEventListener('click', () => {
          if (els.toolsSidebar.classList.contains('hidden')) {
            openRightPanel(els.toolsSidebar, els.toggleToolsBtn);
          } else {
            openRightPanel(null, null);
          }
        });
      }


      if (els.toolAddBoxBtn) {
        els.toolAddBoxBtn.addEventListener('click', () => {
          if (state.activeTool === 'add-box') {
            state.activeTool = null;
            els.toolAddBoxBtn.classList.remove('active');
            els.viewer.style.cursor = 'default';
          } else {
            state.activeTool = 'add-box';
            els.toolAddBoxBtn.classList.add('active');
            document.getElementById('etv-add-text-btn')?.classList.remove('active');
            els.viewer.style.cursor = 'crosshair';
          }
        });
      }
      
      if (els.toolTextBtn) {
        els.toolTextBtn.addEventListener('click', () => {
          // This button now only toggles the sub-toolbar (handled in text-tool.js)
          // We can remove logic from here to avoid duplication.
        });
      }

      // Subtoolbars are mutually-exclusive tabs in the options-bar row; null =
      // default (text options bar). A plugin contributes a toggle button + an
      // element with class "options-bar"; it registers the button via
      // registerSubtoolbar so openSubtoolbar can deactivate it generically —
      // the core never names a specific plugin here.
      const _subtoolbarButtons = [];
      window.registerSubtoolbar = function (button) {
        if (button && !_subtoolbarButtons.includes(button)) _subtoolbarButtons.push(button);
      };

      // Exposed as window.openSubtoolbar so plugin scripts can call it on click.
      // Only `.options-bar` (contextual) bars are switched; a plugin's
      // `.ribbon-bar` is persistent and is never hidden here.
      window.openSubtoolbar = function openSubtoolbar(barToShow, btnToActivate) {
        const toggleFmt = document.getElementById('toggle-fmt') ?? document.getElementById('tool-text');
        document.querySelectorAll('#unified-options-bar-container .options-bar')
          .forEach(bar => bar.classList.add('hidden'));
        _subtoolbarButtons.forEach(btn => btn.classList.remove('active'));
        toggleFmt?.classList.remove('active');
        if (!barToShow) return;
        barToShow.classList.remove('hidden');
        btnToActivate?.classList.add('active');
      };

      // Set initial state — no contextual bar open
      openSubtoolbar(null, null);

      function triggerZoomCheck(mouseX = null, mouseY = null) {
        let val = parseInt(els.zoomInputElem.value.replace('%', ''));
        if (!isNaN(val)) {
          const newZoom = val / 100;
          processZoomFromText(newZoom, mouseX, mouseY);
        } else {
          updateZoomLevelText();
        }
      }

      // Zoom commands
      els.zoomInBtn.addEventListener('click', () => { 
        els.zoomInputElem.value = `${Math.round(state.currentZoom * 1.1 * 100)}%`;
        triggerZoomCheck();
      });
      els.zoomOutBtn.addEventListener('click', () => { 
        els.zoomInputElem.value = `${Math.round(state.currentZoom / 1.1 * 100)}%`;
        triggerZoomCheck();
      });
      els.zoomInputElem.addEventListener('change', () => triggerZoomCheck());

      // Click to add box/text tool logic
      els.viewer.addEventListener('mousedown', async (e) => {
        const pageEl = e.target.closest('.page-container');
        if (!pageEl) return;
        
        const pageNum = parseInt(pageEl.id.replace('pageContainer', ''));

        // Map screen click → document-space coordinates via the SVG text layer's
        // getScreenCTM().  This is immune to toolbar layout shifts, scroll offsets
        // and CSS scale-factor sizing.
        let pxX, pxY;
        const svg = pageEl.querySelector('svg.text-layer');
        if (svg && typeof svg.getScreenCTM === 'function') {
          const pt = svg.createSVGPoint();
          pt.x = e.clientX;
          pt.y = e.clientY;
          const transformed = pt.matrixTransform(svg.getScreenCTM().inverse());
          pxX = transformed.x;
          pxY = transformed.y;
        } else {
          // Fallback for pages without an SVG layer yet
          const rect = pageEl.getBoundingClientRect();
          const scale = state.currentZoom || 1.0;
          pxX = (e.clientX - rect.left) / scale;
          pxY = (e.clientY - rect.top) / scale;
        }

        if (state.activeTool === 'add-box') {
          if (typeof handleManualAddBox === 'function') {
            handleManualAddBox(pageNum, pxX, pxY);
          }
          state.activeTool = null;
          els.viewer.style.cursor = 'default';
          document.getElementById('tool-add-box')?.classList.remove('active');
        }
        else if (state.activeTool === 'text') {
           // Create a new editable UnifiedTextBox at the click position.
           if (typeof handleManualAddText === 'function') {
              handleManualAddText(pageNum, pxX, pxY);
           } else if (typeof addEmbeddedTextSpan === 'function') {
              addEmbeddedTextSpan(pageNum, pxX, pxY);
           }

           // Deselect tool after one use to avoid spam
           state.activeTool = null;
           els.viewer.style.cursor = 'default';
           const toolBtn = document.getElementById('etv-add-text-btn');
           if (toolBtn) toolBtn.classList.remove('active');
        }
      });

      // Ctrl+Wheel Zoom
      els.viewerContainer.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
          e.preventDefault();
          const newZoom = state.currentZoom * Math.pow(1.005, -e.deltaY);
          els.zoomInputElem.value = `${Math.round(newZoom * 100)}%`;
          
          const rect = els.viewerContainer.getBoundingClientRect();
          const mouseX = e.clientX - rect.left;
          const mouseY = e.clientY - rect.top;
          
          triggerZoomCheck(mouseX, mouseY);
        }
      }, { passive: false });

      // Drag overlay standard
      window.addEventListener('dragover', (e) => { e.preventDefault(); els.dragOverlay.classList.remove('hidden'); });
      els.dragOverlay.addEventListener('dragleave', (e) => { e.preventDefault(); els.dragOverlay.classList.add('hidden'); });
      window.addEventListener('drop', (e) => {
        e.preventDefault();
        els.dragOverlay.classList.add('hidden');
        if (e.dataTransfer.files.length > 0) {
          const t = e.dataTransfer.files[0].type;
          const name = e.dataTransfer.files[0].name.toLowerCase();
          const accepted = t === 'application/pdf' || t.startsWith('image/') ||
            /\.(pdf|png|jpe?g|tiff?|bmp|webp)$/.test(name);
          if (accepted) {
            els.pdfFile.files = e.dataTransfer.files;
            handleFileUpload();
          }
        }
      });

      // Regular file select
      els.pdfFile.addEventListener('change', handleFileUpload);

      // Jump to page
      els.pageInputElem.addEventListener('change', (e) => {
        if (!state.pageImages.length) return;
        let p = parseInt(e.target.value);
        if (isNaN(p) || p < 1) p = 1;
        if (p > state.numPages) p = state.numPages;
        e.target.value = p;
        goToPage(p);
      });

      if (els.prevPageBtn) {
        els.prevPageBtn.addEventListener('click', () => {
          if (state.currentPage > 1) goToPage(state.currentPage - 1);
        });
      }
      if (els.nextPageBtn) {
        els.nextPageBtn.addEventListener('click', () => {
          if (state.currentPage < state.numPages) goToPage(state.currentPage + 1);
        });
      }

      // Core toolbar wiring is complete — plugins attach their own buttons /
      // option-bar controls now (e.g. webgl_mask wires its mask toggle here).
      await PDFHooks.emit('ui:ready');

      // 3. Auto-load the sample document on startup
      try {
        const resp = await fetch('/open-default');
        if (resp.ok) {
          const data = await resp.json();
          state.hasPdf = true;
          els.titleElem.textContent = data.default_filename || 'Sample document';
          await loadDocument(data, null);
        }
      } catch (e) {
        console.warn('Auto-load of the sample document failed:', e.message);
      }

    })();