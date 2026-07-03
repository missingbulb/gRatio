# Biological / equipment assumptions baked into the pipeline

This file is a **registry of assumptions that are about the specimen or the
microscope, not about image processing**. They were calibrated on a *3-image*
TEM learning set. If a future sample looks wrong, check here first: a mismatch
against one of these is the likeliest cause, and each entry says how it fails.

Every such assumption is also marked inline in the code with a
`# BIOLOGICAL ASSUMPTION [<id>]` comment, so you can jump between here and the
site that relies on it.

| id | assumption | where | how it fails on mismatched data |
|----|------------|-------|---------------------------------|
| **A-MYELIN-DARK** | Myelin is *darker* than the axoplasm and than most extracellular space (osmium-stained TEM). | `myelin_percentile`, `myelin_fill_percentile` threshold the darkest pixels as myelin. | Inverted-contrast modalities (some SEM) mark axoplasm as "myelin". Needs a polarity flip (`255 - image`), as in `reference_run.py`. |
| **A-MYELIN-LAMELLAR** | The myelin sheath is a stack of *concentric membranes* (lamellae) that render as ridges, and genuine extracellular space is reachable from outside the fibre **without crossing a lamella**. | `membrane_outer_boundary` (opt-in) refines the outer edge by flooding inward from the background, blocked by ridge (meijering+sato) and dark-myelin barriers. | Immature / compact-only / thin myelin with no resolvable lamellae, or magnification too low to resolve them, leaves no ridge barrier → the flood leaks into real myelin and trims it. **This is why the feature is OFF by default** (on the current 3 images it trims real compact myelin through lamella gaps; net ≈ −0.003 IoU). |
| **A-MYELIN-DENSE** | Myelin is *solidly* dark (high local dark-pixel density); extracellular neuropil is only *sparsely* dark (scattered membranes in bright ground). So the sheath can be followed outward through the solid-dark region and it **ends where the density drops to neuropil**. | `dense_extend` (ON) follows the solid dark outward per direction past the thickness cap; extends where the dense run ends in neuropil, keeps the cap where it runs to a touching neighbour (no gap). Fixes locally-thick sheaths the median cap clips. | Fails where neuropil is as densely dark as myelin (very heavy osmium, or magnification so low the neuropil membranes merge) → the follow would run out into the tissue. Also cannot separate two touching sheaths with no bright/sparse gap between them (that boundary is left at the cap — see sample_02 top). |
| **A-ISOLATED-TIGHTER** | An *isolated* fibre's myelin is not much thicker than its own measured ring; dark tissue extending far past that ring is a neighbouring cell, not this fibre's myelin. | `myelin_thickness_mult_isolated` (=1.4) caps an isolated axon's band tighter than a clustered one (`isolation_ramp`). 1.4 is the measured elbow on sample_02: it removes the maximal outer over-reach with the under-reach still at baseline (R31). | A genuinely thick-myelin *isolated* fibre (e.g. large PNS fibre alone in frame) would be clipped, and 1.4 leaves less margin than the old 1.8. **Calibrated on exactly ONE isolated axon (sample_02)** — the single weakest-supported number in the pipeline. |
| **A-SHEATHS-MEET-BY-THICKNESS** | Where two fibres touch, their sheaths meet in proportion to each fibre's *own* myelin thickness (not at the geometric midline). | Thickness-weighted territory: pixel → axon minimising `distance / own_thickness`. | Two touching fibres with very unequal *staining* (not thickness) could be mis-split; assumes thickness, not intensity, sets the meeting line. |
| **A-AXON-CONVEX-BRIGHT** | An axon body is a bright, roughly convex compartment above a size floor. | `min_axon_frac`, `min_solidity`, `bright_margin` in axon detection. | Very small, dark, or highly non-convex axons (severe pathology) may be missed or split. |
| **A-JUNCTION-MYELIN** | Where several fibres pack together, the dark material filling the interstitial pocket *between two adjacent sheaths* is myelin (their touching compact-myelin walls), not another dark structure. | `junction_fill` (ON) closes the inter-fibre gaps (scale-free kernel = `junction_fill_kfrac` × median fibre thickness) and adds back dense-dark pixels flanked by a *second* fibre. Reclaims junction myelin left beyond every axon's cap. | A dark non-myelin process (glial cytoplasm, debris) running through a junction would be absorbed as myelin. Strictly a no-op for isolated fibres (needs two fibres), so it cannot touch sample_02. |
| **A-NONMYELIN-BRIGHT** | Compact myelin is *solidly dark*; a genuine non-myelin pocket embedded in the sheath — a vacuole, a split, or an extracellular inclusion (the tracer's orange *omit* region) — is markedly *brighter* (at axoplasm / background level) and is a *fat* blob, not a thin inter-lamellar gap. | `detect_nonmyelin` (ON, Phase 3): within each fibre's assigned myelin, a region brighter than the dark-myelin threshold that survives an opening scaled to that fibre's *own* measured ring thickness (`nonmyelin_open_frac`) is a pocket; it is excluded from `A_myelin`. The discriminating rules scale with the measured thickness (resolution-independent), g-ratio-prior-free (the only raw-pixel value is `nonmyelin_min_px`, a speckle floor), and a per-fibre cap `nonmyelin_max_frac` bounds how much myelin may be removed. See `_detect_nonmyelin_pockets`. | Fails on immature / lightly-stained myelin whose compact sheath is itself bright (no dark/bright contrast). There the cap **skips the fibre** rather than strip its sheath and inflate g toward 1.0. Low-contrast splits only slightly brighter than the myelin are conservatively **left in** (the thickness-scaled opening drops them), since removing real myelin is worse than missing a faint pocket — e.g. sample_01's dim outer sliver and its thin edge-bay are not recovered. |
| **A-MYELIN-LAMELLAR-CONTINUOUS** | The sheath's *outermost membrane* renders as a **traceable concentric ridge line**, so the fibre's true outer edge lies **on** that outermost lamella. | `lamella_trim_outer` (ON, but self-gated to a **single detected neuron**; code in `gratio/lamella.py`) traces the lamellae as ridge polylines (`trace_lamellae`) and pulls the lone fibre's over-reaching outer boundary **inward** to the outermost lamella within `lamella_band_frac` × its own measured thickness (trim-only; never grows). Stacks on the R31 cap re-sweep (`myelin_thickness_mult_isolated` 1.8 → 1.4): sample_02 myelin IoU 0.883 → 0.897. See `docs/reference/lamella_continuation.md`. | Immature / compact-only or low-magnification myelin has no resolvable outermost lamella → nothing to trim to (no-op). At a **shared wall** the outer lamella is the neighbour's too, so that over-reach is not trimmed. Gated to single-neuron images (with ≥2 fibres a shared outer lamella merges with the neighbour's — selection is ambiguous); calibrated on the **one** isolated axon (sample_02). Distinct from A-MYELIN-LAMELLAR (that floods *inward from background* blocked by ridges; this traces the *outermost line* and trims to it — constructive, not subtractive). |

## Scale-dependence (equipment, not biology)

Separately, several parameters are still in **raw pixels** and therefore tied to
this data's magnification (nm/pixel): `speckle_min`, `close_fiber`,
`myelin_close`, `bilateral`, `smooth_max_px`, `border_min_radius`, and the
`nonmyelin_min_px` pocket speckle-floor (a lower bound only; the pocket size is
otherwise `(nonmyelin_min_thick × thickness)²`, and the fatness gate is the
thickness-scaled opening — both scale-free). The outer-myelin *cap* and the
non-myelin-pocket detector's opening are **not** among these — they scale with
each axon's own measured thickness. Parsing the burn-in scale bar (currently only inpainted, not
read) would let the pixel parameters be re-expressed in physical units; see the
F5 note in `continuation.md`.

## Why this registry exists

The learning set is 3 images. Some choices that raise agreement here encode a
biological prior that may not generalise. Rather than hide them inside tuned
constants, they are named, located, and given a failure mode, so that when new
samples arrive the first diagnostic step — "which assumption did this sample
break?" — is fast.
