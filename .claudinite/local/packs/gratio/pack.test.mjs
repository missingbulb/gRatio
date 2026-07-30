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
import validationTiersSeparate from './validation-tiers-separate.mjs';
import myelinBandScaleFree from './myelin-band-scale-free.mjs';
import detectionRecallPinned from './detection-recall-pinned.mjs';

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

// A mask-free (published-g, no masks) external set, as macaque_cc actually sits
// on disk: a labels table, images, and nothing mask-shaped.
const G_LABELLED_SET = {
  'data/external/macaque_cc/gratio_labels.csv': 'image,g\nSegment_1,0.70\n',
  'data/external/macaque_cc/images/Segment_1.png': '',
  'data/external/macaque_cc/fetch.py': '# downloader\n',
};

// A tier-2 external set that ships its own annotated masks — the legitimate
// mask-tier case that must NOT fire.
const MASKED_SET = {
  'data/external/adseg_sem/images/img_1.png': '',
  'data/external/adseg_sem/masks/img_1_seg-axonmyelin.png': '',
  'data/external/adseg_sem/gratio_labels.csv': 'image,g\nimg_1,0.62\n',
};

test('validation-tiers-separate fires when the IoU harness reads a mask-free set', () => {
  const found = validationTiersSeparate.run(ctxOf({
    ...G_LABELLED_SET,
    'evaluate_segmentation.py': 'from gratio.evaluate import evaluate\n'
      + 'RAW_DIR = "data/external/macaque_cc/crops"\n',
  }));
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 2);
});

test('validation-tiers-separate fires when a GT builder targets a mask-free set', () => {
  const found = validationTiersSeparate.run(ctxOf({
    ...G_LABELLED_SET,
    'build_ground_truth.py': 'import cv2\nfor p in glob.glob("data/external/*/images/*.png"):\n    pass\n',
  }));
  assert.equal(found.length, 1);
});

test('validation-tiers-separate tolerates the other tier named in prose', () => {
  assert.deepEqual(validationTiersSeparate.run(ctxOf({
    ...G_LABELLED_SET,
    'evaluate_segmentation.py': '"""Scores masks; data/external/macaque_cc has none."""\n'
      + 'from gratio.evaluate import evaluate\n'
      + 'RAW_DIR = "data/samples"  # not data/external/macaque_cc\n',
  })), []);
});

test('validation-tiers-separate leaves the mask-free harness alone', () => {
  assert.deepEqual(validationTiersSeparate.run(ctxOf({
    ...G_LABELLED_SET,
    'validate_external.py': 'from gratio import segment\nDATA_DIR = "data/external/macaque_cc"\n',
  })), []);
});

test('validation-tiers-separate allows an external set that ships its own masks', () => {
  assert.deepEqual(validationTiersSeparate.run(ctxOf({
    ...MASKED_SET,
    'evaluate_segmentation.py': 'from gratio.evaluate import evaluate\n'
      + 'RAW_DIR = "data/external/adseg_sem/images"\n',
  })), []);
});

test('myelin-band-scale-free fires when DEFAULTS.myelin_band is a number', () => {
  const found = myelinBandScaleFree.run(ctxOf({
    'gratio/pipeline.py': 'DEFAULTS = dict(\n'
      + '    touch_dilate=5,\n'
      + '    myelin_band=0.7,         # fraction of axon radius\n'
      + '    smooth_frac=0.15,\n'
      + ')\n',
  }));
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3);
});

test('myelin-band-scale-free tolerates the shipped None default', () => {
  assert.deepEqual(myelinBandScaleFree.run(ctxOf({
    'gratio/pipeline.py': 'DEFAULTS = dict(\n'
      + '    touch_dilate=5,\n'
      + '    myelin_band=None,        # fraction of axon radius; None = off\n'
      + '    smooth_frac=0.15,\n'
      + ')\n',
  })), []);
});

test('myelin-band-scale-free ignores a call-site override outside DEFAULTS', () => {
  assert.deepEqual(myelinBandScaleFree.run(ctxOf({
    'gratio/pipeline.py': 'DEFAULTS = dict(\n'
      + '    myelin_band=None,\n'
      + ')\n',
    'reference_run.py': 'segment(img, myelin_band=0.7, bright_margin=-40)\n',
  })), []);
});

