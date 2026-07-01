"""Register the hand-annotation masks onto the raw micrographs.

The annotations were delivered as a rendered crop (300 dpi, padded) whose base
raster is the same micrograph as data/samples/sample_0X.png, only scaled and
translated. We recover that similarity transform by multi-scale template
matching of the raw image against the crop, then warp the extracted ground-truth
label masks into the raw image's native pixel coordinates.

This gives ground-truth masks that line up pixel-for-pixel with the raw data,
so a raw-data segmentation can be scored against them.
"""
import cv2
import numpy as np

from .mask_extract import extract


def register(raw_gray, crop_bgr, scales=None):
    """Find (scale, dx, dy) placing `raw_gray` inside the annotated `crop_bgr`.

    Returns (scale, x0, y0, score): the raw image, scaled by `scale`, sits at
    offset (x0, y0) in the crop, matched with normalised-correlation `score`.
    """
    crop_gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    if scales is None:
        scales = np.linspace(0.9, 2.2, 66)
    best = None
    for s in scales:
        tw, th = int(round(raw_gray.shape[1] * s)), int(round(raw_gray.shape[0] * s))
        if tw > crop_gray.shape[1] or th > crop_gray.shape[0]:
            continue
        templ = cv2.resize(raw_gray, (tw, th), interpolation=cv2.INTER_AREA)
        res = cv2.matchTemplate(crop_gray, templ, cv2.TM_CCOEFF_NORMED)
        _, mx, _, mxloc = cv2.minMaxLoc(res)
        if best is None or mx > best[3]:
            best = (float(s), int(mxloc[0]), int(mxloc[1]), float(mx))
    return best


def _warp_label_to_raw(label_crop, scale, x0, y0, raw_shape):
    """Crop the placed region out of a crop-space label image and resize to raw."""
    H, W = raw_shape
    w, h = int(round(W * scale)), int(round(H * scale))
    sub = label_crop[y0:y0 + h, x0:x0 + w]
    if sub.shape[:2] != (h, w):                    # clamp if the box runs past the edge
        pad = np.zeros((h, w), label_crop.dtype)
        pad[:sub.shape[0], :sub.shape[1]] = sub
        sub = pad
    return cv2.resize(sub, (W, H), interpolation=cv2.INTER_NEAREST)


def ground_truth_for(raw_gray, crop_bgr):
    """Return ground-truth masks in the raw image's native coordinates.

    dict: axon_labels, fiber_labels, myelin_mask, orange_mask, plus the fitted
    (scale, x0, y0, score) and the per-axon list from the crop-space extraction.
    """
    ext = extract(crop_bgr)
    scale, x0, y0, score = register(raw_gray, crop_bgr)
    to_raw = lambda lab: _warp_label_to_raw(lab, scale, x0, y0, raw_gray.shape)
    return dict(
        axon_labels=to_raw(ext.axon_labels),
        fiber_labels=to_raw(ext.fiber_labels),
        myelin_mask=to_raw(ext.myelin_mask.astype(np.int32)).astype(np.uint8),
        orange_mask=to_raw(ext.orange_mask.astype(np.int32)).astype(np.uint8),
        fit=dict(scale=scale, x0=x0, y0=y0, score=score),
        n_axons=len(ext.axons),
    )
