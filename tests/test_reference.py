"""Regression tests on the real ground-truth dataset (AxonDeepSeg SEM).

These pin the reference g-ratios computed from the manual masks, so the trusted
"correct" answers for the regular cases stay fixed as the code evolves.
"""
import glob
import os

import cv2
import numpy as np
import pytest

from gratio.reference import gratio_from_mask, summarize

DATA = os.path.join(os.path.dirname(__file__), "..", "data", "reference", "axondeepseg_sem")
MASKS = sorted(glob.glob(os.path.join(DATA, "*_mask.png")))


def test_dataset_present():
    assert len(MASKS) >= 5, "expected the AxonDeepSeg SEM validation subset"


@pytest.mark.parametrize("mask_path", MASKS, ids=[os.path.basename(m) for m in MASKS])
def test_each_sample_in_healthy_range(mask_path):
    recs = gratio_from_mask(cv2.imread(mask_path, cv2.IMREAD_GRAYSCALE))
    s = summarize(recs)
    assert s["n"] > 50, "should detect many axons"
    assert 0.40 < s["mean"] < 0.95, f"mean g out of healthy range: {s['mean']:.3f}"
    # every individual axon is a physically plausible ratio
    assert all(0.2 < r["g"] < 1.0 for r in recs)


def test_known_sample_data1_regression():
    """sample-data1 is the densest sample; pin its summary stats."""
    p = os.path.join(DATA, "sub-rat1_sample-data1_mask.png")
    recs = gratio_from_mask(cv2.imread(p, cv2.IMREAD_GRAYSCALE))
    s = summarize(recs)
    assert s["n"] == 531
    assert s["mean"] == pytest.approx(0.678, abs=0.005)
    assert s["median"] == pytest.approx(0.678, abs=0.005)


def test_overall_population_mean():
    gs = []
    for p in MASKS:
        gs += [r["g"] for r in gratio_from_mask(cv2.imread(p, cv2.IMREAD_GRAYSCALE))]
    gs = np.array(gs)
    assert gs.size > 1000
    assert gs.mean() == pytest.approx(0.655, abs=0.01)
