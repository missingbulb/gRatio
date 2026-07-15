# What we're building here, and where its parts might reach further

Two purposes:

1. **What this project is.** A classic-CV pipeline that measures the myelin
   **g-ratio** from EM cross-sections, area-based
   (`g = sqrt(A_axon / (A_axon + A_myelin))`) so malformed / non-hermetic myelin is
   handled correctly. Everything in `gratio/` serves that one measurement.

2. **Where individual sub-phases might reach further.** Several steps solve a
   *generic* image / morphometry problem that recurs elsewhere in neurobiology.
   This document is the **only** place we record that — the out-of-band home the
   canon's *record cross-domain applicability out-of-band* rule requires
   (`research-project` RULES.md §12): the algorithm code and inline comments stay
   strictly about the g-ratio task and its `A-*` biological assumptions, and a
   pointer entry lands here whenever a sub-phase is built or substantially
   changed. It is a map of pointers, not a roadmap and not a claim of correctness.

## The pipeline in sub-phases (as built)

`gratio/pipeline.py::segment()` unless noted. Each row: what the step does **for
the g-ratio**, then **potential** applicability elsewhere (speculative pointers).

| sub-phase (where) | what it does here | potential neurobiology applications (pointers) |
|---|---|---|
| **Edge-preserving denoise** — bilateral filter | flatten EM speckle without blurring membranes | generic pre-processing for any EM/LM membrane or organelle segmentation |
| **Dark-percentile threshold** (`myelin_percentile`, A-MYELIN-DARK) | pick osmium-dense myelin | detecting any osmiophilic / heavily-stained structure (dense-core vesicles, mitochondria, synaptic densities) |
| **Ring-sealing + hole-fill → compartment isolation** (`close_fiber`) | isolate axoplasm from background through a broken myelin ring | recovering enclosed compartments from **incomplete** boundaries — partially-imaged cells, vacuoles, organelles cut by the section |
| **Bright convex compartment detection** (`min_solidity`/`bright_margin`, A-AXON-CONVEX-BRIGHT) | find axon bodies | soma / nucleus / large-vacuole detection; convexity as a generic "is this one cell body vs a leaky pocket" gate |
| **Measured-thickness cap + distance-transform ring** (`myelin_thickness_mult`) | bound the sheath by its *own* measured thickness (scale-free, no pixel constant) | resolution-independent morphometry of any annular/shell structure (cell wall, capsule, basement membrane thickness) |
| **Thickness-weighted territory split** (A-SHEATHS-MEET-BY-THICKNESS) | divide a shared sheath between touching fibres by `distance / own_thickness` | instance segmentation of **touching** objects by a feature-weighted (not equidistant) watershed — packed cell bodies, glomeruli, tightly-packed axons |
| **Dense-vs-sparse dark follow** (`dense_extend`, A-MYELIN-DENSE) | follow solid-dark myelin outward, stop where it thins to neuropil | compact-vs-loose **tissue-density** mapping; flagging loosening/degenerating compact structures |
| **Interstitial-material assignment** (`junction_fill`, A-JUNCTION-MYELIN) | claim dark material trapped between two packed sheaths | assigning shared extracellular material in densely-packed tissue to its owner |
| **Otsu peel of the inner border** (`axon_otsu_bias`) | place the axolemma at the true inner-myelin edge | local membrane-edge localization inside a coarse region-of-interest |
| **Ridge / vesselness lineness** (Frangi/Sato/meijering; `gratio/lamella.py`, `_refine_outer_membrane`) | enhance thin dark membranes, suppress blobs | detecting **thin filamentous/membranous** structures generally: microtubules, neurofilaments, ER, mitochondrial cristae, microvessels, plasma membranes |
| **Line detection + extend-&-trim** (`gratio/lamella.py::trace_lamellae`; the owner's algorithm) | trace myelin lamellae into clean polylines and reconnect broken ones by good-continuation | (a) **perceptual grouping / reconnection** of any fragmented curvilinear structure — membrane reconstruction, axon/dendrite/vessel **tracing** for connectomics; (b) **lamella count / spacing / periodicity** as direct readouts of myelin **compaction & maturity** — de-/re-myelination, hypomyelination, CMT / MS models (a sibling metric to the g-ratio) |
| **Non-myelin pocket detection** (`detect_nonmyelin`, A-NONMYELIN-BRIGHT) | exclude bright vacuoles/splits from `A_myelin` | quantifying **vacuolation / inclusions / edema / degeneration** as a pathology score |
| **Least-squares spline border refit** (`fit_smooth_border`, Schneider-style) | de-staircase borders without shrinking; vector-like | vectorized morphometry & **SVG/vector export**; shape descriptors (curvature, circularity) for any traced cell |
| **Area-based ratio** (`g = sqrt(A_axon/(A_axon+A_myelin))`) | direction-independent g-ratio | robust morphometry of any **malformed / non-hermetic shell** where a single diameter misleads (partial ensheathment, irregular capsules) |

## Notes

- These are **pointers**, deliberately terse and unvalidated. Chasing any of them
  is its own project; nothing here changes the g-ratio pipeline's scope.
- The one entry that has been *partly* exercised is the lamella tracer: it is used
  in-pipeline only for the outer-boundary trim (`lamella_trim_outer`); its
  count/spacing/reconnection potential above is untested.
