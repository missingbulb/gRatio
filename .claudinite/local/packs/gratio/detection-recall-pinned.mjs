// Local pack check — dependency-free by contract; returns plain finding objects.

// RULES.md "Recall is the hard constraint, IoU is the objective": a missed axon
// merges its myelin into a neighbour and corrupts *that* fibre's g, so a change
// that trades a detection for boundary accuracy is a regression however good the
// IoU delta looks. Whether a given tuning change is that trade is a judgment no
// scan can make — but the mechanism that *catches* the trade is an artifact: the
// regression suite asserts, over every sample, that detection has zero false
// negatives and zero false positives (tests/test_evaluate.py's
// `test_every_axon_found` / `test_no_spurious_axons`). Delete or weaken those
// two assertions and the one unacceptable regression becomes silent — an IoU
// gain bought with a lost axon then looks like an improvement. So the check is
// narrow: *some* assertion in the suite must still pin FN to zero, and *some*
// assertion must still pin FP to zero. How they are phrased, split, or which
// file holds them is free — any rewrite that keeps the guarantee passes.

// The guarantee, in the forms it can honestly take: zero false negatives (an
// `fn` count compared to 0) or perfect recall (recall == 1 / >= 1); zero false
// positives (an `fp` count compared to 0) or perfect precision. A weakened
// bound reads `>= 0.55` or `<= 1` and matches none of these.
const GUARDS = [
  {
    what: 'zero missed axons (detection false negatives)',
    patterns: [/\bfn\b["'\]\s)]*==\s*0\b/, /\brecall\b["'\]\s)]*[><]?==?\s*1(\.0*)?\b/],
    fix: 'restore an assertion that detection false negatives are zero across every sample (tests/test_evaluate.py::test_every_axon_found asserted `det["fn"] == 0`) — recall is the constraint, not a metric to trade',
  },
  {
    what: 'zero phantom axons (detection false positives)',
    patterns: [/\bfp\b["'\]\s)]*==\s*0\b/, /\bprecision\b["'\]\s)]*[><]?==?\s*1(\.0*)?\b/],
    fix: 'restore an assertion that detection false positives are zero across every sample (tests/test_evaluate.py::test_no_spurious_axons asserted `fp == 0`)',
  },
];

// `assert` statements only, with docstrings and comments stripped: a docstring
// that *describes* the guarantee ("Recall must be perfect") must not stand in
// for an assertion that enforces it. (The sibling checks strip Python the same
// way; each local-pack module stays self-contained so a pack file can be read,
// moved, or vendored on its own.)
function assertCode(text) {
  const out = [];
  let fence = null; // the triple-quote currently open, if any
  for (const raw of text.split('\n')) {
    let line = raw;
    if (fence) {
      const close = line.indexOf(fence);
      if (close === -1) continue;
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
    if (/\bassert\b/.test(code)) out.push(code);
  }
  return out;
}

const TEST_FILE = /^tests\/.*\.py$/;

const rule = {
  id: 'gratio-detection-recall-pinned',
  severity: 'blocking',
  description: 'The suite still pins detection recall 1.0 and zero false positives',
  doc: '.claudinite/local/packs/gratio/RULES.md',
  why: 'a missed axon does not merely lose one fibre — its myelin merges into a neighbour and corrupts that neighbour\'s g, so detection is the hard constraint and IoU only the objective; with the zero-FN/zero-FP assertions gone, a tuning change that buys boundary accuracy with a lost axon reports as an improvement (CLAUDE.md design principles; RULES.md "Recall is the hard constraint")',

  run(ctx) {
    // `tracked` (every tracked file), not the mode-scoped scan set: a
    // must-exist check asks about the whole suite, and in changed-file mode the
    // suite is usually absent from the scan.
    const files = (ctx.tracked ?? ctx.files ?? []).filter((f) => TEST_FILE.test(f));
    // Nothing to pin unless this repo has both the evaluator whose detection
    // counts are being asserted and a suite to assert them in.
    if (!files.length || !(ctx.tracked ?? ctx.files ?? []).includes('gratio/evaluate.py')) return [];

    const asserts = files.flatMap((f) => {
      const text = ctx.read(f);
      return text === null ? [] : assertCode(text);
    });

    const home = files.includes('tests/test_evaluate.py') ? 'tests/test_evaluate.py' : files[0];
    const out = [];
    for (const guard of GUARDS) {
      if (asserts.some((line) => guard.patterns.some((p) => p.test(line)))) continue;
      out.push({
        rule: rule.id, severity: rule.severity, file: home, line: null,
        what: `no assertion in tests/ pins ${guard.what}`,
        why: rule.why,
        fix: guard.fix,
        doc: rule.doc,
      });
    }
    return out;
  },
};

export default rule;
export { assertCode };
