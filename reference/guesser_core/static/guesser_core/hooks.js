/* =========================================================
   PDFHooks — plugin lifecycle bus
   =========================================================
   The core (guesser_core) never calls a plugin function by name.
   Instead it *emits* lifecycle events; plugins *subscribe* with
   PDFHooks.on(event, handler). Deleting a plugin folder removes its
   subscriptions, so the core keeps emitting into the void with zero
   dangling references — "delete the folder, done" actually holds.

   Events emitted by the core
   --------------------------------------------------------------
   'ui:ready'        ()                              — toolbar/DOM is wired; safe to attach plugin buttons
   'viewer:clear'    ()                              — viewer is about to be torn down for a page change
   'page:rendered'   ({ pageContainer, pageNum })    — a page container was added to the DOM
   'pages:refresh'   ()                              — re-sync any per-page overlays
   'document:loaded' ({ file, isDefault })           — a document finished loading (file === null on auto-load)
   'zoom:changed'    ({ zoom })                       — the viewer zoom factor changed

   Handlers may be async; emit() awaits them in registration order and
   never lets one plugin's error break another (or the core).
   ========================================================= */
(function () {
  const handlers = new Map(); // event -> Set<fn>

  function on(event, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(fn);
    return () => off(event, fn);
  }

  function off(event, fn) {
    handlers.get(event)?.delete(fn);
  }

  async function emit(event, payload) {
    const fns = handlers.get(event);
    if (!fns || fns.size === 0) return [];
    const results = [];
    for (const fn of [...fns]) {
      try {
        results.push(await fn(payload));
      } catch (e) {
        console.error(`[PDFHooks] handler for "${event}" failed:`, e);
      }
    }
    return results;
  }

  window.PDFHooks = { on, off, emit };
})();
