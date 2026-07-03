#!/usr/bin/env python3
"""Register the hand annotations onto the raw micrographs and save ground-truth
masks in native pixel coordinates (so raw-data segmentation can be scored).

Writes, per sample, into data/samples/masks/native/:
    <stem>_gt_axon.png     16-bit axon labels (0=bg, 1..N)
    <stem>_gt_fiber.png    16-bit fibre labels
    <stem>_gt_myelin.png   8-bit myelin annulus MINUS the omit pockets (0/255)
    <stem>_gt_omit.png     8-bit non-myelin omit pockets (0/255)  [Phase 3]
    <stem>_gt_check.png    raw image with GT axon(green)/fibre(red)/omit(orange) contours

Usage:  python build_ground_truth.py
"""
import glob
import os

import cv2
import numpy as np

from gratio.gt_register import ground_truth_for

RAW_DIR = "data/samples"
CROP_DIR = "data/samples/masks"
OUT_DIR = "data/samples/masks/native"


def _check_image(raw_gray, gt):
    vis = cv2.cvtColor(raw_gray, cv2.COLOR_GRAY2BGR)
    al = gt["axon_labels"]
    for i in range(1, int(al.max()) + 1):
        cs, _ = cv2.findContours((al == i).astype(np.uint8), cv2.RETR_EXTERNAL,
                                 cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(vis, cs, -1, (0, 255, 0), 2)
    cs, _ = cv2.findContours((gt["fiber_labels"] > 0).astype(np.uint8),
                             cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(vis, cs, -1, (0, 0, 255), 2)
    if gt.get("omit_mask") is not None and gt["omit_mask"].any():
        cs, _ = cv2.findContours(gt["omit_mask"], cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(vis, cs, -1, (0, 140, 255), 2)   # orange: non-myelin pockets
    return vis


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    crops = sorted(glob.glob(os.path.join(CROP_DIR, "*_masked.png")))
    for crop_path in crops:
        stem = os.path.basename(crop_path).replace("_masked.png", "")
        raw_path = os.path.join(RAW_DIR, stem + ".png")
        raw = cv2.imread(raw_path, cv2.IMREAD_GRAYSCALE)
        if raw is None:
            print(f"!! no raw image for {stem}")
            continue
        gt = ground_truth_for(raw, cv2.imread(crop_path))
        f = gt["fit"]
        cv2.imwrite(os.path.join(OUT_DIR, f"{stem}_gt_axon.png"),
                    gt["axon_labels"].astype(np.uint16))
        cv2.imwrite(os.path.join(OUT_DIR, f"{stem}_gt_fiber.png"),
                    gt["fiber_labels"].astype(np.uint16))
        cv2.imwrite(os.path.join(OUT_DIR, f"{stem}_gt_myelin.png"), gt["myelin_mask"])
        cv2.imwrite(os.path.join(OUT_DIR, f"{stem}_gt_omit.png"), gt["omit_mask"])
        cv2.imwrite(os.path.join(OUT_DIR, f"{stem}_gt_check.png"), _check_image(raw, gt))
        print(f"  {stem}: fit scale={f['scale']:.3f} off=({f['x0']},{f['y0']}) "
              f"score={f['score']:.3f}  axons={gt['n_axons']}  omits={gt['n_omits']}")
    print(f"ground truth -> {OUT_DIR}")


if __name__ == "__main__":
    main()
