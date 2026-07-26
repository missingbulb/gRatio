// Local pack check — dependency-free by contract; returns plain finding objects.

// The generated ground truth. CLAUDE.md: "The masks under
// data/samples/masks/native/*_gt_*.png are generated, not hand-edited. Source of
// truth = the hand-annotated data/samples/masks/<stem>_masked.png crop. To fix
// GT, fix the crop (or the extraction) and regenerate — never edit the native
// PNGs (they get overwritten)."
const GENERATED = (f) => f.startsWith('data/samples/masks/native/') && f.endsWith('.png');

// Anything whose change legitimately explains a regenerated mask: the annotated
// crop, the extraction/registration code, or the builder that runs them.
const SOURCE = (f) =>
  /^data\/samples\/masks\/[^/]+_masked\.png$/.test(f) ||
  f === 'gratio/mask_extract.py' ||
  f === 'gratio/gt_register.py' ||
  f === 'build_ground_truth.py' ||
  f === 'extract_masks.py' ||
  f === 'data/samples/axon_seeds.json';

const rule = {
  id: 'gratio-generated-gt-masks',
  severity: 'blocking',
  description: 'Native GT masks change only alongside the annotation or the extraction that generates them',
  doc: '.claudinite/local/packs/gratio/RULES.md',
  scope: 'work',
  why: 'the native masks are regenerated output — a hand edit is silently overwritten by the next build_ground_truth.py run, and ground truth that was touched by hand is no longer annotated evidence',

  run(work) {
    const changed = work.changedFiles ?? [];
    const generated = changed.filter(GENERATED);
    if (!generated.length || changed.some(SOURCE)) return [];
    return [{
      rule: rule.id, severity: rule.severity,
      file: generated[0], line: null,
      what: `${generated.length} generated GT mask(s) changed with no change to the annotated crop or the extraction that produces them`,
      why: rule.why,
      fix: 'revert the native PNGs, fix data/samples/masks/<stem>_masked.png (or the extraction), then rerun `python extract_masks.py && python build_ground_truth.py` — see docs/reference/gt_from_masks.md',
      doc: rule.doc,
    }];
  },
};

export default rule;
