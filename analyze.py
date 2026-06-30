#!/usr/bin/env python3
"""CLI: compute area-based g-ratios for EM cross-section images.

For each input image, writes a coloured overlay PNG (axon interior, myelin, and
the per-axon g-ratio drawn at the axon centroid) and a CSV of per-axon results.

Usage:
    python analyze.py data/samples/*.png -o outputs/
    python analyze.py img.png -o outputs/ --myelin-percentile 25
"""
import argparse
import csv
import os
import cv2

from gratio import segment, render, DEFAULTS


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("images", nargs="+", help="input image path(s)")
    ap.add_argument("-o", "--outdir", default="outputs", help="output directory")
    # expose the numeric tunables
    for key, val in DEFAULTS.items():
        if isinstance(val, (int, float)):
            ap.add_argument(f"--{key.replace('_', '-')}", type=type(val), default=None)
    args = ap.parse_args()

    overrides = {}
    for key, val in DEFAULTS.items():
        if isinstance(val, (int, float)):
            got = getattr(args, key)
            if got is not None:
                overrides[key] = got

    os.makedirs(args.outdir, exist_ok=True)
    for path in args.images:
        img = cv2.imread(path)
        if img is None:
            print(f"!! could not read {path}")
            continue
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        seg = segment(gray, **overrides)
        out = render(gray, seg)

        stem = os.path.splitext(os.path.basename(path))[0]
        overlay_path = os.path.join(args.outdir, f"{stem}_gratio.png")
        csv_path = os.path.join(args.outdir, f"{stem}_gratio.csv")
        cv2.imwrite(overlay_path, out)
        with open(csv_path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["axon_id", "g_ratio", "axon_area_px", "myelin_area_px",
                        "centroid_x", "centroid_y", "equiv_radius_px", "solidity"])
            for a in seg["axons"]:
                w.writerow([a["id"], f"{a['g']:.4f}", a["area"], a["myelin_area"],
                            f"{a['cx']:.1f}", f"{a['cy']:.1f}", f"{a['r']:.1f}",
                            f"{a['solidity']:.3f}"])

        gs = ", ".join(f"#{a['id']}={a['g']:.2f}" for a in seg["axons"])
        print(f"{path}: {len(seg['axons'])} axon(s) [{gs}]  ->  {overlay_path}")


if __name__ == "__main__":
    main()
