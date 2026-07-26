// Local pack check — dependency-free by contract; returns plain finding objects.

// scikit-image is a *dev* dependency here: requirements.txt pins only
// opencv-python-headless / numpy / scipy, while requirements-dev.txt adds
// scikit-image "for the opt-in outer-boundary refinements ... the pipeline
// no-ops without it". So the main path may use it, but only behind a guarded,
// function-local import — gratio/pipeline.py's membrane_outer_boundary and
// gratio/lamella.py's trace_lamellae both do `try: from skimage... except:
// return <unrefined>`. A module-level import would make `pip install -r
// requirements.txt` insufficient to run the pipeline at all.
const SPIKE = /^gratio\/(phase1_.*|phase2)\.py$/;
const MAIN_PATH = (file) => file.startsWith('gratio/') && file.endsWith('.py') && !SPIKE.test(file);

// Column 0 = module level. An indented import is inside a function or a
// try-block, which is the guarded shape this rule asks for.
const TOP_LEVEL_SKIMAGE = /^(?:import|from)\s+skimage\b/;

const rule = {
  id: 'gratio-optional-skimage-import',
  severity: 'blocking',
  description: 'scikit-image is imported lazily in the pipeline, never at module level',
  doc: '.claudinite/local/packs/gratio/RULES.md',
  why: 'scikit-image is in requirements-dev.txt only — a module-level import makes the whole pipeline unimportable for anyone who installed requirements.txt, instead of degrading to the unrefined result',

  run(ctx) {
    const out = [];
    for (const file of ctx.files.filter(MAIN_PATH)) {
      const text = ctx.read(file);
      if (text === null) continue;
      text.split('\n').forEach((line, i) => {
        if (!TOP_LEVEL_SKIMAGE.test(line)) return;
        out.push({
          rule: rule.id, severity: rule.severity, file, line: i + 1,
          what: `module-level scikit-image import: ${line.trim()}`,
          why: rule.why,
          fix: 'move the import inside the function that needs it, wrapped in try/except returning the unrefined result — the shape gratio/lamella.py trace_lamellae uses — or add scikit-image to requirements.txt if it has become mandatory',
          doc: rule.doc,
        });
      });
    }
    return out;
  },
};

export default rule;
