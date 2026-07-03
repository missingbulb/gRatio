#!/usr/bin/env python3
"""Fetch + convert the macaque corpus-callosum TEM set into this repo.

Source (open access, CC-BY 4.0):
    Stikov N, Perry LM, Mezer A, Rykhlevskaia E, Wandell BA, Pauly JM, Dougherty RF.
    "Bound pool fractions complement diffusion measures to describe white matter
    microstructure" -- companion morphometry:
    "Quantitative analysis of the myelin g-ratio from electron microscopy images
    of the macaque corpus callosum." Data in Brief 4:368-373 (2015).
    DOI: 10.1016/j.dib.2015.05.019   PMC: PMC4510539

Eight transmission-electron micrographs (TEM) of one cynomolgus macaque corpus
callosum, 1900x, 9.144 nm/pixel, ~21x28 um fields, dense myelinated axons. The
paper reports an AGGREGATE g-ratio per image (Table 1) -- NOT per-axon masks --
so these are validation data for the g-ratio *number*, not for segmentation IoU
(see README.md and the R-note in docs/reference/user_masks.md).

The published TIFFs are plain 8-bit grayscale, so TIFF->PNG here is LOSSLESS and
roughly halves the footprint (~66 MB -> ~34 MB). The scale bar and calibration
are burned into the pixels; the pipeline's scale-bar remover handles them.

Usage:
    python data/external/macaque_cc/fetch.py            # populate images/ + crops/
    python data/external/macaque_cc/fetch.py --force    # re-download & regenerate
"""
import argparse
import io
import os
import tarfile
import urllib.request
import zipfile

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
IMAGES = os.path.join(HERE, "images")
CROPS = os.path.join(HERE, "crops")

# Europe PMC mirrors the Data-in-Brief supplement reliably (the NCBI /bin/ path
# is behind an interstitial). This bundle contains mmc1.zip -> DIB.tar -> 8 tiffs.
SUPP_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC4510539/supplementaryFiles"

# One representative sample-scale crop per segment. (row0, col0, size) in native
# px, chosen to sit in axon-rich tissue and clear of the bottom scale-bar strip.
# Deterministic so `fetch.py` reproduces byte-identical crops.
CROP = 760
CROP_ORIGIN = {1: (700, 300), 2: (500, 1400), 3: (300, 900), 4: (600, 1700),
               5: (400, 1200), 6: (500, 500), 7: (800, 1500), 8: (300, 1000)}


def _download_tiffs():
    """Return {segment_int: np.uint8 array} pulled from the nested supplement."""
    print(f"downloading supplement ({SUPP_URL}) ...")
    req = urllib.request.Request(SUPP_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        supp = r.read()
    print(f"  got {len(supp)/1e6:.1f} MB; unwrapping zip -> mmc1.zip -> DIB.tar ...")
    with zipfile.ZipFile(io.BytesIO(supp)) as z:
        mmc1 = z.read("mmc1.zip")
    with zipfile.ZipFile(io.BytesIO(mmc1)) as z:
        tar_name = next(n for n in z.namelist() if n.endswith(".tar"))
        tar_bytes = z.read(tar_name)
    tiffs = {}
    with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as t:
        for m in t.getmembers():
            if not m.name.lower().endswith((".tif", ".tiff")):
                continue
            base = os.path.basename(m.name)             # Segment_N.tif
            num = int("".join(ch for ch in base if ch.isdigit()))
            buf = np.frombuffer(t.extractfile(m).read(), np.uint8)
            arr = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)
            if arr.ndim == 3:
                arr = arr[..., 0]
            tiffs[num] = arr
    print(f"  extracted {len(tiffs)} TEM images")
    return dict(sorted(tiffs.items()))


def _to_uint8(arr):
    if arr.dtype == np.uint8:
        return arr
    a = arr.astype(np.float32)
    return ((a - a.min()) / (a.max() - a.min() + 1e-9) * 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="re-download and regenerate")
    args = ap.parse_args()

    os.makedirs(IMAGES, exist_ok=True)
    os.makedirs(CROPS, exist_ok=True)
    have = len([f for f in os.listdir(IMAGES) if f.endswith(".png")])
    if have == 8 and not args.force:
        print(f"images/ already has {have} PNGs; use --force to regenerate.")
        return

    tiffs = _download_tiffs()
    png = [cv2.IMWRITE_PNG_COMPRESSION, 9]
    for num, arr in tiffs.items():
        img = _to_uint8(arr)
        cv2.imwrite(os.path.join(IMAGES, f"Segment_{num}.png"), img, png)
        r0, c0 = CROP_ORIGIN[num]
        r0 = min(r0, img.shape[0] - CROP)
        c0 = min(c0, img.shape[1] - CROP)
        crop = img[r0:r0 + CROP, c0:c0 + CROP]
        cv2.imwrite(os.path.join(CROPS, f"Segment_{num}_crop.png"), crop, png)
    print(f"wrote {len(tiffs)} full PNGs -> images/ and {len(tiffs)} crops -> crops/")


if __name__ == "__main__":
    main()
