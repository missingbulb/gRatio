// Red-first fixtures for the gratio pack's checks: each rule must fire on a
// violating input and stay quiet on the repo as it actually stands.
// Run: node --test .claudinite/local/packs/gratio/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import noSampleSpecialCasing from './no-sample-special-casing.mjs';
import generatedGtMasks from './generated-gt-masks.mjs';
import optionalSkimageImport from './optional-skimage-import.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

// A world-scope context over literal file contents.
const ctxOf = (files) => ({
  files: Object.keys(files),
  read: (f) => (f in files ? files[f] : null),
  exists: (f) => f in files,
});

// The real repo as the clean fixture: every tracked file, read from disk.
const realCtx = () => {
  const tracked = execFileSync('git', ['-C', repoRoot, 'ls-files'], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  return {
    files: tracked,
    read: (f) => (existsSync(join(repoRoot, f)) ? readFileSync(join(repoRoot, f), 'utf8') : null),
    exists: (f) => existsSync(join(repoRoot, f)),
  };
};

test('no-sample-special-casing fires on code keyed to a stem', () => {
  const found = noSampleSpecialCasing.run(ctxOf({
    'gratio/pipeline.py': 'def segment(img, stem):\n    if stem == "sample_01":\n        thresh = 0.4\n',
  }));
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
});

test('no-sample-special-casing tolerates a sample cited in a comment or docstring', () => {
  assert.deepEqual(noSampleSpecialCasing.run(ctxOf({
    'gratio/pipeline.py': '"""Tuned against sample_02, the lone isolated fibre."""\n'
      + 'ring_tol = 1.4  # the elbow measured on sample_02\n',
  })), []);
});

test('no-sample-special-casing ignores the frozen research spikes', () => {
  assert.deepEqual(noSampleSpecialCasing.run(ctxOf({
    'gratio/phase2.py': 'g = cv2.imread(f"data/samples/sample_0{n}.png")\n',
  })), []);
});

test('optional-skimage-import fires on a module-level import', () => {
  const found = optionalSkimageImport.run(ctxOf({
    'gratio/lamella.py': 'import numpy as np\nfrom skimage.filters import sato\n',
  }));
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
});

test('optional-skimage-import tolerates the guarded function-local import', () => {
  assert.deepEqual(optionalSkimageImport.run(ctxOf({
    'gratio/lamella.py': 'def trace_lamellae(g):\n    try:\n'
      + '        from skimage.filters import sato\n    except Exception:\n        return None\n',
  })), []);
});

test('generated-gt-masks fires when a native mask changes alone', () => {
  const found = generatedGtMasks.run({
    changedFiles: ['data/samples/masks/native/sample_01_gt_axon.png'],
  });
  assert.equal(found.length, 1);
});

test('generated-gt-masks is quiet when the annotated crop changed too', () => {
  assert.deepEqual(generatedGtMasks.run({
    changedFiles: [
      'data/samples/masks/sample_01_masked.png',
      'data/samples/masks/native/sample_01_gt_axon.png',
    ],
  }), []);
});

test('the repo as it stands is clean under every rule', () => {
  const ctx = realCtx();
  assert.deepEqual(noSampleSpecialCasing.run(ctx), []);
  assert.deepEqual(optionalSkimageImport.run(ctx), []);
});
