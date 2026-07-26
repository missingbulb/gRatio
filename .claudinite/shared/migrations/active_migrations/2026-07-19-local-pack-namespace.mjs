// Namespace local-pack declarations: a repo's own pack (.claudinite/local_packs/<name>/)
// is declared in .claudinite-checks.json by its namespaced token `local_packs/<name>`,
// not a bare id — self-documenting, and a canon id can never be claimed by accident
// (the bare form shared the canon namespace; a collision was only CAUGHT by the
// discoverPacks shadow guard, never prevented).
//
// Seed-style, like grow-with-claudinite-seed: the WRITE rides baselining — its
// declaration-normalization step runs in the member checkout (which knows which
// declared ids are local packs) and rewrites any bare local-pack declaration to the
// namespaced form (see the baselining worker doc). This record holds no ops of its
// own; it is the convergence telemetry. The engine accepts BOTH forms throughout (and
// after — packEntryId's strip is the permanent parser, not a tolerance this record
// carries), so retiring strands nothing.
//
// legacyPresent: a member still declares a bare id (string entry or entry-object id,
// no `local_packs/` prefix) whose pack lives in its own .claudinite/local_packs/ tree.
// A bare id with no such local pack is a canon declaration — not this record's business.
// retire: 'auto' — self-retires once the fleet has converged and stayed quiet a cycle.
export default {
  id: 'local-pack-namespace',
  landed: '2026-07-19',
  summary: 'local-pack declarations namespaced as local_packs/<name> (baselining rewrites bare ids; the engine accepts both forms)',
  legacyPresent: async (exists, read) => {
    const raw = await read('.claudinite-checks.json');
    if (raw == null) return false;
    let packs;
    try { ({ packs } = JSON.parse(raw)); } catch { return false; }
    if (!Array.isArray(packs)) return false;
    for (const e of packs) {
      const id = typeof e === 'string' ? e : e?.id;
      if (typeof id !== 'string' || id.startsWith('local_packs/')) continue;
      if (await exists(`.claudinite/local_packs/${id}/pack.mjs`)) return true;
    }
    return false;
  },
  retire: 'auto',
};
