// Local pack check — dependency-free by contract (it must load without the
// gitignored canon mount), so it returns plain finding objects rather than
// importing the engine's finding() helper.

// The two validation tiers (docs/reference/external_datasets.md):
//
//   * MASK tier — hand-annotated per-pixel masks exist, so segmentation is
//     scored: `evaluate_segmentation.py` / `report.py` via `gratio/evaluate.py`,
//     against the masks `build_ground_truth.py` regenerates. Only
//     `data/samples/` sits here.
//   * G-LABEL tier — a published g-ratio per image and NO masks, so only the
//     *number* is scored (`validate_external.py`). `data/external/macaque_cc/`
//     sits here.
//
// Pointing the mask tier at a g-labelled set is only possible by inventing the
// masks it needs, which makes the "ground truth" an echo of the pipeline. This
// check watches for exactly that wiring.

const EXTERNAL = 'data/external/';

// A mask-free external set = one that ships a *labels*.csv (the published-g
// table) and no mask artifacts. A tier-2 external set that legitimately ships
// downloaded masks (AxonDeepSeg SEM, WMMDB — see external_datasets.md) has a
// `masks/` directory or `_gt_`/`_mask` rasters, and is deliberately NOT flagged:
// wiring *that* into the IoU harness is the intended use, not the violation.
const LABELS = /(^|\/)[^/]*labels[^/]*\.csv$/i;
const MASK_ARTIFACT = /(^|\/)masks?\/|_gt_|_mask/;

function maskFreeSets(files) {
  const sets = new Map(); // name -> { labels, masks }
  for (const f of files) {
    if (!f.startsWith(EXTERNAL)) continue;
    const rest = f.slice(EXTERNAL.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) continue; // a loose file directly under data/external/ is not a set
    const name = rest.slice(0, slash);
    const within = rest.slice(slash + 1);
    const seen = sets.get(name) ?? { labels: false, masks: false };
    if (LABELS.test(within)) seen.labels = true;
    if (MASK_ARTIFACT.test(within)) seen.masks = true;
    sets.set(name, seen);
  }
  return new Set([...sets].filter(([, s]) => s.labels && !s.masks).map(([n]) => n));
}

// The mask-scoring tier: anything that imports the IoU/detection evaluator, plus
// the ground-truth builders that manufacture the masks it scores against (those
// import no evaluator but are the other half of the same harness).
const GT_BUILDERS = new Set([
  'build_ground_truth.py',
  'extract_masks.py',
  'gratio/evaluate.py',
  'gratio/gt_register.py',
  'gratio/mask_extract.py',
]);
const EVALUATOR_IMPORT = /^[^#\n]*\b(?:from\s+gratio\.evaluate\s+import|import\s+gratio\.evaluate)\b/m;
const isMaskTier = (file, text) => GT_BUILDERS.has(file) || EVALUATOR_IMPORT.test(text);

// Lines whose *code* — not a comment, not a docstring — matches `re`. Prose
// naming the other tier is this repo's normal practice and must not fire:
// evaluate_segmentation.py's and validate_external.py's module docstrings each
// describe the tier they are NOT. (The sibling no-sample-special-casing check
// strips Python the same way; each local-pack module stays self-contained so a
// pack file can be read, moved, or vendored on its own.)
function codeLinesMatching(text, re) {
  const hits = [];
  let fence = null; // the triple-quote currently open, if any
  text.split('\n').forEach((raw, i) => {
    let line = raw;
    if (fence) {
      const close = line.indexOf(fence);
      if (close === -1) return;
      line = line.slice(close + 3);
      fence = null;
    }
    for (;;) {
      const m = /"""|'''/.exec(line);
      if (!m) break;
      const rest = line.slice(m.index + 3);
      const close = rest.indexOf(m[0]);
      if (close === -1) { fence = m[0]; line = line.slice(0, m.index); break; }
      line = line.slice(0, m.index) + rest.slice(close + 3);
    }
    const code = line.split('#')[0];
    const found = re.exec(code);
    if (found) hits.push({ line: i + 1, text: raw.trim(), set: found[1] });
  });
  return hits;
}

// `data/external/<set>` in code. A bare `data/external` or a glob over it
// captures no set name, and counts against every mask-free set present.
const EXTERNAL_REF = /data\/external\/?([A-Za-z0-9_.-]+)?/;

const rule = {
  id: 'gratio-validation-tiers-separate',
  severity: 'blocking',
  description: 'The mask-scoring harness never reads a mask-free (published-g) external set',
  doc: '.claudinite/local/packs/gratio/RULES.md',
  why: 'a set that publishes a g-ratio and no masks cannot be scored for IoU — the masks that harness needs would have to be invented, and invented ground truth is an echo of the pipeline rather than evidence about it (docs/reference/external_datasets.md; "GT is annotated, never invented")',

  run(ctx) {
    const maskFree = maskFreeSets(ctx.files);
    if (!maskFree.size) return [];
    const out = [];
    for (const file of ctx.files) {
      if (!file.endsWith('.py')) continue;
      const text = ctx.read(file);
      if (text === null || !isMaskTier(file, text)) continue;
      for (const hit of codeLinesMatching(text, EXTERNAL_REF)) {
        // A named tier-2 set (masks shipped with the data) is the legitimate case.
        if (hit.set && !maskFree.has(hit.set)) continue;
        const named = hit.set ?? [...maskFree].join(', ');
        out.push({
          rule: rule.id, severity: rule.severity, file, line: hit.line,
          what: `the mask-scoring harness reads a mask-free external set (${named}): ${hit.text.slice(0, 90)}`,
          why: rule.why,
          fix: 'score a published-g set through validate_external.py (mean g vs the published g) instead; if the set really does ship annotated masks, add them under data/external/<set>/masks/ so it is a mask-tier set',
          doc: rule.doc,
        });
      }
    }
    return out;
  },
};

export default rule;
export { maskFreeSets, isMaskTier };
