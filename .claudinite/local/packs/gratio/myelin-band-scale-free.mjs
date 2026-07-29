// Local pack check — dependency-free by contract; returns plain finding objects.

// RULES.md "Myelin rules stay scale-free and g-ratio-prior-free": cap a myelin
// band by the axon's own measured ring thickness, never by a fraction of the
// axon radius — a radius fraction bakes a g-ratio prior into a g-ratio
// measurement. `DEFAULTS.myelin_band` in gratio/pipeline.py is exactly that
// forbidden shape (an ABSOLUTE ceiling expressed as a fraction of axon
// radius), kept present only as an explicit, off-by-default opt-in for a
// dataset the measured-thickness cap can't handle (reference_run.py's
// inverted-contrast SEM tuning uses it as a call-site override — legitimate,
// because it is chosen deliberately per-dataset, not shipped as everyone's
// default). So the check is narrow and precise: DEFAULTS.myelin_band itself
// must stay `None`; a call-site override elsewhere is untouched.
const DEFAULTS_START = /^DEFAULTS\s*=\s*dict\(/;
const DEFAULTS_END = /^\)\s*$/;
const MYELIN_BAND = /^\s*myelin_band\s*=\s*([^,]+),/;

const rule = {
  id: 'gratio-myelin-band-scale-free',
  severity: 'blocking',
  description: 'gratio/pipeline.py DEFAULTS.myelin_band stays None (no fraction-of-radius ceiling on by default)',
  doc: '.claudinite/local/packs/gratio/RULES.md',
  why: 'myelin_band is an absolute ceiling expressed as a fraction of axon radius — turning it on by default bakes a g-ratio prior into the g-ratio measurement, the one error the number cannot survive (CLAUDE.md; R20 in docs/reference/user_masks.md)',

  run(ctx) {
    const out = [];
    const file = 'gratio/pipeline.py';
    if (!ctx.files.includes(file)) return out;
    const text = ctx.read(file);
    if (text === null) return out;

    const lines = text.split('\n');
    const start = lines.findIndex((l) => DEFAULTS_START.test(l));
    if (start === -1) return out;
    const endOffset = lines.slice(start + 1).findIndex((l) => DEFAULTS_END.test(l));
    const end = endOffset === -1 ? lines.length - 1 : start + 1 + endOffset;

    for (let i = start; i <= end; i++) {
      const m = MYELIN_BAND.exec(lines[i]);
      if (!m) continue;
      const value = m[1].trim();
      if (value === 'None') continue;
      out.push({
        rule: rule.id, severity: rule.severity, file, line: i + 1,
        what: `DEFAULTS.myelin_band is ${value}, not None`,
        why: rule.why,
        fix: 'set myelin_band back to None in DEFAULTS — cap the band via the axon\'s own measured ring thickness (myelin_thickness_mult) instead; if a dataset genuinely needs the absolute fraction-of-radius ceiling, pass myelin_band as an explicit call-site override (as reference_run.py does), never as the shipped default',
        doc: rule.doc,
      });
    }
    return out;
  },
};

export default rule;
