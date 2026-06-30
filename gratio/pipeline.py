"""Area-based g-ratio from raw electron-microscopy cross-sections.

Motivation
----------
The classical g-ratio (inner axon diameter / outer fiber diameter) is measured
along a chosen diameter, so it is sensitive to which cross-section / direction
is used and is skewed when myelin does not hermetically enclose the axon. This
module works from **areas**, which are direction-independent:

    g = sqrt( A_axon / (A_axon + A_myelin) )          # textbook, value < 1

On a perfectly circular, hermetically myelinated axon this reproduces the
diameter-ratio g exactly (sqrt of the area ratio == the radius ratio), so it is
in parity with the standard metric; it diverges only when the myelin is
malformed -- which is the intent. See docs/reference/myeltracer_notes.md.

Structural model
----------------
Each fiber is a set of contiguous bodies with **smooth, roughly-closed borders**
(not strict ellipses, and not intricate pixel-following outlines):

* axon   -- a smoothed bright body (the axoplasm); its border is the inner
            border of the myelin.
* myelin -- a smoothed band around the axon (axon border -> outer fiber border),
            of bounded thickness; a band shared by touching fibers is split by
            nearest axon so neighbours are not confused.
* bubble -- a significant bright hole in the band (a vacuole, or a stretch of
            missing / non-hermetic myelin). Bubbles are NOT myelin: they are
            excluded from A_myelin and highlighted -- they are exactly the
            malformation of interest.

Pipeline
--------
1. grayscale + bilateral filter (edge-preserving denoise)
2. myelin mask = darkest pixels (percentile threshold); remove speckle
3. fiber region = myelin closed enough to seal broken rings, then hole-filled;
   isolates each axon's bright body from background even when the ring is broken
4. axon bodies = bright bodies inside fibers passing area / solidity / brightness
5. myelin = dark band touching the axon within a thickness cap; shared band split
   by nearest axon
6. smooth the axon body and the (axon | myelin) region into roughly-closed shapes
7. bubbles = significant bright holes in the smoothed annulus -> excluded
8. g per axon from the area formula above
"""
from __future__ import annotations
import cv2
import numpy as np
from scipy.ndimage import binary_fill_holes, distance_transform_edt, label as cc_label

# Default parameters. Override per call via segment(..., **overrides).
DEFAULTS = dict(
    bilateral=(9, 75, 75),    # OpenCV bilateralFilter (d, sigmaColor, sigmaSpace)
    myelin_percentile=23,     # darkest X% of pixels treated as myelin material
    speckle_min=40,           # drop myelin connected components smaller than this (px)
    close_fiber=27,           # seal broken rings to isolate axon bodies
    myelin_close=11,          # close thin inter-lamellar gaps (keeps large gaps open)
    min_axon_frac=0.004,      # min axon-body area as a fraction of the image
    max_axon_frac=0.60,       # max axon-body area as a fraction of the image
    min_solidity=0.75,        # reject leaky / wrap-around bodies (convex-hull based)
    bright_margin=0,          # axon-body mean intensity must exceed median(image)+margin
    touch_dilate=5,           # myelin must touch the axon within this many px
    myelin_band=0.55,         # myelin thickness cap as a fraction of axon radius
    smooth_frac=0.33,         # border smoothing kernel as a fraction of axon radius
    bubble_min_frac=0.02,     # a hole counts as a bubble if >= this fraction of the axon
    bubble_min_px=250,        # ...and at least this many pixels
)

# Distinct per-axon colours (BGR); myelin is drawn as a darker shade of each.
PALETTE = [
    (0, 200, 255), (235, 180, 0), (0, 220, 100), (255, 90, 200),
    (60, 170, 255), (200, 130, 255), (255, 200, 60), (120, 220, 0),
]
BUBBLE_COLOR = (0, 0, 255)   # red: holes / missing myelin


def _palette(i):
    return PALETTE[i % len(PALETTE)]


def _smooth(mask, k):
    """Round a binary mask into a smooth, roughly-closed shape."""
    ks = int(max(5, k)) | 1
    el = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ks, ks))
    m = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, el)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, el)
    return binary_fill_holes(m > 0)


