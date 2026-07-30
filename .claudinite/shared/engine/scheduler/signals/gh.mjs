// The Action-side GitHub reader for the scheduler (per-project-scheduling
// DESIGN §10: engine/scheduler/ is the one place that legitimately uses the
// Action's GITHUB_TOKEN — everything session-side stays MCP-only). A minimal
// REST client over global fetch: `gh(path) -> { status, json }`, the same shape
// the fleet planner's injected reader uses, so the collectors read uniformly and
// test against a fake `gh`.
//
// `path` is an API path beginning with `/` (e.g. `/repos/owner/name/commits`);
// the base URL and auth are applied here. A non-2xx returns `{ status, json:
// null }` rather than throwing, so a 404 (no release yet, missing file) is data,
// not an error.

const API = process.env.GITHUB_API_URL || 'https://api.github.com';

export function makeGh({ token = process.env.GITHUB_TOKEN, api = API, fetchImpl = fetch } = {}) {
  // `gh(path)` reads; `gh(path, { method, body })` writes (body JSON-encoded).
  return async function gh(path, { method = 'GET', body } = {}) {
    const res = await fetchImpl(`${api}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'user-agent': 'claudinite-scheduler',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  };
}

// The timestamp of the last SUCCESSFUL run of this workflow, from the Actions run
// ledger (DESIGN §3.1) — the due-slot watermark, so there is no state file. Reads
// the workflow's own runs by file name.
//
// Returns null for EXACTLY ONE state: the ledger was read and holds no successful
// run (fresh adoption → the first-run evaluation). Anything that leaves the
// watermark unknown THROWS — this is the one read in the scheduler where the
// non-2xx-is-data convention above does not apply, because null is not "no data"
// here, it is a positive claim that this repo has never run. A rate limit, a 5xx
// or a token blip returning null would make that claim on a mature repo and
// re-fire every frequency off-anchor, silently. Failing instead costs nothing:
// a failed run never enters the success ledger, so the watermark stays put and
// the next successful run catches up every missed slot — the outage self-healing
// of DESIGN §3.1, applied to the ledger read itself (#522).
// The scheduler workflow's file name — the vendored shim's, identical in every
// member (the workflow is core, not pack content). Named here because this is the
// module that reads the workflow's own run ledger; anything else that needs to find
// those runs (the usage fold reads their logs for the task-invocation records)
// imports it rather than restating the string.
export const SCHEDULER_WORKFLOW_FILE = 'claudinite-scheduler.yml';

export async function lastSuccessTime(gh, repo, workflowFile = SCHEDULER_WORKFLOW_FILE) {
  const { status, json } = await gh(`/repos/${repo}/actions/workflows/${workflowFile}/runs?status=success&per_page=1`);
  if (status !== 200) throw new Error(`run ledger unreadable: GET workflow runs returned ${status}`);
  const run = json?.workflow_runs?.[0];
  if (!run) return null;
  const at = run.run_started_at || run.created_at;
  // A run record exists, so this repo is demonstrably not a fresh adoption —
  // saying null here would be the same wrong claim by a narrower route.
  if (!at) throw new Error('run ledger unreadable: newest successful run carries no timestamp');
  return at;
}

// The repo slug (owner/name) and default branch the workflow runs against, from
// the Actions environment. `GITHUB_REPOSITORY` is always set in a workflow;
// `GITHUB_REF_NAME` is the branch for a scheduled/dispatch run on the default branch.
export function actionRepoContext(env = process.env) {
  return {
    repo: env.GITHUB_REPOSITORY || null,
    defaultBranch: env.GITHUB_REF_NAME || 'main',
  };
}
