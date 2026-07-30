// The executor's entry gate: identify the ONE dispatch this session was started
// for, and validate it in code BEFORE any model judgment (per-project-scheduling
// DESIGN §5.2). This is the CLI shell `validate-dispatch.mjs` was written to be
// driven by — it wires that pure core's `exists` / `isPackDeclared` / `loadTask`
// capabilities to this checkout and hands it the issue body.
//
// IT DOES NOT CLAIM. The claim protocol (read labels → swap ready → agent-running
// → post a claim comment → re-read, earliest claim wins) needs GitHub WRITES,
// which the executor session can only make through its MCP tools, so it stays
// agent-driven prose in executor.md. This shell only decides "is there a dispatch
// here, is it mine, and is it legal".
//
// TWO TRIGGER SOURCES, because the same `issues.labeled` webhook reaches an
// executor session by two different transports and only one of them was ever
// read here:
//
//   1. GITHUB ACTIONS writes the whole webhook payload to disk at
//      `$GITHUB_EVENT_PATH` — `action`, `label.name` and the entire `issue`
//      object, `issue.number` and `issue.body` included. Payload plus local
//      checkout is everything the validation needs, in one shot.
//   2. CLAUDE CODE ON THE WEB (CCR) delivers the same trigger as environment
//      variables instead — `CCR_TRIGGER_SOURCE`, `CCR_TRIGGER_EVENT`,
//      `CCR_TRIGGER_REPO`, `CCR_TRIGGER_ISSUE_NUMBER` — and writes no payload
//      file at all. It NAMES the issue but carries neither the label that was
//      added nor the body, so it resolves in two shots: this shell reports
//      `needs-issue` with the number, the executor fetches that one issue over
//      MCP, saves the tool's raw JSON response verbatim to a file, and
//      re-invokes with `--issue-json` for the identical validation. The shell
//      extracts body, labels, and title from the response itself — the agent
//      pastes bytes, it never hand-extracts fields — and rejects a response
//      whose `number` is not the trigger's, so fetching the wrong issue is
//      caught in code. (`--issue-body-file` + `--issue-labels` remain as the
//      manual fallback should the fetch's response shape ever surprise.)
//
// Reading only source 1 is what made every CCR-run executor session miss its own
// trigger and select an issue by listing instead — the duplicate-execution bug
// re-entered through the front door. Observed live 2026-07-28: two sessions each
// selected dispatch #772 and claimed it one second apart.
//
// ZERO NETWORK, BY CONSTRUCTION — still. The executor session is MCP-only and
// carries no repo credential of its own, so anything reaching the GitHub REST API
// here would both fail to authenticate and trip the in-session-github-access
// rule. The CCR path does not change that: this shell never fetches the issue
// itself, it tells the EXECUTOR to fetch it over MCP and hand the bytes back.
//
// EXIT CODES ARE THE INTERFACE (see EXIT below). The executor branches on the
// number, so each verdict has its own code and its own documented next step:
//
//   0  valid       — a legal dispatch for this session's scope; go claim it.
//   10 invalid     — a forged or mangled dispatch. Comment the printed `reason`,
//                    remove the ready label, add `needs-human`, end the session.
//                    It never runs.
//   11 not-mine    — the trigger label is the OTHER executor's ready label, is no
//                    ready label at all, or the issue no longer carries one (a
//                    dispatch another session has already claimed). Stop. Change
//                    nothing, comment nothing.
//   13 needs-issue — a CCR trigger named the issue but carries no body/labels.
//                    Fetch THAT issue over MCP and re-invoke with them.
//   12 no-trigger  — NO source names an issue. STOP THE SESSION. There is no
//                    fallback: never select a dispatch by listing (see below).
//   2  usage       — bad invocation (an unknown scope argument, an unreadable
//                    `--issue-body-file`).
//   1  internal    — an unexpected fault in this shell.
//
// THERE IS NO FALLBACK, BY DESIGN. Exit 12 used to send the executor off to list
// the open dispatches and take the oldest. That is precisely the
// N-sessions-racing-over-N-issues failure the one-session-one-issue rule exists to
// prevent, reached from the other direction: one scheduler run files every due
// dispatch seconds apart, so every session that cannot name its own trigger builds
// the SAME work list and races over it. A session that does not know its issue
// must run nothing — the scheduler re-arms an unrun dispatch on its next hourly
// pass, so stopping costs a delay while guessing costs duplicated work.
//
// Usage: `node <engine>/scheduler/resolve-dispatch.mjs [self|fleet]`
//                `[--issue-json <path> | --issue-body-file <path> --issue-labels <csv>]`
// The positional argument is THIS SESSION's scope — which of the two executor
// routines is running. It defaults to `self`, which is every ordinary project's
// executor; the FLEET routine must pass `fleet` explicitly, and a fleet payload
// arriving at a session that did not is reported as not-mine with that stated
// plainly. The flags carry what a CCR trigger cannot, and are ignored on the
// Actions path (whose payload already has everything).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DISPATCH_PATH_RE, dispatchFirstLine, validateDispatchBody } from './validate-dispatch.mjs';
import { parseDispatchTitle, readyLabelForScope } from './dispatch.mjs';
import { SESSION_SCOPES } from './task-contract.mjs';
import { SHARED_SUBDIR } from '../pack_loader/pack-registry.mjs';

