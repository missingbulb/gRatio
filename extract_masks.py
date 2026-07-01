#!/usr/bin/env python3
"""Extract purple (axon) and red (myelin-outer) masks from the annotated images.

Deterministic CV extraction -- no g-ratio maths. For each annotated micrograph
it writes label masks, a myelin mask, a feedback overlay, and a CSV of region
areas, then checks the axon/fibre counts against the known ground truth.

Usage:
    python extract_masks.py                     # all annotated samples, self-check
    python extract_masks.py data/samples/masks/sample_02_masked.png
"""
import argparse
import csv
import glob
import os
import sys

import cv2
import numpy as np

from gratio.mask_extract import extract, render_overlay

# expected enclosed-region counts, from the user's hand numbering
EXPECTED = {
    "sample_01": {"axons": 4},   # + 4 orange omit regions (not counted here)
    "sample_02": {"axons": 1},
    "sample_03": {"axons": 5},
}


def sample_key(path):
    base = os.path.basename(path)
    for k in EXPECTED:
        if base.startswith(k):
            return k
    return None


def run(path, outdir):
    bgr = cv2.imread(path)
    if bgr is None:
        print(f"!! could not read {path}")
        return None
    key = sample_key(path) or os.path.splitext(os.path.basename(path))[0]
    ext = extract(bgr, stem=key)

    os.makedirs(outdir, exist_ok=True)
    cv2.imwrite(os.path.join(outdir, f"{key}_axon_labels.png"),
                ext.axon_labels.astype(np.uint16))
    cv2.imwrite(os.path.join(outdir, f"{key}_fiber_labels.png"),
                ext.fiber_labels.astype(np.uint16))
    cv2.imwrite(os.path.join(outdir, f"{key}_myelin_mask.png"), ext.myelin_mask)
    cv2.imwrite(os.path.join(outdir, f"{key}_extract.png"), render_overlay(bgr, ext))

    with open(os.path.join(outdir, f"{key}_regions.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["type", "id", "area_px", "centroid_x", "centroid_y"])
        for a in ext.axons:
            w.writerow(["axon", a["id"], a["area_px"], f"{a['cx']:.1f}", f"{a['cy']:.1f}"])
        for r in ext.fibers:
            w.writerow(["fiber", r["id"], r["area_px"], f"{r['cx']:.1f}", f"{r['cy']:.1f}"])

    exp = EXPECTED.get(key, {}).get("axons")
    got = len(ext.axons)
    ok = (exp is None) or (got == exp)
    tag = "OK " if ok else "XX "
    exps = "?" if exp is None else str(exp)
    orange_px = int((ext.orange_mask > 0).sum())
    print(f"  {tag}{key}: axons={got} (expect {exps})  fibers={len(ext.fibers)}"
          f"  orange_px={orange_px}")
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("images", nargs="*",
                    default=sorted(glob.glob("data/samples/masks/*_masked.png")))
    ap.add_argument("-o", "--outdir", default="outputs/masks")
    args = ap.parse_args()
    if not args.images:
        print("no annotated images found under data/samples/masks/")
        return 1
    print(f"extracting purple/red masks -> {args.outdir}")
    results = [run(p, args.outdir) for p in args.images]
    passed = sum(1 for r in results if r)
    total = sum(1 for r in results if r is not None)
    print(f"count-check: {passed}/{total} images match expected axon count")
    return 0 if passed == total else 2


if __name__ == "__main__":
    sys.exit(main())
