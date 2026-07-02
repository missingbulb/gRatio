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
from scipy.ndimage import binary_fill_holes, distance_transform_edt, label as cc_label
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
    border_smooth_tol=0,      # final pass: refit axon+fibre borders as smooth curves within this many px
                              # (least-squares spline; removes pixel staircase without shrinking). 0 = off.
                              # Off by default: the morphological smoothing already gives clean rounded
                              # borders, and the extra spline refit cost a little IoU on the hand masks.
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
    fill_edge_holes=True,     # fill vacuoles cut open by the IMAGE EDGE: a bright pocket enclosed
                              # by myelin on its visible sides but touching the border cannot be
                              # closed by binary_fill_holes; reflect-pad handles it. Only affects
                              # fibres that touch the image edge.
)

# Distinct per-axon colours (BGR); myelin is drawn as a darker shade of each.
PALETTE = [
    (0, 200, 255), (235, 180, 0), (0, 220, 100), (255, 90, 200),
    (60, 170, 255), (200, 130, 255), (255, 200, 60), (120, 220, 0),
]
BUBBLE_COLOR = (0, 0, 255)   # red: holes / missing myelin


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

    # candidate axon compartments = regions separated by the sealed myelin
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
    # Outer myelin cap, per axon, derived from the axon's OWN ring thickness rather
    # than from a pixel count or a fraction of the axon radius (see myelin_thickness_mult).
    # thickness = median distance-to-axon of the dark material assigned to this axon;
    # the median is robust to the far extracellular blobs that inflate the tail.
    uncapped = myelin_keep & (nearest > 0)
    r_by = np.zeros(len(cands) + 1)
    cap_by = np.zeros(len(cands) + 1)
    thick_by = np.zeros(len(cands) + 1)
    for a in cands:
        r_by[a['id']] = a['r']
        d = dist[uncapped & (nearest == a['id'])]
        thick = float(np.median(d)) if d.size else 0.0
        thick_by[a['id']] = thick
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
            dt_other = distance_transform_edt(axon_lbl != a['id'])
            ratio = float(dt_other[(axon_lbl > 0) & (axon_lbl != a['id'])].min()) / thick
        else:
            ratio = np.inf                       # lone axon in the field
        lo, hi = P['isolation_ramp']
        t = float(np.clip((ratio - lo) / (hi - lo), 0.0, 1.0))   # 0 clustered -> 1 isolated
        mult = P['myelin_thickness_mult'] + t * (P['myelin_thickness_mult_isolated'] - P['myelin_thickness_mult'])
        cap_by[a['id']] = mult * thick
    band_cap = cap_by[nearest]
    if P.get('myelin_band'):                     # optional absolute ceiling (usually off)
        band_cap = np.minimum(band_cap, P['myelin_band'] * r_by[nearest])
    assigned = np.where(uncapped & (dist <= band_cap), nearest, 0)

    axon_mask = np.zeros((H, W), np.int32)
    myelin_mask = np.zeros((H, W), np.int32)
    fiber_mask = np.zeros((H, W), np.int32)
    bubble = np.zeros((H, W), bool)
    axons = []
    for a in cands:
        terr = (nearest == a['id']) | (nearest == 0)   # Voronoi territory (split touching fibers)
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

    # final polish: refit each axon + fibre border as a smooth curve (vector-like,
    # hand-tracing look) without shrinking; bubbles stay excluded from myelin.
    if P['border_smooth_tol'] > 0 and axons:
        sa = np.zeros((H, W), np.int32)
        sf = np.zeros((H, W), np.int32)
        for a in axons:
            fs = fit_smooth_border(fiber_mask == a['id'],
                                   P['border_smooth_tol'], P['border_min_radius'])
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
