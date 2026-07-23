// The one vendored place that maps a task's declared model FAMILY to the model
// the executor dispatches its subagent at (per-project-scheduling DESIGN §1, §3).
// A model-generation bump is a single edit HERE — task files and the executor
// only ever speak in families, never concrete ids.
//
// The resolved value is what the executor passes as the subagent's model. Short
// family names are themselves valid model selectors, so they are the safe
// default; to pin a task tier to a concrete dated snapshot, change only that
// family's value in MODEL_MAP below (nothing else needs to move).

export const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'none'];

// family → the model the executor dispatches at. `none` is agentless (the worker
// is code the scheduler runs inline — no subagent, no model), so it maps to null.
export const MODEL_MAP = {
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
  none: null,
};

// `none` means "pure code, no agent" (DESIGN §1) — the scheduler runs the
// worker .mjs inline rather than filing a dispatch issue.
export const isAgentless = (family) => family === 'none';

// Resolve a family to its concrete model, or throw on an unknown family (the
// task-declaration-shape check is the author-time guard; this is the runtime
// backstop for the executor/validator).
export function resolveModel(family) {
  if (!Object.prototype.hasOwnProperty.call(MODEL_MAP, family)) {
    throw new Error(`unknown model family "${family}" — valid families: ${MODEL_FAMILIES.join(', ')}`);
  }
  return MODEL_MAP[family];
}
