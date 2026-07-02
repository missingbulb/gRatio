# Research thread: a LEARNED outer-myelin boundary for isolated fibres

Status: **open / next up.** This is the active follow-up after R30. Read this
before touching sample_02's outer boundary again — it records why every
geometric route was exhausted and the concrete learned-model route to try next.

## The problem this addresses

sample_02 is a single isolated fibre whose **outer** myelin boundary we
consistently over-reach (myelin IoU stuck ≈0.842; the error is almost all
false-positive over-reach, worst at the top-left where it shares a wall with an
edge-cropped neighbour). See the per-region error map in `user_masks.md` item 12
and `diag_s02_diff.py`.

### Why it is a genuine wall for geometry (all confirmed, not assumed)

1. **Isotropic cap can't fit it** (`diag_s02_capsweep.py`). sample_02's true
   myelin is thin where it shares the top wall and thick on the sides. One
   median-thickness cap tuned to the thick sides necessarily over-reaches the thin
   top; tightening it trades top over-reach for side under-reach with **no clean
   optimum** (FP 29k→11k only as FN 11k→60k).
2. **Neighbour-split cuts inside GT** (`diag_s02_boundary.py`, image
   `s02_boundary.png`). Detecting the neighbour's bright axoplasm and splitting the
   shared wall (equidistant OR thickness-weighted) fails: the neighbours crowd
   sample_02 on *all* sides while its own myelin is thick, so any midline falls
   inside the true border everywhere except the one spot we over-reach. Dropped
   whole-image myelin 0.842 → ~0.50.
3. **No local signal separates the over-reach** — it *is* the neighbour's myelin,
   texturally identical (six discriminators tested across the session: brightness,
   meijering/sato ridge strength, structure-tensor coherence, concentric
   orientation, radial continuity, radial periodicity — all statistically identical
   between real myelin and over-reach).

Conclusion reached with the owner: this boundary needs a **learned appearance/
shape prior**, not another hand-crafted rule.

## The empirical clue (owner, 2026-07)

The owner opened sample_02 in macOS **Preview** and used **Remove Background** —
it isolated the fibre's outer boundary *perfectly*, i.e. it solved exactly the
boundary geometry can't.

### What Preview's "Remove Background" actually is

- Since macOS 14 Sonoma, Preview/Finder → Remove Background calls **one Vision
  request: `VNGenerateForegroundInstanceMaskRequest`** (see
  `VNInstanceMaskObservation` in Apple docs). Same tech as iOS 16 "lift subject."
- It is a **trained deep neural network** (salient-object / foreground-instance
  segmentation), run **on-device** (Neural Engine). Not a classical algorithm.
- It detects foreground instances, merges them into one mask, composites as alpha.
- It works here because it has a **learned prior for "one coherent object vs
  background"** — the isolated fibre reads as a single high-contrast subject.

### Two caveats that scope where this can help

1. **Single-subject foreground/background only.** Perfect for an *isolated* fibre
   (sample_02). On clusters (sample_01/03) it returns the whole cluster as one
   blob — it cannot split fibre-from-fibre, only fibre-from-background. So this is
   an **isolated-fibre outer-bound refiner**, not a general replacement.
2. **Outer boundary, not the inner split.** The "subject" = axon+myelin together.
   That's fine: the outer myelin bound is sample_02's unsolved problem; the inner
   axon border is already strong (axon IoU 0.963).

## Recreation routes (in priority order to try)

| route | what | fidelity | fits the Python pipeline |
|-------|------|----------|--------------------------|
| **`rembg` + BiRefNet** (or U²-Net) | open-source trained salient-object-detection DNNs, ONNX, CPU/GPU | *analogous* to Apple's, not identical | **yes** — drops in. BiRefNet is SOTA-2025 (reported IoU≈0.87). Needs Python ≥3.10; model 40–300 MB auto-downloads to `~/.u2net`. |
| **SAM / SAM2** (Meta) | prompt-based (box/point on the fibre) → mask | very strong, controllable | yes, but needs a prompt (we have the axon centroid → free point prompt) |
| **Native Mac CLI** `stroniarz/remove-bg` | calls the *exact* `VNGenerateForegroundInstanceMaskRequest` | identical to what the owner saw | Mac-only, outside the pipeline (good for a fidelity baseline) |

Honest caveat: rembg/BiRefNet/SAM are trained on **natural photos**, not TEM.
Preview generalised well, but that is not guaranteed on harder crops (low
contrast, dense clusters). The robust endpoint is to **fine-tune a segmentation
model on the owner's hand-traced masks** — the same "learn a shape prior from
more samples" conclusion, now with a concrete architecture.

## Concrete next experiment

1. `pip install rembg onnxruntime` (env has proxied HTTPS; model downloads on
   first run).
2. Crop sample_02 to the fibre bbox (pad ~20%), run rembg with `birefnet-general`
   (and `u2net` for comparison); take the returned alpha as the fibre mask.
3. Score its **outer** boundary against `data/samples/masks/native/sample_02_gt_fiber.png`
   (fibre IoU) and derive myelin = mask − our axon; compare to the current 0.842.
   Reuse the scoring in `diag_s02_diff.py`.
4. Also run it on an isolated crop from sample_01/03 to check generalisation, and
   on a *cluster* crop to confirm it merges (documents the single-subject limit).

### If it reproduces Preview's result — integration sketch

- Add an **opt-in** param (e.g. `learned_outer=True`, default **OFF** — it adds a
  heavy ML dep and a biological-prior-free but training-distribution-dependent
  model). Register the assumption (call it **A-LEARNED-FOREGROUND**: "an isolated
  fibre is the salient foreground object in its bounding crop").
- **Gate it to isolated fibres only** — reuse the existing isolation signal
  (`isolation_ramp`; a lone detected axon has `ratio=inf`). Clusters keep the
  current geometric pipeline untouched (this is the same gate that makes
  `junction_fill` a no-op on sample_02, applied in reverse).
- Use the learned mask as the **outer** boundary only; keep our inner axon border
  (Otsu peel) and the final spline refit. Intersect, don't replace.
- Verify no regression on sample_01/03 and that recall/precision stay 1.00.

## Files

- `diag_s02_diff.py` — per-region FP/FN error map for sample_02 (red=over, blue=missed).
- `diag_s02_boundary.py` → `s02_boundary.png` — the decisive image: GT vs prediction
  vs the two neighbour-split boundaries; shows why the split cuts inside GT.
- `diag_s02_capsweep.py` — isotropic-cap sweep proving FP/FN are coupled (no optimum).
- `diag_s03_diff.py` — sample_03 error map (motivated R30 junction fill).

Sources:
- Apple, `VNInstanceMaskObservation` / `VNGenerateForegroundInstanceMaskRequest`.
- rembg (danielgatis/rembg); BiRefNet vs rembg vs U²-Net comparisons (2025).
- stroniarz/remove-bg (native macOS Vision CLI).
</content>
