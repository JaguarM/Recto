# Reference — not live code

Kept for lookup only. Nothing here is imported, and `settings.py` will not
auto-discover it: plugin discovery scans only the **top level** of the project
for folders containing an `apps.py`, and `reference/` has none.

- `guesser_core/` — the pre-rebrand core, before it was split into `pdf_core`
  (document ingestion + viewer) and a separate analysis plugin. That plugin has
  since been removed too, so this folder is the only remaining copy of the
  black-bar detection and width-matching code.

Safe to delete once you no longer need it.
