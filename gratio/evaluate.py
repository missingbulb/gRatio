"""Score a raw-data segmentation against the hand-annotation ground truth.

Two views:
  * semantic  -- pixel overlap of the axon / myelin / fibre classes (IoU, Dice),
                 independent of how axons are split into instances.
  * detection -- match predicted axons to ground-truth axons by overlap, giving
                 precision / recall and per-match axon+myelin IoU.
"""
import numpy as np


def iou(a, b):
    a, b = a.astype(bool), b.astype(bool)
    u = (a | b).sum()
    return float((a & b).sum() / u) if u else 1.0


def dice(a, b):
    a, b = a.astype(bool), b.astype(bool)
    s = a.sum() + b.sum()
    return float(2 * (a & b).sum() / s) if s else 1.0


def semantic_scores(pred, gt):
    """IoU + Dice for each class between prediction and ground truth."""
    out = {}
    for name, p, g in [("axon", pred["axon"], gt["axon"]),
                       ("myelin", pred["myelin"], gt["myelin"]),
                       ("fiber", pred["fiber"], gt["fiber"])]:
        out[name] = {"iou": iou(p, g), "dice": dice(p, g),
                     "pred_px": int(p.sum()), "gt_px": int(g.sum())}
    return out


def match_axons(pred_labels, gt_labels, min_iou=0.3):
    """Greedy 1-1 matching of predicted to GT axon instances by IoU."""
    pids = [i for i in np.unique(pred_labels) if i > 0]
    gids = [i for i in np.unique(gt_labels) if i > 0]
    pairs = []
    for pi in pids:
        pm = pred_labels == pi
        for gi in gids:
            v = iou(pm, gt_labels == gi)
            if v >= min_iou:
                pairs.append((v, pi, gi))
    pairs.sort(reverse=True)
    used_p, used_g, matches = set(), set(), []
    for v, pi, gi in pairs:
        if pi in used_p or gi in used_g:
            continue
        used_p.add(pi); used_g.add(gi)
        matches.append({"pred_id": int(pi), "gt_id": int(gi), "axon_iou": v})
    tp = len(matches)
    return {
        "matches": matches,
        "n_pred": len(pids), "n_gt": len(gids),
        "tp": tp, "fp": len(pids) - tp, "fn": len(gids) - tp,
        "precision": tp / len(pids) if pids else 0.0,
        "recall": tp / len(gids) if gids else 0.0,
    }


def evaluate(seg, gt):
    """seg: gratio.segment() output; gt: registered ground-truth dict.

    Returns semantic scores, detection stats, and per-match myelin IoU.
    """
    pred = {"axon": seg["axon_mask"] > 0,
            "myelin": seg["myelin_mask"] > 0,
            "fiber": seg["fiber_mask"] > 0}
    gtb = {"axon": gt["axon_labels"] > 0,
           "myelin": gt["myelin_mask"] > 0,
           "fiber": gt["fiber_labels"] > 0}
    sem = semantic_scores(pred, gtb)
    det = match_axons(seg["axon_mask"], gt["axon_labels"])
    for m in det["matches"]:
        pm = seg["myelin_mask"] == m["pred_id"]
        gm = gt["myelin_mask"] > 0
        gfib = gt["fiber_labels"] == m["gt_id"]
        m["myelin_iou"] = iou(pm, gm & gfib)
    return {"semantic": sem, "detection": det}
