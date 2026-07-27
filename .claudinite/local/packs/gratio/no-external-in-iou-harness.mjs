// Local pack check — dependency-free by contract (it must load without the
// gitignored canon mount), so it returns plain finding objects rather than
// importing the engine's finding() helper.

// The IoU/segmentation harness is pinned by name in CLAUDE.md's "Two
// validation tiers" section: evaluate_segmentation.py and report.py score
// *segmentation* (IoU/recall + per-neuron g) against the three data/samples/
// hand-drawn masks. External, mask-free sets (data/external/, currently
// macaque_cc) have only a published aggregate g-ratio and score through
// validate_external.py instead -- inventing masks to wire one into the
// mask-IoU harness would break "GT is annotated, never invented" (R34 in
// docs/reference/user_masks.md).
const HARNESS_FILES = ['evaluate_segmentation.py', 'report.py'];

const EXTERNAL_REF = /data[\\/]external/;

// Lines whose *code* (not comment, not docstring) references an external-set
// path. A comment or docstring documenting the exclusion (as this rule's own
// header does, and as R34 does in user_masks.md) is the repo's normal
// practice and must not fire.
function codeLinesReferencingExternal(text) {
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
    // Consume complete same-line triple-quoted strings, then open a fence if one
    // is left dangling.
    for (;;) {
      const m = /"""|'''/.exec(line);
      if (!m) break;
      const rest = line.slice(m.index + 3);
      const close = rest.indexOf(m[0]);
      if (close === -1) { fence = m[0]; line = line.slice(0, m.index); break; }
      line = line.slice(0, m.index) + rest.slice(close + 3);
    }
    const code = line.split('#')[0];
    if (EXTERNAL_REF.test(code)) hits.push({ line: i + 1, text: raw.trim() });
  });
  return hits;
}

const rule = {
  id: 'gratio-no-external-in-iou-harness',
  severity: 'blocking',
  description: 'The mask-IoU harness must never reference the mask-free external set',
  doc: '.claudinite/local/packs/gratio/RULES.md',
  why: 'data/external/ sets (e.g. macaque_cc) carry a published g-ratio but no per-axon masks -- CLAUDE.md: "never wire a mask-free set into the IoU harness (fabricating masks breaks \'GT is annotated, never invented\')" (R34 in docs/reference/user_masks.md)',

  run(ctx) {
    const out = [];
    for (const file of HARNESS_FILES) {
      if (!ctx.files.includes(file)) continue;
      const text = ctx.read(file);
      if (text === null) continue;
      for (const hit of codeLinesReferencingExternal(text)) {
        out.push({
          rule: rule.id, severity: rule.severity, file, line: hit.line,
          what: `the IoU harness references an external-set path: ${hit.text.slice(0, 90)}`,
          why: rule.why,
          fix: 'score a mask-free external set only through validate_external.py (mean g vs published g); never invent masks to run it through evaluate_segmentation.py / report.py',
          doc: rule.doc,
        });
      }
    }
    return out;
  },
};

export default rule;
export { codeLinesReferencingExternal };
