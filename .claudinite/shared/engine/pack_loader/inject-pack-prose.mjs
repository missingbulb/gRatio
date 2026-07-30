#!/usr/bin/env node
// SessionStart hook: emit the prose of every declared pack (basics included)
// so the baseline and the project's technology guidance load once per session —
// the eager, reliable replacement for hoping a soft-pointer read fires. Its
// stdout becomes session context. Fails soft (emits nothing) on any error.
// Registered per-repo — see bootstrap.md.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const loaderDir = dirname(fileURLToPath(import.meta.url)); // <canon>/engine/pack_loader
  const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  let declared = [];
  const configPath = join(projectRoot, '.claudinite-checks.json');
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    if (Array.isArray(raw.packs)) declared = raw.packs;
  }

  const { loadPacks, isActive } = await import(join(loaderDir, 'pack-registry.mjs'));
  // Include the project's own local packs (.claudinite/local_packs/) alongside
  // the canon: their prose loads the same way, so a project's rules ride the pack
  // system rather than an explicit @import.
  const packs = await loadPacks({ localRoot: projectRoot });

  // Nothing active means this repo runs no Claudinite: no prose, and no routing
  // table either. The hook stays silent rather than pushing a catalog of the
  // corpus into a session that declared none of it.
  const active = packs.filter((pack) => isActive(pack, { packs: declared }));
  if (!active.length) process.exit(0);

  const sections = [];
  for (const pack of active) {
    if (!pack.prose) continue;
    // Resolve prose off the pack's OWN directory (canon or local_packs), not a
    // single shared root — so a local pack's RULES.md is found where it lives.
    const prosePath = join(pack.dir, pack.prose);
    if (!existsSync(prosePath)) continue;
    sections.push(`<!-- pack:${pack.id} -->\n${readFileSync(prosePath, 'utf8').trim()}`);
  }

  // The routing table: every pack's own statement of its boundary, so a session
  // holding a piece of content (a doc, a rule, a skill) routes it to the pack
  // that owns it instead of defaulting into the baseline. Emitted for every pack
  // DISCOVERED, not only the active ones — a consumer holds just the packs it
  // vendored, so the discovered set is already the set it can route into, and in
  // the canon every pack is a legitimate destination whether or not this repo
  // declares it. Rows are short by contract (the manifest spec caps each side at
  // 20 words — pack-schema.mjs), so the whole table stays a cheap session cost.
  const routed = packs.filter((p) => p.ruleRoutingGuidance?.belongs && p.ruleRoutingGuidance?.excludes);
  const routingTable = routed.length
    ? `# Claudinite — where content goes (pack routing)\n\nEach pack states what it owns and what it does not. When a rule, doc, skill or check could live in more than one, this table decides it — and "no pack fits" means a new pack or the project's own \`local_packs/\`, never the baseline by default.\n\n| Pack | Belongs | Does not belong |\n|---|---|---|\n${routed
        .map((p) => `| \`${p.id}\`${p.local ? ' (local)' : ''} | ${p.ruleRoutingGuidance.belongs} | ${p.ruleRoutingGuidance.excludes} |`)
        .join('\n')}\n`
    : '';

  if (sections.length || routingTable) {
    const guidance = sections.length
      ? `# Claudinite — active-pack guidance\n\nThe baseline plus the packs this project declares. Deeper per-pack reference (e.g. a pack's release doc) is linked from its prose and read on demand.\n\n${sections.join('\n\n---\n\n')}\n`
      : '';
    process.stdout.write([guidance, routingTable].filter(Boolean).join('\n---\n\n'));
  }
} catch {
  // fail soft — a broken loader must never block a session
}
