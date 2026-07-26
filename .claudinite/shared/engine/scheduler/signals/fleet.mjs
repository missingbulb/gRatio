// The `fleet` signal reader (per-project-scheduling DESIGN §3.3) — the members
// aggregate the CANON repo's fleet-scoped tasks (growth-promote,
// growth-discover-packs, migrations-retire) decide from. A consumer cannot
// declare `fleet`; only the canon repo's scheduler builds it, over the fleet PAT
// (`FLEET_GITHUB_TOKEN` — the census's existing credential, the one token that
// can enumerate every repo the owner owns; the Action's default GITHUB_TOKEN sees
// only this repo). run.mjs invokes this ONLY when a due task declares `fleet`, so
// an ordinary night pays nothing for the fleet enumeration.
//
// Pure over an injected `fleetGh` (the same `gh(path) -> { status, json }` shape
// the other collectors take), so the whole reader tests against a fake `gh` with
// no live GitHub — exactly like signals/index.mjs. The one place the real
// FLEET_GITHUB_TOKEN is read is `makeFleetGh`, at the I/O edge.
//
// This deliberately ports routines/fleet/signals.mjs's per-member probes (the
// `fleetMembers` bundle the old central planner stamped on the home repo) into
// the per-repo scheduler, adapted for the `local/packs` rename (both roots
// accepted through the migration) and carrying each member's provenance stamp so
// the retire guard can read per-repo apply evidence.

import { makeGh } from './gh.mjs';
import { packEntryId } from '../../pack_loader/pack-registry.mjs';

// Local-pack roots, canonical first — a window commit touching either is a local
// -pack change (promote's trigger). Both are live until the Phase 4 cleanup drops
// the legacy dual root.
const LOCAL_ROOTS = ['.claudinite/local/packs/', '.claudinite/local_packs/'];

async function paged(gh, path) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const { status, json } = await gh(`${path}${sep}per_page=100&page=${page}`);
    if (status !== 200 || !Array.isArray(json) || json.length === 0) break;
    out.push(...json);
    if (json.length < 100) break;
  }
  return out;
}

// A repo mounts Claudinite iff it carries the tracked declaration file — the one
// membership signal every member has whatever its mount shape (the same test the
// census's isCovered uses: activePacks are read from it, so a mount marker with
// no declaration is a half-adoption that must classify as uncovered).
function parseChecks(contentB64) {
  try { return JSON.parse(Buffer.from(contentB64, 'base64').toString('utf8')); }
  catch { return null; }
}

// The member's declared packs (BARE ids, either declaration form), each entry's
// config (id -> config, so home-only gates honor per-pack settings like the
// growth promote opt-out), the per-repo scheduling cutover marker, and the
// vendored-mount provenance stamp (retire's per-repo apply evidence).
function readDeclaration(checks) {
  const entries = Array.isArray(checks?.packs) ? checks.packs : [];
  const activePacks = entries.map((e) => packEntryId(e)).filter((id) => typeof id === 'string');
  const packConfigs = {};
  for (const e of entries) {
    if (e && typeof e === 'object' && typeof e.id === 'string' && e.config !== undefined) {
      packConfigs[packEntryId(e)] = e.config;
    }
  }
  const schedulesItself = checks?.taskScheduler !== undefined && checks?.taskScheduler !== null;
  const stamp = checks?.claudinite ?? null;
  return {
    activePacks,
    packConfigs,
    schedulesItself,
    stamp: stamp ? { updated: stamp.updated ?? null, ref: stamp.ref ?? null } : null,
  };
}

// Did a default-branch commit in the window touch this member's local packs (the
// real promote trigger — a member that changed product code but not its local
// packs has nothing to lift up)? Scans only the window's commits (a handful) and
// stops at the first hit; a commit whose files can't be read contributes nothing.
async function localPacksChangedInWindow(gh, fullName, defaultBranch, sinceIso) {
  const list = await paged(gh, `/repos/${fullName}/commits?sha=${encodeURIComponent(defaultBranch)}&since=${sinceIso}`);
  for (const c of list) {
    if (!c?.sha) continue;
    const detail = await gh(`/repos/${fullName}/commits/${c.sha}`);
    const files = detail.status === 200 ? (detail.json?.files ?? []) : [];
    if (files.some((f) => typeof f.filename === 'string' && LOCAL_ROOTS.some((r) => f.filename.startsWith(r)))) return true;
  }
  return false;
}

