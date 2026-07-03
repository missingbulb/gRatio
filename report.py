#!/usr/bin/env python3
"""Results report: the presentation format the owner wants for pipeline output.

Per sample it writes a 3-panel figure  [ original | result | ground truth ]  in
the review style (thin 1px semi-transparent axon / myelin / non-myelin lines over
faint, mostly-transparent area fills), and a per-neuron metrics table comparing
the raw-data segmentation to the registered ground truth:

  * per area (axon, myelin, non-myelin), per matched neuron:
      precision ("accuracy") = |pred ∩ gt| / |pred|   and
      recall                 = |pred ∩ gt| / |gt|,   plus the raw pixel counts
  * g-ratio per neuron, pipeline vs ground truth
  * segmentation execution time per sample (ms, median of a few runs)

Outputs -> outputs/report/<stem>_report.png, outputs/report/metrics.{md,csv}

Usage:  python report.py            (after build_ground_truth.py)
"""
import csv
import glob
import os
import statistics
import time

import cv2
import numpy as np

from gratio import segment, PALETTE
from gratio.evaluate import match_axons

RAW_DIR = "data/samples"
GT_DIR = "data/samples/masks/native"
OUT_DIR = "outputs/report"

WHITE = (255, 255, 255)
NONMYELIN = (0, 140, 255)          # orange
FILL_ALPHA = 0.20                  # area masks: mostly transparent
LINE_ALPHA = 0.70                  # thin lines: semi-transparent
LINE_PX = 1


def _col(i):
    return tuple(int(c) for c in PALETTE[i % len(PALETTE)])


def _contour(mask):
    cs, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return cs


def panel(gray, title, neurons, nonmyelin=None):
    """neurons: list of dicts {axon(bool), myelin(bool), color}. Thin, transparent."""
    base = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    ov = base.copy()
    for n in neurons:
        ov[n["myelin"]] = n["color"]
        ov[n["axon"]] = tuple(int(0.4 * c + 0.6 * 255) for c in n["color"])
    if nonmyelin is not None and nonmyelin.any():
        ov[nonmyelin] = NONMYELIN
    painted = np.zeros(gray.shape, bool)
    for n in neurons:
        painted |= n["axon"] | n["myelin"]
    if nonmyelin is not None:
        painted |= nonmyelin
    out = base.copy()
    out[painted] = (FILL_ALPHA * ov[painted] + (1 - FILL_ALPHA) * base[painted]).astype(np.uint8)

    ln = out.copy()
    for n in neurons:
        cv2.drawContours(ln, _contour(n["axon"] | n["myelin"]), -1, n["color"], LINE_PX, cv2.LINE_AA)
        cv2.drawContours(ln, _contour(n["axon"]), -1, WHITE, LINE_PX, cv2.LINE_AA)
    if nonmyelin is not None and nonmyelin.any():
        cv2.drawContours(ln, _contour(nonmyelin), -1, NONMYELIN, LINE_PX, cv2.LINE_AA)
    out = cv2.addWeighted(ln, LINE_ALPHA, out, 1 - LINE_ALPHA, 0)

    for n in neurons:                                   # tiny id tag for cross-ref
        ys, xs = np.nonzero(n["axon"])
        if len(xs):
            org = (int(xs.mean()) - 8, int(ys.mean()) + 5)
            cv2.putText(out, n["tag"], org, cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3, cv2.LINE_AA)
            cv2.putText(out, n["tag"], org, cv2.FONT_HERSHEY_SIMPLEX, 0.5, WHITE, 1, cv2.LINE_AA)
    band = np.full((32, out.shape[1], 3), 20, np.uint8)
    cv2.putText(band, title, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, WHITE, 1, cv2.LINE_AA)
    return np.vstack([band, out])


def load_gt(stem):
    a = cv2.imread(f"{GT_DIR}/{stem}_gt_axon.png", cv2.IMREAD_UNCHANGED)
    f = cv2.imread(f"{GT_DIR}/{stem}_gt_fiber.png", cv2.IMREAD_UNCHANGED)
    m = cv2.imread(f"{GT_DIR}/{stem}_gt_myelin.png", cv2.IMREAD_GRAYSCALE)
    o = cv2.imread(f"{GT_DIR}/{stem}_gt_omit.png", cv2.IMREAD_GRAYSCALE)
    if a is None:
        return None
    if o is None:
        o = np.zeros_like(m)
    return {"axon_labels": a.astype(np.int32), "fiber_labels": f.astype(np.int32),
            "myelin_mask": m > 0, "omit_mask": o > 0}


def pr(pred, gt):
    inter = int((pred & gt).sum())
    p = pred.sum(); g = gt.sum()
    return (float(inter / p) if p else (1.0 if not g else 0.0),
            float(inter / g) if g else (1.0 if not pred.any() else 0.0),
            int(p), int(g))


