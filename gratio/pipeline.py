"""Area-based g-ratio from raw electron-microscopy cross-sections.

Motivation
----------
The classical g-ratio (inner axon diameter / outer fiber diameter) is measured
along a chosen diameter, so it is sensitive to which cross-section / direction
is used and is skewed when myelin does not hermetically enclose the axon. This
module instead works from **areas**, which are rotation- and direction-
independent, and measures the **actual myelin material** present so that
malformed / non-hermetic myelin correctly reduces the apparent sheath:

    g = sqrt( A_axon / (A_axon + A_myelin) )          # textbook, value < 1

On a perfectly circular, hermetically myelinated axon this reproduces the
diameter-ratio g exactly (sqrt of the area ratio == the radius ratio), so it is
in parity with the standard metric; it diverges only when the myelin is
malformed -- which is the intent. See docs/reference/myeltracer_notes.md.

Pipeline
--------
1. grayscale + bilateral filter (edge-preserving denoise)
2. myelin mask = darkest pixels (percentile threshold); remove speckle
3. fiber detection: close lamellar gaps -> fill holes -> lumens = filled holes
4. keep lumens by area / convex-hull solidity / brightness (axoplasm is bright)
5. per-axon myelin = actual dark pixels in that fiber's sheath, with thin
   inter-lamellar gaps closed (large malformation gaps left open), split
   between touching fibers by nearest lumen
6. g per axon from the area formula above

Known limitation
----------------
Lumen detection relies on the myelin ring being closed enough to enclose a
hole. Severely broken / malformed rings (e.g. the central axon in sample_01)
let the lumen leak into the background and are not yet detected; handling those
is the next iteration (axon-first detection / interactive seeding / ML).
"""
from __future__ import annotations
import cv2
import numpy as np
from scipy.ndimage import binary_fill_holes, distance_transform_edt, label as cc_label

# Default parameters. Override per call via analyze_image(..., **overrides).
DEFAULTS = dict(
    bilateral=(9, 75, 75),   # OpenCV bilateralFilter (d, sigmaColor, sigmaSpace)
    myelin_percentile=23,    # darkest X% of pixels treated as myelin material
    speckle_min=40,          # drop myelin connected components smaller than this (px)
    close_ksize=9,           # morphological close to bridge lamellae for fiber detection
    lumen_open=3,            # smooth lumen boundary / drop pinholes
    min_axon_frac=0.004,     # min lumen area as a fraction of the image
    max_axon_frac=0.45,      # max lumen area as a fraction of the image
    min_solidity=0.70,       # reject leaky / wrap-around lumens (convex-hull based)
    bright_margin=0,         # lumen mean intensity must exceed median(image) + margin
    myelin_fill=11,          # close thin inter-lamellar gaps (keeps large gaps open)
    myelin_band=0.8,         # cap myelin assignment to band * lumen_radius from lumen
)

# Overlay colours (BGR).
AXON_COLOR = (200, 230, 0)    # cyan
MYELIN_COLOR = (40, 40, 230)  # red


