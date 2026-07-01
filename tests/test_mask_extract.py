"""Regression tests for extracting the hand-drawn purple/red masks.

These pin the deterministic CV extraction on the three user-annotated
micrographs: the axon/fibre counts must match the user's numbering, each fibre
must fully contain its axon, and the myelin annulus must be non-empty.
"""
import glob
import os

import cv2
import numpy as np
import pytest

from gratio.mask_extract import extract

MASKDIR = os.path.join(os.path.dirname(__file__), "..", "data", "samples", "masks")
IMAGES = sorted(glob.glob(os.path.join(MASKDIR, "*_masked.png")))

# the user's hand numbering: enclosed purple axon loops per image
EXPECTED_AXONS = {"sample_01": 4, "sample_02": 1, "sample_03": 5}


def _key(path):
    return os.path.basename(path).replace("_masked.png", "")


def test_annotated_images_present():
    assert {_key(p) for p in IMAGES} == set(EXPECTED_AXONS), \
        "expected the three annotated sample crops under data/samples/masks/"


@pytest.mark.parametrize("path", IMAGES, ids=[_key(p) for p in IMAGES])
def test_axon_and_fiber_counts(path):
    ext = extract(cv2.imread(path), stem=_key(path))
    expect = EXPECTED_AXONS[_key(path)]
    assert len(ext.axons) == expect, "axon count must match the hand numbering"
    # watershed yields exactly one fibre per axon
    assert len(ext.fibers) == expect


@pytest.mark.parametrize("path", IMAGES, ids=[_key(p) for p in IMAGES])
def test_geometry_is_sane(path):
    ext = extract(cv2.imread(path), stem=_key(path))
    for a in ext.axons:
        axon = ext.axon_labels == a["id"]
        fiber = ext.fiber_labels == a["id"]
        assert axon.sum() > 0 and fiber.sum() > 0
        # the fibre fully contains its own axon...
        assert np.all(fiber[axon]), "axon must lie inside its fibre"
        # ...with a real myelin ring around it
        myelin = fiber & ~axon
        assert myelin.sum() > 0.05 * axon.sum(), "myelin annulus too thin/empty"
    # axon and myelin masks never overlap
    assert not np.any((ext.axon_labels > 0) & (ext.myelin_mask > 0))


def test_determinism():
    """Same input image -> byte-identical masks on a re-run."""
    path = IMAGES[0]
    a = extract(cv2.imread(path))
    b = extract(cv2.imread(path))
    assert np.array_equal(a.axon_labels, b.axon_labels)
    assert np.array_equal(a.fiber_labels, b.fiber_labels)
    assert np.array_equal(a.myelin_mask, b.myelin_mask)
