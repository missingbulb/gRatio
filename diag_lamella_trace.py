#!/usr/bin/env python3
"""Diagnostic + evidence for the lamella-continuation outer-boundary refinement
(the owner's line-detection + extend-&-trim algorithm). See
docs/reference/lamella_continuation.md.

Emits, for the isolated fibre sample_02:
  1. the headline table  (baseline vs `lamella_trim_outer=True`, all 3 samples);
  2. the band_frac sweep  (the FP<->FN trade that fixes band_frac ~ 0.3);
  3. outputs/diag/s02_lamella_trim.png  (Phase-A traced lamellae + the current /
     lamella-trimmed / GT outer boundaries).

Run:  python diag_lamella_trace.py
"""
import os
import cv2
import numpy as np
from gratio import segment
from gratio.lamella import trace_lamellae

GT = 'data/samples/masks/native'
OUT = 'outputs/diag'
STEMS = ['sample_01', 'sample_02', 'sample_03']


def iou(a, b):
    return (a & b).sum() / ((a | b).sum() + 1e-9)


def _load(stem):
    gray = cv2.imread(f'data/samples/{stem}.png', 0)
    ga = cv2.imread(f'{GT}/{stem}_gt_axon.png', cv2.IMREAD_UNCHANGED).astype(np.int32)
    gf = cv2.imread(f'{GT}/{stem}_gt_fiber.png', cv2.IMREAD_UNCHANGED).astype(np.int32)
    return gray, ga, gf, (gf > 0) & (ga == 0)


def headline():
    print('== lamella_trim_outer: baseline vs ON (isolated-gated) ==')
    base_ious, on_ious = [], []
    for stem in STEMS:
        gray, ga, gf, gm = _load(stem)
        off = segment(gray, lamella_trim_outer=False)   # explicit baseline (trim is ON by default now)
        on = segment(gray, lamella_trim_outer=True)
        bm, om = off['myelin_mask'] > 0, on['myelin_mask'] > 0
        base_ious.append(iou(bm, gm)); on_ious.append(iou(om, gm))
        tag = '' if len(on['axons']) == 1 else '  (clustered: strict no-op)'
        print(f'  {stem}: myelin IoU {iou(bm,gm):.3f} -> {iou(om,gm):.3f}   '
              f'FP {int((bm&~gm).sum()):6d}->{int((om&~gm).sum()):6d}  '
              f'FN {int((gm&~bm).sum()):6d}->{int((gm&~om).sum()):6d}{tag}')
    print(f'  MEAN myelin IoU {np.mean(base_ious):.3f} -> {np.mean(on_ious):.3f}')


def band_sweep():
    print('\n== sample_02 band_frac sweep (FP<->FN trade; peak ~0.3) ==')
    gray, ga, gf, gm = _load('sample_02')
    for bf in [0.0, 0.2, 0.3, 0.4, 0.6]:
        if bf == 0.0:
            pm = segment(gray, lamella_trim_outer=False)['myelin_mask'] > 0
            label = 'baseline'
        else:
            pm = segment(gray, lamella_trim_outer=True, lamella_band_frac=bf)['myelin_mask'] > 0
            label = f'band_frac={bf}'
        print(f'  {label:14s}: myelin IoU {iou(pm,gm):.3f}  '
              f'FP {int((pm&~gm).sum()):6d}  FN {int((gm&~pm).sum()):6d}')


def figure():
    os.makedirs(OUT, exist_ok=True)
    gray, ga, gf, gm = _load('sample_02')
    base = segment(gray, lamella_trim_outer=False)['myelin_mask'] > 0
    on = segment(gray, lamella_trim_outer=True)['myelin_mask'] > 0
    L = trace_lamellae(gray, 80, 14, 1.35)               # Phase-A traced lamellae
    vis = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    if L is not None:
        vis[L] = (255, 150, 0)                           # traced lamellae (light blue)
    for m, col in [(base, (0, 165, 255)),                # current boundary (orange)
                   (on, (0, 0, 255)),                    # lamella-trimmed (red)
                   (gf > 0, (0, 255, 0))]:               # GT (green)
        cs, _ = cv2.findContours(m.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(vis, cs, -1, col, 2)
    path = f'{OUT}/s02_lamella_trim.png'
    cv2.imwrite(path, vis)
    print(f'\nwrote {path}  '
          '(light-blue=traced lamellae, orange=current, red=lamella-trimmed, green=GT)')


if __name__ == '__main__':
    headline()
    band_sweep()
    figure()
