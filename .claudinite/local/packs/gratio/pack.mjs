import noSampleSpecialCasing from './no-sample-special-casing.mjs';
import generatedGtMasks from './generated-gt-masks.mjs';
import optionalSkimageImport from './optional-skimage-import.mjs';
import validationTiersSeparate from './validation-tiers-separate.mjs';

// gRatio's own pack: the measurement invariants and repo mechanics that are
// specific to this project and to no facet the canon homes. The project *class*
// (algorithm over similarly-formatted inputs, scored against annotated ground
// truth, improved in reviewable iterations) is the declared canon
// `research-project` pack — nothing here repeats it; what lives here is the
// g-ratio-specific residue: what may not be keyed on, what may not be imported,
// and which artifacts are generated rather than authored.
//
// Declared by hand as `local/gratio` in .claudinite-checks.json; never
// fingerprinted (detect/marker stay null) — a local pack is not seeded.
export default {
  id: 'gratio',
  detect: null,
  marker: null,
  prose: 'RULES.md',
  rules: [noSampleSpecialCasing, generatedGtMasks, optionalSkimageImport, validationTiersSeparate],
  skills: [],
  run_daily: [],
};
