// The signal collectors (per-project-scheduling DESIGN §3.3). Each reads a
// bounded, cheap slice of the repo's GitHub state (or local disk) for one signal
// name; `collectSignals` gathers only the union the due tasks declared, so a
// non-daily slot never pays for daily tasks' signals. Every collector takes the
// shared `(gh, ctx)` and returns a plain data object a precondition reads.
//
// Pure over the injected `gh` reader and a `ctx` of already-resolved facts, so
// the whole layer tests against a fake `gh` with no live GitHub.

// A default-branch commit is genuine project work unless it is bot/CI
// housekeeping or one of Claudinite's own automated writes — the same exclusions
// the fleet planner applies (kept in sync), extended with the scheduler's own
// `[claudinite-task]` writes so the scheduler never self-triggers.
const HOUSEKEEPING = /\[skip ci\]|(^|\n)\s*baselin(e|ing)\b|claudinite[ -](baselin|maintenance|growth|task)|seed default-on/i;
const isSubstantive = (c) => {
  const login = c.author?.login ?? '';
  if (login.endsWith('[bot]')) return false;
  return !HOUSEKEEPING.test(c.commit?.message ?? '');
};

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

// Commit objects in the window, with their changed-file lists resolved (one read
// per commit — the window is a handful of commits).
async function windowCommits(gh, repo, branch, sinceIso) {
  const list = await paged(gh, `/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&since=${sinceIso}`);
  const detailed = [];
  for (const c of list) {
    const d = await gh(`/repos/${repo}/commits/${c.sha}`);
    const files = d.status === 200 ? (d.json?.files ?? []).map((f) => f.filename).filter(Boolean) : [];
    detailed.push({ sha: c.sha, message: c.commit?.message ?? '', author: c.author?.login ?? null, substantive: isSubstantive(c), files });
  }
  return detailed;
}

const COLLECTORS = {
  async commits(gh, ctx) {
    const commits = await windowCommits(gh, ctx.repo, ctx.defaultBranch, ctx.sinceIso);
    return {
      list: commits,
      count: commits.length,
      substantiveChange: commits.some((c) => c.substantive),
      touchedPaths: [...new Set(commits.flatMap((c) => c.files))],
    };
  },

  async prs(gh, ctx) {
    const open = await paged(gh, `/repos/${ctx.repo}/pulls?state=open&sort=updated&direction=desc`);
    const since = new Date(ctx.sinceIso);
    return {
      open: open.map((p) => ({ number: p.number, title: p.title, updatedAt: p.updated_at })),
      touched: open.filter((p) => new Date(p.updated_at) >= since).map((p) => p.number),
    };
  },

  async issues(gh, ctx) {
    const open = await paged(gh, `/repos/${ctx.repo}/issues?state=open&sort=updated&direction=desc`);
    const since = new Date(ctx.sinceIso);
    // Exclude PRs (the issues endpoint returns both) and the scheduler's own
    // dispatch issues / standing trackers — invisible to signals (DESIGN §3.3).
    const real = open.filter((i) => !i.pull_request
      && !/^\[claudinite-task\]/.test(i.title ?? '')
      && !/^(claudinite tracker:|auto-improvements tracker\b|repo tidy tracker$)/i.test((i.title ?? '').trim()));
    return {
      open: real.map((i) => ({ number: i.number, title: i.title, updatedAt: i.updated_at, labels: (i.labels ?? []).map((l) => l.name ?? l) })),
      touched: real.filter((i) => new Date(i.updated_at) >= since).map((i) => i.number),
    };
  },

  async branches(gh, ctx) {
    const names = (await paged(gh, `/repos/${ctx.repo}/branches`)).map((b) => b.name);
    return { names };
  },

  async release(gh, ctx) {
    const { status, json } = await gh(`/repos/${ctx.repo}/releases/latest`);
    const latestTag = status === 200 ? (json?.tag_name ?? null) : null; // 404 → no release yet
    return { latestTag, manifestVersion: ctx.manifestVersion ?? null };
  },

  // Whether the repo carries local packs, and whether a window commit touched
  // one (under either local root during the rename window).
  async localPacks(gh, ctx) {
    const commits = ctx.commits ?? await windowCommits(gh, ctx.repo, ctx.defaultBranch, ctx.sinceIso);
    const touches = (f) => f.startsWith('.claudinite/local/packs/') || f.startsWith('.claudinite/local_packs/');
    const present = ctx.hasLocalPacks ?? null;
    return { present, changedInWindow: commits.some((c) => c.files.some(touches)) };
  },

  // Which DECLARED packs' vendored files changed in the window — the local echo
  // of "canon changed" (replaces the cross-repo relevantCanonChanged).
  async sharedMount(gh, ctx) {
    const commits = ctx.commits ?? await windowCommits(gh, ctx.repo, ctx.defaultBranch, ctx.sinceIso);
    const declared = new Set(ctx.activePacks ?? []);
    const changed = new Set();
    for (const c of commits) {
      for (const f of c.files) {
        const m = /^\.claudinite\/shared\/packs\/([^/]+)\//.exec(f);
        if (m && declared.has(m[1])) changed.add(m[1]);
      }
    }
    return { changedPacks: [...changed] };
  },

  // The conversation-logs orphan branch: present, and the age of its oldest JSONL
  // vs the configured retention (the age-based prune's trigger on quiet repos).
  async conversationLogs(gh, ctx) {
    const { status } = await gh(`/repos/${ctx.repo}/branches/conversation-logs`);
    return { present: status === 200, retentionDays: ctx.retentionDays ?? null };
  },

  // The vendored-mount provenance stamp and its age; the canon head sha when the
  // Action was given one (baselining's precondition falls back to stamp age).
  async stamp(gh, ctx) {
    const stamp = ctx.config?.claudinite ?? null;
    let ageDays = null;
    if (stamp?.updated) {
      const ms = new Date(ctx.now).getTime() - new Date(stamp.updated).getTime();
      if (Number.isFinite(ms)) ageDays = ms / 86400000;
    }
    return { updated: stamp?.updated ?? null, ref: stamp?.ref ?? null, ageDays, canonHead: ctx.canonHead ?? null };
  },

  // Fleet aggregate — canon-only, over the fleet PAT (DESIGN §3.3). A consumer
  // cannot declare it; the collector returns null unless the caller supplied a
  // fleet reader (wired on the canon/sheepdog repos in Phase 2).
  async fleet(gh, ctx) {
    return ctx.fleet ?? null;
  },
};

export const SIGNAL_COLLECTORS = Object.keys(COLLECTORS);

// Collect exactly the requested signal names into one object. An unknown name is
// ignored (the task-declaration-shape check rejects those at author time); a
// collector that throws records `{ error }` under its key rather than sinking the
// whole collection (per-signal isolation).
export async function collectSignals(gh, ctx, names) {
  const out = {};
  // Commit-derived collectors share one window read.
  if (names.some((n) => ['commits', 'localPacks', 'sharedMount'].includes(n)) && !ctx.commits) {
    try { ctx = { ...ctx, commits: await windowCommits(gh, ctx.repo, ctx.defaultBranch, ctx.sinceIso) }; } catch { /* collectors re-read on demand */ }
  }
  for (const name of names) {
    const collect = COLLECTORS[name];
    if (!collect) continue;
    try { out[name] = await collect(gh, ctx); }
    catch (e) { out[name] = { error: e.message }; }
  }
  return out;
}
