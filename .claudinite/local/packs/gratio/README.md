# gratio pack (local)

gRatio's own pack: the g-ratio measurement invariants and repo mechanics that no
canon pack homes. The project *class* — algorithm over similarly-formatted
inputs, scored against annotated ground truth, improved in reviewable iterations
— is the declared canon `research-project` pack, and this pack deliberately
repeats none of it. Declared by hand as `local/gratio`.

## Checks (`rules`)

| Rule | Section (≤5 words) | How enforced |
|---|---|---|
| `gratio-no-sample-special-casing` | No single-sample special-casing | check — `gratio/*.py` (main path, spikes excluded) may not name a sample stem in code; comments and docstrings citing a sample as evidence are fine |
| `gratio-generated-gt-masks` | Native GT masks are generated | check (work scope) — `data/samples/masks/native/*.png` may not change without the annotated crop or the extraction that produces them |
| `gratio-optional-skimage-import` | scikit-image imported lazily | check — scikit-image is dev-only; the main path imports it inside a guarded function, so the pipeline degrades instead of failing to import |

## Prose (`RULES.md`) — by section

| Section (≤5 words) | How enforced |
|---|---|
| Myelin rules stay scale-free | prose |
| Recall is the hard constraint | prose |
| Two validation tiers, never merged | prose |
| Borders look hand-traced | prose |
| Show report.py, write R-note | prose |

## Fixtures

`node --test .claudinite/local/packs/gratio/pack.test.mjs` — each rule fires on a
violating input and stays quiet on the repo as it actually stands.

Distilled from this repo's `CLAUDE.md` design principles, `docs/reference/user_masks.md`
(R20, R24), `docs/reference/external_datasets.md`, `requirements-dev.txt`, and the
guarded scikit-image imports in `gratio/pipeline.py` and `gratio/lamella.py`.
