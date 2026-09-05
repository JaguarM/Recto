// matching.test.mjs — the matcher's width logic under Node with the viewer's
// globals stubbed: which names fit a bar (pixel tolerance vs the pen-exact
// lattice a refiner can vouch for), the loose fallback, and how page-pixel
// verdicts from an optional hypothesis tester rank the list. Run directly
// (`node tests_js/matching.test.mjs`) or through `python manage.py test
// redaction_matching`, which shells out to it.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// ── Viewer globals (api.js touches these at load) ──────────
globalThis.window = globalThis;
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  fonts: { ready: Promise.resolve() },
};
globalThis.state = {};
globalThis.els = {};
globalThis.utbState = {
  boxes: [], selectedId: null, editingId: null,
  getBox(id) { return this.boxes.find((b) => b.id === id); },
};
globalThis.PDFHooks = { on() {}, emit() {} };

vm.runInThisContext(fs.readFileSync(path.join(root, 'static', 'redaction_matching', 'api.js'), 'utf8'));
for (const fn of ['getBoxMatchInfo', 'getBoxMatches', 'effectiveTolerance', 'scoreMatches', 'shownMatch', 'matchesLetterFilter']) {
  assert.equal(typeof globalThis[fn], 'function', `${fn} is a global`);
}

// A bar whose measured width is 120.5 px, with a candidate pool measured by
// the shaper: two names tie to the font unit, one is 0.8 px off, one is far.
const WIDTHS = { 'Sarah Kellen': 120.4375, 'Justin Nelson': 120.4453, 'Nicki Haskell': 121.32, 'Woody Allen': 117.0 };
let n = 0;
const bar = (over = {}) => ({
  id: `r${++n}`, type: 'redaction', page: 1, x: 319.5, w: 120.5, y: 0, h: 20, tolerance: 3,
  candidates: Object.keys(WIDTHS), widths: { ...WIDTHS }, ...over,
});
const exactInfo = (box) => ({ exact: true, source: 'ocr', x: box.x, w: box.w, left: {}, right: {}, remnants: [] });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('pixel tolerance: everything within the field, closest first', () => {
  const box = bar();
  const info = getBoxMatchInfo(box);
  assert.deepEqual(info.matches, ['Justin Nelson', 'Sarah Kellen', 'Nicki Haskell']);
  assert.equal(info.tol, 3);
  assert.equal(info.loose, false);
  assert.equal(effectiveTolerance(bar({ tolerance: undefined })), 3, 'default field');
});

test('pen-exact bar: the lattice decides, the 0.8 px name is out', () => {
  const box = bar();
  box.refineInfo = exactInfo(box);
  const info = getBoxMatchInfo(box);
  assert.deepEqual(info.matches, ['Justin Nelson', 'Sarah Kellen']);
  assert.equal(info.tol, 0.3);
  assert.equal(info.loose, false);
});

test('a tighter user field still wins over the lattice', () => {
  const box = bar({ tolerance: 0.055 });
  box.refineInfo = exactInfo(box);
  assert.deepEqual(getBoxMatches(box), ['Justin Nelson']);
  assert.equal(effectiveTolerance(box), 0.055);
});

test('a bar moved after refinement is no longer exact', () => {
  const box = bar();
  box.refineInfo = exactInfo(box);
  box.x += 1;
  assert.equal(effectiveTolerance(box), 3);
  assert.equal(getBoxMatches(box).length, 3);
});

test('embedded-derived edges are not exact', () => {
  const box = bar();
  box.refineInfo = { ...exactInfo(box), exact: false, source: 'embedded' };
  assert.equal(effectiveTolerance(box), 3);
});

test('nothing fits the exact width → nearest names within the field, flagged loose', () => {
  const box = bar({ w: 122.0 });
  box.refineInfo = exactInfo(box);
  const info = getBoxMatchInfo(box);
  assert.equal(info.loose, true);
  assert.equal(info.tol, 3);
  assert.deepEqual(info.matches, ['Nicki Haskell', 'Justin Nelson', 'Sarah Kellen']);
});

test('without a hypothesis tester, verdicts stay empty and order is by width', async () => {
  const box = bar();
  await scoreMatches(box);
  assert.equal(box.verdicts, null);
  assert.equal(getBoxMatches(box)[0], 'Justin Nelson');
});

test('page-pixel verdicts rank the list: consistent, no-evidence, contradicted', async () => {
  const box = bar();
  box.refineInfo = exactInfo(box);
  const calls = [];
  globalThis.ocrTestHypothesis = async (b, name) => {
    calls.push(name);
    if (name === 'Sarah Kellen') return { verdict: 'consistent', open: { ink: 40, match: 40, differ: 0 }, unexplained: 0 };
    if (name === 'Justin Nelson') return { verdict: 'contradicted', open: { ink: 40, match: 12, differ: 28 }, unexplained: 3 };
    return null;
  };
  await scoreMatches(box);
  assert.deepEqual(calls.sort(), ['Justin Nelson', 'Sarah Kellen'], 'only the fitting names are tested');
  assert.deepEqual(getBoxMatches(box), ['Sarah Kellen', 'Justin Nelson']);
  assert.equal(shownMatch(box, getBoxMatches(box)).name, 'Sarah Kellen');
  // The user's own pick still wins while it fits.
  box.matchPick = 'Justin Nelson';
  assert.equal(shownMatch(box, getBoxMatches(box)).name, 'Justin Nelson');
  // A provider that throws is a null verdict, not a broken list.
  globalThis.ocrTestHypothesis = async () => { throw new Error('boom'); };
  await scoreMatches(box);
  assert.deepEqual(box.verdicts, { 'Justin Nelson': null, 'Sarah Kellen': null });
  assert.equal(getBoxMatches(box).length, 2);
  delete globalThis.ocrTestHypothesis;
});

test('starts-with / ends-with filter takes several letters, case-insensitive', () => {
  assert.equal(matchesLetterFilter('Sarah Kellen', { startsWith: 'sa', endsWith: 'LLEN' }), true);
  assert.equal(matchesLetterFilter('Sarah Kellen', { startsWith: 'j' }), false);
  assert.equal(matchesLetterFilter('Sarah Kellen', {}), true);
  assert.equal(matchesLetterFilter('', { startsWith: 's' }), false);
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ok   ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${t.name}\n       ${e.message.split('\n').join('\n       ')}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