def segment(gray: np.ndarray, **overrides) -> dict:
    """Segment axon bodies + myelin bands and compute the area-based g-ratio.

    Returns a dict with ``axons`` (list of per-axon dicts: id, area,
    myelin_area, g, centroid cx/cy, equivalent radius r, solidity) and the label
    images ``axon_mask``, ``myelin_mask``, ``fiber_mask`` (int, per-axon) and
    ``bubble`` (bool, excluded holes).
    """
    P = {**DEFAULTS, **overrides}
    if gray.ndim != 2:
        gray = cv2.cvtColor(gray, cv2.COLOR_BGR2GRAY)
    H, W = gray.shape

    gf = cv2.bilateralFilter(gray, *P['bilateral'])
    T = float(np.percentile(gf, P['myelin_percentile']))
    myel = (gf < T).astype(np.uint8)

    n, lab, stats, _ = cv2.connectedComponentsWithStats(myel, 8)
    keep = np.zeros(n, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= P['speckle_min']
    myel = keep[lab].astype(np.uint8)

    kf = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (P['close_fiber'],) * 2)
    fiber = binary_fill_holes(cv2.morphologyEx(myel, cv2.MORPH_CLOSE, kf).astype(bool))
    km = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (P['myelin_close'],) * 2)
    myelin_mat = (cv2.morphologyEx(myel, cv2.MORPH_CLOSE, km) > 0) & fiber
    bright = fiber & ~myelin_mat

    minA, maxA = P['min_axon_frac'] * H * W, P['max_axon_frac'] * H * W
    bright_thr = np.median(gf) + P['bright_margin']
    blab, nb = cc_label(bright)
    axon_lbl = np.zeros((H, W), np.int32)
    cands = []
    aid = 1
    for c in range(1, nb + 1):
        comp = blab == c
        A = int(comp.sum())
        if not (minA <= A <= maxA):
            continue
        cnt = max(cv2.findContours(comp.astype(np.uint8), cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)[0], key=cv2.contourArea)
        hull = cv2.contourArea(cv2.convexHull(cnt))
        sol = A / hull if hull > 0 else 0.0
        if sol < P['min_solidity'] or gf[comp].mean() < bright_thr:
            continue
        comp = binary_fill_holes(comp)          # absorb intra-axonal granules
        axon_lbl[comp] = aid
        ys, xs = np.where(comp)
        cands.append(dict(id=aid, body=comp, cx=float(xs.mean()), cy=float(ys.mean()),
                          r=float(np.sqrt(comp.sum() / np.pi)), solidity=float(sol)))
        aid += 1

    blank = np.zeros((H, W), np.int32)
    if not cands:
        return dict(gf=gf, T=T, axons=[], axon_mask=blank, myelin_mask=blank,
                    fiber_mask=blank, bubble=np.zeros((H, W), bool))

    # myelin band = dark material touching an axon, within a thickness cap
    kd = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (P['touch_dilate'],) * 2)
    seed = cv2.dilate((axon_lbl > 0).astype(np.uint8), kd) > 0
    myl_lab, _ = cc_label(myelin_mat)
    touch = np.unique(myl_lab[seed & myelin_mat])
    touch = touch[touch > 0]
    myelin_keep = np.isin(myl_lab, touch)
    dist, (iy, ix) = distance_transform_edt(axon_lbl == 0, return_indices=True)
    nearest = axon_lbl[iy, ix]
    r_by = np.zeros(len(cands) + 1)
    for a in cands:
        r_by[a['id']] = a['r']
    assigned = np.where(myelin_keep & (nearest > 0) & (dist <= P['myelin_band'] * r_by[nearest]),
                        nearest, 0)

    axon_mask = np.zeros((H, W), np.int32)
    myelin_mask = np.zeros((H, W), np.int32)
    fiber_mask = np.zeros((H, W), np.int32)
    bubble = np.zeros((H, W), bool)
    axons = []
    for a in cands:
        terr = (nearest == a['id']) | (nearest == 0)   # Voronoi territory (split touching fibers)
        k = a['r'] * P['smooth_frac']
        fm = _smooth(binary_fill_holes(a['body'] | (assigned == a['id'])) & terr, k)
        am = _smooth(a['body'] & terr, k) & fm
        annulus = fm & ~am
        holes = annulus & ~myelin_mat
        hl, nh = cc_label(holes)
        gap = np.zeros((H, W), bool)
        bmin = max(P['bubble_min_px'], P['bubble_min_frac'] * am.sum())
        for h in range(1, nh + 1):
            hm = hl == h
            if hm.sum() >= bmin:
                gap |= hm
        myel_here = annulus & ~gap
        A_ax, A_my = int(am.sum()), int(myel_here.sum())
        g = float(np.sqrt(A_ax / (A_ax + A_my))) if A_ax + A_my > 0 else float('nan')
        axon_mask[am] = a['id']
        myelin_mask[myel_here] = a['id']
        fiber_mask[fm] = a['id']
        bubble |= gap
        axons.append(dict(id=a['id'], cx=a['cx'], cy=a['cy'], r=a['r'],
                          solidity=a['solidity'], area=A_ax, myelin_area=A_my, g=g))

    return dict(gf=gf, T=T, axons=axons, axon_mask=axon_mask, myelin_mask=myelin_mask,
                fiber_mask=fiber_mask, bubble=bubble)


