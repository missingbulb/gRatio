import { finding } from '../../engine/checks/helpers/findings.mjs';

// Validate the grow_with_claudinite pack entry's config (the loader overlays
// each entry's `config` onto packConfig). Declared-but-unconfigured is fine and
// fail-safe — capture and the growth tasks run, promotion participates, and the
// conversation nightly's retention sweep deletes nothing until the project
// states an explicit retention_days (no silent default; the adoption question
// asks for it). `promote: false` opts this repo out of the central promote
// stage while it keeps extracting and deduping locally.
const rule = {
  id: 'growth-config',
  severity: 'blocking',
  doc: 'packs/grow_with_claudinite/README.md',
  description: "The grow_with_claudinite entry's config takes only retention_days (positive integer), promote (boolean), and pack_paths (array of repo-relative pack roots)",
  why: 'a malformed retention config silently stalls the conversation retention sweep, a mistyped promote flag silently changes what leaves the repo, and a bad pack_paths silently mis-scopes the prose-to-checks sweep',

  run(ctx) {
    const cfg = ctx.config?.packConfig?.grow_with_claudinite;
    if (cfg === undefined || cfg === null) return [];
    const bad = (what, fix) => [finding(rule, { file: '.claudinite-checks.json', line: null, what: `grow_with_claudinite config: ${what}`, fix })];
    if (typeof cfg !== 'object' || Array.isArray(cfg)) {
      return bad('must be an object', 'set { "packs": [ { "id": "grow_with_claudinite", "config": { "retention_days": 10 } } ] }');
    }
    const known = new Set(['retention_days', 'promote', 'pack_paths']);
    const unknown = Object.keys(cfg).filter((k) => !known.has(k));
    if (unknown.length) {
      return bad(`unknown ${unknown.length > 1 ? 'properties' : 'property'} ${unknown.map((k) => `"${k}"`).join(', ')}`,
        'it takes only "retention_days", "promote", and "pack_paths"');
    }
    if ('retention_days' in cfg && !(Number.isInteger(cfg.retention_days) && cfg.retention_days >= 1)) {
      return bad(`retention_days must be a positive integer, got ${JSON.stringify(cfg.retention_days)}`,
        'set retention_days to a whole number of days (10 is the recommended floor)');
    }
    if ('promote' in cfg && typeof cfg.promote !== 'boolean') {
      return bad(`promote must be a boolean, got ${JSON.stringify(cfg.promote)}`,
        'set promote to false to opt this repo out of the central promote stage (absent/true = participate)');
    }
    // pack_paths — the prose-to-checks-sweep task's pack roots (repo-relative). A
    // consumer omits it (defaults to its own .claudinite/local/packs); Claudinite
    // adds its core packs/. An empty or non-string-array value is a mis-scope.
    if ('pack_paths' in cfg && !(Array.isArray(cfg.pack_paths) && cfg.pack_paths.length && cfg.pack_paths.every((p) => typeof p === 'string' && p.trim() !== ''))) {
      return bad(`pack_paths must be a non-empty array of repo-relative path strings, got ${JSON.stringify(cfg.pack_paths)}`,
        'set pack_paths to the pack roots to sweep, e.g. [".claudinite/local/packs"] (Claudinite adds "packs")');
    }
    return [];
  },
};

export default rule;
