"""Exact-answer tests on synthetic masks.

A perfect myelinated annulus has a known g-ratio: g = r_in / r_out. These tests
pin the reference metric (and the area<->radius parity) to that ground truth, so
any regression in the g-ratio math is caught immediately.
"""
import numpy as np
import pytest

from gratio.reference import gratio_from_mask, AXON, MYELIN


def make_annulus(r_in, r_out, size=600, center=None):
    """Mask with one axon (255) inside a myelin ring (127); g_true = r_in/r_out."""
    import cv2
    m = np.zeros((size, size), np.uint8)
    cx, cy = center or (size // 2, size // 2)
    cv2.circle(m, (cx, cy), r_out, MYELIN, -1)
    cv2.circle(m, (cx, cy), r_in, AXON, -1)
    return m


@pytest.mark.parametrize("r_in,r_out", [(40, 100), (60, 100), (70, 100), (85, 100), (50, 120)])
def test_perfect_annulus_recovers_radius_ratio(r_in, r_out):
    recs = gratio_from_mask(make_annulus(r_in, r_out))
    assert len(recs) == 1
    g = recs[0]["g"]
    assert g == pytest.approx(r_in / r_out, abs=0.01)


def test_two_axons_recovered_independently():
    import cv2
    m = np.zeros((400, 800), np.uint8)
    # left: g=0.6, right: g=0.8
    for (cx, ri, ro) in [(200, 60, 100), (600, 80, 100)]:
        cv2.circle(m, (cx, 200), ro, MYELIN, -1)
        cv2.circle(m, (cx, 200), ri, AXON, -1)
    recs = sorted(gratio_from_mask(m), key=lambda r: r["cx"])
    assert len(recs) == 2
    assert recs[0]["g"] == pytest.approx(0.60, abs=0.01)
    assert recs[1]["g"] == pytest.approx(0.80, abs=0.01)


def test_sqrt_of_area_ratio_equals_radius_ratio():
    # parity identity that justifies the area formula
    r_in, r_out = 70.0, 100.0
    a_in = np.pi * r_in ** 2
    a_out = np.pi * r_out ** 2
    assert np.sqrt(a_in / a_out) == pytest.approx(r_in / r_out, abs=1e-9)


def test_thin_myelin_is_high_g():
    recs = gratio_from_mask(make_annulus(95, 100))
    assert recs[0]["g"] > 0.9


def test_thick_myelin_is_low_g():
    recs = gratio_from_mask(make_annulus(40, 100))
    assert recs[0]["g"] < 0.45
