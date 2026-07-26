// Enable a repo's own local packs (.claudinite/local_packs/ — tracked project
// prose/checks/skills/run_daily the engine runs alongside the canon). Two pieces
// of member-side plumbing must be in place before a repo can safely COMMIT local
// packs, and BOTH ride baselining (not this record):
//   1. the tracked sync hook must preserve local_packs/ across its dir swap —
//      baselining refreshes the member's tracked mount/sync-claudinite.sh from the
//      canon every run (the canon copy carries the preserve block); and
//   2. .gitignore must re-include .claudinite/local_packs/ — bootstrap.md step 3
//      (idempotent, re-applied by baselining) appends the negation.
// The canon commit that ships those touches mount/ and bootstrap.md, so
// canonChanged fires fleet-wide and baselining converges every member the first
// night after — no per-repo content is materialized here (a project AUTHORS its
// own local packs; the move of existing capture is a judgment task carried by the
// project-instructions and growth-extract skills, never a mechanical alias).
//
// This record is therefore TELEMETRY ONLY: the retire pass reports how many
// members still carry the pre-enablement hook, so the owner can see when the whole
// fleet is safe to author local packs in. `legacyPresent` reads the member's
// tracked hook and returns true while it lacks the local_packs preserve block.
//
// retire: 'manual' — the enablement lives in baselining + bootstrap, not here, so
// this record holds no tolerance to strand; retire it by hand once the retire pass
// reports zero members on the legacy shape.
export default {
  id: 'local-packs-enablement',
  landed: '2026-07-15',
  summary: 'members preserve + track .claudinite/local_packs/ (sync-hook preserve via baselining, gitignore via bootstrap)',
  legacyPresent: async (exists, read) => {
    const hook = await read('.claudinite/mount/sync-claudinite.sh');
    if (hook == null) return false; // pre-mount shape — the mount-folder migration tracks that, not this
    // Converged once the tracked hook carries the preserve block for local_packs.
    return !hook.includes('$dest/local_packs');
  },
  retire: 'manual',
};
