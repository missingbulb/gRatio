# grow_with_claudinite

Opt into the **growth lifecycle** — declaring this pack enrolls a repo in contributing its hard-won
lessons up to the shared Claudinite canon, and in pruning its local packs once the canon owns them.
Seeded by default (`--init` + the one-time `grow-with-claudinite-seed` baseline migration for the
existing fleet), and **opt-out by removal**: baselining never re-adds it.

This pack carries the **repo-side** stages of the growth lifecycle: capturing a repo's own
lessons into its local packs, and pruning them once the shared canon covers them. The central
**promote** stage — which lifts portable lessons up into the shared canon — is a home-only duty
that runs canon-side, not a repo-side task, so it lives outside this pack.

Its scheduled work is five tasks under this pack's own `tasks/`, each discovered by the repo's
scheduler (`engine/scheduler/discover.mjs`) wherever the pack is declared:

| Task | Runs when | Where it lands |
|---|---|---|
| `growth-extract` ([tasks/growth-extract/task.md](tasks/growth-extract/task.md)) | the project changed in the window | the repo's own local packs, via a PR that auto-merges after CI |
| `growth-dedup` ([tasks/growth-dedup/task.md](tasks/growth-dedup/task.md)) | weekly, when the canon or the project's local packs moved in the week | a PR against the repo's `main` |
| `growth-discover-packs` ([tasks/growth-discover-packs/task.md](tasks/growth-discover-packs/task.md)) | weekly | a new **local** pack in the repo's own `.claudinite/local/packs/`, via a reviewed PR |
| `conversation-extract` ([tasks/conversation-extract/task.md](tasks/conversation-extract/task.md)) | after a substantive merge, or to run the retention prune | the repo's own local packs, plus the prune on the logs branch |
| `prose-to-checks-sweep` ([tasks/prose-to-checks-sweep/task.md](tasks/prose-to-checks-sweep/task.md)) | daily (no-ops cheaply on a quiet corpus) | a PR converting always-testable pack prose into checks |

A member that wants the local stages without contributing lessons upstream **opts out of
promotion** on its own entry — `{ "id": "grow_with_claudinite", "config": { "promote": false } }`
— and the central promote stage skips it (absent or `true` = participate).

## The conversation lifecycle — capture in-session, extract in a daily task, retention

The pack also owns **extraction from working sessions** — the conversation-side sibling of the
issues/PRs/commits extract above, replacing the old in-session post-merge lessons pass. The two
halves split by what each needs: **capture** needs the live session transcript, so it runs
in-session (at merge, and again when the session ends); **extraction** only reads the
already-pushed logs, so it is an ordinary
scheduled task with `growth-extract`'s access model — the logs branch is *in the repo*,
so reading it, committing lessons to local packs, and pruning are plain local git on the working
tree; only posting the summary on the issue uses the GitHub MCP tools.

1. **Capture — a step in the merge-to-main skill** (in-session, where the transcript lives).
   Right after a merge lands:
   `node .claudinite/shared/packs/grow_with_claudinite/capture-log.mjs --issue <n>`
   (in the canon repo itself: `node packs/grow_with_claudinite/capture-log.mjs --issue <n>`).
   Deterministic, seconds; it bundles the session transcript (sidechains inline, timestamp
   order), **scrubs enumeration-first** (every value the environment holds — `process.env`
   minus a short named allowlist of structural values, plus known credential stores — is
   redacted wherever it appears, with credential-shape patterns as the backstop; a secret the
   session itself transformed is beyond any static scrub, and push protection is the last
   net), and pushes one file per **capture event** onto the orphan **`conversation-logs`**
   branch: `<stamp>--issue-<n>--<session>.jsonl`, commits marked `[skip ci]`.
   **Delta-aware, keyed on the session id:** every capture pushes only the entries after this
   session's previous capture, whatever event produced it, so any two events chain into
   disjoint files and a zero delta pushes nothing at all. Double-writing is therefore safe by
   construction, not by coordination — the property [`session-end.mjs`](session-end.mjs) relies
   on, so `pack.test.mjs` pins it directly.
   The branch is a **work queue, not an archive** — never merged; tips are cheap in shallow
   session clones and retention keeps them bounded.
