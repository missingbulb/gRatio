// This pack's SessionEnd step — the second capture EVENT (skill-usage-metrics
// DESIGN §3.3). The engine's SessionEnd runner (engine/hooks/session-end-command.mjs)
// invokes every active pack's `session-end.mjs`; this one runs the same capture the
// merge-to-main step runs, with the issue the runner named (0 when it named none).
//
// WHY it earns its place: capture at merge time sees only MERGING sessions, and only
// up to the merge. This event captures the sessions that never merge — a review, an
// investigation, a session that ended in a question — and the post-merge TAIL of the
// ones that do. Both are conversation the growth lifecycle otherwise never sees.
//
// It can double-write with a merge capture, and that is safe by construction, not by
// coordination: capture keys its delta on the SESSION ID across every prior file for
// that session, so a second event for a session pushes only the entries after the
// first, and a zero delta pushes nothing at all (capture-log.mjs, pinned by tests).
//
// Best effort. Nothing depends on this having run — every firing enriches the
// record, every miss leaves exactly the merge-only behaviour. The runner swallows a
// non-zero exit, so this reports honestly rather than pretending to succeed: a repo
// with no `origin` remote, or no transcript on disk, simply exits non-zero and the
// runner logs it.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const capture = join(dirname(fileURLToPath(import.meta.url)), 'capture-log.mjs');

// The engine runner hands on what the harness told it about this session; capture's
// own discovery (CLAUDE_CODE_SESSION_ID, then the newest transcript) is the fallback
// when the hook ran without input.
const transcript = process.env.CLAUDINITE_TRANSCRIPT;
const session = process.env.CLAUDINITE_SESSION_ID;

// The issue this session was ABOUT, when its launcher knew one — the runner's
// documented pass-through (engine/hooks/session-end-command.mjs). A hook firing
// carries none and captures as issue 0; the scheduler's executor session runs the
// runner explicitly at the end of its dispatch and names that dispatch issue, so an
// unattended run's log is filed under the task it ran instead of vanishing into the
// issueless pile. Anything that is not a non-negative integer is ignored rather than
// passed on — capture's argument validation is not the place to discover a typo.
const raw = process.env.CLAUDINITE_SESSION_ISSUE ?? '';
const issue = /^\d+$/.test(raw.trim()) ? raw.trim() : '0';

const run = spawnSync(process.execPath, [
  capture, '--issue', issue,
  ...(transcript ? ['--transcript', transcript] : []),
  ...(session ? ['--session', session] : []),
], { cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(), encoding: 'utf8' });

process.stdout.write(run.stdout ?? '');
process.stderr.write(run.stderr ?? '');
process.exit(run.status ?? 1);
