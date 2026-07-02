#!/usr/bin/env python3
"""sample_02 myelin error map (see docs/reference/learned_outer_boundary.md).
red=false-positive (over-reach), blue=false-negative (missed), green=correct.
Prints FP/FN per vertical third -> the error is almost all over-reach, worst at
the top (the shared wall with the edge-cropped neighbour)."""
import os, cv2, numpy as np
from gratio import segment

GT = 'data/samples/masks/native'
OUT = 'outputs/diag'; os.makedirs(OUT, exist_ok=True)
stem = 'sample_02'
gray = cv2.imread(f'data/samples/{stem}.png', 0)
seg = segment(gray)
ga = cv2.imread(f'{GT}/{stem}_gt_axon.png', cv2.IMREAD_UNCHANGED).astype(np.int32)
gf = cv2.imread(f'{GT}/{stem}_gt_fiber.png', cv2.IMREAD_UNCHANGED).astype(np.int32)
gm = (gf > 0) & (ga == 0)
pm = (seg['fiber_mask'] > 0) & (seg['axon_mask'] == 0)
H, W = gray.shape
fp, fn, tp = pm & ~gm, gm & ~pm, pm & gm
vis = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
vis[tp] = (0, 180, 0); vis[fp] = (0, 0, 255); vis[fn] = (255, 0, 0)
cv2.imwrite(f'{OUT}/s02_diff.png', vis)
for name, lo, hi in [('top', 0, H // 3), ('mid', H // 3, 2 * H // 3), ('bot', 2 * H // 3, H)]:
    b = slice(lo, hi)
    print(f'{name:4s}: FP(over)={int(fp[b].sum()):6d}  FN(missed)={int(fn[b].sum()):6d}  TP={int(tp[b].sum()):6d}')
print(f'total: FP={int(fp.sum())} FN={int(fn.sum())} TP={int(tp.sum())}  '
      f'IoU={tp.sum()/(tp.sum()+fp.sum()+fn.sum()):.3f}  -> {OUT}/s02_diff.png')
