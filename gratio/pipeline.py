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
3. seal broken rings (morphological close) and frame the image border, so axon
   compartments -- including ones cropped by the image edge -- are isolated from
   the background by the surrounding myelin
4. axon bodies = compartments passing area / convex-hull solidity / brightness
   (solidity rejects non-axon corner pockets, which are far less convex)
5. myelin = dark band touching the axon within a thickness cap; a band shared by
   touching axons is split by nearest axon
6. smooth the axon body and the (axon | myelin) region into roughly-closed shapes
   (smoothing kernel capped so large axons are not distorted)
7. bubbles = significant bright holes in the smoothed annulus -> excluded
8. g per axon from the area formula above

Note: steps 2-4 currently assume myelin is darker than the axoplasm (true for
these TEM samples). Inverted-contrast (e.g. SEM) data needs a polarity step.
"""
from __future__ import annotations
import cv2
import numpy as np
from scipy.ndimage import (binary_fill_holes, binary_propagation,
                           distance_transform_edt, label as cc_label)
from scipy.interpolate import splprep, splev

# Default parameters. Override per call via segment(..., **overrides).
DEFAULTS = dict(
    remove_scalebar=True,     # detect & inpaint a burn-in scale-bar ruler + label before segmenting
    bilateral=(9, 75, 75),    # OpenCV bilateralFilter (d, sigmaColor, sigmaSpace)
    myelin_percentile=28,     # darkest X% of pixels treated as myelin (axon separation / detection)
    myelin_fill_percentile=42,  # more inclusive % for the band + inner border (None -> = myelin_percentile).
                              # Decoupled from myelin_percentile (axon separation) so it can be raised to
                              # capture the lighter transitional lamellae the hand tracer includes -- ~20-33%
                              # of GT myelin is brighter than the separation threshold -- without loosening
                              # the walls that separate axons (recall stays 1.0).
    speckle_min=40,           # drop myelin connected components smaller than this (px)
    close_fiber=27,           # seal broken rings to isolate axon bodies
    myelin_close=11,          # close thin inter-lamellar gaps (keeps large gaps open)
    min_axon_frac=0.02,       # min axon-body area as a fraction of the image (also culls small
                              # false-positive extracellular pockets; see docs/reference/user_masks.md)
    max_axon_frac=0.60,       # max axon-body area as a fraction of the image
    min_solidity=0.90,        # reject corner pockets / leaky bodies (real axons are convex)
    bright_margin=-25,        # axon-body mean intensity must exceed median(image)+margin (mild floor)
    touch_dilate=5,           # myelin must touch the axon within this many px
    myelin_thickness_mult=3.0,  # outer myelin cap = this multiple of the axon's OWN measured
                              # ring thickness (the median distance-to-axon of the dark material
                              # hugging it). This bounds how far the band grows outward so an
                              # isolated fibre does not vacuum up dark extracellular material that
                              # connects to it (there is no neighbouring axon to arbitrate). It is
                              # derived from the image, not from a pixel count, so it is
                              # resolution-independent; and it is NOT a fraction of the axon radius,
                              # so it does not bake a g-ratio prior into a g-ratio measurement --
                              # a thickly-myelinated axon gets a proportionally larger cap because
                              # its measured ring is thicker, not because we assumed it. The only
                              # residual assumption is intra-fibre: the outer boundary is within a
                              # few ring-thicknesses of the axon (a wedge ballooning many-fold is a
                              # neighbour bleeding in, not this fibre's myelin).
    myelin_thickness_mult_isolated=1.8,  # tighter cap for an ISOLATED axon (see isolation_ramp):
                              # its myelin faces open extracellular space on all sides, where dark
                              # adjacent tissue looks like myelin and no neighbouring axon bounds it,
                              # so the band must not run past the axon's own uniform ring thickness.
    isolation_ramp=(7.0, 13.0),  # neighbour-distance/own-thickness range over which the cap ramps
                              # from clustered (myelin_thickness_mult, at/below 7) to isolated
                              # (myelin_thickness_mult_isolated, at/above 13). A smooth ramp, not a
                              # hard switch, so an axon near the boundary is not treated abruptly.
                              # On the calibration data clustered axons sit at ratio <=6.3 and the one
                              # isolated axon at infinity, so the ramp reproduces the intended split
                              # with margin; it exists to degrade gracefully on unseen spacings.
    myelin_band=None,         # optional ABSOLUTE ceiling as a fraction of axon radius; None = off.
                              # Only useful to hard-limit a dataset where the measured-thickness cap
                              # is not enough (e.g. inverted-contrast SEM tuning in reference_run.py).
    smooth_frac=0.15,         # border smoothing kernel as a fraction of axon radius
    smooth_max_px=21,         # ...capped to this absolute size (avoid distorting big axons)
    axon_otsu_bias=10,        # the axon border is refined per fibre: Otsu-split the fibre into bright
                              # axoplasm vs dark myelin, peel the dark band inward from the fibre edge,
                              # and keep the bright core. This bias nudges the split darker so the border
                              # sits at the axolemma. Calibrated against the hand masks.
    axon_smooth_frac=0.6,     # smooth the peeled axon border by this fraction of the axon radius, so it
                              # is a simple rounded curve like a hand tracing (the peel itself is ragged)
    axon_smooth_max=99,       # ...capped to this absolute kernel size
    fiber_smooth_frac=0.2,    # smooth the fibre outer bound (open then close) by this fraction of the
                              # axon radius, so it is a clean rounded envelope like a hand tracing
                              # instead of a spiky outline that reaches into the extracellular space
    border_smooth_tol=2.0,    # final pass: refit the INNER (axon) border as a smooth spline within this
                              # many px (least-squares periodic spline; removes the pixel staircase
                              # without shrinking). Larger tol -> fewer control points -> smoother.
    border_smooth_tol_fiber=0.5,  # SEPARATE, tighter tol for the OUTER (fibre) border -> many more
                              # control points, so its longer/undulating outline is de-staircased
                              # without the shape-rounding that a shared (axon) tol caused on sample_03.
                              # None -> use border_smooth_tol.
    border_min_radius=6.0,    # ...but do not refit a region whose equivalent radius is below this (px)
    bubble_min_frac=0.02,     # a hole counts as a bubble if >= this fraction of the axon
    bubble_min_px=250,        # ...and at least this many pixels
    detect_bubbles=False,     # if False, bright gaps (vacuoles) stay part of the myelin band --
                              # the hand tracing counts them inside the myelin, and their removal
                              # is a deferred later stage. Set True to split them out and highlight.
    fiber_vacuole_close_frac=1.0,  # wrap the fibre outer boundary over edge vacuoles by closing it
                              # with a kernel = this fraction of the axon's OWN measured band
                              # thickness. One scale-free rule for every fibre (replaces the R19
                              # per-pocket enclosure heuristic, which was tuned to one sample and
                              # over-reached on the others). 0 = off.
    dense_extend=True,        # follow the SOLID dark myelin outward past the thickness cap where
                              # it ends in sparse neuropil (fixes under-reach of locally-thick
                              # sheaths). Relies on A-MYELIN-DENSE. See _extend_dense_dark.
    dense_extend_win=17,      # px window for the local dark-density (myelin=solid dark, neuropil=
                              # sparse). Scale-dependent (a few lamellar periods).
    dense_extend_thr=0.4,     # min local dark fraction to count as solid myelin
    dense_extend_gmult=3.0,   # generous radius for the follow = this x the fibre's measured thickness;
                              # a dense run reaching it is a touching neighbour (no gap) -> not extended
    dense_extend_gap=8,       # sparse-run length (px) that marks the end of the sheath (outer membrane)
    dense_extend_rays=360,    # angular resolution of the per-direction follow
    dense_extend_smooth=6,    # half-width (rays) of the angular-median window that smooths the
                              # extension into a clean envelope (no per-ray comb) -- an extension
                              # survives only where a broad arc of rays agrees
    junction_fill=True,       # reclaim dense-dark myelin trapped in the interstitial junctions
                              # BETWEEN clustered fibres (beyond every axon's cap, so left
                              # unassigned). Relies on A-JUNCTION-MYELIN. See _fill_junction_myelin.
    junction_fill_kfrac=3.0,  # bridge inter-fibre gaps up to this multiple of the median fibre
                              # myelin thickness (scale-free); only pixels flanked by TWO fibres and
                              # actually dense-dark are added, so isolated fibres are untouched
    membrane_outer_boundary=False,  # OPT-IN: trim outer over-reach past the outermost myelin
                              # lamella (ridge-guided flood). OFF by default -- relies on the
                              # biological A-MYELIN-LAMELLAR assumption (concentric resolvable
                              # lamellae) and on the current 3-image set it trims real compact
                              # myelin through lamella gaps (net ~ -0.003 IoU). See
                              # docs/reference/assumptions.md before enabling on new data.
    membrane_ridge_thr=0.12,  # ridge strength (meijering+sato, 0..1) counted as a lamella barrier
    fill_edge_holes=True,     # fill vacuoles cut open by the IMAGE EDGE: a bright pocket enclosed
                              # by myelin on its visible sides but touching the border cannot be
                              # closed by binary_fill_holes; reflect-pad handles it. Only affects
                              # fibres that touch the image edge.
    # --- Phase 3: non-myelin pockets (the tracer's orange 'omit' regions) -------
    detect_nonmyelin=True,    # detect bright non-myelin pockets (vacuoles / splits / inclusions)
                              # sitting INSIDE the myelin band and EXCLUDE them from A_myelin (so the
                              # g-ratio measures true myelin material). See _detect_nonmyelin_pockets
                              # and A-NONMYELIN-BRIGHT. Byte-clean on fibres with no pockets.
    nonmyelin_bright_percentile=None,  # a pocket pixel is brighter than the dark-myelin threshold;
                              # None -> reuse myelin_fill_percentile (the same cut that defines dark
                              # myelin material), so a pocket is exactly 'in the band but not material'.
    nonmyelin_open_frac=0.8,  # a genuine pocket is a FAT bright blob, not a thin light lamella or the
                              # thin periaxonal ring: keep only bright regions that survive an opening
                              # of radius = this x the fibre's OWN measured ring thickness. Scale-free
                              # (no pixel constant); a thick-myelin fibre demands a proportionally
                              # fatter pocket, which is why a clean concentric sheath yields none.
    nonmyelin_ring_frac=0.15,  # exclude a thin bright periaxonal ring (= this x the fibre thickness)
                              # hugging the axon -- the tracer counts that ring as myelin, not a pocket.
    nonmyelin_min_thick=0.6,  # pocket size floor = (this x the fibre thickness)^2 (scale-free); with
                              # the opening this mostly guards against speckle.
    nonmyelin_min_px=150,     # ...but never below this absolute floor (px).
)

# Distinct per-axon colours (BGR); myelin is drawn as a darker shade of each.
PALETTE = [
    (0, 200, 255), (235, 180, 0), (0, 220, 100), (255, 90, 200),
    (60, 170, 255), (200, 130, 255), (255, 200, 60), (120, 220, 0),
]
BUBBLE_COLOR = (0, 0, 255)   # red: holes / missing myelin
NONMYELIN_COLOR = (0, 140, 255)  # orange: non-myelin pockets excluded from A_myelin (Phase 3)


def _palette(i):
    return PALETTE[i % len(PALETTE)]


def _find_scalebar(gray):
    """Locate a burn-in scale-bar ruler: a long, thin, horizontal high-contrast
    line in the lower part of the image (bright or dark vs its local background).
    Returns (x, y, w, h) or None."""
    H, W = gray.shape
    bg = cv2.GaussianBlur(gray, (0, 0), 9)
    m = (cv2.subtract(gray, bg) > 18).astype(np.uint8)   # bright over local background
    horiz = cv2.morphologyEx(m, cv2.MORPH_OPEN,
                             cv2.getStructuringElement(cv2.MORPH_RECT, (25, 1)))
    n, _, stats, _ = cv2.connectedComponentsWithStats(horiz, 8)
    best = None
    for i in range(1, n):
        x, y, w, h, _ = stats[i]
        # a ruler is short (not the full-width image border), thin, horizontal,
        # in the lower band but not on the very edge row
        if (50 <= w <= 0.45 * W and w >= 5 * max(h, 1)
                and H * 0.6 < y < H - 8):
            if best is None or w > best[2]:
                best = (x, y, w, h)
    return best


def _remove_scalebar(gray):
    """Inpaint the scale-bar ruler + its label so they do not confuse
    segmentation (the label text sits just above/below the ruler)."""
    b = _find_scalebar(gray)
    if b is None:
        return gray
    x, y, w, h = b
    H, W = gray.shape
    y0, y1 = max(0, y - 28), min(H, y + h + 40)
    x0, x1 = max(0, x - 15), min(W, x + w + 15)
    # only inpaint a scale bar that sits in clean (bright) background; if it lies on
    # tissue (dark myelin present in the band) removing it would damage a real axon,
    # so leave it -- correctness of the segmentation outranks a cosmetic clean-up.
    band = gray[y0:y1, x0:x1]
    if (band < np.percentile(gray, 35)).mean() > 0.12:
        return gray
    mask = np.zeros((H, W), np.uint8)
    mask[y0:y1, x0:x1] = 255
    return cv2.inpaint(gray, mask, 3, cv2.INPAINT_TELEA)


def keep_fill(mask, speckle_min):
    """Drop connected components smaller than `speckle_min` pixels."""
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    keep = np.zeros(n, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= speckle_min
    return keep[lab].astype(np.uint8)


def _smooth(mask, k):
    """Round a binary mask into a smooth, roughly-closed shape."""
    ks = int(max(5, k)) | 1
    el = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ks, ks))
    m = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, el)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, el)
    return binary_fill_holes(m > 0)


def fit_smooth_border(mask, tol=2.0, min_radius=0.0):
    """Replace a raster region's boundary with a fitted smooth closed curve.

    Least-squares periodic spline fit (in the spirit of Schneider's Bezier
    fitting): unlike Gaussian contour averaging it does not shrink the shape, so
    it removes the pixel staircase without thinning the region. `tol` (px) trades
    curve tightness vs smoothness; `min_radius` (px) refuses to smooth a region
    whose equivalent radius is below it (protects tiny axons from over-rounding).
    Falls back to the input mask on a degenerate fit (area drift > 12%)."""
    m = mask.astype(np.uint8)
    if tol <= 0 or m.sum() == 0:
        return mask
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cnts:
        return mask
    c = max(cnts, key=cv2.contourArea)
    a0 = cv2.contourArea(c)
    pts = c[:, 0, :].astype(float)
    n = len(pts)
    if n < 24 or a0 < np.pi * min_radius * min_radius:
        return mask
    try:
        tck, _ = splprep([pts[:, 0], pts[:, 1]], s=n * tol * tol, per=1)
        xs, ys = splev(np.linspace(0, 1, max(200, n)), tck)
    except Exception:
        return mask
    out = np.zeros_like(m)
    cv2.fillPoly(out, [np.stack([xs, ys], 1).round().astype(np.int32)], 1)
    a1 = float(out.sum())
    if a1 == 0 or abs(a1 - a0) > 0.12 * a0:      # degenerate fit -> keep original
        return mask
    return out > 0


def _peel_axon(gf, fiber, cx, cy, bias, k):
    """Refine the axon within a fibre by peeling the dark myelin band inward.

    Otsu-split the fibre's intensities into bright axoplasm vs dark myelin, take
    the dark material connected to the fibre's outer boundary as the myelin band,
    and keep the bright core (interior organelles are re-filled). This tracks the
    real inner-myelin edge locally, instead of a fixed erosion of the body.
    """
    F = fiber
    if F.sum() < 25:
        return F
    t, _ = cv2.threshold(gf[F].astype(np.uint8), 0, 255,
                         cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    dark = (gf < t + bias) & F
    dl, _ = cc_label(dark)
    border = F & ~cv2.erode(F.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    blab = np.unique(dl[border])
    band = np.isin(dl, blab[blab > 0])
    core = binary_fill_holes(F & ~band)
    cl, _ = cc_label(core)
    cyi, cxi = int(round(cy)), int(round(cx))
    sid = cl[cyi, cxi] if 0 <= cyi < cl.shape[0] and 0 <= cxi < cl.shape[1] else 0
    if sid == 0:
        sizes = np.bincount(cl.ravel())
        sizes[0] = 0
        sid = int(sizes.argmax()) if sizes.max() > 0 else 0
    axon = binary_fill_holes(cl == sid) if sid > 0 else core
    return _smooth(axon, k) & F


def _refine_outer_membrane(gf, axon_mask, myelin_mask, fiber_mask, myelin_mat, P):
    """Trim fibre over-reach that lies BEYOND the outermost myelin membrane.

    # BIOLOGICAL ASSUMPTION [A-MYELIN-LAMELLAR] -- see docs/reference/assumptions.md
    # The myelin sheath is a stack of concentric membranes (lamellae) that render as
    # ridges; genuine extracellular space is reachable from outside the fibre WITHOUT
    # crossing a lamella. So we flood inward from the background, blocked by ridge
    # (meijering+sato) and dark-myelin barriers -- any fibre area the flood reaches
    # lies past the outermost membrane and is trimmed as over-reach. This FAILS when
    # the myelin has no resolvable lamellae (immature/compact-only myelin, or too low
    # magnification): with no ridge barrier the flood leaks into real myelin. That is
    # why this refinement is OFF by default (membrane_outer_boundary=False); on the
    # current 3-image set it trims real compact myelin through lamella gaps.

    Opt-in (needs scikit-image); returns possibly-trimmed (axon, myelin, fiber) masks.
    """
    try:
        from skimage.filters import meijering, sato
    except Exception:
        return axon_mask, myelin_mask, fiber_mask
    x = gf.astype(np.float32)
    b = cv2.bilateralFilter(gf, 9, 75, 75).astype(float) / 255.0

    def _n(a):
        lo, hi = np.percentile(a, [1, 99]); hi = hi if hi > lo else lo + 1
        return np.clip((a - lo) / (hi - lo), 0, 1)
    M = np.maximum(_n(meijering(b, sigmas=range(1, 6), black_ridges=True)),
                   _n(sato(b, sigmas=range(1, 6), black_ridges=True)))
    ridges = cv2.dilate((M > P['membrane_ridge_thr']).astype(np.uint8),
                        np.ones((3, 3), np.uint8), iterations=2) > 0
    barrier = myelin_mat | ridges | (axon_mask > 0)
    fib = fiber_mask > 0
    outside = (~fib) & (~barrier)
    flooded = binary_propagation(outside, mask=~barrier)
    trim = fib & flooded & (axon_mask == 0)      # bright over-reach past the outer membrane
    fiber_mask = np.where(trim, 0, fiber_mask)
    myelin_mask = np.where(trim, 0, myelin_mask)
    return axon_mask, myelin_mask, fiber_mask


def _extend_dense_dark(axon_mask, myelin_mask, fiber_mask, dense, axons, P):
    """Follow the SOLID dark myelin outward past the thickness cap, per direction.

    # BIOLOGICAL ASSUMPTION [A-MYELIN-DENSE] -- see docs/reference/assumptions.md:
    # myelin is SOLIDLY dark (high local dark-pixel density) whereas extracellular
    # neuropil is only SPARSELY dark. So the sheath can be followed outward through
    # the solid-dark region and it ENDS where the density drops to neuropil. Per ray
    # from the axon centre: extend the fibre through dense-dark until it terminates in
    # neuropil (the true outer edge) within a generous radius; if instead the dense
    # run reaches the generous radius, it is a touching neighbour's myelin with no gap
    # -- keep the current (capped) edge there. This fixes under-reach where the median
    # thickness cap clips a locally thick sheath, without running into a neighbour.
    # Fails if neuropil is as densely dark as myelin (heavy stain / low resolution).
    """
    H, W = dense.shape
    lab = fiber_mask                                     # per-axon fibre labels
    gap = int(P['dense_extend_gap'])
    NS = int(P['dense_extend_rays'])
    for a in axons:
        i = a['id']
        cur = fiber_mask == i
        am = axon_mask == i
        if not cur.any():
            continue
        cx, cy = a['cx'], a['cy']
        dax = distance_transform_edt(~am)
        m = cur & ~am
        th = float(np.median(dax[m])) if m.any() else 10.0
        gen = P['dense_extend_gmult'] * th
        rlim = int(a['r'] + gen + 5)
        rc_r = np.zeros(NS); tgt_r = np.zeros(NS)
        for k in range(NS):
            ang = 2 * np.pi * k / NS
            dx, dy = np.cos(ang), np.sin(ang)
            rc = 0                                        # current fibre outer radius along ray
            for r in range(rlim, 0, -1):
                x = int(round(cx + dx * r)); y = int(round(cy + dy * r))
                if 0 <= x < W and 0 <= y < H and cur[y, x]:
                    rc = r; break
            rc_r[k] = rc
            if rc == 0:
                continue
            last = rc; brun = 0; hit = False
            r = rc + 1
            while r < rc + int(gen) + 1:
                x = int(round(cx + dx * r)); y = int(round(cy + dy * r))
                if not (0 <= x < W and 0 <= y < H):
                    break
                if dax[y, x] > gen:                       # reached generous radius (neighbour)
                    hit = True; break
                if lab[y, x] not in (0, i) or (axon_mask[y, x] not in (0, i)):
                    break                                 # do not invade another fibre/axon
                if dense[y, x]:
                    last = r; brun = 0
                else:
                    brun += 1
                    if brun >= gap:
                        break                             # dense run ended in neuropil
                r += 1
            tgt_r[k] = last if (not hit and last > rc) else rc
        # Suppress lone-ray spikes: an extension survives only if a BROAD arc of
        # neighbouring rays agrees. Take a low percentile over a wide angular window,
        # so a narrow spur (a few rays) is pulled back to the non-extending majority
        # while a genuinely thick sheath sector (most rays extend) is kept.
        pad = int(P['dense_extend_smooth'])
        extv = np.concatenate([tgt_r[-pad:], tgt_r, tgt_r[:pad]])
        tgt_s = np.array([np.median(extv[j:j + 2 * pad + 1]) for j in range(NS)])
        # Fill the extension as a SOLID region -- the smooth radial envelope intersected
        # with the dense-dark myelin -- instead of drawing per-ray lines (which leave a
        # comb of unmerged teeth at wide radius). The envelope bounds how far out; the
        # dense mask keeps it to actual solid myelin, so the added border is clean.
        if (rc_r > 0).sum() < 3:
            continue
        angs = 2 * np.pi * np.arange(NS) / NS
        top = np.maximum(rc_r, tgt_s)
        sel = rc_r > 0
        px = (cx + np.cos(angs) * top)[sel]
        py = (cy + np.sin(angs) * top)[sel]
        env = np.zeros((H, W), np.uint8)
        cv2.fillPoly(env, [np.stack([px, py], 1).round().astype(np.int32)], 1)
        env = env > 0
        # add only the envelope's background pixels (the smooth extension sector); the
        # exact current fibre is preserved, so the added outer border is smooth (no comb)
        # without star-approximating the whole shape.
        newpix = env & (fiber_mask == 0)
        fiber_mask = np.where(newpix, i, fiber_mask)
        myelin_mask = np.where(newpix & (axon_mask == 0), i, myelin_mask)
    return axon_mask, myelin_mask, fiber_mask


def _fill_junction_myelin(axon_mask, myelin_mask, fiber_mask, dense, axons, P):
    """Reclaim dense-dark myelin trapped in the junctions BETWEEN clustered fibres.

    # BIOLOGICAL ASSUMPTION [A-JUNCTION-MYELIN] -- see docs/reference/assumptions.md:
    # where several myelinated fibres pack together, the dark material filling the
    # interstitial pocket between two adjacent sheaths IS myelin (their touching
    # compact-myelin walls), not some other dark structure. That pocket sits beyond
    # every axon's own thickness cap (it is far from all axon centres), so the capped
    # assignment leaves it unclaimed -- a persistent under-reach in tight clusters.
    # Bridge the inter-fibre gaps by CLOSING the fibre union with a scale-free kernel
    # (a multiple of the median fibre thickness), then add back only pixels that are
    # (a) actually dense-dark and (b) flanked by a SECOND fibre within the kernel --
    # so open extracellular neuropil (no fibre on the far side to bridge to) is never
    # filled and a genuinely isolated fibre gets nothing. Fails if a dark non-myelin
    # process runs through the junction, or if two fibres are pressed so close that the
    # gate admits a sliver of the neuropil between them.
    """
    ids = [a['id'] for a in axons]
    if len(ids) < 2:
        return axon_mask, myelin_mask, fiber_mask         # no junction without >=2 fibres
    H, W = dense.shape
    dist_by = {i: distance_transform_edt(fiber_mask != i) for i in ids}
    ths = []
    for a in axons:
        am = axon_mask == a['id']
        mm = (fiber_mask == a['id']) & ~am
        if mm.any():
            ths.append(float(np.median(distance_transform_edt(~am)[mm])))
    th = float(np.median(ths)) if ths else 10.0
    k = max(3, int(round(P['junction_fill_kfrac'] * th)) | 1)
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    closed = cv2.morphologyEx((fiber_mask > 0).astype(np.uint8), cv2.MORPH_CLOSE, ker) > 0
    dstack = np.stack([dist_by[i] for i in ids], 0)
    order = np.argsort(dstack, 0)
    nearest = np.array(ids)[order[0]]
    d2 = np.take_along_axis(dstack, order[1:2], 0)[0]     # distance to the 2nd-nearest fibre
    added = closed & dense & (fiber_mask == 0) & (d2 <= k)
    fiber_mask = np.where(added, nearest, fiber_mask)
    myelin_mask = np.where(added & (axon_mask == 0), nearest, myelin_mask)
    return axon_mask, myelin_mask, fiber_mask


def _fill_edge_holes(fm, margin=40):
    """Fill vacuoles that are enclosed by the fibre except where the IMAGE EDGE
    cuts through them. ``binary_fill_holes`` cannot close a hole that touches the
    border (it is connected to the exterior), so a bright pocket sitting in the
    myelin of an edge-cropped fibre is left open. Reflect-pad the mask before
    filling: the pocket is closed by its own mirror across the edge, while the
    genuine exterior reflects to more exterior and stays connected to the padded
    border (so it is not filled). Only affects fibres that touch the image edge.
    """
    if not (fm[0, :].any() or fm[-1, :].any() or fm[:, 0].any() or fm[:, -1].any()):
        return fm
    p = np.pad(fm.astype(np.uint8), margin, mode='reflect')
    f = binary_fill_holes(p > 0)
    return f[margin:-margin, margin:-margin]


def _detect_nonmyelin_pockets(gf, axon_mask, myelin_mask, axons, P):
    """Find bright non-myelin pockets embedded in the myelin band (Phase 3).

    # BIOLOGICAL ASSUMPTION [A-NONMYELIN-BRIGHT] -- see docs/reference/assumptions.md:
    # compact myelin is solidly dark; a genuine non-myelin pocket embedded in the
    # sheath -- a vacuole, a split, or the extracellular inclusion the tracer marks
    # 'orange / omit' -- is markedly BRIGHTER (at axoplasm / background level) and is
    # a FAT blob, not a thin inter-lamellar gap. So within each fibre's assigned
    # myelin, a bright region (brighter than the dark-myelin threshold) that survives
    # a morphological opening whose radius scales with that fibre's OWN measured ring
    # thickness is a pocket; the thin light lamellae and the thin periaxonal ring do
    # not survive it. Scale-free (opening + size floor scale with the measured
    # thickness -- no pixel constant) and g-ratio-prior-free. Fails on immature /
    # lightly-stained myelin whose compact sheath is itself bright (no dark/bright
    # separation); low-contrast splits barely brighter than the myelin are left in,
    # conservatively (removing real myelin is worse than missing a faint pocket).

    Returns a bool mask of the detected pockets (a subset of ``myelin_mask > 0``).
    """
    H, W = gf.shape
    out = np.zeros((H, W), bool)
    fill_pct = P.get('myelin_fill_percentile') or P['myelin_percentile']
    bp = P.get('nonmyelin_bright_percentile')
    bright_t = float(np.percentile(gf, bp if bp is not None else fill_pct))
    for a in axons:
        i = a['id']
        fib_my = myelin_mask == i
        am = axon_mask == i
        if not fib_my.any() or not am.any():
            continue
        th = float(np.median(distance_transform_edt(~am)[fib_my]))
        if th <= 0:
            continue
        # exclude the thin bright periaxonal ring hugging the axon: the tracer counts
        # it as myelin, not a pocket (scale-free ring width from the fibre thickness).
        rk = max(1, int(round(P['nonmyelin_ring_frac'] * th)))
        ring = cv2.dilate(am.astype(np.uint8),
                          cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (rk * 2 + 1,) * 2)
                          ).astype(bool) & ~am
        bright = fib_my & (gf >= bright_t) & ~ring
        if not bright.any():
            continue
        # keep only FAT bright regions: those surviving an opening whose radius scales
        # with this fibre's own ring thickness (kills thin light lamellae + the ring)
        k = max(3, int(round(P['nonmyelin_open_frac'] * th)) | 1)
        el = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
        opened = cv2.morphologyEx(bright.astype(np.uint8), cv2.MORPH_OPEN, el) > 0
        # reconstruct each surviving fat core back to its full bright pocket
        lab, _ = cc_label(bright)
        seeds = set(np.unique(lab[opened])) - {0}
        if not seeds:
            continue
        pockets = np.isin(lab, list(seeds))
        floor = max(P['nonmyelin_min_px'], (P['nonmyelin_min_thick'] * th) ** 2)
        pl, pn = cc_label(pockets)
        for c in range(1, pn + 1):
            cm = pl == c
            if cm.sum() >= floor:
                out |= cm
    return out


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
    if P['remove_scalebar']:
        gray = _remove_scalebar(gray)
    H, W = gray.shape

    gf = cv2.bilateralFilter(gray, *P['bilateral'])
    # BIOLOGICAL ASSUMPTION [A-MYELIN-DARK] -- see docs/reference/assumptions.md:
    # myelin is the darkest tissue (osmium-stained TEM). The whole threshold-based
    # detection assumes this polarity; inverted-contrast modalities need `255 - image`.
    T = float(np.percentile(gf, P['myelin_percentile']))
    myel = (gf < T).astype(np.uint8)

    n, lab, stats, _ = cv2.connectedComponentsWithStats(myel, 8)
    keep = np.zeros(n, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= P['speckle_min']
    myel = keep[lab].astype(np.uint8)

    kf = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (P['close_fiber'],) * 2)
    mc = cv2.morphologyEx(myel, cv2.MORPH_CLOSE, kf)          # sealed myelin: separates axons (incl. broken central ring)
    # treat the image border as a wall, so edge-cropped axons get enclosed too
    framed = mc.copy()
    framed[0, :] = framed[-1, :] = framed[:, 0] = framed[:, -1] = 1
    enclosed = binary_fill_holes(framed.astype(bool))
    # `myelin_mat` defines the myelin *material* used to place the axon inner
    # border and fill the myelin band. It is decoupled from the detection
    # threshold above: a more inclusive percentile here captures the lighter
    # inner lamellae -- tightening the axon boundary and thickening the myelin --
    # WITHOUT loosening the walls that separate axons (which would spawn false
    # background axons). Defaults to the detection threshold (no behaviour change).
    fill_pct = P.get('myelin_fill_percentile') or P['myelin_percentile']
    myel_fill = (gf < float(np.percentile(gf, fill_pct))).astype(np.uint8)
    myel_fill = keep_fill(myel_fill, P['speckle_min'])
    km = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (P['myelin_close'],) * 2)
    myelin_mat = cv2.morphologyEx(myel_fill, cv2.MORPH_CLOSE, km) > 0

    # candidate axon compartments = regions separated by the sealed myelin.
    # BIOLOGICAL ASSUMPTION [A-AXON-CONVEX-BRIGHT] -- see docs/reference/assumptions.md:
    # an axon body is a bright, roughly convex compartment above a size floor
    # (min_axon_frac / min_solidity / bright_margin below).
    sep = enclosed & ~mc.astype(bool)
    minA, maxA = P['min_axon_frac'] * H * W, P['max_axon_frac'] * H * W
    bright_thr = np.median(gf) + P['bright_margin']
    slab, ns = cc_label(sep)
    axon_lbl = np.zeros((H, W), np.int32)
    cands = []
    aid = 1
    for c in range(1, ns + 1):
        seed = slab == c
        if seed.sum() < minA * 0.4:               # eroded seed; relaxed floor
            continue
        # grow the eroded seed out to the fine myelin boundary, but keep it within
        # the seed's neighbourhood so a broken ring can't flood the background
        terr = cv2.dilate(seed.astype(np.uint8), kf) > 0
        glab, _ = cc_label((~myelin_mat) & terr)
        cy0, cx0 = np.argwhere(seed).mean(0)
        sid = glab[int(round(cy0)), int(round(cx0))]
        body = binary_fill_holes(glab == sid) if sid > 0 else binary_fill_holes(seed)
        A = int(body.sum())
        if not (minA <= A <= maxA):
            continue
        cnt = max(cv2.findContours(body.astype(np.uint8), cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)[0], key=cv2.contourArea)
        hull = cv2.contourArea(cv2.convexHull(cnt))
        sol = A / hull if hull > 0 else 0.0
        if sol < P['min_solidity'] or gf[body].mean() < bright_thr:
            continue
        ys, xs = np.where(body)
        cy, cx, rr = float(ys.mean()), float(xs.mean()), float(np.sqrt(A / np.pi))
        axon_lbl[body] = aid
        cands.append(dict(id=aid, body=body, cx=cx, cy=cy, r=rr, solidity=float(sol)))
        aid += 1

    blank = np.zeros((H, W), np.int32)
    if not cands:
        return dict(gf=gf, T=T, axons=[], axon_mask=blank, myelin_mask=blank,
                    fiber_mask=blank, bubble=np.zeros((H, W), bool),
                    nonmyelin=np.zeros((H, W), bool))

    # myelin band = dark material touching an axon, within a thickness cap
    kd = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (P['touch_dilate'],) * 2)
    seed = cv2.dilate((axon_lbl > 0).astype(np.uint8), kd) > 0
    myl_lab, _ = cc_label(myelin_mat)
    touch = np.unique(myl_lab[seed & myelin_mat])
    touch = touch[touch > 0]
    myelin_keep = np.isin(myl_lab, touch)
    dist, (iy, ix) = distance_transform_edt(axon_lbl == 0, return_indices=True)
    nearest = axon_lbl[iy, ix]
    # Outer myelin cap, per axon, derived from the axon's OWN ring thickness rather
    # than from a pixel count or a fraction of the axon radius (see myelin_thickness_mult).
    # thickness = median distance-to-axon of the dark material assigned to this axon;
    # the median is robust to the far extracellular blobs that inflate the tail.
    uncapped = myelin_keep & (nearest > 0)
    r_by = np.zeros(len(cands) + 1)
    cap_by = np.zeros(len(cands) + 1)
    thick_by = np.zeros(len(cands) + 1)
    ids = [a['id'] for a in cands]
    # per-axon distance transforms (reused for the isolation test, the thickness-
    # weighted territory, and the cap -- one transform per axon, not per use)
    dist_by = {i: distance_transform_edt(axon_lbl != i) for i in ids}
    for a in cands:
        i = a['id']
        r_by[i] = a['r']
        d = dist[uncapped & (nearest == i)]           # thickness from the plain Voronoi ring
        thick = float(np.median(d)) if d.size else 0.0
        thick_by[i] = thick
        # BIOLOGICAL ASSUMPTION [A-ISOLATED-TIGHTER] -- see docs/reference/assumptions.md
        # (calibrated on ONE isolated axon; the weakest-supported number here).
        # An axon whose nearest neighbour is many myelin-thicknesses away is ISOLATED:
        # its myelin faces open extracellular space, where dark adjacent tissue can be
        # taken for myelin with no neighbouring axon to arbitrate the boundary. Such an
        # axon uses a tighter cap. A clustered axon keeps the generous cap for its
        # genuinely thick shared walls (which the neighbour, not the cap, bounds). The
        # isolation measure is scale-free -- the neighbour distance in units of this
        # axon's own measured thickness -- and the multiplier RAMPS smoothly between the
        # clustered and isolated values rather than flipping at a hard threshold, so two
        # near-identical axons near the boundary are not treated very differently.
        if len(cands) > 1 and thick > 0:
            other = (axon_lbl > 0) & (axon_lbl != i)
            ratio = float(dist_by[i][other].min()) / thick
        else:
            ratio = np.inf                       # lone axon in the field
        lo, hi = P['isolation_ramp']
        t = float(np.clip((ratio - lo) / (hi - lo), 0.0, 1.0))   # 0 clustered -> 1 isolated
        mult = P['myelin_thickness_mult'] + t * (P['myelin_thickness_mult_isolated'] - P['myelin_thickness_mult'])
        cap_by[i] = mult * thick

    # BIOLOGICAL ASSUMPTION [A-SHEATHS-MEET-BY-THICKNESS] -- see docs/reference/assumptions.md.
    # Thickness-weighted territory: two touching fibres' sheaths meet in proportion to
    # their myelin thickness, NOT at the equidistant midline. Assign each pixel to the
    # axon minimising (distance / that axon's own measured thickness), so a thin-myelin
    # small axon cannot claim half of a wall it shares with a thick-myelin neighbour --
    # that equidistant split was what produced 'tentacles' of a small fibre's myelin
    # reaching toward a larger one. Falls back to plain nearest when thicknesses are equal.
    eps = 1e-3
    wscore = np.stack([dist_by[i] / max(thick_by[i], eps) for i in ids], 0)
    oidx = np.argmin(wscore, 0)
    owner = np.array(ids)[oidx]                       # per-pixel owning axon (always > 0)
    d_owner = np.take_along_axis(np.stack([dist_by[i] for i in ids], 0), oidx[None], 0)[0]
    cap_at = np.zeros_like(d_owner)
    for pos, i in enumerate(ids):
        cap_at[owner == i] = cap_by[i]
        if P.get('myelin_band'):                      # optional absolute ceiling (usually off)
            cap_at[owner == i] = min(cap_by[i], P['myelin_band'] * r_by[i])
    assigned = np.where(uncapped & (d_owner <= cap_at), owner, 0)

    axon_mask = np.zeros((H, W), np.int32)
    myelin_mask = np.zeros((H, W), np.int32)
    fiber_mask = np.zeros((H, W), np.int32)
    bubble = np.zeros((H, W), bool)
    axons = []
    for a in cands:
        terr = owner == a['id']              # thickness-weighted territory (split touching fibers)
        k = min(a['r'] * P['smooth_frac'], P['smooth_max_px'])
        fm = _smooth(binary_fill_holes(a['body'] | (assigned == a['id'])) & terr, k)
        # smooth the fibre outer bound into a clean rounded envelope: open removes
        # spiky protrusions reaching into the extracellular space, close fills small
        # indentations. (A hand tracing is smooth; the raw myelin outline is not.)
        if P['fiber_smooth_frac'] > 0 and fm.any():
            ks2 = int(max(3, P['fiber_smooth_frac'] * a['r'])) | 1
            el2 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ks2, ks2))
            fm2 = cv2.morphologyEx(fm.astype(np.uint8), cv2.MORPH_OPEN, el2)
            fm2 = cv2.morphologyEx(fm2, cv2.MORPH_CLOSE, el2)
            fm = binary_fill_holes(fm2 > 0) & terr
        # refine the axon border to the real inner-myelin edge (per-fibre Otsu peel),
        # then smooth it into a clean rounded shape like a hand tracing. Do this BEFORE
        # wrapping outer vacuoles so the vacuole-wrapping (which only grows the outer
        # boundary) cannot shift the inner axon border / the g-ratio.
        sk = min(P['axon_smooth_frac'] * a['r'], P['axon_smooth_max'])
        am = _peel_axon(gf, fm, a['cx'], a['cy'], P['axon_otsu_bias'], sk)
        # Wrap the outer boundary over bright vacuoles sitting at the myelin's outer
        # edge: morphological close by a fraction of THIS axon's own measured band
        # thickness. This is one scale-free rule for every fibre (the kernel scales
        # with each axon's myelin), not a per-pocket enclosure test tuned to one image.
        if P['fiber_vacuole_close_frac'] > 0 and fm.any() and thick_by[a['id']] > 0:
            kc = int(max(3, P['fiber_vacuole_close_frac'] * thick_by[a['id']])) | 1
            elc = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kc, kc))
            fm = cv2.morphologyEx(fm.astype(np.uint8), cv2.MORPH_CLOSE, elc) > 0
            fm = binary_fill_holes(fm) & terr
        # fill vacuoles cut open by the image edge (edge-cropped fibres) so a
        # bright pocket enclosed by myelin on its visible sides stays inside the fibre
        if P['fill_edge_holes'] and fm.any():
            fm = _fill_edge_holes(fm) & terr
        am = am & fm                              # axon stays within the (only-grown) fibre
        annulus = fm & ~am
        holes = annulus & ~myelin_mat
        hl, nh = cc_label(holes)
        gap = np.zeros((H, W), bool)
        bmin = max(P['bubble_min_px'], P['bubble_min_frac'] * am.sum())
        # a bright gap is a bubble only if it is an *interior* vacuole; the thin
        # bright periaxonal ring hugging the axon is myelin, not a bubble.
        axon_ring = cv2.dilate(am.astype(np.uint8),
                               np.ones((5, 5), np.uint8)).astype(bool) & ~am
        if P['detect_bubbles']:
            for h in range(1, nh + 1):
                hm = hl == h
                if hm.sum() >= bmin and not (hm & axon_ring).any():
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

    # Follow the solid dark myelin outward past the thickness cap where it ends in
    # sparse neuropil (fixes locally-thick sheaths the median cap clips). A-MYELIN-DENSE.
    if P['dense_extend'] and axons:
        dark = (gf < float(np.percentile(gf, fill_pct))).astype(np.float32)
        dense = cv2.boxFilter(dark, -1, (int(P['dense_extend_win']),) * 2) > P['dense_extend_thr']
        axon_mask, myelin_mask, fiber_mask = _extend_dense_dark(
            axon_mask, myelin_mask, fiber_mask, dense, axons, P)
        myelin_mask = np.where((fiber_mask > 0) & (axon_mask == 0) & ~bubble, fiber_mask, 0)
        for a in axons:
            A_ax = int((axon_mask == a['id']).sum())
            A_my = int((myelin_mask == a['id']).sum())
            a['area'], a['myelin_area'] = A_ax, A_my
            a['g'] = float(np.sqrt(A_ax / (A_ax + A_my))) if A_ax + A_my > 0 else float('nan')

    # Reclaim dense-dark myelin trapped in the junctions between clustered fibres
    # (unassigned because it lies beyond every axon's cap). A-JUNCTION-MYELIN.
    if P['junction_fill'] and len(axons) > 1:
        dark = (gf < float(np.percentile(gf, fill_pct))).astype(np.float32)
        dense = cv2.boxFilter(dark, -1, (int(P['dense_extend_win']),) * 2) > P['dense_extend_thr']
        axon_mask, myelin_mask, fiber_mask = _fill_junction_myelin(
            axon_mask, myelin_mask, fiber_mask, dense, axons, P)
        myelin_mask = np.where((fiber_mask > 0) & (axon_mask == 0) & ~bubble, fiber_mask, 0)
        for a in axons:
            A_ax = int((axon_mask == a['id']).sum())
            A_my = int((myelin_mask == a['id']).sum())
            a['area'], a['myelin_area'] = A_ax, A_my
            a['g'] = float(np.sqrt(A_ax / (A_ax + A_my))) if A_ax + A_my > 0 else float('nan')

    # final polish: refit each axon + fibre border as a smooth spline curve (vector-like,
    # hand-tracing look) without shrinking; bubbles stay excluded from myelin. The OUTER
    # (fibre) border gets a SEPARATE, tighter tolerance than the inner (axon) one: the
    # spline's control-point count grows as the tolerance shrinks (knots satisfy sum of
    # squared residuals <= n*tol^2), and the myelin outline is longer and more undulating
    # than the compact axon body, so it needs many more curves to smooth the pixel
    # staircase without rounding off real shape (as one shared tolerance did to sample_03).
    if P['border_smooth_tol'] > 0 and axons:
        sa = np.zeros((H, W), np.int32)
        sf = np.zeros((H, W), np.int32)
        ftol = P['border_smooth_tol_fiber'] or P['border_smooth_tol']
        for a in axons:
            fs = fit_smooth_border(fiber_mask == a['id'],
                                   ftol, P['border_min_radius'])
            as_ = fit_smooth_border(axon_mask == a['id'],
                                    P['border_smooth_tol'], P['border_min_radius']) & fs
            sf[fs] = a['id']
            sa[as_] = a['id']
        axon_mask, fiber_mask = sa, sf
        myelin_mask = np.where((fiber_mask > 0) & (axon_mask == 0) & ~bubble,
                               fiber_mask, 0)
        for a in axons:
            A_ax = int((axon_mask == a['id']).sum())
            A_my = int((myelin_mask == a['id']).sum())
            a['area'], a['myelin_area'] = A_ax, A_my
            a['g'] = float(np.sqrt(A_ax / (A_ax + A_my))) if A_ax + A_my > 0 else float('nan')

    # OPT-IN outer-membrane refinement (default off; see A-MYELIN-LAMELLAR).
    if P['membrane_outer_boundary'] and axons:
        axon_mask, myelin_mask, fiber_mask = _refine_outer_membrane(
            gf, axon_mask, myelin_mask, fiber_mask, myelin_mat, P)
        for a in axons:
            A_ax = int((axon_mask == a['id']).sum())
            A_my = int((myelin_mask == a['id']).sum())
            a['area'], a['myelin_area'] = A_ax, A_my
            a['g'] = float(np.sqrt(A_ax / (A_ax + A_my))) if A_ax + A_my > 0 else float('nan')

    # PHASE 3: detect bright non-myelin pockets inside the myelin band (the tracer's
    # orange 'omit' regions) and exclude them from A_myelin, so the g-ratio measures
    # true myelin material (A-NONMYELIN-BRIGHT). The pocket stays inside the fibre
    # outline (it is a hole in the sheath, not outside it); only myelin_mask loses it.
    nonmyelin = np.zeros((H, W), bool)
    if P['detect_nonmyelin'] and axons:
        nonmyelin = _detect_nonmyelin_pockets(gf, axon_mask, myelin_mask, axons, P)
        myelin_mask = np.where(nonmyelin, 0, myelin_mask)
        for a in axons:
            A_ax = int((axon_mask == a['id']).sum())
            A_my = int((myelin_mask == a['id']).sum())
            A_nm = int((nonmyelin & (fiber_mask == a['id'])).sum())
            a['area'], a['myelin_area'], a['nonmyelin_area'] = A_ax, A_my, A_nm
            a['g'] = float(np.sqrt(A_ax / (A_ax + A_my))) if A_ax + A_my > 0 else float('nan')

    return dict(gf=gf, T=T, axons=axons, axon_mask=axon_mask, myelin_mask=myelin_mask,
                fiber_mask=fiber_mask, bubble=bubble, nonmyelin=nonmyelin)


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
    if 'nonmyelin' in seg and seg['nonmyelin'].any():
        out[seg['nonmyelin']] = NONMYELIN_COLOR

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