// The suite as it stands: both detection guards asserted, over every sample.
const PINNED_SUITE = {
  'gratio/evaluate.py': 'def evaluate(pred, gt):\n    return {"detection": {}}\n',
  'tests/test_evaluate.py': 'def test_every_axon_found(evaluated):\n'
    + '    for s in SAMPLES:\n        assert evaluated[s][1]["detection"]["fn"] == 0\n\n'
    + 'def test_no_spurious_axons(evaluated):\n'
    + '    fp = sum(evaluated[s][1]["detection"]["fp"] for s in SAMPLES)\n    assert fp == 0\n',
};

test('detection-recall-pinned fires when the zero-false-negative guard is deleted', () => {
  const found = detectionRecallPinned.run(ctxOf({
    ...PINNED_SUITE,
    'tests/test_evaluate.py': 'def test_no_spurious_axons(evaluated):\n'
      + '    fp = sum(evaluated[s][1]["detection"]["fp"] for s in SAMPLES)\n    assert fp == 0\n',
  }));
  assert.equal(found.length, 1);
  assert.match(found[0].what, /false negatives/);
});

test('detection-recall-pinned fires when a guard is weakened to a threshold', () => {
  const found = detectionRecallPinned.run(ctxOf({
    ...PINNED_SUITE,
    'tests/test_evaluate.py': 'def test_detection(evaluated):\n'
      + '    for s in SAMPLES:\n        assert evaluated[s][1]["detection"]["recall"] >= 0.9\n'
      + '        assert evaluated[s][1]["detection"]["fp"] == 0\n',
  }));
  assert.equal(found.length, 1);
  assert.match(found[0].what, /false negatives/);
});

test('detection-recall-pinned does not accept a docstring in place of an assertion', () => {
  const found = detectionRecallPinned.run(ctxOf({
    ...PINNED_SUITE,
    'tests/test_evaluate.py': 'def test_every_axon_found(evaluated):\n'
      + '    """Recall must be perfect: det["fn"] == 0 for every sample."""\n'
      + '    assert evaluated["sample_02"][1]["detection"]["fp"] == 0\n',
  }));
  assert.equal(found.length, 1);
});

test('detection-recall-pinned reports both guards when neither survives', () => {
  const found = detectionRecallPinned.run(ctxOf({
    ...PINNED_SUITE,
    'tests/test_evaluate.py': 'def test_iou(evaluated):\n    assert evaluated["sample_02"][1]["axon"]["iou"] > 0.9\n',
  }));
  assert.equal(found.length, 2);
});

test('detection-recall-pinned is quiet on a suite that pins both guards', () => {
  assert.deepEqual(detectionRecallPinned.run(ctxOf(PINNED_SUITE)), []);
});

test('detection-recall-pinned accepts an equivalent recall/precision phrasing', () => {
  assert.deepEqual(detectionRecallPinned.run(ctxOf({
    ...PINNED_SUITE,
    'tests/test_detect.py': 'def test_detection(evaluated):\n'
      + '    for s in SAMPLES:\n        assert evaluated[s][1]["detection"]["recall"] == 1.0\n'
      + '        assert evaluated[s][1]["detection"]["precision"] == 1.0\n',
    'tests/test_evaluate.py': 'def test_iou(evaluated):\n    assert 1\n',
  })), []);
});

test('detection-recall-pinned stays out of a repo with no evaluator', () => {
  assert.deepEqual(detectionRecallPinned.run(ctxOf({
    'tests/test_synthetic.py': 'def test_ring():\n    assert g < 1\n',
  })), []);
});

test('the repo as it stands is clean under every rule', () => {
  const ctx = realCtx();
  assert.deepEqual(noSampleSpecialCasing.run(ctx), []);
  assert.deepEqual(optionalSkimageImport.run(ctx), []);
  assert.deepEqual(validationTiersSeparate.run(ctx), []);
  assert.deepEqual(myelinBandScaleFree.run(ctx), []);
  assert.deepEqual(detectionRecallPinned.run(ctx), []);
});
