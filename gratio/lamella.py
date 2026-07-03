"""Lamella tracing + a trim-only outer-boundary refinement (opt-in; single fibre).

This is an **optional refinement of the g-ratio pipeline's myelin OUTER boundary**,
kept in its own module because it is not part of the core g-ratio path: it is
scikit-image-dependent, carries a biological prior (A-MYELIN-LAMELLAR-CONTINUOUS),
and only acts when the image contains a **single** detected neuron. All it does is
sharpen the myelin outer edge -- i.e. the ``A_myelin`` term of
``g = sqrt(A_axon / (A_axon + A_myelin))`` -- for a lone fibre whose sheath
over-reaches into extracellular neuropil; it is a strict no-op otherwise.

``pipeline.segment()`` calls :func:`lamella_trim_outer` from a single gated hook
(``P['lamella_trim_outer']``). The core pipeline never depends on this module.

See:
- ``docs/reference/lamella_continuation.md`` -- the full method, evidence, and standing.
- ``docs/reference/neurobiology_applications.md`` -- where the *tracer* (:func:`trace_lamellae`)
  is noted as potentially reusable for other neurobiology problems (lamella
  count/spacing as a myelin-compaction readout, general membrane tracing, etc.).
"""
from __future__ import annotations
import cv2
import numpy as np
from scipy.ndimage import binary_fill_holes, distance_transform_edt, label as cc_label


