// baselining worker — the DETERMINISTIC self-refresh, as agent_preprocessing
// (agent-preprocessing DESIGN §7, E4). This is `agent_model: 'sonnet'` with
// `agent_preprocessing: 'node worker.mjs'`, so the scheduler runs THIS FILE as a
// subprocess (cwd = this task dir) bounded by `agent_preprocessing_timeout`,
// BEFORE any agent. It absorbs everything about the nightly refresh that is
// dependency-free code — so most nights are AGENTLESS and quiet, and an agent is
// requested only when real judgment is left (owner decision, 2026-07-23):
//
//   agent requested  ⇔  a pending AGENTIC migration note exists
//                    OR  the converge changed things AND check_the_world is not green.
//   no change, or changed-but-green with no agentic note  →  agentless night.
//
// What it does, Action-side, over the one sanctioned non-MCP surface (the Action
// GITHUB_TOKEN in env) and a direct PUBLIC canon fetch (owner §10: canon is
// public — no token, no tarball channel):
//   1. shallow-clone canon at its head sha (then drop .git → a rootless tree, so
//      apply-vendor-set skips the ancestry guards that a shallow clone can't
//      satisfy — it is head by construction);
//   2. run the CLONED canon's vendoring/apply-vendor-set.mjs to converge
//      .claudinite/shared/ and stamp it (compute+apply, one snapshot);
//   3. run the cloned converge-wiring.mjs (scheduler workflow + hashed cron + the
//      tasks' declared required_secrets, settings hooks, retired-import removal),
//      and ask the owner for any declared secret the repo hasn't configured;
//   4. apply the MECHANICAL migration notes (aliases/materialize/rewrite) via the
//      cloned migrations/apply.mjs — idempotent;
//   5. detect pending AGENTIC notes (registry.mjs `agenticMigrations`, gated on
//      the prior stamp day, same-day inclusive #330) and, if any, HOLD the stamp
//      at the day before the earliest one so the agent still sees the note (the
//      stamp/agentic coupling rule);
//   6. deliver the converge as ONE commit on the per-cycle maintenance branch via
//      NATIVE git (find the family's open PR by head-branch prefix and reuse it,
//      else mint a dated branch and open the PR), arming auto-merge per the
//      member's `maintenance.delivery` and DISPATCHING the repo's PR CI on the
//      branch — the GITHUB_TOKEN push emits no pull_request run of its own
//      (#565), so the checks the arm waits on must be started explicitly;
//   7. request the agent (write CLAUDINITE_REQUEST_AGENT) only when judgment is
//      left — the scheduler files `ready-for-agent` iff this file appears (§3,
//      conditional handoff). NO code→agent data channel: the file is a pure
//      control signal; the agent discovers its work by reading the repo (the
//      pushed branch, the held stamp, the pending note).
//
// Self-contained — imports only node builtins statically (the pack-independence
// barrier forbids reaching into the engine). The vendoring/migrations machinery
// is canon-internal (vendoring/ is never vendored, #385), so the worker INVOKES
// the freshly-fetched canon's scripts as subprocesses and DYNAMIC-imports its
// registry from the temp clone path — never a static import of engine code.
//
// This SUPERSEDES the per-cycle maintenance-branch naming of PR #407 (that PR
// reworked the OLD fleet-apply MCP path; baselining's delivery is native git
// Action-side and carries its own prefix/find-by-prefix here).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const CANON_URL = 'https://github.com/missingbulb/Claudinite.git'; // public — no token
const MAINT_PREFIX = 'claudinite/maintenance';
const API = 'https://api.github.com';

// --- pure helpers (exported, unit-tested git-free) --------------------------

// The member's delivery preference, normalized. `push`/`auto` → auto-merge and
// `pr` → review are the permanent legacy aliases (same tolerance as fleet-apply);
// anything else is invalid (null) and fails the run rather than guessing.
export function normalizeDelivery(raw) {
  const v = String(raw ?? '').trim();
  if (v === 'auto-merge' || v === 'auto' || v === 'push') return 'auto-merge';
  if (v === 'review' || v === 'pr') return 'review';
  return null;
}

