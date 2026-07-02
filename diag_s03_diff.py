#!/usr/bin/env python3
"""sample_03 myelin error map (motivated the R30 junction fill). red=over-reach
into background, orange=over onto another fibre, blue=missed, green=correct.
sample_03's error is dominated by UNDER-reach in the interstitial junctions
between clustered fibres -- dark myelin beyond every axon's cap, left unassigned
(now reclaimed by _fill_junction_myelin / A-JUNCTION-MYELIN)."""
import os, cv2, numpy as np
from gratio import segment

GT = 'data/samples/masks/native'
OUT = 'outputs/diag'; os.makedirs(OUT, exist_ok=True)
stem = 'sample_03'
gray = cv2.imread(f'data/samples/{stem}.png', 0)
seg = segment(gray)
ga = cv2.imread(f'{GT}/{stem}_gt_axon.png', cv2.IMREAD_UNCHANGED).astype(np.int32)
gf = cv2.imread(f'{GT}/{stem}_gt_fiber.png', cv2.IMREAD_UNCHANGED).astype(np.int32)
gm = (gf > 0) & (ga == 0)
pm = (seg['fiber_mask'] > 0) & (seg['axon_mask'] == 0)
fp, fn, tp = pm & ~gm, gm & ~pm, pm & gm
fp_bg, fp_other = fp & (gf == 0), fp & (gf > 0)
print(f'sample_03 myelin: FP={int(fp.sum())} FN={int(fn.sum())} TP={int(tp.sum())} '
      f'IoU={tp.sum()/(tp.sum()+fp.sum()+fn.sum()):.3f}')
print(f'  over-reach into background={int(fp_bg.sum())}  onto another GT fibre={int(fp_other.sum())}  '
      f'missed(all genuine myelin)={int((fn & (ga == 0)).sum())}')
vis = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
vis[tp] = (0, 160, 0); vis[fp_bg] = (0, 0, 255); vis[fp_other] = (0, 140, 255); vis[fn] = (255, 0, 0)
cv2.imwrite(f'{OUT}/s03_diff.png', vis)
print(f'  -> {OUT}/s03_diff.png')
