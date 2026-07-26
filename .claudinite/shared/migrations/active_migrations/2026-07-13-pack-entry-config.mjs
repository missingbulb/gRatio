// Per-pack parameters moved from the top-level `packConfig` key onto each pack's
// `packs` entry as `config` (#278). The write side is bootstrap step 4d (the fold
// snippet baselining re-runs on every member), not this record — like the pack
// seeds, this record is the transition's TELEMETRY: legacyPresent reads a member's
// declaration and reports it still on the old shape while a top-level `packConfig`
// key remains, so the retire pass shows fleet-wide convergence.
//
// retire:'manual' — the read-side tolerance lives INLINE, not resolver-driven:
// loadConfig still accepts the key (CONFIG_KEYS) and overlays it under the entry
// view (engine/checks/helpers/repo-context.mjs), and the fleet census's config reader falls back
// to it. Deleting this record alone would strand those. When the retire pass
// reports zero repos on the legacy shape, drop it all in one deliberate change:
// this record, bootstrap step 4d, 'packConfig' from CONFIG_KEYS + the overlay
// (a straggler then gets the blocking unknown-setting error, the settings-validity
// gate becoming the enforcement), and the census fallback.
export default {
  id: 'pack-entry-config',
  landed: '2026-07-13',
  summary: "per-pack parameters moved from the top-level packConfig key onto each pack's packs entry as config (one-time fold; key stays readable until retirement)",
  legacyPresent: async (exists, read) => {
    const raw = await read('.claudinite-checks.json');
    if (raw == null) return false; // no declaration to read — don't hold retirement on it
    try {
      const parsed = JSON.parse(raw);
      return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'packConfig' in parsed;
    } catch {
      return false; // unparsable — don't block retirement
    }
  },
  retire: 'manual',
};
