import { sep } from 'node:path';
import { finding } from '../../engine/checks/helpers/findings.mjs';
import { LOCAL_PACKS_SUBDIR, LEGACY_LOCAL_PACKS_SUBDIR } from '../../engine/pack_loader/pack-registry.mjs';

// The machine backstop for dedup.md's rule: a dedup edit only ever REMOVES
// portable text. The routine has instead reworded partially-covered items —
// leading with a "this rule is portable (canon)" meta-line and re-stating the
// now-canon rule (and which pack owns it) inside the local pack — which grows
// the entry and duplicates canon prose, the inverse of dedup. Two independent
// signals catch that:
//
//  (1) Canon-restatement fingerprint. An ADDED local-pack prose line that says
//      a rule "is portable (canon)", that a "pack owns" a rule, or that the
//      canon "owns" it, is re-importing the canon into the local pack. This is
//      a corruption on any branch, dedup-labeled or not, so it is unscoped. The
//      legitimate delegation convention ("(canon): here <residue>") names the
//      canon without any of these phrasings, so it is not matched.
//
//  (2) A dedup run must SHRINK the pack it prunes. Scoped to a run whose commits
//      announce a dedup (extract legitimately GROWS a pack, so the shrink
//      invariant can't be unscoped): a modified local-pack prose file whose head
//      has more lines than its base grew instead of pruning.
//
// Local packs live under either root during the rename transition; git emits
// '/'-separated paths, so the platform-joined constants are normalized.
const LOCAL_ROOTS = [LOCAL_PACKS_SUBDIR, LEGACY_LOCAL_PACKS_SUBDIR]
  .map((s) => `${s.split(sep).join('/')}/`);

const isLocalPackProse = (file) =>
  file.endsWith('.md') && LOCAL_ROOTS.some((root) => file.startsWith(root));

const RESTATES_CANON = /\b(?:is|are) portable\s*\(canon\)|\bpack owns\b|\bcanon (?:now )?owns\b|\bowned by (?:the )?canon\b/i;
const DEDUP_RUN = /\bdedup\b|\bcanon now (?:covers|owns)\b/i;

const rule = {
  id: 'dedup-prune-integrity',
  severity: 'blocking',
  scope: 'work',
  doc: 'packs/grow_with_claudinite/dedup.md',
  description: 'A dedup edit only removes portable text — it never grows a local pack or re-imports a canon rule into it',
  why: 'the growth-dedup routine has reworded partially-covered items instead of stripping them — restating the canon rule inside the local pack, the inverse of dedup — and every dedup edit must shrink the pack, not grow it',

  run(work) {
    if (work.onDefaultBranch()) return [];
    const prose = work.changedFiles.filter(isLocalPackProse);
    if (!prose.length) return [];
    const findings = [];

    // (1) Canon-restatement fingerprint — unscoped: no legitimate edit re-imports
    // a canon rule into a local pack.
    for (const { file, line, text } of work.addedLines(prose)) {
      if (RESTATES_CANON.test(text)) {
        findings.push(finding(rule, {
          file,
          line,
          what: `local-pack prose re-imports a canon rule: "${text.trim().slice(0, 80)}"`,
          fix: 'delegate the portable rule to the canon and keep only this project\'s residue — never restate the canon rule, its fix, or which pack owns it (use the pack\'s "(canon): here …" convention)',
        }));
      }
    }

    // (2) A dedup run must shrink the pack it prunes, never grow it.
    if (work.commits.some((m) => DEDUP_RUN.test(m))) {
      for (const file of prose) {
        const base = work.readBase(file);
        const head = work.read(file);
        // A file absent at base (new pack) or gone at head (whole-file prune)
        // did not grow — only a modified-in-place file can.
        if (base === null || head === null) continue;
        const baseLines = base.split('\n').length;
        const headLines = head.split('\n').length;
        if (headLines > baseLines) {
          findings.push(finding(rule, {
            file,
            what: `a dedup run grew ${file} from ${baseLines} to ${headLines} lines — a prune/strip removes duplicated text, it never grows the pack`,
            fix: 'strip each covered item down to its project residue (a deletion that shrinks the entry); if you are keeping an item, leave it unchanged rather than rewording it',
          }));
        }
      }
    }

    return findings;
  },
};

export default rule;