export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  invalid: 10,
  notMine: 11,
  noTrigger: 12,
  needsIssue: 13,
};

// The executor scope a ready label implies — the exact inverse of the mapping the
// SCHEDULER files a dispatch under (`readyLabelForScope`), derived from it rather
// than restated, so the two can never drift. `null` = not a ready label at all.
export const scopeForLabel = (label) =>
  SESSION_SCOPES.find((scope) => readyLabelForScope(scope) === label) ?? null;

// Which checkout do the task paths in a dispatch body resolve against? Answered
// from where THIS engine copy is mounted, not from cwd — a consumer runs the
// vendored engine at `<root>/.claudinite/shared/engine/scheduler/`, the canon
// repo runs its own at `<root>/engine/scheduler/`. Deriving it from the module's
// own location means whichever copy the executor invoked resolves against that
// copy's own repo, with nothing to pass — and nothing for executor.md to explain.
const MOUNT_SUFFIX = sep + SHARED_SUBDIR;
export function repoRootFrom(moduleUrl) {
  const home = dirname(dirname(dirname(fileURLToPath(moduleUrl)))); // <home>/engine/scheduler/<this file>
  return home.endsWith(MOUNT_SUFFIX) ? home.slice(0, -MOUNT_SUFFIX.length) : home;
}

// Read the webhook payload the label event was started with. Every way of not
// having one collapses to a single `{ error }` — unset, unreadable, unparsable —
// because the caller's response to all of them is the same: try the other
// trigger source, and stop the session if that names no issue either.
export function readEventPayload(env = process.env, read = (p) => readFileSync(p, 'utf8')) {
  const path = env.GITHUB_EVENT_PATH;
  if (!path) return { error: 'GITHUB_EVENT_PATH is not set — this session has no event payload on disk' };
  let raw;
  try {
    raw = read(path);
  } catch (e) {
    return { error: `GITHUB_EVENT_PATH points at ${path}, which is unreadable: ${e.message}` };
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch (e) {
    return { error: `the event payload at ${path} is not valid JSON: ${e.message}` };
  }
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return { error: `the event payload at ${path} is not an event object` };
  }
  return { event };
}

// The three facts a dispatch trigger must carry. Anything short of all three
// means the payload cannot name this session's issue — not a rejection of a
// dispatch, just this source failing to identify one; the caller tries the other
// source before giving up.
export function triggerFromEvent(event) {
  const action = event.action;
  const label = event.label?.name;
  const number = event.issue?.number;
  if (action !== 'labeled') return { error: `the event payload is a "${action}" event, not a label event — it names no dispatch` };
  if (typeof label !== 'string' || label === '') return { error: 'the label event carries no label.name' };
  if (!Number.isInteger(number)) return { error: 'the label event carries no issue.number' };
  return { trigger: { source: 'payload', label, number, body: event.issue?.body ?? '', title: event.issue?.title ?? '' } };
}