// Does the member track any local packs of its own (a directory under either local
// root)? A cheap contents read that avoids the per-commit window scan for a repo
// that has none (promote and dedup have nothing to do without local packs).
async function hasLocalPacks(gh, fullName) {
  for (const root of LOCAL_ROOTS) {
    const { status, json } = await gh(`/repos/${fullName}/contents/${root.replace(/\/$/, '')}`);
    if (status === 200 && Array.isArray(json) && json.some((e) => e && e.type === 'dir')) return true;
  }
  return false;
}

// Build one member's record from its declaration + local-pack probes. `sinceIso`
// bounds the window; `localPacksChanged` is only meaningful (and only worth the
// per-commit reads) for a repo that carries local packs.
async function buildMember(gh, repo, sinceIso) {
  const fullName = repo.full_name;
  const defaultBranch = repo.default_branch || 'main';
  const decl = readDeclaration(repo.checks);
  const local = decl.activePacks.length ? await hasLocalPacks(gh, fullName) : false;
  const localChanged = local ? await localPacksChangedInWindow(gh, fullName, defaultBranch, sinceIso) : false;
  return {
    repo: fullName,
    defaultBranch,
    activePacks: decl.activePacks,
    packConfigs: decl.packConfigs,
    hasLocalPacks: local,
    localPacksChanged: localChanged,
    schedulesItself: decl.schedulesItself,
    stamp: decl.stamp,
  };
}

// Read the fleet aggregate: every COVERED member the owner owns (excluding the
// canon repo itself, forks, and archived repos), each with its declaration +
// local-pack window probe. Pure over `fleetGh`. Returns `{ owner, members, error }`;
// `error` is set (and `members` empty) when enumeration itself failed or returned
// nothing — a fleet task's precondition treats an errored/empty fleet as "no work
// I can prove", never as "the fleet is empty" (the census's own refuse-on-empty
// rule: an empty enumeration is a wrong-token/scope symptom, not consent).
export async function readFleet(fleetGh, { owner, canonRepo, sinceIso }) {
  const ownerLc = String(owner).toLowerCase();
  const mine = await paged(fleetGh, '/user/repos?affiliation=owner');
  const owned = mine.filter((r) => r?.owner?.login?.toLowerCase() === ownerLc);
  if (owned.length === 0) {
    return { owner: ownerLc, members: [], error: `enumeration returned no repos owned by ${ownerLc} — wrong token user or scope` };
  }
  const members = [];
  for (const r of owned.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullName = r.full_name;
    if (fullName.toLowerCase() === String(canonRepo).toLowerCase()) continue; // the canon doesn't mount itself
    if (r.archived || r.fork) continue;
    const res = await fleetGh(`/repos/${fullName}/contents/.claudinite-checks.json`);
    if (res.status !== 200 || !res.json?.content) continue; // uncovered — no tracked declaration
    const checks = parseChecks(res.json.content);
    if (!checks) continue; // unparsable declaration → not a member we can plan for
    members.push(await buildMember(fleetGh, { full_name: fullName, default_branch: r.default_branch, checks }, sinceIso));
  }
  return { owner: ownerLc, members };
}

// The I/O edge: build a fleet `gh` from FLEET_GITHUB_TOKEN, or null when the
// secret isn't set (a consumer, or the canon before the secret is provisioned) —
// run.mjs then leaves ctx.fleet null and the fleet collector returns null, so the
// fleet tasks' preconditions skip rather than crash.
export function makeFleetGh(env = process.env) {
  const token = env.FLEET_GITHUB_TOKEN;
  if (!token) return null;
  return makeGh({ token });
}
