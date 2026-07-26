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
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashedCron } from './hash-minute.mjs';

// The settings-hook registrations a scheduled repo carries (bootstrap Part 5).
// Ensured present without clobbering — a set-union keyed on the command string, so
// a repo's own extra hooks and any hand-added entries survive untouched.
export const REQUIRED_HOOKS = [
  { event: 'SessionStart', matcher: null, command: 'bash $CLAUDE_PROJECT_DIR/.claudinite/shared/engine/hooks/session-start-command.sh' },
  { event: 'Stop', matcher: null, command: 'node $CLAUDE_PROJECT_DIR/.claudinite/shared/engine/hooks/stop-command.mjs' },
  { event: 'PreToolUse', matcher: 'Bash', command: 'node $CLAUDE_PROJECT_DIR/.claudinite/shared/engine/hooks/pretooluse-command.mjs' },
];

export const SCHEDULER_WORKFLOW = '.github/workflows/claudinite-scheduler.yml';
export const SETTINGS_PATH = '.claude/settings.json';
export const CLAUDE_MD = 'CLAUDE.md';

// The retired corpus-index import (#385): a line importing `.claudinite/shared/CLAUDE.md`.
// The whole line (and its trailing newline) is removed wherever it appears.
const CORPUS_IMPORT_RE = /^.*@\.claudinite\/shared\/CLAUDE\.md.*\n?/m;

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

// Converge every wiring surface, returning a flat summary of what changed (empty
// when the repo was already converged). `stubText` is the vendored scheduler stub.
export function convergeWiring(root, fullName, stubText, secretNames = []) {
  const changed = [];
  if (convergeSchedulerWorkflow(root, fullName, stubText, secretNames)) changed.push(SCHEDULER_WORKFLOW);
  const hooks = ensureHooks(root);
  for (const h of hooks.added) changed.push(`hook:${h}`);
  if (removeRetiredCorpusImport(root)) changed.push(`removed retired ${CLAUDE_MD} corpus import`);
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
  const { loadConfig } = await import('../checks/helpers/repo-context.mjs');
  const secretNames = await declaredSecrets(root, loadConfig(root));
  const { changed, error } = convergeWiring(root, fullName, readFileSync(stubPath, 'utf8'), secretNames);
  if (error) console.log(`! ${error}`);
  console.log(changed.length ? `converge-wiring: ${changed.join(', ')}` : 'converge-wiring: already converged');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