// The CCR trigger: same webhook, delivered as environment variables by Claude
// Code on the web, which writes no payload file. It names the issue and nothing
// else — no `label.name`, no `issue.body` — so the trigger it yields is
// deliberately PARTIAL, and `main` turns that into the two-shot `needs-issue`
// handshake rather than guessing either missing field.
export function triggerFromCcrEnv(env = process.env) {
  const source = env.CCR_TRIGGER_SOURCE;
  const event = env.CCR_TRIGGER_EVENT;
  const raw = env.CCR_TRIGGER_ISSUE_NUMBER;
  if (!source && !event && !raw) return { error: 'no CCR_TRIGGER_* variables are set either — this session carries no CCR trigger' };
  if (source !== 'github') return { error: `CCR_TRIGGER_SOURCE is ${JSON.stringify(source ?? null)}, not "github" — this session was not started by a GitHub event` };
  if (event !== 'issues.labeled') return { error: `CCR_TRIGGER_EVENT is ${JSON.stringify(event ?? null)}, not "issues.labeled" — it names no dispatch` };
  const number = Number(raw);
  if (!raw || !Number.isInteger(number) || number <= 0) return { error: `CCR_TRIGGER_ISSUE_NUMBER is ${JSON.stringify(raw ?? null)}, which is not an issue number` };
  return { trigger: { source: 'ccr', number, repo: env.CCR_TRIGGER_REPO ?? '' } };
}

// Identify this session's ONE dispatch from whichever transport carried it.
// Order is preference, not precedence-by-truth: the Actions payload is tried
// first only because it answers in one shot, and a session that somehow has both
// gets the same issue from either. Every failure of both sources is collected
// into one reason, because the executor prints it and then stops.
export function resolveTrigger(env = process.env, read) {
  const reasons = [];
  const { event, error: payloadError } = readEventPayload(env, read);
  if (payloadError) reasons.push(payloadError);
  else {
    const { trigger, error } = triggerFromEvent(event);
    if (trigger) return { trigger };
    reasons.push(error);
  }
  const { trigger: ccr, error: ccrError } = triggerFromCcrEnv(env);
  if (ccr) return { trigger: ccr };
  reasons.push(ccrError);
  return { error: reasons.join('; ') };
}

// `[scope] [--flag value|--flag=value]`. Kept deliberately tiny — the shell takes
// one positional and two flags, and a dependency-free parser is less surface than
// the alternative.
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq !== -1) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else flags[arg.slice(2)] = argv[++i] ?? '';
  }
  return { positional, flags };
}

// Which of the issue's CURRENT labels is a ready label? On the CCR path this
// stands in for the `label.name` the trigger never carried — and it is strictly
// more informative than the event's: a dispatch another session already claimed
// no longer carries a ready label at all, so this catches the lost race here at
// step 1 rather than at the claim.
export function readyLabelAmong(labels) {
  const ready = labels.filter((l) => scopeForLabel(l) !== null);
  if (ready.length === 0) return { error: `it carries no ready label (it has: ${labels.join(', ') || 'none'}) — its dispatch has already been claimed or converged by another session` };
  if (ready.length > 1) return { error: `it carries more than one ready label (${ready.join(', ')}), so which executor owns it is ambiguous` };
  return { label: ready[0] };
}

// The CCR handshake's payload: the raw issue-fetch response, saved verbatim.
// The whole point is that the executor pastes bytes instead of hand-extracting
// fields — a body threaded through the shell mangles quoting, a hand-assembled
// labels CSV drops one. Accepts both label shapes (the MCP tools return plain
// strings, the REST API returns { name } objects), and surfaces `number` so the
// caller can assert the agent fetched the issue the trigger actually names.
export function parseIssueJson(raw) {
  let issue;
  try {
    issue = JSON.parse(raw);
  } catch (e) {
    return { error: `not valid JSON: ${e.message}` };
  }
  if (issue === null || typeof issue !== 'object' || Array.isArray(issue)) {
    return { error: 'not an issue object' };
  }
  const labels = (Array.isArray(issue.labels) ? issue.labels : [])
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter((l) => typeof l === 'string' && l !== '');
  return { issue: {
    number: Number.isInteger(issue.number) ? issue.number : null,
    body: typeof issue.body === 'string' ? issue.body : '',
    labels,
    title: typeof issue.title === 'string' ? issue.title : '',
  } };
}

