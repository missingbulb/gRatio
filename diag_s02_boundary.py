#!/usr/bin/env python3
"""The decisive image behind 'the neighbour-split cannot fix sample_02'
(docs/reference/learned_outer_boundary.md). Detect the neighbouring fibres'
bright axoplasm (undetected because edge-cropped) and draw the two candidate
split boundaries against GT:

  white   = GT outer myelin border (truth)
  black   = our current prediction (over-reaches)
  cyan    = geometric-midline split
  magenta = thickness-weighted split
  teal    = detected neighbour axoplasm (the seeds)

Both cyan and magenta cut INSIDE the white almost everywhere -- the neighbours
crowd sample_02 on all sides while its own myelin is thick, so any midline falls
inside the true border except where we actually over-reach. -> geometry can't win;
a learned outer boundary is the next route.
"""
import os, cv2, numpy as np
from scipy.ndimage import distance_transform_edt, binary_fill_holes, label as cc_label
from gratio import segment
from gratio.pipeline import DEFAULTS, _remove_scalebar

P = DEFAULTS
GT = 'data/samples/masks/native'
OUT = 'outputs/diag'; os.makedirs(OUT, exist_ok=True)


def neighbor_seeds(gray, axon_mask, nbr_frac=0.008):
    """Large bright compartments enclosed by myelin that are NOT detected axons
    (edge-cropped neighbours)."""
    gray = _remove_scalebar(gray)
    H, W = gray.shape
    gf = cv2.bilateralFilter(gray, *P['bilateral'])
    myel = (gf < np.percentile(gf, P['myelin_percentile'])).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(myel, 8)
    keep = np.zeros(n, bool); keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= P['speckle_min']
    myel = keep[lab].astype(np.uint8)
    kf = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (P['close_fiber'],) * 2)
    mc = cv2.morphologyEx(myel, cv2.MORPH_CLOSE, kf)
    framed = mc.copy(); framed[0, :] = framed[-1, :] = framed[:, 0] = framed[:, -1] = 1
    enclosed = binary_fill_holes(framed.astype(bool))
    sep = enclosed & ~mc.astype(bool)
    slab, ns = cc_label(sep)
    bright_thr = np.median(gf) + P['bright_margin']
    seeds = np.zeros((H, W), np.int32); sid = 1
    for c in range(1, ns + 1):
        comp = slab == c; A = int(comp.sum())
        if A < nbr_frac * H * W or gf[comp].mean() < bright_thr:
            continue
        if (comp & (axon_mask > 0)).sum() > 0.05 * A:
            continue
        seeds[comp] = sid; sid += 1
    return seeds


stem = 'sample_02'
gray = cv2.imread(f'data/samples/{stem}.png', 0)
seg = segment(gray)
gf = cv2.imread(f'{GT}/{stem}_gt_fiber.png', cv2.IMREAD_UNCHANGED).astype(np.int32)
H, W = gray.shape
nbr = neighbor_seeds(gray, seg['axon_mask'])
gfb = cv2.bilateralFilter(gray, *P['bilateral'])
dark = (gfb < np.percentile(gfb, P['myelin_fill_percentile'])).astype(np.float32)
densef = cv2.boxFilter(dark, -1, (P['dense_extend_win'],) * 2) > P['dense_extend_thr']

seedmap = seg['axon_mask'].astype(np.int32).copy()
for j in [v for v in np.unique(nbr) if v > 0]:
    seedmap[(nbr == j) & (seedmap == 0)] = -j
ids = [v for v in np.unique(seedmap) if v != 0]
D = {i: distance_transform_edt(seedmap != i) for i in ids}
near = np.array(ids)[np.argmin(np.stack([D[i] for i in ids], 0), 0)]
dmin = distance_transform_edt(seedmap == 0)
thick = {}
for i in ids:
    d = dmin[densef & (near == i) & (seedmap == 0)]
    thick[i] = float(np.median(d)) if d.size else 10.0
axid = [v for v in ids if v > 0][0]
own_geo = np.array(ids)[np.argmin(np.stack([D[i] for i in ids], 0), 0)]
own_tw = np.array(ids)[np.argmin(np.stack([D[i] / max(thick[i], 1e-3) for i in ids], 0), 0)]
fib = binary_fill_holes(seg['fiber_mask'] == axid)

vis = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
for j in [v for v in np.unique(nbr) if v > 0]:
    vis[nbr == j] = (0.5 * vis[nbr == j] + np.array([40, 40, 0])).astype(np.uint8)
def border(m, col, th=2):
    cs, _ = cv2.findContours(m.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(vis, cs, -1, col, th)
border(gf > 0, (255, 255, 255), 3)
border(fib, (0, 0, 0), 2)
border(fib & (own_geo == axid), (255, 255, 0), 2)
border(fib & (own_tw == axid), (255, 0, 255), 2)
cv2.imwrite(f'{OUT}/s02_boundary.png', vis)
nbr_thicks = {int(i): round(thick[i], 1) for i in ids if i < 0}
print(f'axon thick={thick[axid]:.1f}  neighbour thicks={nbr_thicks}')
print(f'-> {OUT}/s02_boundary.png  (white=GT, black=pred, cyan=geo-split, magenta=tw-split, teal=neighbours)')
