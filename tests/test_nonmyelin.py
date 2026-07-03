"""Phase 3 regression: non-myelin pockets (the tracer's orange 'omit' regions).

Pins (a) the filled-omit extraction from the hand annotation, (b) the raw-data
detector that excludes bright non-myelin pockets from the myelin band, and (c)
that excluding them moves the g-ratio up and improves myelin agreement with the
omit-corrected ground truth -- while staying byte-neutral on samples that have no
annotated pockets.
"""
import os

import cv2
import numpy as np
import pytest

from gratio import segment
from gratio.mask_extract import extract
from gratio.gt_register import ground_truth_for
from gratio.evaluate import evaluate

RAW = os.path.join(os.path.dirname(__file__), "..", "data", "samples")
CROP = os.path.join(RAW, "masks")
SAMPLES = ["sample_01", "sample_02", "sample_03"]

# the tracer's hand numbering: filled orange 'omit' pockets per image.
# (update alongside EXPECTED_AXONS when a new annotation arrives -- see
#  docs/reference/gt_from_masks.md)
EXPECTED_OMITS = {"sample_01": 5, "sample_02": 0, "sample_03": 0}


def _raw(stem):
    return cv2.imread(os.path.join(RAW, stem + ".png"), cv2.IMREAD_GRAYSCALE)


@pytest.mark.parametrize("stem", SAMPLES)
def test_omit_extraction_counts(stem):
    """Closed orange loops fill into the expected number of pockets; the
    handwritten #N glyphs are dropped, and clean samples yield none."""
    ext = extract(cv2.imread(os.path.join(CROP, stem + "_masked.png")), stem=stem)
    assert len(ext.omits) == EXPECTED_OMITS[stem]
    assert int(ext.omit_labels.max()) == EXPECTED_OMITS[stem]
    # omit pockets never overlap the axon bodies (they live in the myelin layer)
    assert not np.any((ext.omit_labels > 0) & (ext.axon_labels > 0))


def test_omit_extraction_is_deterministic():
    a = extract(cv2.imread(os.path.join(CROP, "sample_01_masked.png")))
    b = extract(cv2.imread(os.path.join(CROP, "sample_01_masked.png")))
    assert np.array_equal(a.omit_labels, b.omit_labels)


def test_segment_without_axons_still_returns_nonmyelin_key():
    """An image with no detectable axons short-circuits early; the output must
    still carry a (empty) 'nonmyelin' mask so consumers can rely on the key."""
    blank = np.full((200, 200), 255, np.uint8)   # all-white -> no axons
    seg = segment(blank)
    assert seg["axons"] == []
    assert "nonmyelin" in seg and seg["nonmyelin"].sum() == 0


def test_detector_byte_neutral_without_pockets():
    """A sample with no annotated pockets must lose no myelin to Phase 3."""
    for stem in ("sample_02", "sample_03"):
        seg = segment(_raw(stem))
        assert seg["nonmyelin"].sum() == 0
        on = segment(_raw(stem), detect_nonmyelin=True)
        off = segment(_raw(stem), detect_nonmyelin=False)
        assert np.array_equal(on["myelin_mask"], off["myelin_mask"])


def test_safety_valve_bounds_removal():
    """The per-fibre cap (nonmyelin_max_frac) prevents the detector from deleting
    most of a fibre's myelin -- e.g. a uniformly-bright (uneven-stain) sheath that
    would otherwise be stripped wholesale and inflate g toward 1.0."""
    from gratio.pipeline import _detect_nonmyelin_pockets, DEFAULTS
    H = W = 200
    gf = np.full((H, W), 200, np.uint8)                       # whole field bright
    axon = np.zeros((H, W), np.int32); cv2.circle(axon, (100, 100), 40, 1, -1)
    myelin = np.zeros((H, W), np.int32); cv2.circle(myelin, (100, 100), 80, 1, -1)
    myelin[axon == 1] = 0
    axons = [{"id": 1}]
    band = int((myelin == 1).sum())
    wide = _detect_nonmyelin_pockets(gf, axon, myelin, axons, {**DEFAULTS, "nonmyelin_max_frac": 1.0})
    capped = _detect_nonmyelin_pockets(gf, axon, myelin, axons, {**DEFAULTS, "nonmyelin_max_frac": 0.5})
    assert wide.sum() > 0.5 * band          # without the cap it would gut the band
    assert capped.sum() == 0                 # with the cap that fibre is left intact


def test_detector_finds_sample01_pockets():
    """On sample_01 the detector recovers the clear bright vacuoles with good
    precision, matched against the registered omit ground truth."""
    raw = _raw("sample_01")
    gt = ground_truth_for(raw, cv2.imread(os.path.join(CROP, "sample_01_masked.png")))
    seg = segment(raw)
    assert seg["nonmyelin"].sum() > 5000            # substantial pockets detected
    o = evaluate(seg, gt)["omit"]
    assert o["recall"] >= 0.55                       # >= the 3 clear vacuoles
    assert o["precision"] >= 0.65                    # does not gut real myelin
    # every detected pocket lies inside the predicted myelin territory (a fibre)
    assert np.all((seg["fiber_mask"] > 0)[seg["nonmyelin"]])


def test_pocket_boundaries_are_smoothed():
    """Detected pockets get the regular spline border smoothing: the boundary is
    refit (mask differs from the raw detector output) without changing the area
    (area-neutral, no shrink), so the g-ratio is unaffected."""
    raw = _raw("sample_01")
    on = segment(raw, nonmyelin_smooth_tol=None)   # smoothing on (default)
    off = segment(raw, nonmyelin_smooth_tol=0)     # raw pocket boundary
    a_on, a_off = int(on["nonmyelin"].sum()), int(off["nonmyelin"].sum())
    assert a_on > 0 and a_off > 0
    assert not np.array_equal(on["nonmyelin"], off["nonmyelin"])   # boundary refit
    assert abs(a_on - a_off) < 0.05 * a_off                        # area-neutral
    g_on = {a["id"]: a["g"] for a in on["axons"]}
    g_off = {a["id"]: a["g"] for a in off["axons"]}
    assert all(abs(g_on[i] - g_off[i]) < 0.01 for i in g_on)       # g unaffected


def test_excluding_pockets_raises_g_and_helps_myelin():
    """Removing non-myelin pockets raises the g-ratio of the affected fibres and
    improves myelin agreement with the omit-corrected ground truth on sample_01;
    it does neither on the clean samples."""
    raw = _raw("sample_01")
    gt = ground_truth_for(raw, cv2.imread(os.path.join(CROP, "sample_01_masked.png")))
    on = segment(raw, detect_nonmyelin=True)
    off = segment(raw, detect_nonmyelin=False)
    g_on = {a["id"]: a["g"] for a in on["axons"]}
    g_off = {a["id"]: a["g"] for a in off["axons"]}
    # the large central fibre #2 carries most of the pockets -> its g must rise
    assert g_on[2] > g_off[2]
    # and no fibre's g is lowered by the exclusion (removing myelin only raises g)
    assert all(g_on[i] >= g_off[i] - 1e-9 for i in g_on)
    m_on = evaluate(on, gt)["semantic"]["myelin"]["iou"]
    m_off = evaluate(off, gt)["semantic"]["myelin"]["iou"]
    assert m_on > m_off