def segment(gray: np.ndarray, **overrides) -> dict:
    """Segment axons + myelin and compute the area-based g-ratio per axon.

    Parameters
    ----------
    gray : 2-D uint8 grayscale image.
    **overrides : any key in DEFAULTS.

    Returns a dict with keys: ``axons`` (list of per-axon dicts with id, area,
    myelin_area, g, centroid cx/cy, equivalent radius r, solidity), plus the
    intermediate masks (``gf``, ``T``, ``myelin``, ``lumen_label``, ``assigned``).
    """
    P = {**DEFAULTS, **overrides}
    if gray.ndim != 2:
        gray = cv2.cvtColor(gray, cv2.COLOR_BGR2GRAY)

    gf = cv2.bilateralFilter(gray, *P['bilateral'])
    T = float(np.percentile(gf, P['myelin_percentile']))
    myelin_raw = (gf < T).astype(np.uint8)

    # remove speckle (small connected components)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(myelin_raw, 8)
    keep = np.zeros(n, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= P['speckle_min']
    myelin = keep[lab].astype(np.uint8)

    # close lamellar gaps -> fill holes -> fiber solids; the holes are lumens
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (P['close_ksize'],) * 2)
    myelin_closed = cv2.morphologyEx(myelin, cv2.MORPH_CLOSE, k)
    fiber_solid = binary_fill_holes(myelin_closed.astype(bool))
    lumen = (fiber_solid & ~myelin_closed.astype(bool)).astype(np.uint8)
    if P['lumen_open'] > 1:
        ko = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (P['lumen_open'],) * 2)
        lumen = cv2.morphologyEx(lumen, cv2.MORPH_OPEN, ko)
    # absorb intra-axonal dark granules (interior holes) into the axon
    lumen = binary_fill_holes(lumen.astype(bool)).astype(np.uint8)
    fiber_lab, _ = cc_label(fiber_solid)

    H, W = gray.shape
    minA, maxA = P['min_axon_frac'] * H * W, P['max_axon_frac'] * H * W
    bright_thr = np.median(gf) + P['bright_margin']
    lab_l, nl = cc_label(lumen)
    lumen_keep = np.zeros_like(lab_l)
    axons = []
    next_id = 1
    for i in range(1, nl + 1):
        comp = lab_l == i
        A = int(comp.sum())
        if A < minA or A > maxA:
            continue
        cnts, _ = cv2.findContours(comp.astype(np.uint8), cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
        c = max(cnts, key=cv2.contourArea)
        hullA = cv2.contourArea(cv2.convexHull(c))
        solidity = A / hullA if hullA > 0 else 0.0
        if solidity < P['min_solidity']:
            continue
        if gf[comp].mean() < bright_thr:   # axoplasm is brighter than background
            continue
        lumen_keep[comp] = next_id
        ys, xs = np.where(comp)
        cy, cx = float(ys.mean()), float(xs.mean())
        fid = int(fiber_lab[int(round(cy)), int(round(cx))])
        axons.append(dict(id=next_id, area=A, cx=cx, cy=cy,
                          r=float(np.sqrt(A / np.pi)), solidity=float(solidity),
                          fid=fid))
        next_id += 1

    # Myelin = actual dark pixels in each kept fiber's sheath. Restricting to the
    # lumen's own fiber component excludes far debris; thin inter-lamellar gaps
    # are closed (large malformation gaps stay open); nearest-lumen splits a
    # sheath shared by touching fibers.
    if axons:
        keep_fibers = {a['fid'] for a in axons if a['fid'] > 0}
        sheath = np.isin(fiber_lab, list(keep_fibers)) & (lumen_keep == 0)
        myelin_actual = (myelin > 0) & sheath
        if P['myelin_fill'] > 1:
            kf = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (P['myelin_fill'],) * 2)
            closed = cv2.morphologyEx(myelin_actual.astype(np.uint8), cv2.MORPH_CLOSE, kf)
            myelin_actual = (closed > 0) & sheath

        dist, (iy, ix) = distance_transform_edt(lumen_keep == 0, return_indices=True)
        nearest = lumen_keep[iy, ix]
        r_by_id = np.zeros(next_id)
        for a in axons:
            r_by_id[a['id']] = a['r']
        cap = P['myelin_band'] * r_by_id[nearest]
        assigned = np.where(myelin_actual & (dist <= cap) & (nearest > 0), nearest, 0)
        for a in axons:
            a['myelin_area'] = int((assigned == a['id']).sum())
            tot = a['area'] + a['myelin_area']
            a['g'] = float(np.sqrt(a['area'] / tot)) if tot > 0 else float('nan')
    else:
        assigned = np.zeros_like(lumen_keep)

    return dict(gf=gf, T=T, myelin=myelin, lumen_label=lumen_keep,
                assigned=assigned, axons=axons)


def render(gray: np.ndarray, seg: dict, alpha: float = 0.45) -> np.ndarray:
    """Colour the axon interiors and myelin and label each with its g-ratio."""
    if gray.ndim != 2:
        gray = cv2.cvtColor(gray, cv2.COLOR_BGR2GRAY)
    base = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    overlay = base.copy()
    overlay[seg['lumen_label'] > 0] = AXON_COLOR
    overlay[seg['assigned'] > 0] = MYELIN_COLOR
    out = cv2.addWeighted(overlay, alpha, base, 1 - alpha, 0)
    for a in seg['axons']:
        txt = f"{a['g']:.2f}"
        scale = max(0.5, a['r'] / 45)
        th = max(1, int(scale * 2))
        (tw, tht), _ = cv2.getTextSize(txt, cv2.FONT_HERSHEY_SIMPLEX, scale, th)
        org = (int(a['cx'] - tw / 2), int(a['cy'] + tht / 2))
        cv2.putText(out, txt, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), th + 2, cv2.LINE_AA)
        cv2.putText(out, txt, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), th, cv2.LINE_AA)
    return out


def analyze_image(gray: np.ndarray, **overrides):
    """Convenience: return (overlay_bgr, axons_list) for a grayscale image."""
    seg = segment(gray, **overrides)
    return render(gray, seg), seg['axons']
