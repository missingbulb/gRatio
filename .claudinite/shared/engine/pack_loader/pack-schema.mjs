// THE PACK MANIFEST SPEC — the single declarative statement of what a
// `pack.mjs` may and must carry. Everything a pack declares about itself is
// described here once, and `validateManifest` is the only thing that judges a
// manifest against it. The loader calls it on every pack it imports (canon and a
// consumer's own `local_packs/` alike), so a malformed or incomplete manifest
// surfaces as a blocking `config` error at load — the same class as invalid JSON
// in `.claudinite-checks.json`.
//
// WHY A SPEC AND NOT A CHECK. A required manifest field is part of the pack
// contract, not a conformance opinion about a repo's content: a conformance rule
// would have to be declared BY a pack, run only when that pack is active, and
// re-derive the manifest by reading its source text — enforcing the shape of the
// system from inside one of its members. The spec is upstream of every pack, so
// there is nothing to declare and nothing to parse.
//
// Dependency-free by the engine's module rule: no imports, no filesystem. The
// caller supplies the facts from disk (the `skills/` directory listing), so this
// module is pure and testable standalone.

// The routing budget. Both sides of `ruleRoutingGuidance` are emitted as one row
// of a table every session loads (engine/pack_loader/inject-pack-prose.mjs), so
// the cap is a context cost, not a style preference: enough for a boundary and a
// pointer to the pack that owns the other side.
export const MAX_ROUTING_WORDS = 20;

// The two conformance scopes. A rule's scope is its PLACEMENT on the manifest —
// `worldRules` audit repo state, `workRules` judge the change and session in
// front of you — so the two runners' partition is declared where a reader of the
// pack can see it, and a rule module never restates (or contradicts) it.
export const RULE_SCOPES = { worldRules: 'world', workRules: 'work' };

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isRuleArray = (v) => Array.isArray(v) && v.every((x) => isPlainObject(x) && typeof x.id === 'string' && typeof x.run === 'function');

// Every field a manifest may carry. `required` fields must be present; the rest
// are validated only when declared. An UNDECLARED field is an error: the spec is
// the closed vocabulary of a pack, so a typo (`rule:`, `skill:`) fails loudly
// instead of being silently ignored forever.
export const PACK_FIELDS = {
  id: { required: true, describe: 'the pack id, matching its directory name', valid: (v) => typeof v === 'string' && v.length > 0 },
  ruleRoutingGuidance: { required: true, describe: 'what belongs in this pack and what does not, each at most 20 words', valid: isPlainObject },
  badge: { describe: 'the pack badge filename, resolved off the pack directory', valid: (v) => typeof v === 'string' },
  detect: { describe: 'a fingerprint predicate over the repo context, or null', valid: (v) => v === null || typeof v === 'function' },
  marker: { describe: 'a human-readable glob naming what detect looks for, or null', valid: (v) => v === null || typeof v === 'string' },
  prose: { describe: 'the RULES.md filename injected at session start, or null', valid: (v) => v === null || typeof v === 'string' },
  seededByDefault: { describe: 'whether bootstrap --init seeds this pack everywhere', valid: (v) => typeof v === 'boolean' },
  requires: { describe: 'pack ids this pack depends on, resolved when the declaration is written', valid: isStringArray },
  contributes: { describe: 'rules addressed to another pack, keyed by that pack id', valid: isPlainObject },
  contributedRules: { describe: 'the seam interpreting other packs contributions to this one', valid: (v) => typeof v === 'function' },
  env: { describe: 'environment requirements the pack needs to run its checks', valid: isPlainObject },
  questions: { describe: 'the pack adoption-interview questions', valid: (v) => Array.isArray(v) },
  skills: { describe: 'the skill directory names bundled under this pack skills/', valid: isStringArray },
  worldRules: { describe: 'rules auditing repo state (check_the_world)', valid: isRuleArray },
  workRules: { describe: 'rules judging the current change and session (check_the_work)', valid: isRuleArray },
};

const REQUIRED = Object.entries(PACK_FIELDS).filter(([, f]) => f.required).map(([k]) => k);

const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

