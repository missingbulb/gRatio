"""Extract the hand-drawn purple (axon) and red (myelin-outer) areas from the
user-annotated micrographs into clean, filled label masks.

The annotations use a fixed colour convention (see docs/reference/user_masks.md):

    purple  -> axon boundary   (interior = the axon area)
    red     -> myelin outer boundary (interior = the whole fibre area)
    orange  -> regions to omit  (detected and reported, not yet used)

The handwritten region numbers are drawn in the *same* purple ink as the axon
loops, so we never count purple pixels directly -- we fill closed purple loops
and drop anything too small to be an axon (which removes the digit glyphs).

This module is deterministic: same input image -> same masks, every run.
"""
from dataclasses import dataclass, field

import cv2
import numpy as np

# --- colour gates (HSV, OpenCV ranges: H 0-179, S/V 0-255) -------------------
# Tuned from the hue histogram of the annotated crops:
#   purple ink ~ H 140-150, red ~ H 0-10, orange ~ H 10-22.
PURPLE_HUE = (125, 160)
RED_HUE_LO = (0, 9)       # red wraps around 0; low side
RED_HUE_HI = (170, 180)   # ...and high side
ORANGE_HUE = (9, 26)
MIN_SAT = 60              # ink is saturated; grayscale EM is not
MIN_VAL = 60

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


def extract(bgr, stem=""):
    """Run the full extraction on one annotated BGR image."""
    h, w = bgr.shape[:2]
    min_area = MIN_REGION_FRAC * h * w
    purple, red, orange = _color_masks(bgr)

    axon_fill = _fill_closed_loops(purple, min_area)
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

    axon_labels, axons = _relabel_reading_order(axon_labels, axons)
    fiber_labels, fibers = _fibers_by_watershed(bgr, red, axon_labels, axons)

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