// The default a repo gets when it never declared one.
export const DEFAULT_DELIVERY = 'auto-merge';

// `maintenance.delivery` is always EXPLICIT — but a key that is simply absent is
// DRIFT, not an error, and drift is what a converge exists to repair. A repo
// adopted before the key existed, or one whose key was hand-removed, would
// otherwise fail baselining every night forever with nothing that could ever fix
// it (the only writer is check_the_world --init, which runs once at adoption).
// So: materialize the default into .claudinite-checks.json and carry on — it
// rides the same maintenance commit as the rest of the converge, and the repo
// self-heals on one cycle.
//
// An UNRECOGNIZED value is a different thing entirely: someone wrote an intent
// the worker cannot honour, and silently substituting a default would deliver
// the opposite of what they asked for. That still fails the run (delivery: null).
//
// Returns { delivery, materialize } — `delivery` null only for the unrecognized
// case. A content-free value (empty/whitespace) carries no intent, so it is
// treated as absent rather than as a typo.
export function resolveDelivery(raw) {
  if (raw == null || String(raw).trim() === '') {
    return { delivery: DEFAULT_DELIVERY, materialize: true };
  }
  return { delivery: normalizeDelivery(raw), materialize: false };
}

// The pending AGENTIC notes: those dated on/after the DAY of the prior stamp
// (same-day inclusive, #330), oldest first. `agenticList` is registry.mjs
// `agenticMigrations(all)` — already filtered to records carrying a valid
// `agentic` note (a malformed note throws THERE, aborting the run loudly).
export function pendingAgentic(agenticList, priorUpdated) {
  const priorDay = String(priorUpdated ?? '').slice(0, 10);
  return [...(agenticList ?? [])]
    .filter((m) => !priorDay || String(m.landed) >= priorDay)
    .sort((a, b) => String(a.landed).localeCompare(String(b.landed)));
}

