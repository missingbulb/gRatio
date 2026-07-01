import cv2, numpy as np, glob, os
from scipy.ndimage import label
from gratio import segment
from gratio.reference import AXON, MYELIN
OUT='outputs/reference_run'; os.makedirs(OUT,exist_ok=True)
# small-axon, inverted-SEM settings
CFG=dict(myelin_percentile=45, myelin_fill_percentile=55, close_fiber=5, myelin_close=5,
         speckle_min=10, min_axon_frac=0.00006, max_axon_frac=0.03, min_solidity=0.80,
         touch_dilate=3, myelin_band=0.7, smooth_frac=0.2, smooth_max_px=7, bright_margin=-40)
def overlay(gray,axon,myel):
    vis=cv2.cvtColor(gray,cv2.COLOR_GRAY2BGR); f=vis.copy()
    f[myel>0]=(40,40,210); f[axon>0]=(230,180,0); p=(myel>0)|(axon>0)
    vis[p]=(0.5*f[p]+0.5*vis[p]).astype(np.uint8); return vis
def band(im,t):
    b=np.full((30,im.shape[1],3),20,np.uint8); cv2.putText(b,t,(6,21),cv2.FONT_HERSHEY_SIMPLEX,0.6,(255,255,255),2); return np.vstack([b,im])
rows_summary=[]
for p in sorted(glob.glob('data/reference/axondeepseg_sem/*.png')):
    if '_mask' in p: continue
    stem=os.path.basename(p)[:-4]
    g=cv2.imread(p,0); inv=255-g   # SEM polarity: myelin bright -> dark
    seg=segment(inv,**CFG)
    npred=len(seg['axons'])
    m=cv2.imread(p.replace('.png','_mask.png'),0)
    ngt=label(m==AXON)[1] if m is not None else -1
    pred=band(overlay(g,seg['axon_mask']>0,seg['myelin_mask']>0),f'prediction: {npred} axons')
    gtv=band(overlay(g,(m==AXON),(m==MYELIN)),f'ground truth: {ngt} axons') if m is not None else band(cv2.cvtColor(g,cv2.COLOR_GRAY2BGR),'no GT')
    raw=band(cv2.cvtColor(g,cv2.COLOR_GRAY2BGR),'raw')
    fig=np.hstack([raw,np.full((raw.shape[0],6,3),255,np.uint8),pred,np.full((raw.shape[0],6,3),255,np.uint8),gtv])
    cv2.imwrite(f'{OUT}/{stem}_ref.png',fig)
    print(f'{stem}: pred={npred} gt={ngt}')
    rows_summary.append((stem,npred,ngt))
print('done',OUT)
