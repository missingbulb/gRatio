#!/usr/bin/env python3
"""Evidence that ONE isotropic myelin cap cannot fit sample_02 (see
docs/reference/learned_outer_boundary.md). Sweep the isolated multiplier: FP
(top over-reach) and FN (side under-reach) are coupled -- tightening trades one
for the other with no clean optimum, because sample_02's true myelin is thin at
the shared top wall and thick on the sides."""
import cv2, numpy as np
from gratio import segment

GT = 'data/samples/masks/native'
stem = 'sample_02'
gray = cv2.imread(f'data/samples/{stem}.png', 0)
ga = cv2.imread(f'{GT}/{stem}_gt_axon.png', cv2.IMREAD_UNCHANGED).astype(np.int32)
gf = cv2.imread(f'{GT}/{stem}_gt_fiber.png', cv2.IMREAD_UNCHANGED).astype(np.int32)
gm = (gf > 0) & (ga == 0)
def iou(a, b): return (a & b).sum() / ((a | b).sum() + 1e-9)
for m in [1.0, 1.2, 1.4, 1.6, 1.8]:
    seg = segment(gray, myelin_thickness_mult_isolated=m, dense_extend=False)
    pm = (seg['fiber_mask'] > 0) & (seg['axon_mask'] == 0)
    print(f'mult_isolated={m}: myelin IoU={iou(pm, gm):.3f}  '
          f'FP={int((pm & ~gm).sum()):6d}  FN={int((gm & ~pm).sum()):6d}')
