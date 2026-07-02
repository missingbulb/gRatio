"""Extract the hand-drawn annotations from the user micrographs into clean,
filled label masks. Two annotation schemes are supported and auto-detected:

**red-boundary scheme** (samples 1-2)::

    purple  -> axon boundary   (interior = the axon area)
    red     -> myelin outer boundary (interior = the whole fibre area)
    orange  -> regions to omit  (detected and reported, not yet used)

Fibres are the marker-controlled watershed of the axons with the red line burned
in as a ridge.

**per-neuron-fill scheme** (sample 3, no red)::

    purple loop        -> axon boundary (inner)
    translucent fill   -> that neuron's myelin; the fill's OUTER edge is the
                          myelin outer boundary. Each neuron gets a distinct hue.

Here the myelin comes straight from the colour the user painted, so no red outer
line is needed. The pen loops are ~fully saturated while the fills are
translucent (S ~ 90-110), so a saturation cut separates the axon loops from the
fills. See docs/reference/gt_from_masks.md for the full procedure.

The handwritten region numbers are drawn in the *same* purple ink as the axon
loops, so we never count purple pixels directly -- we fill closed purple loops
and drop anything too small to be an axon (which removes the digit glyphs).

This module is deterministic: same input image -> same masks, every run.
"""
from dataclasses import dataclass, field

import cv2
import numpy as np
from scipy import ndimage as ndi

# --- colour gates (HSV, OpenCV ranges: H 0-179, S/V 0-255) -------------------
# Tuned from the hue histogram of the annotated crops:
#   purple ink ~ H 140-150, red ~ H 0-10, orange ~ H 10-22.
PURPLE_HUE = (125, 160)
RED_HUE_LO = (0, 9)       # red wraps around 0; low side
RED_HUE_HI = (170, 180)   # ...and high side
ORANGE_HUE = (9, 26)
MIN_SAT = 60              # ink is saturated; grayscale EM is not
MIN_VAL = 60

# per-neuron-fill scheme: the pen lines are ~fully saturated, the translucent
# colour fills sit lower (S ~ 90-110), so these cuts split the two.
PURPLE_LINE_MIN_SAT = 150   # isolate the axon pen loop from any bluish fill
RED_LINE_MIN_SAT = 150      # a real red outer-boundary line (fills stay below)
FILL_SAT = (45, 165)        # translucent per-neuron myelin fill
FILL_HUE_TOL = 12           # circular hue window when growing one neuron's fill

# a region must be at least this fraction of the image to count as an axon/fibre
# (drops handwritten digits and stray ink specks)
MIN_REGION_FRAC = 0.004


@dataclass
class Extraction:
    stem: str
    shape: tuple
    axon_labels: np.ndarray          # int32, 0 = bg, 1..N per axon
    fiber_labels: np.ndarray         # int32, 0 = bg, 1..M per fibre
    myelin_mask: np.ndarray          # uint8, fibre minus axon (0/255)
    orange_mask: np.ndarray          # uint8, raw omit ink (0/255)
    axons: list = field(default_factory=list)   # dicts: id, area_px, cx, cy
    fibers: list = field(default_factory=list)


def _ink_mask(hsv, hue_range):
    lo = np.array([hue_range[0], MIN_SAT, MIN_VAL])
    hi = np.array([hue_range[1], 255, 255])
    return cv2.inRange(hsv, lo, hi)