def render(gray: np.ndarray, seg: dict, alpha: float = 0.45, references=None) -> np.ndarray:
    """Overlay: per-axon colour fills, smooth axon + myelin borders, bubbles
    highlighted, g-ratio at each centroid. ``references`` optionally maps axon
    id -> reference g (shown beneath ours as ``ref 0.xx``)."""
    if gray.ndim != 2:
        gray = cv2.cvtColor(gray, cv2.COLOR_BGR2GRAY)
    base = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    ov = base.copy()
    for a in seg['axons']:
        col = _palette(a['id'] - 1)
        ov[seg['axon_mask'] == a['id']] = col
        ov[seg['myelin_mask'] == a['id']] = tuple(int(c * 0.5) for c in col)
    out = cv2.addWeighted(ov, alpha, base, 1 - alpha, 0)
    out[seg['bubble']] = BUBBLE_COLOR

    for a in seg['axons']:
        col = _palette(a['id'] - 1)
        for mask, color, thick in [(seg['fiber_mask'] == a['id'], col, 2),
                                   (seg['axon_mask'] == a['id'], (255, 255, 255), 2)]:
            cs, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL,
                                     cv2.CHAIN_APPROX_SIMPLE)
            cv2.drawContours(out, cs, -1, color, thick, cv2.LINE_AA)

    for a in seg['axons']:
        scale = max(0.5, a['r'] / 55)
        th = max(1, int(round(scale * 2)))
        lines = [f"{a['g']:.2f}"]
        if references and a['id'] in references:
            lines.append(f"ref {references[a['id']]:.2f}")
        (tw, tht), _ = cv2.getTextSize(lines[0], cv2.FONT_HERSHEY_SIMPLEX, scale, th)
        y = int(a['cy'] + tht / 2 - (len(lines) - 1) * (tht + 6) / 2)
        for i, txt in enumerate(lines):
            sc = scale if i == 0 else scale * 0.7
            (tw, tht2), _ = cv2.getTextSize(txt, cv2.FONT_HERSHEY_SIMPLEX, sc, th)
            org = (int(a['cx'] - tw / 2), y + i * int(tht * 1.4))
            cv2.putText(out, txt, org, cv2.FONT_HERSHEY_SIMPLEX, sc, (0, 0, 0), th + 3, cv2.LINE_AA)
            cv2.putText(out, txt, org, cv2.FONT_HERSHEY_SIMPLEX, sc, (255, 255, 255), th, cv2.LINE_AA)
    return out


def render_comparison(gray: np.ndarray, seg: dict, gap: int = 8, references=None) -> np.ndarray:
    """Side-by-side [ original | overlay ] so the highlighting can be verified."""
    if gray.ndim != 2:
        gray = cv2.cvtColor(gray, cv2.COLOR_BGR2GRAY)
    left = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    right = render(gray, seg, references=references)
    sep = np.full((gray.shape[0], gap, 3), 255, np.uint8)

    def banner(img, text):
        out = img.copy()
        cv2.rectangle(out, (0, 0), (out.shape[1], 34), (0, 0, 0), -1)
        cv2.putText(out, text, (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                    (255, 255, 255), 2, cv2.LINE_AA)
        return out

    return np.hstack([banner(left, "original"), sep, banner(right, "g-ratio overlay")])


def analyze_image(gray: np.ndarray, **overrides):
    """Convenience: return (comparison_bgr, axons_list) for a grayscale image."""
    seg = segment(gray, **overrides)
    return render_comparison(gray, seg), seg['axons']
