"""Semi-automated Phase 1: take the user's selected candidate numbers, refine
each to an accurate smooth border (region-based active contour -> contour smooth),
renumber 1..N, render, and persist the chosen seeds for reproducibility."""
import cv2, numpy as np, json, sys; sys.path.insert(0,'.')
import canon
from skimage.segmentation import morphological_chan_vese as MCV
from skimage.filters import gaussian
from scipy.ndimage import binary_fill_holes, label as cc_label

SEL = {1:[2,9,11,12], 2:[7], 3:[3,4,6,8,10]}

def refine(gf, mask):
    img=gaussian(gf.astype(np.float64)/255.0, sigma=2)
    ls=MCV(img, num_iter=40, init_level_set=mask.astype(np.uint8), smoothing=3,
           lambda1=1.0, lambda2=1.1)
    lab,_=cc_label(ls); ys,xs=np.where(mask); cy,cx=int(ys.mean()),int(xs.mean())
    if 0<=cy<lab.shape[0] and 0<=cx<lab.shape[1] and lab[cy,cx]>0:
        ls=(lab==lab[cy,cx])
    else:
        ls=mask
    ls=binary_fill_holes(ls)
    poly=canon._smooth_contour(ls, frac=0.05)
    out=np.zeros_like(mask,np.uint8)
    if poly is not None: cv2.fillPoly(out,[poly],1)
    return out>0, poly

PAL=canon.PAL
def run(n):
    g=cv2.cvtColor(cv2.imread(f'/home/user/gRatio/data/samples/sample_0{n}.png'),cv2.COLOR_BGR2GRAY)
    gf=cv2.bilateralFilter(g,9,75,75)
    cand=canon.detect(g)
    cand=sorted(cand,key=lambda a:(round(a['cy']/80),a['cx']))   # same numbering the user saw
    for i,a in enumerate(cand,1): a['num']=i
    chosen=[a for a in cand if a['num'] in SEL[n]]
    # refine + renumber 1..N in reading order
    chosen=sorted(chosen,key=lambda a:(round(a['cy']/80),a['cx']))
    base=cv2.cvtColor(g,cv2.COLOR_GRAY2BGR); ov=base.copy(); polys=[]; seeds=[]
    for i,a in enumerate(chosen,1):
        m,poly=refine(gf,a['mask']); a['final']=m; a['poly']=poly; a['fnum']=i
        ys,xs=np.where(m); seeds.append([int(xs.mean()),int(ys.mean())])
        if poly is not None: cv2.fillPoly(ov,[poly],PAL[(i-1)%len(PAL)])
        polys.append(poly)
    out=cv2.addWeighted(ov,0.22,base,0.78,0)
    H,W=g.shape
    for a,poly in zip(chosen,polys):
        if poly is not None: cv2.polylines(out,[poly],True,PAL[(a['fnum']-1)%len(PAL)],2,cv2.LINE_AA)
    for a in chosen:
        ys,xs=np.where(a['final']); cy,cx=ys.mean(),xs.mean(); r=np.sqrt(a['final'].sum()/np.pi)
        t=f"#{a['fnum']}"; sc=max(0.6,r/60); th=max(2,int(sc*2))
        (tw,tht),_=cv2.getTextSize(t,cv2.FONT_HERSHEY_SIMPLEX,sc,th)
        ox=min(max(4,int(cx-tw/2)),W-tw-4); oy=min(max(45,int(cy+tht/2)),H-6)
        cv2.putText(out,t,(ox,oy),cv2.FONT_HERSHEY_SIMPLEX,sc,(0,0,0),th+3,cv2.LINE_AA)
        cv2.putText(out,t,(ox,oy),cv2.FONT_HERSHEY_SIMPLEX,sc,(255,255,255),th,cv2.LINE_AA)
    sep=np.full((H,8,3),255,np.uint8)
    def ban(im,t):
        o=im.copy(); cv2.rectangle(o,(0,0),(o.shape[1],32),(0,0,0),-1)
        cv2.putText(o,t,(8,23),cv2.FONT_HERSHEY_SIMPLEX,0.6,(255,255,255),2,cv2.LINE_AA); return o
    cv2.imwrite(f'select_s{n}.png',np.hstack([ban(base,'original'),sep,ban(out,'Phase 1: selected axons (refined)')]))
    return seeds

if __name__=="__main__":
    allseeds={}
    for n in [1,2,3]:
        s=run(n); allseeds[f'sample_0{n}']=s
        print(f's{n}: {len(s)} axons, seeds={s}')
    json.dump(allseeds, open('axon_seeds.json','w'), indent=2)
    print('saved axon_seeds.json')