def _color_masks(bgr):
    """Return (purple, red, orange) binary ink masks."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    purple = _ink_mask(hsv, PURPLE_HUE)
    red = _ink_mask(hsv, RED_HUE_LO) | _ink_mask(hsv, RED_HUE_HI)
    orange = _ink_mask(hsv, ORANGE_HUE)
    return purple, red, orange


def _red_line_mask(hsv):
    """The saturated red *outer-boundary line* (not the translucent coral fill)."""
    H, S = hsv[..., 0], hsv[..., 1]
    hue = ((H <= RED_HUE_LO[1]) | (H >= RED_HUE_HI[0]))
    return (hue & (S >= RED_LINE_MIN_SAT)).astype(np.uint8) * 255


def _purple_line_mask(hsv):
    """The saturated purple axon pen loop, excluding translucent bluish fills."""
    H, S, V = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    return ((H >= PURPLE_HUE[0]) & (H <= PURPLE_HUE[1]) &
            (S >= PURPLE_LINE_MIN_SAT) & (V >= MIN_VAL)).astype(np.uint8) * 255


def _fill_closed_loops(ink, min_area, close_k=9):
    """Fill closed hand-drawn loops in `ink`, dropping shapes below min_area.

    Robust to small pen gaps (morphological close) and ignores open strokes
    such as digit glyphs, whose filled interior is tiny.
    """
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_k, close_k))
    sealed = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, k)
    cnts, _ = cv2.findContours(sealed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros(ink.shape, np.uint8)
    for c in cnts:
        if cv2.contourArea(c) >= min_area:
            cv2.drawContours(filled, [c], -1, 255, cv2.FILLED)
    return filled


def _fibers_by_watershed(bgr, red_ink, axon_labels, axons, close_k=17):
    """Assign each fibre (axon + its myelin) as the catchment of its axon.

    Marker-controlled watershed: every axon is a seed, an "outside" seed floods
    the extracellular space, and the red ink is burned in as a ridge so the
    basins meet exactly on the red outer boundary. This yields one fibre per
    axon and cleanly splits fibres that share a myelin wall -- no leaks, no gaps.

    The red outer line is hand-drawn and has small gaps; we close it firmly so
    the "outside" basin cannot leak through a gap into the dark myelin band.
    """
    h, w = red_ink.shape
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_k, close_k))
    walls = cv2.morphologyEx(red_ink, cv2.MORPH_CLOSE, k)

    # "outside" seed: free space reachable from the border without crossing red
    free = cv2.bitwise_not(cv2.dilate(walls, k))
    ff = free.copy()
    ffmask = np.zeros((h + 2, w + 2), np.uint8)
    for x in range(0, w, 5):
        for y in (0, h - 1):
            if ff[y, x] == 255:
                cv2.floodFill(ff, ffmask, (x, y), 128)
    for y in range(0, h, 5):
        for x in (0, w - 1):
            if ff[y, x] == 255:
                cv2.floodFill(ff, ffmask, (x, y), 128)
    outside = cv2.erode((ff == 128).astype(np.uint8) * 255, k)

    bg_id = (max((a["id"] for a in axons), default=0) + 1)
    markers = np.zeros((h, w), np.int32)
    markers[outside > 0] = bg_id
    markers[axon_labels > 0] = axon_labels[axon_labels > 0]

    # ridge surface: base grey with the red ink burned to a hard edge
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    surf = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    surf[walls > 0] = (0, 0, 255)
    cv2.watershed(surf, markers)

    out = np.zeros((h, w), np.int32)
    regions = []
    for a in axons:
        m = markers == a["id"]
        if not m.any():
            continue
        out[m] = a["id"]
        ys, xs = np.nonzero(m)
        regions.append({"id": a["id"], "area_px": int(m.sum()),
                        "cx": float(xs.mean()), "cy": float(ys.mean())})
    return out, regions


def _relabel_reading_order(labels, regions):
    """Renumber regions top-to-bottom, left-to-right for stable, human IDs."""
    order = sorted(regions, key=lambda r: (round(r["cy"] / 40), r["cx"]))
    remap = {r["id"]: i + 1 for i, r in enumerate(order)}
    out = np.zeros_like(labels)
    for old, new in remap.items():
        out[labels == old] = new
    for r in regions:
        r["id"] = remap[r["id"]]
    regions.sort(key=lambda r: r["id"])
    return out, regions


def _axons_from_loops(loop_ink, min_area, shape):
    """Fill closed purple loops -> axon label image + reading-order region list."""
    h, w = shape
    axon_fill = _fill_closed_loops(loop_ink, min_area)
    an, alab, astats, acent = cv2.connectedComponentsWithStats(axon_fill, 8)
    axon_labels = np.zeros((h, w), np.int32)
    axons = []
    aid = 0
    for i in range(1, an):
        if astats[i, cv2.CC_STAT_AREA] < min_area:
            continue
        aid += 1
        axon_labels[alab == i] = aid
        axons.append({"id": aid, "area_px": int(astats[i, cv2.CC_STAT_AREA]),
                      "cx": float(acent[i][0]), "cy": float(acent[i][1])})
    return _relabel_reading_order(axon_labels, axons)


def _myelin_by_fill(hsv, axon_labels, axons):
    """Per-neuron myelin from the translucent colour fills.

    Each axon's fill is identified by the dominant hue seen in a ring just
    outside its loop, then grown to the connected fill of that hue touching the
    ring. Distinct hues keep neighbouring fills from bleeding into one another,
    so there is no need for a red line to split shared walls.
    """
    h, w = axon_labels.shape
    H, S = hsv[..., 0].astype(int), hsv[..., 1]
    purple = _purple_line_mask(hsv) > 0
    red_line = _red_line_mask(hsv) > 0
    fill = ((S >= FILL_SAT[0]) & (S < FILL_SAT[1]) & ~purple & ~red_line &
            (axon_labels == 0))
    fill = cv2.morphologyEx(fill.astype(np.uint8) * 255, cv2.MORPH_OPEN,
                            np.ones((3, 3), np.uint8)) > 0

    myelin_labels = np.zeros((h, w), np.int32)
    ring_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31))
    for a in axons:
        ai = (axon_labels == a["id"]).astype(np.uint8)
        dil = cv2.dilate(ai, ring_k) > 0
        ring = dil & fill
        if ring.sum() < 50:
            continue
        hue = int(np.median(H[ring]))
        d = np.abs(H - hue)
        d = np.minimum(d, 180 - d)
        colmask = fill & (d <= FILL_HUE_TOL)
        lab, _ = ndi.label(colmask)
        touch = set(np.unique(lab[dil])) - {0}
        band = np.isin(lab, list(touch))
        myelin_labels[band & (myelin_labels == 0)] = a["id"]
    return myelin_labels


def _fibers_from_fill(axon_labels, myelin_labels, axons, close_k=15):
    """Fibre = axon + its myelin fill, closed and hole-filled per neuron."""
    h, w = axon_labels.shape
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_k, close_k))
    fiber_labels = np.zeros((h, w), np.int32)
    fibers = []
    for a in axons:
        reg = (axon_labels == a["id"]) | (myelin_labels == a["id"])
        reg = cv2.morphologyEx(reg.astype(np.uint8) * 255, cv2.MORPH_CLOSE, k) > 0
        reg = ndi.binary_fill_holes(reg)
        fiber_labels[reg] = a["id"]
        ys, xs = np.nonzero(reg)
        fibers.append({"id": a["id"], "area_px": int(reg.sum()),
                       "cx": float(xs.mean()), "cy": float(ys.mean())})
    return fiber_labels, fibers


def extract(bgr, stem=""):
    """Run the full extraction on one annotated BGR image.

    Auto-detects the scheme: a saturated red outer-boundary line -> red-watershed
    fibres; no red line -> per-neuron colour fills define the myelin.
    """
    h, w = bgr.shape[:2]
    min_area = MIN_REGION_FRAC * h * w
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    purple, red, orange = _color_masks(bgr)

    if int((_red_line_mask(hsv) > 0).sum()) >= min_area:
        # red-boundary scheme (samples 1-2)
        axon_labels, axons = _axons_from_loops(purple, min_area, (h, w))
        fiber_labels, fibers = _fibers_by_watershed(bgr, red, axon_labels, axons)
    else:
        # per-neuron-fill scheme (sample 3): purple loop = axon, fill = myelin
        axon_labels, axons = _axons_from_loops(_purple_line_mask(hsv), min_area, (h, w))
        myelin_labels = _myelin_by_fill(hsv, axon_labels, axons)
        fiber_labels, fibers = _fibers_from_fill(axon_labels, myelin_labels, axons)

    myelin = np.where((fiber_labels > 0) & (axon_labels == 0), 255, 0).astype(np.uint8)

    return Extraction(stem=stem, shape=(h, w),
                      axon_labels=axon_labels, fiber_labels=fiber_labels,
                      myelin_mask=myelin, orange_mask=orange,
                      axons=axons, fibers=fibers)


# --- visualisation -----------------------------------------------------------
_PALETTE = [(66, 135, 245), (245, 197, 66), (66, 245, 132), (245, 66, 197),
            (66, 245, 245), (155, 66, 245), (245, 111, 66), (111, 245, 66)]


def render_overlay(bgr, ext, alpha=0.6):
    """Side-by-side [annotated | extracted masks] for visual feedback.

    Myelin is filled solid red, each axon a distinct colour, at `alpha` opacity
    so the extracted regions read cleanly over the grayscale texture.
    """
    vis = bgr.copy()
    fill = vis.copy()
    fill[ext.myelin_mask > 0] = (40, 40, 210)
    for a in ext.axons:
        fill[ext.axon_labels == a["id"]] = _PALETTE[(a["id"] - 1) % len(_PALETTE)]
    painted = (ext.myelin_mask > 0) | (ext.axon_labels > 0)
    vis[painted] = (alpha * fill[painted] + (1 - alpha) * vis[painted]).astype(np.uint8)

    for lab, colbase in ((ext.fiber_labels, (0, 0, 255)),
                         (ext.axon_labels, (255, 255, 255))):
        for i in range(1, int(lab.max()) + 1):
            edge = cv2.morphologyEx((lab == i).astype(np.uint8) * 255,
                                    cv2.MORPH_GRADIENT,
                                    np.ones((3, 3), np.uint8))
            vis[edge > 0] = colbase
    for a in ext.axons:
        org = (int(a["cx"]) - 22, int(a["cy"]) + 10)
        cv2.putText(vis, f"#{a['id']}", org, cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 4)
        cv2.putText(vis, f"#{a['id']}", org, cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)

    def titled(im, txt):
        band = np.full((36, im.shape[1], 3), 20, np.uint8)
        cv2.putText(band, txt, (8, 26), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
        return np.vstack([band, im])

    left = titled(bgr, "annotated (input)")
    right = titled(vis, "extracted: axon=colour  myelin=red  (border: red=fibre white=axon)")
    gap = np.full((left.shape[0], 12, 3), 255, np.uint8)
    return np.hstack([left, gap, right])
