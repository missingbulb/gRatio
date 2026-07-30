// Fresh-path wiring convergence (agent-preprocessing DESIGN §7, the primitive
// absorbed from #405). The deterministic half of baselining's self-refresh that
// has nothing to do with the vendored mount's CONTENT: the repo-specific wiring a
// scheduled Claudinite consumer must carry, converged idempotently in code so the
// nightly refresh never needs a model to re-enact bootstrap's prose.
//
// One source of truth: bootstrap Part 5 (the settings hooks) + Part 6 (the
// scheduler workflow) describe this same set for a fresh adoption; this module is
// what both bootstrap and baselining CALL, so the wiring can never drift between
// "how a repo is set up" and "how the nightly keeps it set up".
//
// Operates on a repo working tree at `root` with node:fs directly (like
// apply-vendor-set.mjs), returning a summary of what it changed — idempotent: a
// repo already converged produces an empty change list.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashedCron } from './hash-minute.mjs';

// The settings-hook registrations a scheduled repo carries (bootstrap Part 5).
// Ensured present without clobbering — a set-union keyed on the command string, so
// a repo's own extra hooks and any hand-added entries survive untouched.
export const REQUIRED_HOOKS = [
  { event: 'SessionStart', matcher: null, command: 'bash $CLAUDE_PROJECT_DIR/.claudinite/shared/engine/hooks/session-start-command.sh' },
  { event: 'Stop', matcher: null, command: 'node $CLAUDE_PROJECT_DIR/.claudinite/shared/engine/hooks/stop-command.mjs' },
  { event: 'PreToolUse', matcher: 'Bash', command: 'node $CLAUDE_PROJECT_DIR/.claudinite/shared/engine/hooks/pretooluse-command.mjs' },
  { event: 'SessionEnd', matcher: null, command: 'node $CLAUDE_PROJECT_DIR/.claudinite/shared/engine/hooks/session-end-command.mjs' },
];

export const SCHEDULER_WORKFLOW = '.github/workflows/claudinite-scheduler.yml';
export const SETTINGS_PATH = '.claude/settings.json';
export const CLAUDE_MD = 'CLAUDE.md';
export const CHECKS_PATH = '.claudinite-checks.json';
export const README = 'README.md';

// The pack-badge row: the marks of the packs this repo declares, on a single
// line of its README. Adopting Claudinite is what puts the row there and the nightly is
// what keeps it true — a hand-written row goes stale the day the repo declares
// its next pack, which is exactly the class of upkeep this module exists to take
// off a maintainer.
//
// Delimited by HTML comments rather than located by position, so the row can be
// re-converged in place wherever the repo has moved it, and so anything the repo
// writes AFTER the closing marker on the same line (a tagline, a build badge) is
// its own and survives untouched — which is why the CLOSING marker stays inline,
// at the end of the badges' own line.
//
// The OPENING marker gets a line to itself, and that newline is load-bearing: a
// line that BEGINS with `<!--` opens a CommonMark HTML block, and every character
// through the line carrying `-->` is then emitted as raw HTML. Put the badges
// after the opening marker on one line and a README renders the literal text
// `![basics](…)` instead of the images (#587). Breaking the line ends the HTML
// block at the marker, so the badges start a paragraph and parse as markdown.
export const BADGE_ROW_START = '<!-- claudinite:packs -->';
export const BADGE_ROW_END = '<!-- /claudinite:packs -->';
const BADGE_ROW_RE = new RegExp(`${BADGE_ROW_START}[\\s\\S]*?${BADGE_ROW_END}`);

// The retired corpus-index import (#385): a line importing `.claudinite/shared/CLAUDE.md`.
// The whole line (and its trailing newline) is removed wherever it appears.
const CORPUS_IMPORT_RE = /^.*@\.claudinite\/shared\/CLAUDE\.md.*\n?/m;

// The project's settings, loaded through the one reader that validates them.
// Dynamic and in one place: the scheduler reaches the checks helpers exactly here,
// so the cross-tree import stays a single, reviewable edge.
const repoConfig = async (root) => (await import('../checks/helpers/repo-context.mjs')).loadConfig(root);

// The repo Actions secrets its scheduled tasks declare via `required_secrets`,
// deduped and sorted. Async because task discovery is; pure otherwise.
export async function declaredSecrets(root, config) {
  const { discoverTasks } = await import('./discover.mjs');
  const { tasks } = await discoverTasks(root, config);
  return [...new Set(tasks.flatMap((t) => t.decl?.required_secrets ?? []))].sort();
}

