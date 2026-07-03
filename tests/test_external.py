"""Smoke tests for the external g-ratio validation set (macaque_cc).

These lock in that the data + loader are intact and the pipeline RUNS on real
external crops -- they deliberately do NOT assert segmentation quality or g
accuracy, because the zoom-tuned pipeline under-detects on these dense wide
fields (that gap is tracked in docs/reference/user_masks.md, not gated here).
"""
import csv
import os

import cv2
import numpy as np
import pytest

from gratio import segment

DATA = "data/external/macaque_cc"
LABELS = os.path.join(DATA, "gratio_labels.csv")


def _rows():
    with open(LABELS, newline="") as fh:
        return list(csv.DictReader(fh))


@pytest.mark.skipif(not os.path.exists(LABELS), reason="external set not present")
def test_labels_present_and_ranged():
    rows = _rows()
    assert len(rows) == 8
    for r in rows:
        g_mean, g_agg = float(r["g_mean"]), float(r["g_aggregate"])
        assert 0.4 < g_mean < 0.95 and 0.4 < g_agg < 0.95   # plausible CNS g


@pytest.mark.skipif(not os.path.exists(LABELS), reason="external set not present")
def test_published_aggregate_g_is_self_consistent():
    # aggregate g = sqrt(1 - MVF/FVF); reproduces Table 1 to ~0.01
    for r in _rows():
        mvf, fvf, g_agg = float(r["mvf"]), float(r["fvf"]), float(r["g_aggregate"])
        assert np.sqrt(1 - mvf / fvf) == pytest.approx(g_agg, abs=0.02)


@pytest.mark.skipif(not os.path.exists(os.path.join(DATA, "crops")),
                    reason="crops not present (run fetch.py)")
def test_pipeline_runs_on_external_crop():
    crop = os.path.join(DATA, "crops", "Segment_5_crop.png")
    if not os.path.exists(crop):
        pytest.skip("crop missing")
    gray = cv2.imread(crop, cv2.IMREAD_GRAYSCALE)
    seg = segment(gray)                       # must not raise on real TEM data
    for a in seg["axons"]:                    # any detected g is a valid ratio
        assert 0.0 < a["g"] < 1.0
