// chrome-extension-release's reusable workflows + composite actions moved out of
// Claudinite core (.github/) and into the pack, vendored into each consumer's own
// .github/ (#276). GitHub only resolves a reusable workflow / composite action
// from a repo's own .github/, never from a packs/… subdir, so "into the pack"
// means the pack holds the templates and each consumer hosts a managed copy.
//
// This record is the transition's whole machinery:
//   - appliesTo    — the gate: only a repo whose orchestrator is named
//                    "Release to Chrome Store" (the consumers). Claudinite carries
//                    a file of the same path named "… (reusable)", so it's skipped.
//   - materialize  — vendor the four reusable workflows + three composite actions
//                    verbatim into the consumer's .github/ (idempotent; overwrites
//                    on drift, so a hand-edited copy self-heals).
//   - rewrite      — repoint the orchestrator's three cross-repo @main calls at the
//                    local vendored files, preserving any per-repo build_env tweak.
//   - legacyPresent — fleet telemetry: still on the old shape while anything under
//                    .github/workflows/ references Claudinite's core release
//                    workflows @main.
//   - retire:'auto' + retireDeletesFromHome — once the retire pass sees 0 repos on
//                    the old shape, it deletes Claudinite's now-unused core release
//                    plumbing from the canon repo, then this record. The check-layer
//                    tolerance is driven by migrationActive('chrome-release-vendoring')
//                    (registry.mjs), so it vanishes in the same step this file is
//                    deleted — nothing inline is stranded, so 'auto' is honest.
//
// The automatic deletion is done by the migration retire pass over daily
// maintenance's own access to the canon repo (no special grant) — once the fleet has
// vendored the copy, so the canon ends with no leftovers.
const STUB = '.github/workflows/chrome-extension-release.yml';
const S = 'packs/chrome-extension-release/stubs';

export default {
  id: 'chrome-release-vendoring',
  landed: '2026-07-13',
  summary: 'chrome-extension-release reusable workflows + composite actions vendored from Claudinite core into each consumer repo (#276)',

  // Only touch a repo that ships the pipeline — its orchestrator is named
  // "Release to Chrome Store" (or the legacy "Release"). `read(path)` returns the
  // file's content or null.
  appliesTo: async (read) => {
    const text = await read(STUB);
    if (!text) return false;
    const name = /^name:\s*['"]?(.+?)['"]?\s*$/m.exec(text)?.[1];
    return name === 'Release to Chrome Store' || name === 'Release';
  },

  // Vendor the reusable workflows + actions verbatim (the create-package reusable
  // is renamed from chrome-extension-release.yml to avoid colliding with the
  // orchestrator's own filename inside one repo).
  materialize: [
    { template: `${S}/workflows/chrome-extension-create-package.yml`, dest: '.github/workflows/chrome-extension-create-package.yml' },
    { template: `${S}/workflows/chrome-extension-publish-store.yml`, dest: '.github/workflows/chrome-extension-publish-store.yml' },
    { template: `${S}/workflows/chrome-extension-daily-release.yml`, dest: '.github/workflows/chrome-extension-daily-release.yml' },
    { template: `${S}/workflows/deploy-privacy-page.yml`, dest: '.github/workflows/deploy-privacy-page.yml' },
    { template: `${S}/actions/read-release-config/action.yml`, dest: '.github/actions/read-release-config/action.yml' },
    { template: `${S}/actions/read-release-config/read-config.mjs`, dest: '.github/actions/read-release-config/read-config.mjs' },
    { template: `${S}/actions/bump-extension-patch/action.yml`, dest: '.github/actions/bump-extension-patch/action.yml' },
    { template: `${S}/actions/bump-extension-patch/bump.mjs`, dest: '.github/actions/bump-extension-patch/bump.mjs' },
    { template: `${S}/actions/report-failure/action.yml`, dest: '.github/actions/report-failure/action.yml' },
  ],

  // Repoint the orchestrator's three @main calls at the local vendored files.
  rewrite: [
    { file: STUB, replace: [
      { from: 'missingbulb/Claudinite/.github/workflows/chrome-extension-release.yml@main', to: './.github/workflows/chrome-extension-create-package.yml' },
      { from: 'missingbulb/Claudinite/.github/workflows/chrome-extension-publish-store.yml@main', to: './.github/workflows/chrome-extension-publish-store.yml' },
      { from: 'missingbulb/Claudinite/.github/workflows/chrome-extension-daily-release.yml@main', to: './.github/workflows/chrome-extension-daily-release.yml' },
    ] },
  ],

  // A repo is still on the legacy shape while anything under .github/workflows/
  // still references Claudinite's core release workflows @main.
  legacyPresent: async (exists, read) => {
    const text = (await read(STUB)) || '';
    return text.includes('missingbulb/Claudinite/.github/workflows/chrome-extension-');
  },

  // retire: 'manual' — the fleet has fully vendored (0 repos on the legacy shape),
  // but this record is NOT safe to auto-retire: deleting it + retireDeletesFromHome
  // strands a web of inline references the retire pass does not clean — the barriers
  // `except` entries in the canon's .claudinite-checks.json that excuse those core
  // files, the .github/workflows/README.md links to them, and this migration's own
  // tests (migrations.test.mjs asserts migrationActive('chrome-release-vendoring')
  // and the deletion-set length). Auto-retiring broke the canon's CI (53 stale-ref
  // findings + 2 tests). Retire it by hand in one change that also prunes those
  // references (and consider teaching the retire pass to sweep references, or
  // driving these tolerances off resolvePath, before flipping back to 'auto').
  retire: 'manual',
  // Claudinite's now-unused core release plumbing, deleted on retirement (each
  // file explicitly — the Contents API deletes files, not directories; an emptied
  // action dir drops out with its last file).
  //
  // report-failure is deliberately EXCLUDED from this deletion set: it is shared
  // canon infrastructure, NOT chrome-release-exclusive. Another (non-chrome) pack's
  // vendored coverage-workflow stub (stubs/fleet-coverage.yml) references
  // `…/.github/actions/report-failure@main`, and it is the general
  // unattended-workflow failure reporter documented across the fleet's consumer
  // repos. This migration's legacyPresent probe only inspects the
  // chrome-extension-release *stub*, so its "0 repos on the legacy shape" signal says
  // nothing about those non-chrome @main callers — deleting report-failure on that
  // signal would break that other pack's coverage workflow on its next
  // materialization. The four release *workflows* being deleted here
  // reference report-failure @main internally, but those references vanish with the
  // files; the canon action itself must survive for the non-chrome callers. Chrome
  // consumers keep working via the copy `materialize` vendors into each of them.
  // (Retiring report-failure itself, if ever, belongs to whatever owns that shared
  // action — not to this chrome-release migration.)
  retireDeletesFromHome: [
    '.github/workflows/chrome-extension-release.yml',
    '.github/workflows/chrome-extension-publish-store.yml',
    '.github/workflows/chrome-extension-daily-release.yml',
    '.github/workflows/deploy-privacy-page.yml',
    '.github/actions/read-release-config/action.yml',
    '.github/actions/read-release-config/read-config.mjs',
    '.github/actions/bump-extension-patch/action.yml',
    '.github/actions/bump-extension-patch/bump.mjs',
  ],
};
