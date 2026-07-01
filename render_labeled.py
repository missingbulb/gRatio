#!/usr/bin/env python3
"""Render per-axon coloured, numbered review figures for the sample images.

For each raw micrograph writes outputs/eval/<stem>_labeled.png, a 3-panel
[ raw | CURRENT prediction | ground truth ] figure where every axon has its own
colour, its fibre's myelin is the same colour (darker), the axon border is white,
the fibre outer border is the axon colour, detected bubbles are yellow, and each
axon centre carries a number (top-to-bottom, left-to-right; same numbering in
both panels so axons can be referred to by number).

Usage:  python render_labeled.py
"""
import glob
import os

import cv2
import numpy as np

from gratio import segment

RAW_DIR = "data/samples"
GT_DIR = "data/samples/masks/native"
OUT_DIR = "outputs/eval"

PALETTE = [(66, 135, 245), (245, 180, 66), (66, 220, 120), (230, 70, 200),
           (66, 240, 240), (180, 90, 245), (245, 150, 60), (120, 230, 40)]


def _renumber(axon_labels):
    """Map raw axon ids -> reading-order numbers (top-to-bottom, left-to-right)."""
    cents = []
    for i in [v for v in np.unique(axon_labels) if v > 0]:
        ys, xs = np.where(axon_labels == i)
        cents.append((i, xs.mean(), ys.mean()))
    order = sorted(cents, key=lambda c: (round(c[2] / 60), c[1]))
    return {old: n + 1 for n, (old, _, _) in enumerate(order)}


def _draw(gray, axon_labels, fiber_labels, bubble=None, alpha=0.3,
          line_thickness=1, line_alpha=0.55):
    vis = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    fill = vis.copy()
    remap = _renumber(axon_labels)
    for old, new in remap.items():
        col = PALETTE[(new - 1) % len(PALETTE)]
        fill[axon_labels == old] = col
        fill[(fiber_labels == old) & (axon_labels == 0)] = tuple(int(x * 0.45) for x in col)
    paint = (axon_labels > 0) | ((fiber_labels > 0) & (axon_labels == 0))
    vis[paint] = (alpha * fill[paint] + (1 - alpha) * vis[paint]).astype(np.uint8)
    if bubble is not None and bubble.any():
        vis[bubble] = (0, 255, 255)
    # Draw thin border lines onto a separate layer, then blend so the raw
    # image stays visible underneath and border placement can be checked.
    lines = vis.copy()
    for old, new in remap.items():
        col = PALETTE[(new - 1) % len(PALETTE)]
        for lab, c in [(fiber_labels == old, col), (axon_labels == old, (255, 255, 255))]:
            cs, _ = cv2.findContours(lab.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cv2.drawContours(lines, cs, -1, c, line_thickness, cv2.LINE_AA)
    vis = (line_alpha * lines + (1 - line_alpha) * vis).astype(np.uint8)
    for old, new in remap.items():
        ys, xs = np.where(axon_labels == old)
        org = (int(xs.mean()) - 14, int(ys.mean()) + 10)
        cv2.putText(vis, str(new), org, cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 0, 0), 5, cv2.LINE_AA)
        cv2.putText(vis, str(new), org, cv2.FONT_HERSHEY_SIMPLEX, 1.1, (255, 255, 255), 2, cv2.LINE_AA)
    return vis


def _banner(img, text):
    bar = np.full((34, img.shape[1], 3), 20, np.uint8)
    cv2.putText(bar, text, (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.66, (255, 255, 255), 2)
    return np.vstack([bar, img])


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for raw_path in sorted(glob.glob(os.path.join(RAW_DIR, "sample_*.png"))):
        stem = os.path.splitext(os.path.basename(raw_path))[0]
        gray = cv2.imread(raw_path, cv2.IMREAD_GRAYSCALE)
        seg = segment(gray)
        cur = _draw(gray, seg["axon_mask"], seg["fiber_mask"], seg["bubble"])
        panels = [_banner(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR), f"{stem} raw"),
                  _banner(cur, "CURRENT (axon=white line, fibre=colour line, bubbles=yellow)")]
        ga = cv2.imread(os.path.join(GT_DIR, f"{stem}_gt_axon.png"), cv2.IMREAD_UNCHANGED)
        gf = cv2.imread(os.path.join(GT_DIR, f"{stem}_gt_fiber.png"), cv2.IMREAD_UNCHANGED)
        if ga is not None:
            panels.append(_banner(_draw(gray, ga.astype(np.int32), gf.astype(np.int32)),
                                  "GROUND TRUTH"))
        sep = np.full((panels[0].shape[0], 6, 3), 255, np.uint8)
        fig = panels[0]
        for p in panels[1:]:
            fig = np.hstack([fig, sep, p])
        cv2.imwrite(os.path.join(OUT_DIR, f"{stem}_labeled.png"), fig)
        print(f"  {stem}: {len(seg['axons'])} axons -> {OUT_DIR}/{stem}_labeled.png")


if __name__ == "__main__":
    main()
