#!/usr/bin/env node
// World-scope conformance runner (see DESIGN.md): the rules that audit repo
// state as it exists now, plus the pack-agnostic settings/load integrity
// diagnostics (malformed config, an unknown pack, a broken pack.mjs). Rules that
// judge the current change (`scope: 'work'`) run in check_the_work.mjs, which
// this file shares no code with — only the scope-blind mechanism helpers
// (run-active-pack-rules.mjs, report-findings.mjs). It names NO pack: adoption
// interview hygiene is a skill-owned check that rides its own pack's activation,
// and a malformed `questions` field is a load fault the pack registry reports.
// Wired into the project's test/CI flow, not the Stop hook. Dependency-free Node ≥18.
//   (default)   whole-repo sweep — milliseconds on a text corpus, sees cross-file breakage
//   --changed   transitional: scope to files changed vs the merge-base with main
//               (adopting a repo with a backlog only — not the enforcement default)
//   --base REF  override the base ref
//   --list      machine-readable catalog of every rule, both scopes (id, severity, description, doc)
//   --init      write .claudinite-checks.json — basics plus the fingerprinted packs
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildContext } from './helpers/repo-context.mjs';
import { discoverPacks, resolveDeclaredPacks } from '../pack_loader/pack-registry.mjs';
import { runActivePackRules, contributedRules } from './run-active-pack-rules.mjs';
import { reportFindings } from './report-findings.mjs';

const configError = (what, fix) => ({
  rule: 'config', severity: 'blocking', file: '.claudinite-checks.json', line: null,
  what, why: 'the settings file is what executes — a bad key, value, or pack name silently changes what runs', fix, doc: 'engine/checks/README.md',
});

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const root = value('--root') || process.cwd();

if (has('--list')) {
  const { packs } = await discoverPacks({ localRoot: root });
  const rules = [
    ...packs.flatMap((p) => p.rules ?? []),
    ...packs.flatMap((p) => p.skillChecks ?? []),
    ...packs.flatMap((p) => contributedRules(p, packs)),
  ];
  for (const r of rules.sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`${r.id}\t${r.severity}\t${r.description}\t${r.doc}`);
  }
  process.exit(0);
}

if (has('--init')) {
  const path = join(root, '.claudinite-checks.json');
  if (existsSync(path)) {
    console.log(`${path} already exists — leaving it as-is.`);
    process.exit(0);
  }
  const { packs } = await discoverPacks({ localRoot: root });
  const ctx = buildContext({ root, mode: 'all' });
  // No pack is active by default, so the baseline is seeded as an explicit
  // declaration alongside the fingerprinted packs: every pack that flags
  // `seededByDefault` is written in (discovered structurally — the engine names
  // no pack), plus the ones a fingerprint detects. A seeded pack is still
  // opt-out-able where its own policy allows (baselining re-adds only the packs
  // whose absence it treats as drift), so removing a seeded declaration can
  // stick; each seeded pack ships its own one-time seed migration for the fleet.
  // Local packs are declared by hand, never fingerprinted or seeded — exclude
  // them from --init's seeding so a repo that already carries local packs (but
  // no config yet) doesn't auto-declare them.
  const seeded = packs.filter((p) => p.seededByDefault && !p.local).map((p) => p.id);
  const detected = [...seeded, ...packs.filter((p) => p.detect && !p.local && p.detect(ctx)).map((p) => p.id)];
  // A pack can't be imported without its dependencies — pull each declared pack's
  // `requires` closure into the declaration so it's complete and visible.
  const declared = resolveDeclaredPacks(detected, packs);
  // maintenance.delivery is deliberately materialized, not defaulted — the selection
  // must be visible in the file where a project would change it (see engine/checks/README.md).
  // Only what carries a decision: the declaration and the always-explicit
  // delivery. Empty rules/accept boilerplate is noise, not settings (#385);
  // loadConfig defaults absent keys.
  writeFileSync(path, `${JSON.stringify({ packs: declared, maintenance: { delivery: 'auto-merge' } }, null, 2)}\n`);
  console.log(`Wrote ${path} (packs: ${declared.join(', ')}).`);
  // The adoption interview (surfacing each declared pack's pending questions) is
  // driven by the adopt-claudinite skill / bootstrap.md, and nudged every session
  // by the SessionStart interview-check step — not printed here, so this runner
  // imports no pack.
  process.exit(0);
}

const { packs, errors: packErrors } = await discoverPacks({ localRoot: root });
const ctx = buildContext({ root, mode: has('--changed') ? 'changed' : 'all', baseOverride: value('--base') });

// Settings/load integrity — pack-agnostic, so the world runner owns them.
// Settings validity is checked at load: malformed JSON, an unknown
// property, and a wrong pack name are all equally settings errors. loadConfig
// reports the first two; the runner adds unknown pack names (only it holds the
// registry) and broken/duplicate local pack.mjs faults.
const findings = [];
for (const e of ctx.config.errors) findings.push(configError(e.what, e.fix));
for (const e of packErrors) findings.push(configError(e.what, e.fix));
// knownIds spans canon AND local packs, so a declared local pack id is valid and
// the unknown-pack message lists it among the declarable packs. ctx.config.packs
// is loadConfig's normalized view — bare ids, a namespaced local_packs/<name>
// declaration already resolved through packEntryId.
const knownIds = new Set(packs.map((p) => p.id));
for (const name of ctx.config.packs) {
  if (typeof name === 'string' && !knownIds.has(name)) {
    findings.push(configError(`declares unknown pack "${name}"`, `remove it or fix the name — declarable packs: ${[...knownIds].sort().join(', ')}`));
  }
}
// (Adoption-interview hygiene is a skill-owned check that runs below with the
// other active-pack rules; a malformed `questions` field arrives as a load fault
// in packErrors above. Neither names a pack here.)

// The world rules: everything not scoped to the work. A broken contributedRules
// seam is a config-level fault surfaced here (the world runner owns diagnostics).
findings.push(...runActivePackRules(ctx, packs, {
  includeRule: (rule) => rule.scope !== 'work',
  onContributeError: (pack, e) => findings.push(configError(
    `the "${pack.id}" pack's contributedRules failed: ${e.message}`, 'fix the pack manifest, or the contribution it interprets')),
}));

const blocking = reportFindings(findings, ctx.config, { scopeLabel: 'world', mode: ctx.mode, baseRef: ctx.baseRef });
process.exit(blocking ? 1 : 0);
