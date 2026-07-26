// The one vendored place that computes a repo's stable scheduler cron MINUTE
// (per-project-scheduling DESIGN §3). The per-repo scheduler workflow runs hourly
// on a repo-hashed minute constrained to :10–:50 — spreading the fleet across the
// band, dodging GitHub's :00 stampede, and staying clear of the hour boundary the
// slot math anchors on.
//
// This is the minute the stub's placeholder (`cron: '10 * * * *'`) is rewritten to
// when the workflow lands in a repo: bootstrap assigns it, and baselining's
// self-refresh preserves it (the one repo-specific value in the otherwise-identical
// vendored stub). Deriving it from the full name — not storing it — means any
// session can recompute the canonical value and detect drift.
//
// Self-contained by the engine's module rule: imports nothing, so bootstrap, the
// baselining worker, and a human can load or run it standalone.

// The inclusive minute band. 41 slots (10..50) — the widest window that clears the
// :00 stampede and the hour boundary on both sides.
export const MINUTE_MIN = 10;
export const MINUTE_MAX = 50;
const BAND = MINUTE_MAX - MINUTE_MIN + 1; // 41

// FNV-1a over the lowercased full name → a minute in [MINUTE_MIN, MINUTE_MAX].
// Same hash family as routines/fleet/schedule.mjs's weekday bucket: deterministic,
// well-spread, and Math.imul keeps the multiply in 32-bit range. Keyed on the repo
// full name ("owner/repo") so the value is stable across re-vendors and re-derivable
// anywhere the name is known.
export function hashedMinute(fullName) {
  let h = 0x811c9dc5;
  const s = String(fullName).toLowerCase();
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return MINUTE_MIN + ((h >>> 0) % BAND);
}

// The full hourly cron line for a repo — what the vendored workflow's `cron:` holds.
export const hashedCron = (fullName) => `${hashedMinute(fullName)} * * * *`;

// CLI: `node hash-minute.mjs <owner/repo>` prints the minute (bootstrap / baselining
// use this to stamp or verify the workflow's cron without re-implementing the hash).
if (import.meta.url === `file://${process.argv[1]}`) {
  const fullName = process.argv[2];
  if (!fullName) {
    process.stderr.write('usage: node hash-minute.mjs <owner/repo>\n');
    process.exit(2);
  }
  process.stdout.write(`${hashedMinute(fullName)}\n`);
}
