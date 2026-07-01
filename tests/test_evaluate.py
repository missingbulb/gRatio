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
