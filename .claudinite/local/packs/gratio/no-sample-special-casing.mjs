// Local pack check — dependency-free by contract (it must load without the
// gitignored canon mount), so it returns plain finding objects rather than
// importing the engine's finding() helper.

// The main path is the `gratio` package minus the older research spikes:
// CLAUDE.md — "`gratio/phase1_*.py`, `phase2.py` | older research spikes, NOT
// the main path. 'The pipeline' = `gratio.segment`." The spikes legitimately
// hard-code `data/samples/sample_0{n}.png` as their driver (phase1_select.py:48,
// phase2.py:30) and are frozen; the CLI/report scripts at the repo root
// legitimately name the sample files as inputs. Only the library's decision
// logic is governed.
const SPIKE = /^gratio\/(phase1_.*|phase2)\.py$/;
const MAIN_PATH = (file) => file.startsWith('gratio/') && file.endsWith('.py') && !SPIKE.test(file);

const STEM = /sample_0\d/;

// Lines whose *code* (not comment, not docstring) names a sample stem. Comments
// citing a sample as the evidence for a tuned constant are the repo's normal
// practice and must not fire — gratio/pipeline.py's DEFAULTS block does it a
// dozen times ("1.4 is the elbow measured against the one isolated example
// (sample_02)"). Docstrings are skipped for the same reason
// (gratio/gt_register.py's module docstring names the sample rasters).
function codeLinesNamingAStem(text) {
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
    if (STEM.test(code)) hits.push({ line: i + 1, text: raw.trim() });
  });
  return hits;
}

const rule = {
  id: 'gratio-no-sample-special-casing',
  severity: 'blocking',
  description: 'Pipeline code must not branch on a sample stem (sample_01/02/03)',
  doc: '.claudinite/local/packs/gratio/RULES.md',
  why: 'a rule keyed on a stem scores well on the three-image set and generalises to nothing — the owner directive is "No single-sample special-casing" (CLAUDE.md; the R24 audit in docs/reference/user_masks.md)',

  run(ctx) {
    const out = [];
    for (const file of ctx.files.filter(MAIN_PATH)) {
      const text = ctx.read(file);
      if (text === null) continue;
      for (const hit of codeLinesNamingAStem(text)) {
        out.push({
          rule: rule.id, severity: rule.severity, file, line: hit.line,
          what: `executable code names a sample stem: ${hit.text.slice(0, 90)}`,
          why: rule.why,
          fix: 'express the rule in terms the image itself supplies (measured ring thickness, area fractions, neuron count) instead of the stem; if the sample is only the evidence for a constant, say so in a comment rather than in code',
          doc: rule.doc,
        });
      }
    }
    return out;
  },
};

export default rule;
export { codeLinesNamingAStem };