// Stamp the declared secrets into the scheduler workflow's engine step, beside
// GITHUB_TOKEN. This is the whole delivery mechanism: GitHub Actions requires each
// secret to be named statically in the workflow, and a task's `required_secrets` is
// exactly that list — so the wiring converge writes it, and a worker then reads
// `process.env.<NAME>` like any other environment variable. No bundle, no parsing,
// no engine-side selection. Regenerated from the stub each converge, so the list
// tracks the declarations rather than accumulating.
export function withDeclaredSecrets(stubText, names = []) {
  if (!names.length) return stubText;
  const lines = names.map((n) => `          ${n}: \${{ secrets.${n} }}`).join('\n');
  return stubText.replace(/^(\s*GITHUB_TOKEN: \$\{\{ github\.token \}\})$/m, `$1\n${lines}`);
}

// Re-converge the scheduler workflow to the vendored stub, with the cron minute set
// to this repo's stable hashed value (never guessed — hash-minute.mjs, a pure
// function of the full name, so re-vendors and this convergence agree) and the
// declared `required_secrets` stamped into the engine step's env. `stubText` is the
// vendored stub's content (the caller reads it from the mount). Returns true when
// the file was written (absent, or drifted from the target).
export function convergeSchedulerWorkflow(root, fullName, stubText, secretNames = []) {
  const target = withDeclaredSecrets(stubText, secretNames)
    .replace(/cron:\s*'[^']*'/, `cron: '${hashedCron(fullName)}'`);
  const path = join(root, SCHEDULER_WORKFLOW);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === target) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, target);
  return true;
}

// Ensure the required settings hooks are present (add-if-missing, never clobber).
// Returns { added: [labels], error? }. A malformed settings file is reported, never
// overwritten (the transactional stance — surface it, don't destroy hand config).
export function ensureHooks(root) {
  const path = join(root, SETTINGS_PATH);
  let settings = {};
  if (existsSync(path)) {
    try { settings = JSON.parse(readFileSync(path, 'utf8')); }
    catch { return { added: [], error: `${SETTINGS_PATH} is not valid JSON — left untouched` }; }
  }
  settings.hooks ??= {};
  const added = [];
  for (const h of REQUIRED_HOOKS) {
    const list = (settings.hooks[h.event] ??= []);
    const present = list.some((group) =>
      (h.matcher == null || group.matcher === h.matcher)
      && (group.hooks ?? []).some((entry) => entry?.command === h.command));
    if (!present) {
      list.push({ ...(h.matcher != null ? { matcher: h.matcher } : {}), hooks: [{ type: 'command', command: h.command }] });
      added.push(`${h.event}${h.matcher ? `[${h.matcher}]` : ''}`);
    }
  }
  if (added.length) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
  }
  return { added };
}

// Remove the retired `@.claudinite/shared/CLAUDE.md` corpus-index import (#385) from
// the repo's CLAUDE.md. Returns true when a line was removed.
export function removeRetiredCorpusImport(root) {
  const path = join(root, CLAUDE_MD);
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  if (!CORPUS_IMPORT_RE.test(text)) return false;
  writeFileSync(path, text.replace(CORPUS_IMPORT_RE, ''));
  return true;
}

// Materialize the repo's say over the badge row — `"badges": { "readme": "auto" }`
// — when the file does not carry it yet. The knob is written rather than defaulted
// so it sits visibly in the file anyone would open to change it: setting `"off"`
// is how a repo tells the nightly to stop maintaining (and stop re-adding) the row.
// Returns true when the key was added. A malformed or missing settings file is
// left alone — this converge never creates or repairs settings.
export function ensureBadgeSetting(root) {
  const path = join(root, CHECKS_PATH);
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  let raw;
  try { raw = JSON.parse(text); } catch { return false; }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || raw.badges !== undefined) return false;
  writeFileSync(path, JSON.stringify({ ...raw, badges: { readme: 'auto' } }, null, 2) + '\n');
  return true;
}

