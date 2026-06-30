"""Area-based g-ratio from raw electron-microscopy cross-sections.

Motivation
----------
The classical g-ratio (inner axon diameter / outer fiber diameter) is measured
along a chosen diameter, so it is sensitive to which cross-section / direction
is used and is skewed when myelin does not hermetically enclose the axon. This
module works from **areas**, which are direction-independent, and measures the
**actual myelin material** present so that malformed / non-hermetic myelin
correctly reduces the apparent sheath:

    g = sqrt( A_axon / (A_axon + A_myelin) )          # textbook, value < 1

On a perfectly circular, hermetically myelinated axon this reproduces the
diameter-ratio g exactly (sqrt of the area ratio == the radius ratio), so it is
in parity with the standard metric; it diverges only when the myelin is
malformed -- which is the intent. See docs/reference/myeltracer_notes.md.

Structural model (each fiber is a set of contiguous bodies, not loose pixels)
----------------------------------------------------------------------------
* axon   -- a contiguous bright body (the axoplasm), holes filled.
* myelin -- a contiguous dark band that touches the axon, of bounded thickness;
            it has an outer border and an inner border (= the axon border).
* bubble -- a bright pocket fully enclosed by the sheath, i.e. a hole in the
            myelin. Bubbles are NOT myelin: they are excluded from A_myelin and
            highlighted, because they are exactly the malformation of interest.

Pipeline
--------
1. grayscale + bilateral filter (edge-preserving denoise)
2. myelin mask = darkest pixels (percentile threshold); remove speckle
3. fiber region = myelin closed enough to seal broken rings, then hole-filled;
   this isolates each axon's bright body from the background even when the
   surrounding ring is incomplete (the malformed case)
4. axon bodies = bright bodies inside fibers passing area / solidity /
   brightness; intra-axonal granules are filled in
5. myelin = dark band contiguous with an axon (touching it) within a thickness
   cap; a band shared by touching fibers is split by nearest axon
6. bubbles = enclosed holes in (axon u myelin); excluded from myelin
7. g per axon from the area formula above
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
    close_fiber=27,           # seal broken rings to isolate axon bodies (fiber detection)
    myelin_close=11,          # close thin inter-lamellar gaps (keeps large gaps open)
    min_axon_frac=0.004,      # min axon-body area as a fraction of the image
    max_axon_frac=0.60,       # max axon-body area as a fraction of the image
    min_solidity=0.75,        # reject leaky / wrap-around bodies (convex-hull based)
    bright_margin=0,          # axon-body mean intensity must exceed median(image)+margin
    touch_dilate=5,           # myelin must touch the axon within this many px
    myelin_band=0.5,          # myelin thickness cap as a fraction of axon radius
)

# Distinct per-axon colours (BGR); myelin is drawn as a darker shade of each.
PALETTE = [
    (0, 200, 255),    # amber
    (235, 180, 0),    # blue
    (0, 220, 100),    # green
    (255, 90, 200),   # magenta
    (60, 170, 255),   # orange
    (200, 130, 255),  # pink
    (255, 200, 60),   # cyan-blue
    (120, 220, 0),    # teal-green
]


def _palette(i):
    return PALETTE[i % len(PALETTE)]


def segment(gray: np.ndarray, **overrides) -> dict:
    """Segment axon bodies + myelin bands and compute the area-based g-ratio.

    Returns a dict with ``axons`` (list of per-axon dicts: id, area,
    myelin_area, g, centroid cx/cy, equivalent radius r, solidity) and the label
    images ``axon_lbl`` (int, per-axon), ``assigned`` (int, myelin per-axon), and
    ``bubble`` (bool, excluded holes).
    """
    P = {**DEFAULTS, **overrides}
    if gray.ndim != 2:
        gray = cv2.cvtColor(gray, cv2.COLOR_BGR2GRAY)
    H, W = gray.shape

    gf = cv2.bilateralFilter(gray, *P['bilateral'])
    T = float(np.percentile(gf, P['myelin_percentile']))
    myel = (gf < T).astype(np.uint8)

    # remove speckle (small connected components)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(myel, 8)
    keep = np.zeros(n, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= P['speckle_min']
    myel = keep[lab].astype(np.uint8)

    # fiber region: seal broken rings, then fill -> isolates bright axon bodies
    kf = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (P['close_fiber'],) * 2)
    fiber = binary_fill_holes(cv2.morphologyEx(myel, cv2.MORPH_CLOSE, kf).astype(bool))
    # myelin material: gentle inter-lamellar closing only
    km = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (P['myelin_close'],) * 2)
    myelin_mat = (cv2.morphologyEx(myel, cv2.MORPH_CLOSE, km) > 0) & fiber
    bright_inside = fiber & ~myelin_mat

    minA, maxA = P['min_axon_frac'] * H * W, P['max_axon_frac'] * H * W
    bright_thr = np.median(gf) + P['bright_margin']
    blab, nb = cc_label(bright_inside)
    axon_lbl = np.zeros((H, W), np.int32)
    axons = []
    aid = 1
    for c in range(1, nb + 1):
        comp = blab == c
        A = int(comp.sum())
        if not (minA <= A <= maxA):
            continue
        cnts, _ = cv2.findContours(comp.astype(np.uint8), cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
        cc = max(cnts, key=cv2.contourArea)
        hullA = cv2.contourArea(cv2.convexHull(cc))
        sol = A / hullA if hullA > 0 else 0.0
        if sol < P['min_solidity'] or gf[comp].mean() < bright_thr:
            continue
        comp = binary_fill_holes(comp)          # absorb intra-axonal granules
        axon_lbl[comp] = aid
        ys, xs = np.where(comp)
        axons.append(dict(id=aid, area=int(comp.sum()), cx=float(xs.mean()),
                          cy=float(ys.mean()), r=float(np.sqrt(comp.sum() / np.pi)),
                          solidity=float(sol)))
        aid += 1

    assigned = np.zeros((H, W), np.int32)
    bubble = np.zeros((H, W), bool)
    if axons:
        # myelin band = dark material touching an axon, within a thickness cap
        kd = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (P['touch_dilate'],) * 2)
        seed = cv2.dilate((axon_lbl > 0).astype(np.uint8), kd) > 0
        myl_lab, _ = cc_label(myelin_mat)
        touch = np.unique(myl_lab[seed & myelin_mat])
        touch = touch[touch > 0]
        myelin_keep = np.isin(myl_lab, touch)

        dist, (iy, ix) = distance_transform_edt(axon_lbl == 0, return_indices=True)
        nearest = axon_lbl[iy, ix]
        r_by_id = np.zeros(len(axons) + 1)
        for a in axons:
            r_by_id[a['id']] = a['r']
        cap = P['myelin_band'] * r_by_id[nearest]
        assigned = np.where(myelin_keep & (nearest > 0) & (dist <= cap), nearest, 0)

        # bubbles = enclosed holes in (axon u myelin) -> excluded from myelin
        region = (axon_lbl > 0) | (assigned > 0)
        bubble = binary_fill_holes(region) & ~region

        for a in axons:
            a['myelin_area'] = int((assigned == a['id']).sum())
            tot = a['area'] + a['myelin_area']
            a['g'] = float(np.sqrt(a['area'] / tot)) if tot > 0 else float('nan')

    return dict(gf=gf, T=T, axon_lbl=axon_lbl, assigned=assigned,
                bubble=bubble, axons=axons)


def _axon_region(seg, axon_id):
    """Filled outer region of one fiber (axon + its myelin + enclosed bubbles)."""
    reg = (seg['axon_lbl'] == axon_id) | (seg['assigned'] == axon_id)
    return binary_fill_holes(reg).astype(np.uint8)


def render(gray: np.ndarray, seg: dict, alpha: float = 0.45) -> np.ndarray:
    """Overlay: per-axon colour fills, axon + myelin borders, bubble outlines,
    and the g-ratio drawn at each axon centroid."""
    if gray.ndim != 2:
        gray = cv2.cvtColor(gray, cv2.COLOR_BGR2GRAY)
    base = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    ov = base.copy()
    for a in seg['axons']:
        col = _palette(a['id'] - 1)
        ov[seg['axon_lbl'] == a['id']] = col
        ov[seg['assigned'] == a['id']] = tuple(int(c * 0.5) for c in col)  # myelin = darker shade
    out = cv2.addWeighted(ov, alpha, base, 1 - alpha, 0)

    # bubble outlines (holes in the sheath -> not myelin)
    cs, _ = cv2.findContours(seg['bubble'].astype(np.uint8), cv2.RETR_EXTERNAL,
                             cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(out, cs, -1, (0, 0, 255), 1, cv2.LINE_AA)

    for a in seg['axons']:
        col = _palette(a['id'] - 1)
        myel_out = _axon_region(seg, a['id'])
        cs, _ = cv2.findContours(myel_out, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(out, cs, -1, col, 2, cv2.LINE_AA)             # myelin outer border
        ax = (seg['axon_lbl'] == a['id']).astype(np.uint8)
        cs, _ = cv2.findContours(ax, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(out, cs, -1, (255, 255, 255), 2, cv2.LINE_AA)  # axon border

    for a in seg['axons']:
        txt = f"{a['g']:.2f}"
        scale = max(0.5, a['r'] / 55)
        th = max(1, int(round(scale * 2)))
        (tw, tht), _ = cv2.getTextSize(txt, cv2.FONT_HERSHEY_SIMPLEX, scale, th)
        org = (int(a['cx'] - tw / 2), int(a['cy'] + tht / 2))
        cv2.putText(out, txt, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), th + 3, cv2.LINE_AA)
        cv2.putText(out, txt, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), th, cv2.LINE_AA)
    return out


def render_comparison(gray: np.ndarray, seg: dict, gap: int = 8) -> np.ndarray:
    """Side-by-side [ original | overlay ] so the highlighting can be verified."""
    if gray.ndim != 2:
        gray = cv2.cvtColor(gray, cv2.COLOR_BGR2GRAY)
    left = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    right = render(gray, seg)
    H = gray.shape[0]
    sep = np.full((H, gap, 3), 255, np.uint8)

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
