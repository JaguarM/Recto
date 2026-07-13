/* =========================================================
       State & Application Setup
       ========================================================= */
const state = {
  // PDF Viewer State
  pageImages: [],    // data URLs, one per page (index 0 = page 1)
  numPages: 0,
  pageWidth: GEO.PAGE_WIDTH_PX,
  pageHeight: GEO.PAGE_HEIGHT_PX,
  currentPage: 1,
  currentZoom: 1.0,
  minZoom: 0.5,
  maxZoom: 8.0,
  renderQueue: [],

  // Unredactor State
  namesData: [],          // raw JSON entries from epstein_names.json
  customCandidates: [],   // names added manually by the user (shared across all boxes)
  excludedPersons: new Set(), // indices into namesData that were deleted — global, hides the
                              // whole person from every box regardless of each box's name format
  candidates: [],         // template/global union (template nameSettings ∪ custom, minus deleted)
                          // — used by the uppercase heuristic; per-box matching uses box.candidates
  // Template name-format settings: edited when no box is selected and copied onto
  // each new redaction box. Per-box overrides live on box.nameSettings.
  nameSettings: {
    generateFull: true,          // "Jeffrey Epstein"
    generateFirstOnly: false,    // "Jeffrey"
    generateLastOnly: false,     // "Epstein"
    includePrefix: false,        // "Prince Andrew"
    includeSuffix: false,        // "Albert Bryan Jr."
    expandFirstAliases: false,   // one candidate per first-name variant
    expandLastAliases: false,    // one candidate per last-name variant
    includeNickname: false,      // add nickname field as extra candidate
    firstLetter: '',             // keep only candidates whose first character matches
    lastLetter: '',              // keep only candidates whose last character matches
  },
  // Legacy redaction array removed — now managed by utbState.boxes
  // selectedRedactionIdx removed — now utbState.selectedId

  // Candidates Pagination/Sort
  page: 1,
  perPage: 15,
  sortBy: 'name',
  sortDir: 'asc',
  activeTool: null, // 'add-box' or null
};

const els = {
  // Viewer
  dragOverlay: document.getElementById('drag-overlay'),
  viewerContainer: document.getElementById('viewer-container'),
  viewer: document.getElementById('viewer'),
  titleElem: document.getElementById('document-title'),
  pageCountElem: document.getElementById('page-count'),
  pageInputElem: document.getElementById('page-input'),
  zoomInputElem: document.getElementById('zoom-input'),
  zoomInBtn: document.getElementById('zoom-in'),
  zoomOutBtn: document.getElementById('zoom-out'),
  sidebar: document.getElementById('sidebar'),
  toggleSidebarBtn: document.getElementById('toggle-sidebar'),
  thumbnailView: document.getElementById('thumbnail-view'),
  prevPageBtn: document.getElementById('prev-page'),
  nextPageBtn: document.getElementById('next-page'),

  // Tools Sidebar
  toolsSidebar: document.getElementById('tools-sidebar'),
  toggleToolsBtn: document.getElementById('toggle-tools'),
  toolAddBoxBtn: document.getElementById('tool-add-box'),
  toolTextBtn: document.getElementById('tool-text'),
  textOptionsBar: document.getElementById('text-options-bar'),
  // Plugin-owned controls (webgl mask toggle, edge slider, ETV add-text, …) are
  // looked up by the plugins themselves — the core no longer references them.

  // Settings
  tol: document.getElementById('tolerance'),
  kern: document.getElementById('kerning'),
  upper: document.getElementById('force-uppercase'),

  // Data
  pdfFile: document.getElementById('pdf-file'),
  nameInput: document.getElementById('name-input'),
  pasteInput: document.getElementById('paste-input'),
  tableBody: document.getElementById('names-body'),
  pageInfo: document.getElementById('page-info'),

  // All Matches
  allMatchesCard: document.getElementById('all-matches-card'),
  allMatchesSummary: document.getElementById('all-matches-summary'),
  allMatchesBody: document.getElementById('all-matches-body')
};