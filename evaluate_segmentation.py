#!/usr/bin/env python3
"""Run the raw-data segmentation and score it against the hand annotations.

For each sample: segment the RAW grayscale micrograph, load the registered
ground-truth masks, print semantic IoU/Dice + detection precision/recall, and
write a 3-panel [raw | prediction | ground truth] figure to outputs/eval/.

Usage:  python evaluate_segmentation.py       (after build_ground_truth.py)
"""
import csv
import glob
import os

import cv2
import numpy as np

from gratio import segment
from gratio.evaluate import evaluate

RAW_DIR = "data/samples"
GT_DIR = "data/samples/masks/native"
OUT_DIR = "outputs/eval"


def load_gt(stem):
    a = cv2.imread(os.path.join(GT_DIR, f"{stem}_gt_axon.png"), cv2.IMREAD_UNCHANGED)
    f = cv2.imread(os.path.join(GT_DIR, f"{stem}_gt_fiber.png"), cv2.IMREAD_UNCHANGED)
    m = cv2.imread(os.path.join(GT_DIR, f"{stem}_gt_myelin.png"), cv2.IMREAD_GRAYSCALE)
    o = cv2.imread(os.path.join(GT_DIR, f"{stem}_gt_omit.png"), cv2.IMREAD_GRAYSCALE)
    if a is None:
        return None
    if o is None:
        o = np.zeros_like(m)
    return {"axon_labels": a.astype(np.int32), "fiber_labels": f.astype(np.int32),
            "myelin_mask": (m > 0).astype(np.uint8) * 255,
            "omit_mask": (o > 0).astype(np.uint8) * 255}


def panel(gray, axon_any, myelin_any, fiber_any, title, omit_any=None):
    vis = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    fill = vis.copy()
    fill[myelin_any > 0] = (40, 40, 210)
    fill[axon_any > 0] = (230, 180, 0)
    paint = (myelin_any > 0) | (axon_any > 0)
    vis[paint] = (0.5 * fill[paint] + 0.5 * vis[paint]).astype(np.uint8)
    if omit_any is not None and np.any(omit_any):
        vis[omit_any > 0] = (0, 140, 255)   # orange: non-myelin pockets
    cs, _ = cv2.findContours((fiber_any > 0).astype(np.uint8), cv2.RETR_EXTERNAL,
                             cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(vis, cs, -1, (0, 0, 255), 2)
    band = np.full((34, vis.shape[1], 3), 20, np.uint8)
    cv2.putText(band, title, (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    return np.vstack([band, vis])


def figure(gray, seg, gt, path):
    pred = panel(gray, seg["axon_mask"] > 0, seg["myelin_mask"] > 0,
                 seg["fiber_mask"] > 0, "prediction (raw-data segmentation)",
                 omit_any=seg.get("nonmyelin"))
    truth = panel(gray, gt["axon_labels"] > 0, gt["myelin_mask"] > 0,
                  gt["fiber_labels"] > 0, "ground truth (your masks)",
                  omit_any=gt.get("omit_mask"))
    raw = panel(gray, np.zeros_like(gray), np.zeros_like(gray),
                np.zeros_like(gray), "raw")
    gap = np.full((raw.shape[0], 10, 3), 255, np.uint8)
    cv2.imwrite(path, np.hstack([raw, gap, pred, gap, truth]))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    rows = []
    for raw_path in sorted(glob.glob(os.path.join(RAW_DIR, "sample_*.png"))):
        stem = os.path.splitext(os.path.basename(raw_path))[0]
        gt = load_gt(stem)
        if gt is None:
            print(f"!! no ground truth for {stem}; run build_ground_truth.py")
            continue
        gray = cv2.imread(raw_path, cv2.IMREAD_GRAYSCALE)
        seg = segment(gray)
        r = evaluate(seg, gt)
        s, d = r["semantic"], r["detection"]
        print(f"\n== {stem} ==")
        print(f"  detection: pred={d['n_pred']} gt={d['n_gt']}  "
              f"TP={d['tp']} FP={d['fp']} FN={d['fn']}  "
              f"P={d['precision']:.2f} R={d['recall']:.2f}")
        for cls in ("axon", "myelin", "fiber"):
            print(f"  {cls:6s} IoU={s[cls]['iou']:.3f} Dice={s[cls]['dice']:.3f}"
                  f"  (pred {s[cls]['pred_px']}px vs gt {s[cls]['gt_px']}px)")
        o = r.get("omit")
        if o is not None and (o["gt_px"] > 0 or o["pred_px"] > 0):
            print(f"  omit   IoU={o['iou']:.3f} recall={o['recall']:.2f} "
                  f"precision={o['precision']:.2f}  (pred {o['pred_px']}px vs gt {o['gt_px']}px)")
        for m in d["matches"]:
            print(f"    match pred#{m['pred_id']}~gt#{m['gt_id']}: "
                  f"axon_IoU={m['axon_iou']:.2f} myelin_IoU={m.get('myelin_iou', 0):.2f}")
        figure(gray, seg, gt, os.path.join(OUT_DIR, f"{stem}_eval.png"))
        rows.append([stem, d["n_pred"], d["n_gt"], d["tp"], d["fp"], d["fn"],
                     f"{d['precision']:.3f}", f"{d['recall']:.3f}",
                     f"{s['axon']['iou']:.3f}", f"{s['myelin']['iou']:.3f}",
                     f"{s['fiber']['iou']:.3f}",
                     f"{o['iou']:.3f}" if o else "", f"{o['recall']:.3f}" if o else ""])

    with open(os.path.join(OUT_DIR, "scores.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["sample", "n_pred", "n_gt", "tp", "fp", "fn", "precision",
                    "recall", "axon_iou", "myelin_iou", "fiber_iou",
                    "omit_iou", "omit_recall"])
        w.writerows(rows)
    if rows:
        ai = np.mean([float(r[8]) for r in rows])
        mi = np.mean([float(r[9]) for r in rows])
        fi = np.mean([float(r[10]) for r in rows])
        print(f"\nMEAN IoU  axon={ai:.3f}  myelin={mi:.3f}  fiber={fi:.3f}   -> {OUT_DIR}/scores.csv")


if __name__ == "__main__":
    main()
