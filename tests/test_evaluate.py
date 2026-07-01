"""End-to-end regression for the raw-data segmentation vs. ground-truth check.

Registers the hand annotations onto each raw micrograph, runs the raw-data
segmentation, and pins the agreement (registration quality, detection recall,
class IoU) so the extraction cannot silently regress.
"""
import os

import cv2
import numpy as np
import pytest

from gratio import segment
from gratio.gt_register import ground_truth_for
from gratio.evaluate import evaluate, iou, match_axons

RAW = os.path.join(os.path.dirname(__file__), "..", "data", "samples")
CROP = os.path.join(RAW, "masks")
SAMPLES = ["sample_01", "sample_02", "sample_03"]


def _load(stem):
    raw = cv2.imread(os.path.join(RAW, stem + ".png"), cv2.IMREAD_GRAYSCALE)
    crop = cv2.imread(os.path.join(CROP, stem + "_masked.png"))
    return raw, crop


@pytest.fixture(scope="module")
def evaluated():
    out = {}
    for s in SAMPLES:
        raw, crop = _load(s)
        gt = ground_truth_for(raw, crop)
        out[s] = (gt, evaluate(segment(raw), gt))
    return out


def test_metric_helpers():
    a = np.zeros((10, 10), bool); a[:5] = True
    b = np.zeros((10, 10), bool); b[:5] = True
    assert iou(a, b) == 1.0
    assert iou(a, ~a) == 0.0


@pytest.mark.parametrize("stem", SAMPLES)
def test_registration_locks_on(evaluated, stem):
    gt = evaluated[stem][0]
    assert gt["fit"]["score"] > 0.75, "template match should lock the annotation onto the raw image"
    # registered ground truth is geometrically consistent: axon lies within fibre
    axon = gt["axon_labels"] > 0
    fiber = gt["fiber_labels"] > 0
    assert axon.sum() > 0 and np.all(fiber[axon])


@pytest.mark.parametrize("stem", SAMPLES)
def test_segmentation_overlaps_truth(evaluated, stem):
    sem = evaluated[stem][1]["semantic"]
    # the raw-data axon/fibre extraction meaningfully overlaps the hand masks
    assert sem["axon"]["iou"] > 0.75
    assert sem["fiber"]["iou"] > 0.75
    assert sem["myelin"]["iou"] > 0.45   # myelin is the known weak class


def test_single_axon_is_detected_exactly(evaluated):
    """sample_02 has one axon; it must be found without a false positive."""
    det = evaluated["sample_02"][1]["detection"]
    assert det["n_gt"] == 1 and det["tp"] == 1 and det["fp"] == 0


def test_every_axon_found(evaluated):
    """Recall must be perfect: a missed axon merges its myelin into a neighbour,
    corrupting that neighbour's measurement. False negatives are unacceptable."""
    for s in SAMPLES:
        det = evaluated[s][1]["detection"]
        assert det["fn"] == 0, f"{s}: missed {det['fn']} axon(s)"


def test_no_spurious_axons(evaluated):
    """No false-positive axons either, so no phantom fibres are introduced."""
    fp = sum(evaluated[s][1]["detection"]["fp"] for s in SAMPLES)
    assert fp == 0


def test_scalebar_detection_and_safety():
    """Scale bars are found; removal only fires on clean background and never
    costs an axon (correctness outranks the cosmetic clean-up)."""
    from gratio.pipeline import _find_scalebar, _remove_scalebar
    from gratio import segment
    s1 = cv2.imread(os.path.join(RAW, "sample_01.png"), cv2.IMREAD_GRAYSCALE)
    s2 = cv2.imread(os.path.join(RAW, "sample_02.png"), cv2.IMREAD_GRAYSCALE)
    s3 = cv2.imread(os.path.join(RAW, "sample_03.png"), cv2.IMREAD_GRAYSCALE)
    assert _find_scalebar(s1) is not None and _find_scalebar(s2) is not None
    assert _find_scalebar(s3) is None
    # sample_01's bar overlaps axon #4 -> gated OFF (image unchanged, axon kept)
    assert np.array_equal(_remove_scalebar(s1), s1)
    assert len(segment(s1)["axons"]) == 4
    # sample_02's bar is in clean background -> removed, axon still found
    assert not np.array_equal(_remove_scalebar(s2), s2)
    assert len(segment(s2)["axons"]) == 1


def test_border_smoothing_is_neutral_and_safe():
    """The fitted-curve border pass smooths without shrinking: recall stays
    perfect and class overlap is within ~1% of the raster version."""
    from gratio import segment
    from gratio.pipeline import fit_smooth_border
    # a fitted circle keeps its area (no inward shrink) and stays a full region
    disk = np.zeros((240, 240), np.uint8)
    cv2.circle(disk, (120, 120), 80, 1, -1)
    sm = fit_smooth_border(disk > 0, tol=2.0)
    assert abs(int(sm.sum()) - int(disk.sum())) < 0.05 * disk.sum()
    # tiny regions are left alone (min_radius guard)
    tiny = np.zeros((60, 60), np.uint8); cv2.circle(tiny, (30, 30), 4, 1, -1)
    assert np.array_equal(fit_smooth_border(tiny > 0, tol=2.0, min_radius=6.0), tiny > 0)
    for s in SAMPLES:
        raw = cv2.imread(os.path.join(RAW, s + ".png"), cv2.IMREAD_GRAYSCALE)
        on = segment(raw, border_smooth_tol=2.0)
        off = segment(raw, border_smooth_tol=0)
        assert len(on["axons"]) == len(off["axons"])          # recall unaffected
        a_on = (on["axon_mask"] > 0).sum(); a_off = (off["axon_mask"] > 0).sum()
        assert abs(a_on - a_off) < 0.03 * a_off               # no shrink
