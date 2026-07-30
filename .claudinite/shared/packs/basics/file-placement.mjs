import { dirname, join, normalize, sep } from 'node:path';
import { finding } from '../../engine/checks/helpers/findings.mjs';
import { engineSurface } from '../../engine/checks/helpers/module-imports.mjs';
import { SHARED_SUBDIR } from '../../engine/pack_loader/pack-registry.mjs';

const CODE_EXT = /\.(mjs|cjs|jsx?|tsx?)$/;
const CODE_REF = /(?:from\s+|require\(\s*|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

// Mandated locations and test files are two of the doc's three exemptions: their long
// references are forced by a tool contract or a test-location convention.
const EXEMPT_SOURCE = (file) =>
  file.startsWith('.github/') || file.startsWith('.claude/') ||
  /(^|\/)(test|tests|__tests__|spec)\//.test(file) || /\.(test|spec)\./.test(file);

// The third exemption is the plugin-contract one, and unlike the two above it is a
// property of the reference, not of the source file: a pack module must import the
// engine surface to do its job at all (a rule needs `finding`, a task check needs the
// task contract), and neither end of that reference can move. The pack loader discovers
// packs at fixed paths (packs/, .claudinite/local/packs/), and the engine is vendored
// canon a consumer doesn't own to restructure. So the distance is fixed by the contract,
// not chosen: 4-5 from a pack in the canon home, 7 from a local pack beside a consumer's
// shared mount. Every pack module ever written takes it, which is what makes it
// structural rather than a placement to fix — a project can only ever waive it.
//
// `engineSurface` is the same allow list `pack-independence` enforces (packs may import
// their own files and this surface, nothing else), so "what a pack may import" and "what
// placement exempts" cannot drift apart. That leaves the rule's real work on packs
// intact: a reach into another pack, or deep into a pack's own subtree, is judged
// normally — as is ordinary code reaching *into* a pack, the same one-directional
// narrowness the mandated-location exemption has.
const PACK_MODULE = /^(?:packs|skills)\/|^\.claudinite\/(?:local\/packs|local_packs)\//;
const SHARED_PREFIX = `${SHARED_SUBDIR.split(sep).join('/')}/`;
const EXEMPT_REF = (file, resolved) => PACK_MODULE.test(file) && engineSurface(
  resolved.startsWith(SHARED_PREFIX) ? resolved.slice(SHARED_PREFIX.length) : resolved,
);

function distance(fromDir, toDir) {
  const a = fromDir === '.' ? [] : fromDir.split('/');
  const b = toDir === '.' ? [] : toDir.split('/');
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  return (a.length - common) + (b.length - common);
}

const rule = {
  id: 'file-placement',
  severity: 'advisory',
  description: 'A code file should mostly reference files at folder distance 0–2; distance 3+ is reach',
  doc: 'skills/file-placement/SKILL.md',
  why: 'the folder tree should encode the dependency graph; far reaches make it lie',

  run(ctx) {
    const out = [];
    for (const file of ctx.files) {
      if (EXEMPT_SOURCE(file)) continue;
      // Reference-distance is a *code* dependency-graph metric — a docs corpus's
      // tree mirrors topics, not a dependency graph, so cross-topic doc citations
      // are healthy, not a smell. Markdown links are governed by reference-integrity
      // and markdown-link-labels instead.
      if (!CODE_EXT.test(file)) continue;
      const text = ctx.read(file);
      if (text === null) continue;

      const refs = [];
      text.split('\n').forEach((lineText, i) => {
        let m;
        CODE_REF.lastIndex = 0;
        while ((m = CODE_REF.exec(lineText)) !== null) refs.push({ target: m[1], line: i + 1 });
      });

      for (const { target, line } of refs) {
        const resolved = normalize(join(dirname(file), target));
        if (resolved.startsWith('..')) continue;
        if (EXEMPT_REF(file, resolved)) continue;
        const d = distance(dirname(file), dirname(resolved));
        if (d >= 3) {
          out.push(finding(rule, {
            file, line,
            what: `references ${target} at distance ${d}`,
            fix: 'move one of the two nearer the other, lift the shared dependency to a common ancestor, or accept it in .claudinite-checks.json with a reason if it is a deliberate cross-cutting concern',
          }));
        }
      }
    }
    return out;
  },
};

export default rule;
