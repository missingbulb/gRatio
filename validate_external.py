#!/usr/bin/env python3
"""Validate the pipeline's g-ratio against EXTERNAL images with published values.

This is a *second, complementary* validation tier to the three hand-annotated
samples:

  * `evaluate_segmentation.py` / `report.py` score SEGMENTATION quality
    (per-neuron IoU, detection recall, per-neuron g) against pixel-wise ground
    truth MASKS. They need masks, and only `data/samples/` has them.

  * THIS script scores the g-ratio NUMBER against datasets that publish a
    g-ratio but no masks -- currently `data/external/macaque_cc/` (aggregate g
    per image, from the paper's Table 1). No IoU is possible or attempted; we
    compare the pipeline's mean g over detected axons to the published g.

It is a REPORT, not a pass/fail gate: on dense wide fields the current
zoom-tuned pipeline under-detects (see the delta column and the R-note in
docs/reference/user_masks.md), so this is the harness a future multi-scale pass
is iterated against -- run it, look at outputs/external/, compare deltas.

Usage:
    python data/external/macaque_cc/fetch.py     # once, to populate the images
    python validate_external.py                  # -> outputs/external/
"""
import csv
import os

import cv2
import numpy as np

from gratio import segment, render

DATA_DIR = "data/external/macaque_cc"
OUT_DIR = "outputs/external"


def load_labels(path):
    with open(path, newline="") as fh:
        return list(csv.DictReader(fh))


def mean_g(seg):
    gs = [a["g"] for a in seg["axons"]]
    return (float(np.mean(gs)) if gs else float("nan")), len(gs)


def overlay(gray, seg, title):
    ov = render(gray, seg)
    band = np.full((30, ov.shape[1], 3), 20, np.uint8)
    cv2.putText(band, title, (6, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                (255, 255, 255), 1, cv2.LINE_AA)
    return np.vstack([band, ov])


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    labels = load_labels(os.path.join(DATA_DIR, "gratio_labels.csv"))
    if not os.path.isdir(os.path.join(DATA_DIR, "images")):
        print(f"!! no images; run: python {DATA_DIR}/fetch.py")
        return

    rows = []
    print(f"{'image':22s} {'n':>4} {'pipe_g':>7} {'pub_gmean':>10} "
          f"{'pub_gagg':>9} {'d(gmean)':>9}")
    for lab in labels:
        seg_n = int(lab["segment"])
        g_mean_pub = float(lab["g_mean"])
        g_agg_pub = float(lab["g_aggregate"])
        for kind, path in (("full", os.path.join(DATA_DIR, lab["image"])),
                           ("crop", os.path.join(DATA_DIR, "crops",
                                                 f"Segment_{seg_n}_crop.png"))):
            gray = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
            if gray is None:
                continue
            seg = segment(gray)
            g, n = mean_g(seg)
            d = (g - g_mean_pub) if n else float("nan")
            name = f"S{seg_n}_{kind}"
            print(f"{name:22s} {n:>4d} {g:>7.3f} {g_mean_pub:>10.2f} "
                  f"{g_agg_pub:>9.2f} {d:>9.3f}")
            # Only the crop overlays are worth keeping: they are small and show
            # detected axons. The full-field overlays are ~12 MB each and detect
            # nothing under the zoom tuning -- their gap is captured in the CSV.
            if kind == "crop":
                cv2.imwrite(os.path.join(OUT_DIR, f"{name}.png"),
                            overlay(gray, seg, f"{name}: {n} axons  pipe g={g:.2f} "
                                    f"vs published g_mean={g_mean_pub:.2f}"))
            rows.append([name, kind, n, f"{g:.4f}", g_mean_pub, g_agg_pub,
                         f"{d:.4f}" if n else ""])

    with open(os.path.join(OUT_DIR, "scores.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["image", "kind", "n_detected", "pipeline_mean_g",
                    "published_g_mean", "published_g_aggregate", "delta_g_mean"])
        w.writerows(rows)

    crops = [r for r in rows if r[1] == "crop" and r[6] != ""]
    if crops:
        md = float(np.mean([abs(float(r[6])) for r in crops]))
        print(f"\ncrops: mean |delta g| = {md:.3f} over {len(crops)} images "
              f"(under-detects on dense fields; see R-note)   -> {OUT_DIR}/scores.csv")


if __name__ == "__main__":
    main()
