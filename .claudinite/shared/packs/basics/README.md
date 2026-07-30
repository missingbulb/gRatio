# basics pack

The baseline pack — the `RULES.md` prose every session loads (injected by the pack-prose hook) plus the core checks. Declared explicitly like every other pack — no pack is active by default; bootstrap seeds the declaration and the nightly baselining backfills it into existing consumers.

## Prose (`RULES.md`)

| Rule (≤5 words) | How enforced |
|---|---|
| Start from the problem, not solution | prose |
| Confirm behavior isn't already provided | prose |
| A misread ≠ a wrong artifact | prose |
| Clean-room rebuild from the source | prose |
| Fix warnings, never tolerate them | prose |
| Never quick-path a warning suppression | prose + check (`warning-suppression`) |
| An approval applies only backward | prose |
| Task lifecycle: issue → branch → PR | prose + check (`task-lifecycle`) |
