"""Reference g-ratio from ground-truth axon/myelin masks.

This codifies the *existing* / standard area-based g-ratio so we have a trusted
answer to validate the image pipeline against. Given a manual segmentation mask
(as published by AxonDeepSeg: 0 = background, 127 = myelin, 255 = axon), it
computes, per axon instance:

    g = sqrt( axon_area / (axon_area + myelin_area) )

which is identical to the textbook diameter ratio for a perfect annulus (sqrt of
the area ratio == the radius ratio). Myelin pixels are assigned to their nearest
axon instance, so a sheath shared by touching fibers is split correctly.

This module deliberately depends only on the mask, not on any image processing,
so its output is ground truth: the "correct" g for the regular cases.
"""
from __future__ import annotations
import numpy as np
from scipy.ndimage import distance_transform_edt, label as cc_label

BG, MYELIN, AXON = 0, 127, 255


def split_classes(mask: np.ndarray):
    """Return boolean (axon, myelin) masks from an axon/myelin label image.

    Accepts the AxonDeepSeg encoding (0/127/255). Values are bucketed so minor
    interpolation artefacts near the three levels are handled.
    """
    mask = np.asarray(mask)
    if mask.ndim == 3:
        mask = mask[..., 0]
    axon = mask >= 200
    myelin = (mask >= 50) & (mask < 200)
    return axon, myelin


def gratio_from_mask(mask: np.ndarray, min_axon_px: int = 200):
    """Per-axon g-ratios from a ground-truth axon/myelin mask.

    Returns a list of dicts (one per kept axon instance), each with:
    ``id``, ``axon_area``, ``myelin_area``, ``g``, ``cx``, ``cy``,
    ``equiv_radius`` (= sqrt(axon_area / pi)). Axon instances smaller than
    ``min_axon_px`` are dropped as specks.
    """
    axon, myelin = split_classes(mask)
    albl, n = cc_label(axon)
    if n == 0:
        return []
    # assign every myelin pixel to the nearest axon instance
    _, (iy, ix) = distance_transform_edt(~axon, return_indices=True)
    nearest = albl[iy, ix]
    nearest_myelin = np.where(myelin, nearest, 0)

    out = []
    for i in range(1, n + 1):
        a = int((albl == i).sum())
        if a < min_axon_px:
            continue
        m = int((nearest_myelin == i).sum())
        tot = a + m
        ys, xs = np.where(albl == i)
        out.append(dict(
            id=i, axon_area=a, myelin_area=m,
            g=float(np.sqrt(a / tot)) if tot > 0 else float("nan"),
            cx=float(xs.mean()), cy=float(ys.mean()),
            equiv_radius=float(np.sqrt(a / np.pi)),
        ))
    return out


def summarize(records):
    """Mean / median / sd / n over a list of gratio_from_mask records."""
    gs = np.array([r["g"] for r in records], float)
    if gs.size == 0:
        return dict(n=0, mean=float("nan"), median=float("nan"), sd=float("nan"))
    return dict(n=int(gs.size), mean=float(gs.mean()), median=float(np.median(gs)),
                sd=float(gs.std()), min=float(gs.min()), max=float(gs.max()))
