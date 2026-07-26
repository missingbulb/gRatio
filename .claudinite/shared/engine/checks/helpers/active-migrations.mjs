import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The synchronous migration-registry surface for the CHECK layer. It lives in
// the engine lib — not migrations/ — because pack checks consult it
// (`migrationActive` gates an in-flight transition's legacy tolerance) and a
// pack imports only its own files and the engine surface (pack-independence):
// the canon-internal migrations/ tree is never vendored, so an import into it
// would crash every vendored consumer. Self-locating relative to the engine
// root, so in a vendored consumer — where migrations/ is absent by design —
// every query answers "no active migrations": a flipped member runs the
// canonical shapes, no tolerance needed. The full registry
// (migrations/registry.mjs) builds on this same surface canon-side.
export const MIGRATIONS_SUBDIR = 'active_migrations';
// The archive of migrations past their TTL (per-project-scheduling redesign): kept
// CANON-ONLY (never vendored — a project up to speed on migrations carries few or
// none), so a dormant project still BACKFILLS from it when baselining applies
// migrations out of the fresh canon clone. `active_migrations` holds the recent
// (within-TTL) records that ship in the mount and drive check-tolerance;
// `migrations-old` holds the aged records that still APPLY but no longer tolerate.
export const MIGRATIONS_OLD_SUBDIR = 'migrations-old';
const migrationsRoot = join(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))), 'migrations'); // <canon>/engine/checks/helpers/
const specsDir = join(migrationsRoot, MIGRATIONS_SUBDIR);
const oldSpecsDir = join(migrationsRoot, MIGRATIONS_OLD_SUBDIR);
export const isSpec = (f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs');
const readSpecs = (d) => { try { return readdirSync(d).filter(isSpec).sort(); } catch { return []; } };
// Tolerant of an absent/empty folder — a vendored consumer, or a canon
// checkout after every record has retired.
export const specFiles = () => readSpecs(specsDir);
// The aged (archived) records — canon-only, so this is empty in any vendored
// consumer mount. Used by the APPLY/backfill path (registry.loadMigrations), NOT
// by check-tolerance: a migration's legacy tolerance ENDS when it ages out of
// active_migrations (all up-to-date repos converged within the TTL), while its
// apply logic persists here for a dormant project's backfill.
export const oldSpecFiles = () => readSpecs(oldSpecsDir);

// True while a migration whose file name carries `slug` is still present — a
// check consults it to know whether an in-flight transition's legacy shape is
// still tolerated. When the census auto-retires the migration (deletes the
// file), this flips to false and the tolerance vanishes with it: the resolver
// pattern, expressed synchronously (checks run synchronously and cannot await
// the async spec loader).
export function migrationActive(slug) {
  return specFiles().some((f) => f.includes(slug));
}
