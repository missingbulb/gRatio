// Scope-blind mechanism (no policy, no scope knowledge): given a built context
// and the discovered packs, run the ACTIVE packs' rules that a caller-supplied
// predicate admits, and return their findings. The world and work runners each
// call this with their own `includeRule` — this file never names a scope, so
// the two runners stay independent of each other while sharing the walk.
import { runRule } from './helpers/work.mjs';
import { isActive } from '../pack_loader/pack-registry.mjs';

// A pack's contributedRules seam: the pack interprets the contributions other
// packs address to it on their manifests (`contributes`), returning first-class
// rules — how packs compose through declaration + configuration instead of
// importing each other's code. Isolated per pack, like manifest loading: one
// broken seam (a consumer-authored local pack's, say) must not sink the run.
// `onError` lets a caller turn a broken seam into a finding; passing none
// swallows it (a runner that doesn't own config diagnostics stays quiet).
export function contributedRules(pack, fromPacks, onError = null) {
  try { return pack.contributedRules?.(fromPacks) ?? []; }
  catch (e) { onError?.(e); return []; }
}

// Every finding from the active packs' rules that `includeRule` admits. A rule
// turned `off` in settings is skipped. `onContributeError(pack, err)` is invoked
// when a pack's contributedRules seam throws (the caller decides whether that
// becomes a finding).
export function runActivePackRules(ctx, packs, { includeRule, onContributeError = null }) {
  const findings = [];
  // Expose the discovered packs to any rule that reasons about pack metadata
  // (e.g. the adoption-interview hygiene check reads each active pack's declared
  // questions) — checks run synchronously and can't re-discover packs themselves.
  ctx.packs = packs;
  const activePacks = packs.filter((p) => isActive(p, ctx.config));
  for (const pack of activePacks) {
    const contributed = contributedRules(pack, activePacks,
      onContributeError ? (e) => onContributeError(pack, e) : null);
    for (const rule of [...(pack.rules ?? []), ...(pack.skillChecks ?? []), ...contributed]) {
      if (!includeRule(rule)) continue;
      if (ctx.config.rules[rule.id] === 'off') continue;
      findings.push(...runRule(rule, ctx));
    }
  }
  return findings;
}