// The block the executor reads. `key: value` lines, one fact per line: an agent
// quoting a field back must not have to parse prose, and a reader diffing two
// runs must see exactly what changed.
const block = (fields) => Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');

function done(code, fields, advice) {
  console.log(block(fields));
  if (advice) console.error(`resolve-dispatch: ${advice}`);
  process.exit(code);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const scopeGiven = positional.length > 0;
  const scope = positional[0] ?? 'self';
  if (!SESSION_SCOPES.includes(scope)) {
    console.error(`resolve-dispatch: unknown scope "${scope}" — usage: node resolve-dispatch.mjs [${SESSION_SCOPES.join('|')}] [--issue-json <path> | --issue-body-file <path> --issue-labels <csv>]`);
    process.exit(EXIT.usage);
  }

  const { trigger, error: triggerError } = resolveTrigger();
  if (triggerError) {
    done(EXIT.noTrigger, { dispatch: 'no-trigger', scope, reason: triggerError },
      `${triggerError}. No trigger source names an issue, so this session cannot know which dispatch it was started for. STOP: run nothing, change nothing, comment nothing, end the session. There is NO fallback — never pick an issue by listing ${readyLabelForScope(scope)}; every dispatch in that list already has its own session, and the scheduler re-arms an unrun one on its next hourly pass.`);
  }

  let { label, number, body } = trigger;
  let title = trigger.title ?? '';

  // The CCR handshake: the trigger named the issue, the executor fetched it over
  // MCP, and hands back here — as the raw response, or the manual two-flag
  // fallback — the fields the environment could not carry.
  if (trigger.source === 'ccr') {
    const jsonFile = flags['issue-json'];
    const bodyFile = flags['issue-body-file'];
    const labelsCsv = flags['issue-labels'];
    let labels;
    if (jsonFile !== undefined) {
      let raw;
      try {
        raw = readFileSync(jsonFile, 'utf8');
      } catch (e) {
        console.error(`resolve-dispatch: --issue-json ${jsonFile} is unreadable: ${e.message}`);
        process.exit(EXIT.usage);
      }
      const { issue, error } = parseIssueJson(raw);
      if (error) {
        console.error(`resolve-dispatch: --issue-json ${jsonFile} is ${error}`);
        process.exit(EXIT.usage);
      }
      if (issue.number !== null && issue.number !== number) {
        console.error(`resolve-dispatch: --issue-json carries issue #${issue.number}, but this session's trigger names #${number} — that is the wrong issue. Fetch #${number} alone and re-run.`);
        process.exit(EXIT.usage);
      }
      ({ body, title } = issue);
      labels = issue.labels;
    } else if (bodyFile !== undefined && labelsCsv !== undefined) {
      try {
        body = readFileSync(bodyFile, 'utf8');
      } catch (e) {
        console.error(`resolve-dispatch: --issue-body-file ${bodyFile} is unreadable: ${e.message}`);
        process.exit(EXIT.usage);
      }
      labels = labelsCsv.split(',').map((l) => l.trim()).filter(Boolean);
    } else {
      done(EXIT.needsIssue, { dispatch: 'needs-issue', issue: number, scope, source: 'ccr', repo: trigger.repo || '(unset)' },
        `the CCR trigger names issue #${number} but carries neither its body nor its labels. Fetch ISSUE #${number} ALONE over MCP (the issue-get tool), save the tool's raw JSON response verbatim to a file, then re-run: node <engine>/scheduler/resolve-dispatch.mjs ${scope} --issue-json <path>. Do not list, select, or touch any other issue.`);
    }
    const { label: ready, error: labelError } = readyLabelAmong(labels);
    if (labelError) {
      done(EXIT.notMine, { dispatch: 'not-mine', issue: number, scope, labels: labels.join('|') || '(none)' },
        `issue #${number}: ${labelError}. Stop: change nothing, comment nothing.`);
    }
    label = ready;
  }

  const labelScope = scopeForLabel(label);
  if (labelScope === null) {
    done(EXIT.notMine, { dispatch: 'not-mine', issue: number, scope, label },
      `issue #${number} was labeled "${label}", which is not a ready label — this is not an executor dispatch. Stop: change nothing, comment nothing.`);
  }
  if (labelScope !== scope) {
    done(EXIT.notMine, { dispatch: 'not-mine', issue: number, scope, label, labelScope },
      `issue #${number} is labeled "${label}", a ${labelScope}-scoped dispatch, but this session's scope is "${scope}"${scopeGiven ? '' : ' (the default — pass "fleet" if this IS the fleet executor)'}. It is the other executor's to run and it already has a session. Stop: change nothing, comment nothing.`);
  }

  // The checkout the dispatch's task path must resolve in. `exists` reads the
  // working tree; in an executor session that IS HEAD (a fresh checkout, nothing
  // written yet), which is what validate-dispatch means by "exists at HEAD".
  const root = process.env.CLAUDINITE_REPO_ROOT || repoRootFrom(import.meta.url);
  const { loadConfig } = await import('../checks/helpers/repo-context.mjs');
  const declared = new Set(loadConfig(root).packs);

  // `loadTask` is SYNCHRONOUS by design — it keeps validate-dispatch's core pure
  // and sync-testable — but importing an .mjs is not, so the shell prefetches the
  // module here and the capability just replays the result (or rethrows the parse
  // failure, which is exactly what the core wants to report).
  const firstLine = dispatchFirstLine(body);
  const mjsRelative = firstLine.replace(/task\.md$/, 'task.mjs');
  let loaded = null;
  let loadError = null;
  if (DISPATCH_PATH_RE.test(firstLine) && existsSync(join(root, mjsRelative))) {
    try {
      loaded = (await import(pathToFileURL(join(root, mjsRelative)).href)).default;
    } catch (e) {
      loadError = e;
    }
  }

  const verdict = validateDispatchBody(body, {
    exists: (p) => existsSync(join(root, p)),
    isPackDeclared: (id) => declared.has(id),
    loadTask: () => { if (loadError) throw loadError; return loaded; },
  });

  if (!verdict.ok) {
    done(EXIT.invalid, { dispatch: 'invalid', issue: number, scope, label, reason: verdict.reason },
      `issue #${number} is not a valid dispatch: ${verdict.reason}. It must not run — comment naming what failed, remove the "${label}" label, add "needs-human", and end the session.`);
  }

  // `brief` is the one line the executor quotes prominently in chat before it
  // acts, so a human skimming the session sees at a glance which task ran and
  // under what parameters. The slot comes from the dispatch title when the
  // trigger carried one (the Actions payload and --issue-json both do; the
  // manual two-flag fallback does not).
  const slot = parseDispatchTitle(title)?.slotId ?? null;
  done(EXIT.ok, {
    dispatch: 'valid',
    brief: `Task: ${verdict.pack}/${verdict.task}${slot ? ` (slot ${slot})` : ''} — issue #${number}, model ${verdict.resolvedModel}, outcome ceiling ${verdict.outcome}, timeout ${verdict.executionTimeout ?? 'none'}s`,
    issue: number,
    scope,
    label,
    source: trigger.source,
    taskPath: verdict.taskPath,
    pack: verdict.pack,
    task: verdict.task,
    slot: slot ?? 'unknown',
    model: verdict.model,
    resolvedModel: verdict.resolvedModel,
    outcome: verdict.outcome,
    executionTimeout: verdict.executionTimeout ?? 'none',
  });
}

// Run only when invoked directly (the executor's `node resolve-dispatch.mjs`),
// never on import — the exported helpers above are unit-testable without it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`resolve-dispatch: ${e.stack || e}`); process.exit(EXIT.internal); });
}