def trace_lamellae(gray, ridge_pct, min_len, max_tort):
    """Phase-A line detection: ridge (sato+meijering) -> threshold -> skeletonize
    -> split at junctions -> trace arcs into polylines -> length + tortuosity
    filter. Returns a rasterized 1-px lamella mask (or None if scikit-image is
    unavailable). Blobs (ribosomes/vesicles) are rejected by the tortuosity
    filter; only line-like fragments survive."""
    try:
        from skimage.filters import sato, meijering
        from skimage.morphology import skeletonize
    except Exception:
        return None
    b = cv2.bilateralFilter(gray, 9, 75, 75).astype(float) / 255.0

    def _n(a):
        lo, hi = np.percentile(a, [1, 99]); hi = hi if hi > lo else lo + 1
        return np.clip((a - lo) / (hi - lo), 0, 1)
    R = np.maximum(_n(sato(b, sigmas=range(1, 6), black_ridges=True)),
                   _n(meijering(b, sigmas=range(1, 6), black_ridges=True)))
    sk = skeletonize(R > np.percentile(R, ridge_pct))
    n8 = np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]], np.uint8)
    deg = cv2.filter2D(sk.astype(np.uint8), -1, n8) * sk
    arcs = sk & (deg < 3)                                # split at junctions (>=3 neighbours)
    lab, nlab = cc_label(arcs, structure=np.ones((3, 3)))
    H, W = gray.shape
    L = np.zeros((H, W), np.uint8)
    for i in range(1, nlab + 1):
        coords = np.argwhere(lab == i)
        if len(coords) < min_len:
            continue
        pts = set(map(tuple, coords))

        def nbrs(p):
            y, x = p
            return [(y + dy, x + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                    if (dy or dx) and (y + dy, x + dx) in pts]
        ends = [p for p in pts if len(nbrs(p)) == 1]
        cur = ends[0] if ends else next(iter(pts))
        order = [cur]; used = {cur}
        while True:
            nxt = [q for q in nbrs(cur) if q not in used]
            if not nxt:
                break
            cur = min(nxt, key=lambda q: (q[0] - order[-1][0]) ** 2 + (q[1] - order[-1][1]) ** 2)
            order.append(cur); used.add(cur)
        poly = np.array(order, float)
        seg_len = float(np.sum(np.linalg.norm(np.diff(poly, axis=0), axis=1)))
        e2e = float(np.linalg.norm(poly[0] - poly[-1])) + 1e-6
        if seg_len < min_len or seg_len / e2e > max_tort:   # too short / too wiggly (blob)
            continue
        cv2.polylines(L, [poly[:, ::-1].round().astype(np.int32)], False, 1, 1)
    return cv2.dilate(L, np.ones((3, 3), np.uint8)) > 0


def lamella_trim_outer(gray, axon_mask, fiber_mask, axons, P):
    """Pull a lone fibre's outer over-reach INWARD to the outermost traced myelin
    lamella (the owner's line-detection method, in trim-only form).

    # BIOLOGICAL ASSUMPTION [A-MYELIN-LAMELLAR-CONTINUOUS] -- see docs/reference/assumptions.md:
    # the sheath's OUTERMOST membrane renders as a traceable concentric ridge line, so the fibre's
    # true outer edge lies ON that outermost lamella. Detect lamellae as ridge lines (sato+meijering),
    # skeletonize + trace + tortuosity-filter into polylines, and for each radial direction pull the
    # (over-reaching) outer boundary INWARD to the outermost lamella lying within a fraction of the
    # fibre's OWN measured thickness. TRIM-ONLY: it never grows the boundary, so floating neuropil
    # ridges beyond it cannot pull it outward. Gated to a SINGLE detected neuron: with two or more
    # fibres a shared outer lamella merges with the neighbour's, where line cues cannot say which is
    # whose (four selection cues -- radius / connectivity / crossing-density / concentricity -- all hit
    # an FP<->FN wall; see the doc). Fails where the outermost lamella is unresolved (immature/compact-
    # only or low magnification -> nothing to trim to) and does not trim a shared-wall over-reach.
    """
    if len(axons) != 1:                     # single-neuron gate (see module docstring)
        return axon_mask, fiber_mask
    L = trace_lamellae(gray, P['lamella_ridge_pct'], P['lamella_min_len'], P['lamella_max_tort'])
    if L is None:
        return axon_mask, fiber_mask
    H, W = gray.shape
    rays = 720
    for a in axons:
        i = a['id']
        am = axon_mask == i
        cur = fiber_mask == i
        if not cur.any() or not am.any():
            continue
        cx, cy = a['cx'], a['cy']
        dax = distance_transform_edt(~am)
        th = float(np.median(dax[cur & ~am])) if (cur & ~am).any() else 10.0
        band = int(round(P['lamella_band_frac'] * th))
        newtop = np.zeros(rays)
        for k in range(rays):
            ang = 2 * np.pi * k / rays
            dx, dy = np.cos(ang), np.sin(ang)
            rc = 0                                   # current fibre outer radius along this ray
            for r in range(int(a['r'] + 3 * th + 50), 0, -1):
                x = int(round(cx + dx * r)); y = int(round(cy + dy * r))
                if 0 <= x < W and 0 <= y < H and cur[y, x]:
                    rc = r; break
            best = rc
            for r in range(rc, max(1, rc - band), -1):   # outermost lamella within band, r <= rc
                x = int(round(cx + dx * r)); y = int(round(cy + dy * r))
                if 0 <= x < W and 0 <= y < H and L[y, x]:
                    best = r; break
            newtop[k] = best
        pad = 6                                       # angular-median smooth (good-continuation)
        extv = np.concatenate([newtop[-pad:], newtop, newtop[:pad]])
        sm = np.array([np.median(extv[j:j + 2 * pad + 1]) for j in range(rays)])
        angs = 2 * np.pi * np.arange(rays) / rays
        px = cx + np.cos(angs) * sm; py = cy + np.sin(angs) * sm
        env = np.zeros((H, W), np.uint8)
        cv2.fillPoly(env, [np.stack([px, py], 1).round().astype(np.int32)], 1)
        fm = binary_fill_holes((env > 0) | am) & cur    # trim-only: stays within the current fibre
        fiber_mask = np.where(fiber_mask == i, 0, fiber_mask)
        fiber_mask = np.where(fm, i, fiber_mask)
    return axon_mask, fiber_mask