// HOLD the stamp at the day before the earliest pending agentic note (the
// stamp/agentic coupling rule): the note stays selected next run until the agent
// lands it and advances the stamp itself. Returns the held ISO datetime, or null
// when nothing is pending (the stamp advances normally).
export function heldStamp(pending) {
  if (!pending?.length) return null;
  const d = new Date(`${String(pending[0].landed).slice(0, 10)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString();
}

// A per-cycle maintenance branch name — dated + a short seed so each cycle gets a
// distinct branch (superseding #407's scheme, native-git side). `seed` is passed
// in so this is pure; main() generates it.
export function maintenanceBranchName(dateStr, seed) {
  return `${MAINT_PREFIX}-${dateStr}-${seed}`;
}

// The family's open maintenance PR, found by head-branch PREFIX (idempotency is
// by prefix now that the name carries a per-cycle seed): a run reuses that PR so
// they never pile up night-over-night. null → mint a fresh one. The whole PR is
// returned, not just its ref, because the reuse path needs its `node_id` to
// re-assert the auto-merge arm each cycle.
export function openMaintenancePull(pulls, prefix = MAINT_PREFIX) {
  return (pulls ?? []).find((pr) => String(pr?.head?.ref ?? '').startsWith(prefix)) ?? null;
}

// Its head branch alone — the shape most callers want.
export function openMaintenanceBranch(pulls, prefix = MAINT_PREFIX) {
  return openMaintenancePull(pulls, prefix)?.head?.ref ?? null;
}

// The escalation predicate (owner, 2026-07-23): agent iff a pending agentic note,
// or a real change the deterministic converge left non-green. No change, or a
// green change with no agentic note, stays agentless.
export function shouldRequestAgent({ pendingCount, meaningfulChange, checksPass }) {
  if (pendingCount > 0) return true;
  return Boolean(meaningfulChange) && !checksPass;
}

// The scheduler hands the worker a path to signal the agent through; writing it
// requests the agent stage (run.mjs files `ready-for-agent` iff it appears).
export const AGENT_REQUEST_MARKER = 'agent-requested';

// --- CI dispatch on the maintenance PR (#565) --------------------------------
// The branch push and the PR open in deliver() both ride the Action's
// GITHUB_TOKEN, and GitHub suppresses workflow runs for events that token
// authors (its recursion guard) — so the maintenance PR gets NO pull_request
// run, auto-merge arms against a green that never arrives, and the PR sits open
// forever (#565; the canon-only variant was #432). The guard's one documented
// exception is workflow_dispatch: a dispatch POSTed with GITHUB_TOKEN does start
// a run, the run's check runs land on the branch-head sha, and that sha is what
// the PR's merge gate reads. So deliver() starts the PR's checks itself:
// dispatch every workflow that WOULD have run on pull_request and CAN be
// dispatched.
//
// Reading the triggers is a best-effort TEXTUAL scan of a workflow's top-level
// `on:` block (the worker is dependency-free — no YAML parser). It covers the
// shapes workflows actually use: a block map of trigger keys (with or without
// nested config), the inline scalar, and the inline list.
export function workflowTriggers(yaml) {
  const lines = String(yaml ?? '').split('\n');
  const onAt = lines.findIndex((l) => /^(['"]?)on\1\s*:/.test(l));
  if (onAt === -1) return [];
  const inline = lines[onAt].replace(/^(['"]?)on\1\s*:/, '').replace(/#.*$/, '').trim();
  if (inline) return inline.replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  const triggers = [];
  let childIndent = null;
  for (let i = onAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;                        // next top-level key — on: is done
    childIndent = childIndent ?? indent;            // first child fixes the trigger level
    if (indent !== childIndent) continue;           // nested config under a trigger
    const m = /^([A-Za-z_]+)\s*:/.exec(line.trim());
    if (m) triggers.push(m[1]);
  }
  return triggers;
}

// The dispatch plan over the repo's workflow files ({name, content} each):
// `dispatch` — runs on pull_request AND carries workflow_dispatch (start these);
// `missing`  — runs on pull_request but CANNOT be dispatched (name these in the
// log: adding `workflow_dispatch:` to that file's `on:` is the owner's one-line
// fix, and silence here would read as "no CI expected" when CI was expected).
// A workflow with no pull_request trigger is never touched — dispatchable-but-
// unrelated workflows (a release orchestrator, say) must not fire nightly.
export function ciDispatchPlan(files) {
  const dispatch = [];
  const missing = [];
  for (const { name, content } of files ?? []) {
    const triggers = workflowTriggers(content);
    if (!triggers.includes('pull_request')) continue;
    (triggers.includes('workflow_dispatch') ? dispatch : missing).push(name);
  }
  return { dispatch, missing };
}

// --- I/O shell (validated by the live pilot, not unit tests) ----------------

const git = (args, opts = {}) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const node = (args, extraEnv = {}) =>
  execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });

async function gh(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

// Run check_the_world against the converged repo; true when it exits clean (no
// blocking findings). Any non-zero exit / throw means "not green" → judgment left.
function checkTheWorldPasses(root) {
  const cw = join(root, '.claudinite/shared/engine/checks/check_the_world.mjs');
  if (!existsSync(cw)) return true; // no vendored checks to gate on
  try { node([cw], { CLAUDE_PROJECT_DIR: root }); return true; }
  catch { return false; }
}

// Why the PR-open POST must be status-checked, as a pure predicate: null when
// the PR was created, else the message to fail on.
//
// This is the one call whose silent failure is invisible AND self-perpetuating.
// `openMaintenancePull` reuses by OPEN PR, so a cycle that pushes its branch but
// fails to open the PR mints a FRESH branch next cycle, and the next — branches
// pile up nightly, the stamp never advances, and the run still reports `ok`
// because nothing read the status. The fleet ran exactly that way for two days:
// every consumer but the pilot sat on the same canon ref carrying 07-29 and
// 07-30 maintenance branches with no PR behind either.
//
// The usual cause is repo-level and invisible from here — "Allow GitHub Actions
// to create and approve pull requests" is off and the POST 403s — so the message
// names that remedy rather than leaving a bare status code.
export function pullCreateError(status, json) {
  if (status === 201 && json?.number) return null;
  const detail = json?.message ?? `HTTP ${status}`;
  return `${detail} — if this is the Actions PR permission, enable Settings → Actions`
    + ' → General → "Allow GitHub Actions to create and approve pull requests"';
}

// How an `auto-merge` member's PR actually lands, given whether this repo has any
// pull_request-triggered workflow at all.
//
// GitHub's auto-merge is a QUEUE FOR CHECKS. On a repo with no PR CI there is
// nothing to queue behind: the mutation is rejected ("Pull request is in clean
// status"), and since the failure was swallowed the PR sat open forever — the
// stamp never advanced, the next cycle reused the same PR, and a repo that asked
// for `auto-merge` got no merge at all. Seven of twelve consumers are in exactly
// that shape (no `pull_request` trigger anywhere in .github/workflows).
//
// So: no CI to wait for → MERGE IT, which is what `auto-merge` meant all along.
// CI present → arm, and let the checks gate it as designed.
//
// `hasPrCi` comes from ciDispatchPlan over the branch's own workflow files —
// `dispatch` (startable) plus `missing` (PR-triggered but not dispatchable). Both
// empty means no workflow anywhere runs on a pull_request, so no check will ever
// appear. That is a fact about the tree, not a race against checks registering.
export function deliveryAction({ delivery, hasPrCi }) {
  if (delivery !== 'auto-merge') return 'none';
  return hasPrCi ? 'arm' : 'merge';
}

// Deliver the converge as one commit on the per-cycle maintenance branch, native
// git. Reuses the family's open PR (by prefix) or mints a dated branch + PR;
// arms auto-merge when the member asked for it. Force-push is the regenerate-not-
// reconcile stance for this bot-owned branch.
async function deliver(root, repo, base, token, delivery, seed) {
  const { json: pulls } = await gh(token, `/repos/${repo}/pulls?state=open&per_page=100`);
  let pr = openMaintenancePull(Array.isArray(pulls) ? pulls : []);
  const reuse = Boolean(pr);
  let branch = reuse ? pr.head.ref : maintenanceBranchName(new Date().toISOString().slice(0, 10), seed);

  git(['-C', root, 'checkout', '-B', branch]);
  git(['-C', root, 'add', '-A']);
  git(['-C', root, '-c', 'user.name=claudinite[bot]', '-c', 'user.email=claudinite@users.noreply.github.com',
    'commit', '-m', 'Claudinite maintenance: converge vendored mount, wiring, and migration notes']);
  const remote = `https://x-access-token:${token}@github.com/${repo}.git`;
  git(['-C', root, 'push', '--force', remote, `HEAD:refs/heads/${branch}`]);

  if (!reuse) {
    const body = delivery === 'auto-merge'
      ? 'Automated Claudinite maintenance (deterministic converge + any migration notes). Regenerated each cycle; auto-merges once this repo\'s checks pass.'
      : 'Automated Claudinite maintenance (deterministic converge + any migration notes). Regenerated each cycle; left for your review.';
    const created = await gh(token, `/repos/${repo}/pulls`, {
      method: 'POST', body: { head: branch, base, title: 'Claudinite maintenance', body },
    });
    const failure = pullCreateError(created.status, created.json);
    if (failure) throw new Error(`could not open the maintenance PR for ${branch}: ${failure}`);
    pr = created.json;
  }

  // ARM GitHub's native auto-merge (not an immediate merge): the PR lands
  // automatically once this repo's required checks pass, and the run never blocks
  // on CI. Auto-merge is a GraphQL-only mutation.
  //
  // RE-ASSERTED EVERY CYCLE, reuse or not. The arm is best-effort, and there are
  // three ordinary ways for it to be absent from an open maintenance PR: the
  // mutation failed when the PR was opened; the repo had not enabled auto-merge
  // yet (a settings change nothing here can see); or the member flipped
  // `maintenance.delivery` from `review` to `auto-merge` while this PR was
  // already open. Arming only on the opening cycle left all three unrecoverable —
  // every later run reuses the branch and never retried, so the PR sat open
  // forever. The stable-PR form this superseded re-asserted the arm on every run;
  // this restores that. Idempotent: arming an already-armed PR is a no-op.
  // Start the PR's checks FIRST — the GITHUB_TOKEN push/open above emitted no
  // pull_request event, so without this the PR has no runs (#565, the
  // ciDispatchPlan block). AFTER the push, so the dispatched runs execute the
  // branch's own head; every delivering cycle, since a force-push emits no
  // synchronize event either and each new head needs its own runs. Best-effort:
  // a dispatch failure must not fail the converge that was already pushed.
  //
  // It runs BEFORE the delivery decision because it is what establishes whether
  // this repo has any PR CI at all — the fact deliveryAction turns on.
  const ci = await dispatchCiRuns(token, repo, branch)
    .catch((e) => { console.log(`baselining: CI dispatch on ${branch} failed: ${e.message}`); return null; });
  const hasPrCi = ci ? ci.dispatch.length + ci.missing.length > 0 : true; // unknown → assume CI, never merge blind

  if (pr?.number) {
    const action = deliveryAction({ delivery, hasPrCi });
    if (action === 'merge') {
      const res = await gh(token, `/repos/${repo}/pulls/${pr.number}/merge`, {
        method: 'PUT', body: { merge_method: 'squash' },
      });
      if (res.status === 200) console.log(`baselining: merged PR #${pr.number} directly — this repo has no pull_request CI to gate on`);
      else console.log(`baselining: could not merge PR #${pr.number} (${res.status}: ${res.json?.message ?? 'no message'})`);
    } else if (action === 'arm' && pr.node_id) {
      // Surfaced, not swallowed: a failed arm is why a maintenance PR sits open
      // forever, and the two usual causes are both fixable repo settings.
      await enableAutoMerge(token, pr.node_id)
        .catch((e) => console.log(`baselining: could not arm auto-merge on PR #${pr.number}: ${e.message}`
          + ' — check Settings → General → "Allow auto-merge"'));
    }
  }
  return branch;
}

// The I/O half of the CI dispatch (#565): read the workflow files as they exist
// ON THE MAINTENANCE BRANCH (the converge may itself have changed them), plan
// with ciDispatchPlan, POST a dispatch per selected workflow, and log every
// outcome — a silent no-checks PR is exactly the failure mode this exists to
// close. Needs the scheduler workflow's `actions: write` (a read-only token
// 403s the POST silently — the store-release lesson).
async function dispatchCiRuns(token, repo, branch) {
  const ref = encodeURIComponent(branch);
  const { json: dir } = await gh(token, `/repos/${repo}/contents/.github/workflows?ref=${ref}`);
  const files = [];
  for (const entry of Array.isArray(dir) ? dir : []) {
    if (!/\.ya?ml$/.test(entry.name ?? '')) continue;
    const { json } = await gh(token, `/repos/${repo}/contents/.github/workflows/${entry.name}?ref=${ref}`);
    files.push({ name: entry.name, content: json?.content ? Buffer.from(json.content, 'base64').toString('utf8') : '' });
  }
  const { dispatch, missing } = ciDispatchPlan(files);
  for (const name of missing) {
    console.log(`baselining: ${name} runs on pull_request but has no workflow_dispatch trigger — `
      + 'cannot start it on the maintenance PR; add `workflow_dispatch:` under its `on:` to let baselining run it');
  }
  if (!dispatch.length && !missing.length) {
    console.log('baselining: no pull_request-triggered workflow — the maintenance PR has no checks to wait for');
  }
  for (const name of dispatch) {
    const res = await gh(token, `/repos/${repo}/actions/workflows/${name}/dispatches`, {
      method: 'POST', body: { ref: branch },
    });
    if (res.status === 204) console.log(`baselining: dispatched ${name} on ${branch} — the maintenance PR gets its checks`);
    else console.log(`baselining: could not dispatch ${name} on ${branch} (${res.status})`);
  }
  return { dispatch, missing };
}

// Ask the owner to add a repo Actions secret a task declares in `required_secrets`
// but the repo has not configured. The wiring converge stamps every declared name
// into the scheduler workflow, so by the time this runs the value is either in the
// environment or genuinely unset — no separate probe needed.
//
// This is the adoption interview's posture, not a gate: nothing fails, no check
// fires, and the task that needs the secret simply doesn't work until someone adds
// it. One open issue per repo (matched by exact title) so an unconfigured secret
// costs one issue, not one per night. Exported for the tests.
export const SECRETS_ISSUE_TITLE = 'Claudinite: configure required Actions secrets';

export function unconfiguredSecrets(declared, env) {
  return (declared ?? []).filter((name) => !env[name]);
}

async function askForSecrets(token, repo, names) {
  const q = encodeURIComponent(`repo:${repo} in:title "${SECRETS_ISSUE_TITLE}" state:open`);
  const { json } = await gh(token, `/search/issues?q=${q}&per_page=10`);
  if ((json?.items ?? []).some((i) => (i.title ?? '').trim() === SECRETS_ISSUE_TITLE)) return false;
  const body = [
    'A scheduled task in this repo declares a repo **Actions secret** that is not configured yet.',
    'Until it is, that task cannot do its work — everything else keeps running normally.',
    '',
    ...names.map((n) => `- \`${n}\``),
    '',
    `Add each one at https://github.com/${repo}/settings/secrets/actions, then close this issue.`,
  ].join('\n');
  await gh(token, `/repos/${repo}/issues`, { method: 'POST', body: { title: SECRETS_ISSUE_TITLE, body } });
  return true;
}

// Arm native auto-merge on a PR (by node id) via the GraphQL mutation — the REST
// `PUT /merge` would merge NOW, ignoring pending checks; this waits for them.
async function enableAutoMerge(token, pullRequestId) {
  const query = 'mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH}){pullRequest{id}}}';
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { id: pullRequestId } }),
  });
  const json = await res.json().catch(() => null);
  if (json?.errors?.length) throw new Error(json.errors[0].message);
}

