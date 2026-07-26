// Pack independence (extending.md; the canon-side `pack-independence` barrier):
// packs no longer import each other's code — a fixed folder-barrier is now
// CONTRIBUTED as manifest data (`requires` the mechanism pack +
// `contributes` on pack.mjs; the engine builds the rule) and the shared
// path/migration helpers moved into the vendored engine lib (engine/checks/helpers/).
// The old code-composition export (`defineBarrier`) is gone.
//
// Canon-side the conversion is complete (rule first, then the fixes — one
// commit each). Member-side there are no mechanical ops: nothing in a
// consumer's tree is renamed or rewritten. The AGENTIC note for the nightly
// worker: if a member's own local packs (.claudinite/local_packs/) composed a
// barrier by importing the shared engine, convert each to the contribution
// shape — move the barrier object (id, edges, description, why, doc,
// crossingExcuse, gateDir) onto the local pack's manifest under
// `contributes` and add the mechanism pack to its `requires`. A local pack
// still importing the removed export fails loudly at pack discovery (the
// runner's fail-soft config finding names the broken manifest) — that
// diagnostic is the member-side signal. Consumers with no such local packs
// need nothing.
//
// retire: 'auto' — the durable enforcement is the check, which every member
// runs from its own snapshot; this record only carries the one-time
// conversion guidance through the fleet's next cycles.
export default {
  id: 'pack-independence',
  landed: '2026-07-19',
  summary: 'packs compose by declaration + contributed config, never code imports; local packs that imported the shared barrier engine convert to `contributes` on their manifest',
  // The AGENTIC note above, now machine-readable (agent-preprocessing DESIGN §7):
  // baselining's deterministic preprocessing detects this and escalates to the
  // agent stage instead of advancing the stamp past it. There are no mechanical
  // member-side ops, so this is the record's whole member-side work.
  agentic: {
    model: 'sonnet',
    instructions: 'If a member local pack (.claudinite/local/packs/) composed a barrier by importing the shared engine, convert it to the contribution shape: move the barrier object (id, edges, description, why, doc, crossingExcuse, gateDir) onto the local pack manifest under `contributes`, and add the mechanism pack to its `requires`. A member with no such local pack needs nothing.',
  },
};
