import { finding } from '../../../../engine/checks/helpers/findings.mjs';
import { interviewState } from '../adopt-claudinite/interview.mjs';

// The adoption-interview's ENFORCING half, sibling to adopt-claudinite's stale
// advisory. Pending answers are a mild SessionStart note everywhere EXCEPT the
// one branch that introduces a pack: there the owner is present by construction
// (adoption is a chosen act), so declaring a pack that asks the project for its
// intent and leaving it unanswered is a work defect this branch must fix — the
// pack is a hollow no-op until answered. Scoped to work so it fires only on that
// branch: a pack already in the base is never re-litigated, and an unattended
// steady-state run (which adds no pack) never trips it. `via`-materialized
// dependencies the project didn't choose are excluded upstream by interviewState.
const idsOf = (decl) =>
  (decl?.packs ?? []).map((e) => (typeof e === 'string' ? e : e?.id)).filter(Boolean);

const rule = {
  id: 'adoption-answers-pending',
  severity: 'blocking',
  description: 'A pack newly declared on this branch records an answer for every adoption question it asks',
  doc: 'packs/README.md',
  scope: 'work',
  why: 'a pack that asks the project for its intent is a no-op until answered, and the adding branch is where the owner is present to answer — so that is where the answer is required',

  run(work) {
    const { head, base } = work.jsonPair('.claudinite-checks.json');
    if (!head) return [];
    const baseIds = new Set(idsOf(base));
    const added = new Set(idsOf(head).filter((id) => !baseIds.has(id)));
    if (!added.size) return [];
    const { pending } = interviewState(work.packs, work.config);
    return pending
      .filter((p) => added.has(p.packId))
      .flatMap(({ packId, questions }) =>
        questions.map((q) => finding(rule, {
          file: '.claudinite-checks.json',
          what: `the newly declared "${packId}" pack asks "${q.id}" but its entry records no answer`,
          fix: `interview the owner and record it on the "${packId}" entry as "answers": { "${q.id}": "<answer>" } ("n/a — none wanted" is a valid answer) — ${q.distill}`,
        })));
  },
};

export default [rule];