// Validate one manifest against the spec. `skillDirs` is the list of directory
// names under `<pack>/skills/` (the caller reads it; this module touches no
// disk). Returns `{ what, fix }` errors — the loader's error shape — never
// throws, so one bad manifest can't sink the run.
export function validateManifest(mod, { label, skillDirs = [] } = {}) {
  const errors = [];
  const at = label ? `${label}: ` : '';
  const err = (what, fix) => errors.push({ what: `${at}${what}`, fix });

  if (!isPlainObject(mod)) {
    err('the pack has no object default export', 'export default { id, ruleRoutingGuidance, ... } from its pack.mjs');
    return errors;
  }

  for (const key of REQUIRED) {
    if (!(key in mod)) err(`declares no "${key}"`, `add "${key}" — ${PACK_FIELDS[key].describe}`);
  }
  for (const [key, value] of Object.entries(mod)) {
    const field = PACK_FIELDS[key];
    if (!field) {
      err(`declares "${key}", which is not a pack manifest field`, `remove it, or add it to the spec in engine/pack_loader/pack-schema.mjs — the known fields are: ${Object.keys(PACK_FIELDS).join(', ')}`);
      continue;
    }
    if (!field.valid(value)) err(`"${key}" is not a valid value`, `${key} is ${field.describe}`);
  }

  if (isPlainObject(mod.ruleRoutingGuidance)) {
    for (const side of ['belongs', 'excludes']) {
      const v = mod.ruleRoutingGuidance[side];
      if (typeof v !== 'string' || !v.trim()) {
        err(`ruleRoutingGuidance declares no "${side}"`, side === 'belongs'
          ? 'state the kind of content this pack owns, in at most 20 words'
          : 'state what belongs elsewhere and which pack owns it, in at most 20 words');
        continue;
      }
      const n = wordCount(v);
      if (n > MAX_ROUTING_WORDS) {
        err(`ruleRoutingGuidance.${side} is ${n} words, over the ${MAX_ROUTING_WORDS}-word cap`,
          `cut it to ${MAX_ROUTING_WORDS} words — it is one row of a table every session loads`);
      }
    }
  }

  // A rule's scope is where it is declared; the manifest is the authority. A
  // rule module may still carry `scope` for the dispatch seam that reads it off
  // the rule object (engine/checks/helpers/work.mjs — which hands a work rule
  // its fluent surface), but then the two must AGREE: a module that says one
  // thing while the list it sits in says another is drift with a wrong context
  // waiting at the end of it.
  for (const [key, scope] of Object.entries(RULE_SCOPES)) {
    if (!isRuleArray(mod[key])) continue;
    for (const rule of mod[key]) {
      if ('scope' in rule && rule.scope !== scope) {
        err(`the rule "${rule.id}" declares scope "${rule.scope}" but sits in ${key}`,
          `move the rule to the list matching its scope, or drop its "scope" field — the manifest decides`);
      }
    }
  }

  // The bundled-skills declaration and the tree must agree in BOTH directions:
  // an undeclared directory is a skill nothing announces, and a declared name
  // with no directory is a manifest that lies.
  if (isStringArray(mod.skills)) {
    for (const name of mod.skills) {
      if (!skillDirs.includes(name)) err(`declares a skill "${name}" with no skills/${name}/ directory`, `create skills/${name}/SKILL.md, or drop the declaration`);
    }
  }
  for (const dir of skillDirs) {
    if (!(mod.skills ?? []).includes(dir)) err(`bundles skills/${dir}/ but does not declare it`, `add "${dir}" to the pack's "skills" list`);
  }

  return errors;
}

// The manifest as the rest of the engine consumes it: the two scoped rule lists
// flattened into the single `rules` array every runner already walks, each rule
// stamped with the scope its placement declared. One derivation, here — nothing
// downstream re-decides a rule's scope.
export function normalizeManifest(mod) {
  const rules = [];
  for (const [key, scope] of Object.entries(RULE_SCOPES)) {
    for (const rule of mod[key] ?? []) rules.push({ ...rule, scope });
  }
  return { ...mod, rules };
}
