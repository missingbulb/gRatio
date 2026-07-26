// One-time seed of the tidy-repo pack into the EXISTING fleet's declarations. New
// repos get tidy-repo from `bootstrap --init`; this migration catches repos
// bootstrapped before the pack existed, so today's universal tidy doesn't regress.
//
// Unlike a path-relocation migration, the "legacy shape" here lives inside a file —
// a member whose .claudinite-checks.json declares no tidy-repo — so legacyPresent
// READS the declaration (the retire pass passes it a content `read` alongside `exists`;
// path-only migrations ignore the extra arg).
//
// While this migration is live, baselining seeds tidy-repo into any member that lacks
// it (bootstrap.md). The retire pass auto-retires it once every member has converged (zero
// on the legacy shape); with the record gone, baselining stops seeding and a later
// removal is durable. retire:'auto' — the tolerance lives entirely here (the bootstrap
// seed step keys off this migration's presence), so deleting the record disables it.
export default {
  id: 'tidy-repo-seed',
  landed: '2026-07-12',
  summary: "seed the tidy-repo pack into existing members' declarations (one-time; not backfilled after)",
  legacyPresent: async (exists, read) => {
    const raw = await read('.claudinite-checks.json');
    if (raw == null) return false; // no declaration to read — don't hold retirement on it
    try {
      const { packs } = JSON.parse(raw);
      // Entries are id strings or { id, ... } objects — compare by id.
      return Array.isArray(packs) && !packs.some((e) => (typeof e === 'string' ? e : e?.id) === 'tidy-repo');
    } catch {
      return false; // unparsable — don't block retirement
    }
  },
  retire: 'auto',
};