export async function main() {
  const root = process.env.CLAUDINITE_REPO_ROOT || process.cwd();
  const repo = process.env.CLAUDINITE_REPO || process.env.GITHUB_REPOSITORY;
  const base = process.env.CLAUDINITE_DEFAULT_BRANCH || 'main';
  const token = process.env.GITHUB_TOKEN;
  const requestFile = process.env.CLAUDINITE_REQUEST_AGENT;
  if (!repo) { console.error('baselining: no repo (CLAUDINITE_REPO/GITHUB_REPOSITORY)'); process.exit(1); }
  if (!token) { console.error('baselining: no GITHUB_TOKEN in env'); process.exit(1); }

  const checksPath = join(root, '.claudinite-checks.json');
  if (!existsSync(checksPath)) { console.log('baselining: no .claudinite-checks.json — nothing to self-refresh'); return; }
  const priorRaw = JSON.parse(readFileSync(checksPath, 'utf8'));
  const priorStamp = priorRaw.claudinite ?? {};
  if (!priorStamp.updated && !priorStamp.ref) {
    console.log('baselining: no vendored-mount stamp — nothing to self-refresh (canon home or pre-adoption)');
    return; // quiet, no agent (matches the precondition self-skip)
  }
  const { delivery, materialize } = resolveDelivery(priorRaw?.maintenance?.delivery);
  if (!delivery) {
    console.error(`baselining: maintenance.delivery "${priorRaw?.maintenance?.delivery}" is neither auto-merge nor review`);
    process.exit(1);
  }
  // Materialize the missing key BEFORE the converge, so the repair rides this
  // cycle's maintenance commit like any other converged surface.
  if (materialize) {
    priorRaw.maintenance = { ...priorRaw.maintenance, delivery };
    writeFileSync(checksPath, JSON.stringify(priorRaw, null, 2) + '\n');
    console.log(`baselining: maintenance.delivery was missing — materialized "${delivery}"`);
  }

  // 1. Fetch canon at head as a ROOTLESS tree (drop .git so apply-vendor-set's
  //    ancestry guards skip — a shallow clone can't answer them, and it is head
  //    by construction).
  const tmp = mkdtempSync(join(tmpdir(), 'claudinite-canon-'));
  git(['clone', '--depth', '1', CANON_URL, tmp]);
  const headSha = git(['-C', tmp, 'rev-parse', 'HEAD']).trim();
  rmSync(join(tmp, '.git'), { recursive: true, force: true });

  // 2-4. Deterministic converge: mount + stamp, then wiring, then mechanical notes.
  node([join(tmp, 'vendoring/apply-vendor-set.mjs'), '--target', root, '--ref', headSha]);
  const wiringOut = node([join(tmp, 'engine/scheduler/converge-wiring.mjs'), repo], { CLAUDINITE_REPO_ROOT: root });
  node([join(tmp, 'migrations/apply.mjs')], { CLAUDE_PROJECT_DIR: root });

  // Ask about any declared secret the repo hasn't configured — but only once the
  // wiring is settled. On the cycle that FIRST stamps a name into the workflow the
  // value cannot be in this process's env yet, so asking then would nag about a
  // secret the owner may well have already added; next cycle tells the truth.
  const { declaredSecrets } = await import(pathToFileURL(join(tmp, 'engine/scheduler/converge-wiring.mjs')).href);
  const missingSecrets = wiringOut.includes('.github/workflows/claudinite-scheduler.yml')
    ? []
    : unconfiguredSecrets(await declaredSecrets(root, JSON.parse(readFileSync(checksPath, 'utf8'))), process.env);
  if (missingSecrets.length && await askForSecrets(token, repo, missingSecrets)) {
    console.log(`baselining: asked the owner to configure ${missingSecrets.join(', ')}`);
  }

  // 5. Pending agentic notes (from the fresh canon clone) + stamp hold.
  const { loadMigrations, agenticMigrations } = await import(pathToFileURL(join(tmp, 'migrations/registry.mjs')).href);
  const pending = pendingAgentic(agenticMigrations(await loadMigrations()), priorStamp.updated);
  if (pending.length) {
    const raw = JSON.parse(readFileSync(checksPath, 'utf8'));
    raw.claudinite = { ...raw.claudinite, updated: heldStamp(pending) };
    writeFileSync(checksPath, JSON.stringify(raw, null, 2) + '\n');
  }

  // 6. Meaningful change? A stamp-only bump against an unchanged head is not one —
  //    revert it and stay quiet (no nightly stamp-only noise).
  const changed = git(['-C', root, 'status', '--porcelain'])
    .split('\n').map((l) => l.slice(3)).filter(Boolean);
  // `materialize` excluded: a materialized delivery key also touches only
  // .claudinite-checks.json, and reverting it would re-drift the repo every night
  // and never land the repair.
  const onlyStamp = changed.length > 0 && !materialize && changed.every((p) => p === '.claudinite-checks.json');
  if (onlyStamp && priorStamp.ref === headSha && !pending.length) {
    git(['-C', root, 'checkout', '--', '.claudinite-checks.json']);
    console.log('baselining: mount already at canon head, nothing changed — agentless, quiet');
    return;
  }
  const meaningfulChange = changed.length > 0;

  // 7. Escalation gate: run the conformance checks only when a change happened and
  //    no agentic note already forces the agent.
  const checksPass = (meaningfulChange && !pending.length) ? checkTheWorldPasses(root) : true;
  const requestAgent = shouldRequestAgent({ pendingCount: pending.length, meaningfulChange, checksPass });

  // 8. Deliver the converge (only when there's something to land).
  if (meaningfulChange || pending.length) {
    const seed = Math.random().toString(36).slice(2, 8);
    const branch = await deliver(root, repo, base, token, delivery, seed);
    console.log(`baselining: delivered converge on ${branch} (${delivery})`);
  } else {
    console.log('baselining: no change to deliver');
  }

  // 9. Request the agent only when judgment is left (conditional handoff, §3).
  if (requestAgent && requestFile) writeFileSync(requestFile, `${AGENT_REQUEST_MARKER}\n`);
  console.log(requestAgent
    ? `baselining: requested agent stage (${pending.length ? `${pending.length} agentic note(s)` : 'conformance not green'})`
    : 'baselining: agentless night — deterministic converge delivered, no agent needed');
}

// Run only when invoked directly (the scheduler's `node worker.mjs`), never on
// import — a test imports the pure helpers without any git or network.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`baselining preprocessing failed: ${e.message}`); process.exit(1); });
}