1. **Capture — again, when the session ends** ([session-end.mjs](session-end.mjs), invoked by the
   engine's SessionEnd hook runner for every active pack that ships one). Same capture, with
   `--issue 0`: **`0` means "no associated issue"**, and the filename shape stays byte-identical
   on purpose — the retention prune, the `conversationLogs` signal and the extract's filename
   parse all already accept it, whereas a *new* shape would be invisible to the prune and become
   immortal on the branch. This event is what captures the sessions that never merge (a review, an
   investigation, a session that ended in a question) and the post-merge **tail** of the ones that
   do. **Best effort:** a container reclaimed by timeout never fires it, so nothing depends on it
   having run — every firing enriches the record, every miss leaves exactly the merge-only
   behaviour. An `issue-0` log has no issue for `conversation-extract` to post its exchange
   summary on; nothing else about its lifecycle differs.
   **Unattended sessions capture through the same step, deliberately not through the hook.** A
   scheduled task's executor session ends by having its container reclaimed, which is exactly
   the ending no `SessionEnd` fires on — so the executor runs the engine's runner itself as its
   last step and names its dispatch issue in `CLAUDINITE_SESSION_ISSUE`, which this step uses in
   place of `0`. Those logs therefore file under the task that ran (the dispatch issue's title
   names `pack/task`), and the work no human watched becomes as countable as the work one did.
2. **Fresh pass — the [conversation-extract](tasks/conversation-extract/task.md) scheduled task**
   (precondition: a substantive merge, or a logs branch with retention configured so the age-based
   prune still runs on a quiet repo; local git on the
   repo's working tree, MCP only for the issue comment). It applies
   [extracting-lessons.md](extracting-lessons.md) (the method — friction signals and the
   measured efficiency analysis, computable from the log's timestamps and token usage), routes
   keepers into the member's local packs, and posts on the worked issue, for each rule that landed,
   a **200-word-max** summary of the slice of conversation that caused it — the dialogue itself is
   never pasted there, it is far too verbose for an issue —
   **extraction is the only path to permanence**: a log that yields no rule gets no comment,
   and its conversation is gone once retention deletes it (a deliberate owner call).
3. **Final pass and deletion** — once a log ages past `config.retention_days`, the same task
   re-reads it with ~a week of hindsight (the rethink window), then deletes it (the weekly full
   sweep guarantees the prune runs even on a repo gone quiet). Every log gets exactly two
   judgment passes. **Unset retention = the prune deletes nothing** (capture-only, fail-safe).

No adoption question over it — `retention_days` stays unset (hidden) by default, which is
fail-safe (capture-only). A project that wants the prune active sets `config.retention_days`
itself (10 is the recommended floor); nothing else to schedule, since extraction rides the
fleet's one daily run like the other growth tasks.

## Skill-usage metrics — what the mounted skills actually do

Mounting a skill only puts its name and one-line description into the session prompt; whether the
model ever **loads** it is discretion, and nothing recorded it. So the promotion ladder's
skill-vs-prose call had no empirical feedback: a skill whose trigger never fires looked exactly like
one that fires daily, and a "skill" that loads in every session (rules wearing a skill's clothes)
looked exactly like a genuinely activity-scoped one.

The [usage-fold](tasks/usage-fold/task.md) task closes that loop — daily, agentless, seconds. It
counts skill loads **and their denominators** (captures, merges, sessions, user messages, user
commands) out of the logs this pack already captures, into
`.claudinite/local/usage.GENERATED.json`: day rows recomputed statelessly inside the raw retention
window, week rows appended once past a `foldedThrough` watermark. Denominators are the point — a raw
count cannot tell healthy-rare from broken, so the question is loads *against the sessions where that
skill's own declared trigger plausibly applied*. Zeros are implicit (a skill with no loads has no
key), which is what makes "never loads" visible: diff the file against the repo's mounted skills.

Fleet-wide aggregation is deliberately **not** here — the canon knows mechanisms, never repos. It is
the sheepdog pack's [`fleet-usage`](../sheepdog/tasks/fleet-usage/task.md) task, in the fleet-enforcer
repo, which is the only place that knows who the members are.

## Rules

| Rule | Kind | What |
|---|---|---|
| `growth-config` | hardcoded ([config-check.mjs](config-check.mjs)) | entry config shape valid |

**Pack discovery** ([tasks/growth-discover-packs/task.md](tasks/growth-discover-packs/task.md)) is
an ordinary weekly task on the repo's own scheduler. The repo runs the whole pipeline over
**itself**: manifest its stack, hold it against the canon packs already on its shelf and its own
existing local packs, and — for genuinely project-specific knowledge neither homes — author a new
**local** pack populated from its real usage, landed through a **reviewed** PR (a new pack ships new
`.mjs` checks, and a check can break CI — the same reason `prose-to-checks-sweep` is reviewed, and
the one place this stage differs from extract). It writes only the repo's own
`.claudinite/local/packs/`; lifting a local pack up into the shared canon is the central promote
task's job.

## Identifying a project's capture surface: its local packs (the same way in every stage)

Every growth stage operates on a project's **local packs** — the tracked packs a repo keeps under
`.claudinite/local_packs/<pack>/` (prose in `RULES.md`, checks in the pack's `rules`, activity
procedures as the pack's skills, scheduled tasks under its `tasks/`). That subtree **is** the
project's own content;
the rest of `.claudinite/` is the **read-only mounted canon** and is never a capture, prune, or
promote target. So "a project's local packs" means precisely *everything under
`.claudinite/local_packs/`, and nothing else under `.claudinite/`*. This is the normalized capture
surface — a structural set the stages read the same way, not a `CLAUDE.md`-graph walk over stray
Markdown (a repo with no local packs yet simply has nothing to extract, dedup, or promote here; a
project adopts the structure via the `generate-project-instructions` skill).

Prefer the strongest mechanism the lesson allows — the **local promotion ladder**, applied at the
project's own level: a deterministic rule becomes a **check** in the owning pack's `rules` (its
failure message carries the lesson), an activity-scoped procedure becomes a **pack skill**, and only
what neither can carry lands as **prose** in a pack's `RULES.md`. A check relieves every session's
context completely where prose only relocates it, so capture writes *more checks and less prose*.

The stages differ only in *how they read that set*, never in *which set it is*: extract and dedup
run against the member repo and read the local packs from the working tree; promote runs centrally
and reads the same subtree over the GitHub API (get-file-contents under `.claudinite/local_packs/`).
Extract writes into it, promote reads from it, dedup prunes within it — all against the identical,
`.claudinite/local_packs/`-rooted set.