def gratio(a_px, m_px):
    return float(np.sqrt(a_px / (a_px + m_px))) if a_px + m_px > 0 else float("nan")


def time_segment(gray, runs=3):
    ts = []
    for _ in range(runs):
        t = time.perf_counter(); segment(gray); ts.append((time.perf_counter() - t) * 1e3)
    return statistics.median(ts)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    md = ["# Pipeline vs ground truth — per-neuron report\n"]
    csv_rows = []
    for raw_path in sorted(glob.glob(f"{RAW_DIR}/sample_*.png")):
        stem = os.path.splitext(os.path.basename(raw_path))[0]
        gt = load_gt(stem)
        if gt is None:
            print(f"!! no GT for {stem}; run build_ground_truth.py"); continue
        gray = cv2.imread(raw_path, cv2.IMREAD_GRAYSCALE)
        seg = segment(gray)
        ms = time_segment(gray)
        det = match_axons(seg["axon_mask"], gt["axon_labels"])
        cmap = {m["gt_id"]: _col(i) for i, m in enumerate(det["matches"])}

        res_neurons, gt_neurons, rows = [], [], []
        for i, mt in enumerate(det["matches"]):
            pid, gid, col = mt["pred_id"], mt["gt_id"], _col(i)
            p_ax = seg["axon_mask"] == pid
            p_my = seg["myelin_mask"] == pid
            g_ax = gt["axon_labels"] == gid
            g_my = gt["myelin_mask"] & (gt["fiber_labels"] == gid)
            axP, axR, axpp, axgp = pr(p_ax, g_ax)
            myP, myR, mypp, mygp = pr(p_my, g_my)
            g_pred = gratio(axpp, mypp)
            g_true = gratio(int(g_ax.sum()), int(g_my.sum()))
            res_neurons.append({"axon": p_ax, "myelin": p_my, "color": col, "tag": f"{i+1}"})
            gt_neurons.append({"axon": g_ax, "myelin": g_my, "color": col, "tag": f"{i+1}"})
            rows.append((i + 1, pid, gid, axP, axR, axpp, axgp, myP, myR, mypp, mygp, g_pred, g_true))
            csv_rows.append([stem, i + 1, pid, gid, f"{axP:.3f}", f"{axR:.3f}", axpp, axgp,
                             f"{myP:.3f}", f"{myR:.3f}", mypp, mygp,
                             f"{g_pred:.3f}", f"{g_true:.3f}", f"{ms:.0f}"])

        original = panel(gray, f"{stem}  original", [])
        result = panel(gray, f"{stem}  result (pipeline)", res_neurons, seg.get("nonmyelin"))
        truth = panel(gray, f"{stem}  ground truth", gt_neurons, gt["omit_mask"])
        gap = np.full((original.shape[0], 8, 3), 255, np.uint8)
        cv2.imwrite(f"{OUT_DIR}/{stem}_report.png", np.hstack([original, gap, result, gap, truth]))

        # non-myelin (per sample; pockets are extracellular, not per-neuron)
        nmP, nmR, nmpp, nmgp = pr(seg.get("nonmyelin", np.zeros_like(gray, bool)).astype(bool),
                                  gt["omit_mask"])
        md.append(f"\n## {stem} — {len(rows)} neurons, segment {ms:.0f} ms\n")
        md.append("| neuron (pred~gt) | axon P | axon R | axon px (pred/gt) | "
                  "myelin P | myelin R | myelin px (pred/gt) | g pred | g GT |")
        md.append("|---|---|---|---|---|---|---|---|---|")
        for (nid, pid, gid, axP, axR, axpp, axgp, myP, myR, mypp, mygp, gp, gt_) in rows:
            md.append(f"| #{nid} (p{pid}~g{gid}) | {axP:.2f} | {axR:.2f} | {axpp}/{axgp} | "
                      f"{myP:.2f} | {myR:.2f} | {mypp}/{mygp} | {gp:.2f} | {gt_:.2f} |")
        if nmgp or nmpp:
            md.append(f"\nnon-myelin pockets (sample): precision {nmP:.2f}, recall {nmR:.2f} "
                      f"(pred {nmpp}px / gt {nmgp}px)")
        print(f"{stem}: {len(rows)} neurons, {ms:.0f} ms, "
              f"detect P={det['precision']:.2f} R={det['recall']:.2f}")

    with open(f"{OUT_DIR}/metrics.md", "w") as fh:
        fh.write("\n".join(md) + "\n")
    with open(f"{OUT_DIR}/metrics.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["sample", "neuron", "pred_id", "gt_id", "axon_precision", "axon_recall",
                    "axon_pred_px", "axon_gt_px", "myelin_precision", "myelin_recall",
                    "myelin_pred_px", "myelin_gt_px", "g_pred", "g_gt", "segment_ms"])
        w.writerows(csv_rows)
    print(f"\n-> {OUT_DIR}/  (figures + metrics.md + metrics.csv)")


if __name__ == "__main__":
    main()