// The row's entries: each declared pack (the `requires` closure included, in
// declaration order) that has a badge on disk, as { id, path } with the path
// relative to the repo root. Derived from the pack's own `dir`, so it resolves to
// `packs/<id>/…` in the canon home and `.claudinite/shared/packs/<id>/…` in a
// consumer with no branch on which repo this is. A pack whose badge is missing is
// skipped rather than reported: a repo's own local pack need not have one.
export async function badgeRowEntries(root, config) {
  const { loadPacks, resolveDeclaredPacks, packEntryId } = await import('../pack_loader/pack-registry.mjs');
  const packs = await loadPacks({ localRoot: root });
  const byId = new Map(packs.map((p) => [p.id, p]));
  const entries = [];
  for (const entry of resolveDeclaredPacks(config.packs ?? [], packs)) {
    const pack = byId.get(packEntryId(entry));
    if (!pack || typeof pack.badge !== 'string' || !pack.badge) continue;
    const path = relative(root, join(pack.dir, pack.badge)).split('\\').join('/');
    if (existsSync(join(root, path))) entries.push({ id: pack.id, path });
  }
  return entries;
}

export const renderBadgeRow = (entries) =>
  `${BADGE_ROW_START}\n${entries.map((e) => `![${e.id}](${e.path} "${e.id}")`).join(' ')}${BADGE_ROW_END}`;

// Write the row into the repo's README: replacing the delimited block where one
// exists, otherwise introducing it just under the title (a README's badges belong
// where a reader looks first) or at the very top when there is no heading.
// Returns true when the file was written. No README, or nothing to show, means
// nothing to do — this converge never creates a README.
export function convergeBadgeRow(root, entries) {
  const path = join(root, README);
  if (!existsSync(path) || !entries.length) return false;
  const text = readFileSync(path, 'utf8');
  const row = renderBadgeRow(entries);
  if (BADGE_ROW_RE.test(text)) {
    const next = text.replace(BADGE_ROW_RE, row);
    if (next === text) return false;
    writeFileSync(path, next);
    return true;
  }
  const lines = text.split('\n');
  const title = lines.findIndex((l) => l.startsWith('# '));
  const at = title === -1 ? 0 : title + 1;
  lines.splice(at, 0, ...(at === 0 ? [row, ''] : ['', row]));
  writeFileSync(path, lines.join('\n'));
  return true;
}

// Converge every wiring surface, returning a flat summary of what changed (empty
// when the repo was already converged). `stubText` is the vendored scheduler stub.
export async function convergeWiring(root, fullName, stubText, secretNames = []) {
  const changed = [];
  if (convergeSchedulerWorkflow(root, fullName, stubText, secretNames)) changed.push(SCHEDULER_WORKFLOW);
  const hooks = ensureHooks(root);
  for (const h of hooks.added) changed.push(`hook:${h}`);
  if (removeRetiredCorpusImport(root)) changed.push(`removed retired ${CLAUDE_MD} corpus import`);
  if (ensureBadgeSetting(root)) changed.push(`${CHECKS_PATH} badges`);
  const config = await repoConfig(root);
  // 'off' is the repo's answer, and it means BOTH halves: stop updating the row,
  // and stop re-adding one the repo has deleted.
  if (config.badges?.readme !== 'off' && convergeBadgeRow(root, await badgeRowEntries(root, config))) changed.push(`${README} pack row`);
  return { changed, ...(hooks.error ? { error: hooks.error } : {}) };
}

// CLI: `node converge-wiring.mjs [owner/repo]` — converge THIS repo's wiring. The
// full name comes from argv or GITHUB_REPOSITORY/CLAUDINITE_REPO; the scheduler
// stub from the vendored mount. This is the single surface bootstrap (Part 6) and
// baselining both invoke, so the wiring set is defined once, here.
async function main() {
  const fullName = process.argv[2] || process.env.GITHUB_REPOSITORY || process.env.CLAUDINITE_REPO;
  if (!fullName) { console.error('converge-wiring: need owner/repo (argv or GITHUB_REPOSITORY)'); process.exit(1); }
  const root = process.env.CLAUDINITE_REPO_ROOT || process.cwd();
  const stubPath = join(root, '.claudinite/shared/engine/scheduler/stubs/claudinite-scheduler.yml');
  if (!existsSync(stubPath)) { console.error(`converge-wiring: vendored stub not found at ${stubPath}`); process.exit(1); }
  const secretNames = await declaredSecrets(root, await repoConfig(root));
  const { changed, error } = await convergeWiring(root, fullName, readFileSync(stubPath, 'utf8'), secretNames);
  if (error) console.log(`! ${error}`);
  console.log(changed.length ? `converge-wiring: ${changed.join(', ')}` : 'converge-wiring: already converged');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
