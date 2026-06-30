"""Phase 2: myelin outer border for each Phase-1 axon.

Per axon, grow outward through the dark myelin to its outer edge. Myelin shared
by two touching axons is split by nearest axon (Voronoi) -- this is the
touching-cell boundary decision. Output: inner (axon) border + outer (myelin)
border per axon, numbered."""
import cv2, numpy as np, sys; sys.path.insert(0,'.')
import canon, phase1_select as ps
from scipy.ndimage import (distance_transform_edt, label as cc_label,
                           binary_fill_holes, binary_propagation, gaussian_filter1d)

PAL=canon.PAL

def smooth_clip(mask, frac=0.04, pad=48):
    """Smooth a mask boundary; image-edge segments stay straight (no spikes)."""
    H,W=mask.shape
    padded=cv2.copyMakeBorder(mask.astype(np.uint8),pad,pad,pad,pad,cv2.BORDER_REPLICATE)
    cs,_=cv2.findContours(padded,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_NONE)
    if not cs: return mask, None
    c=max(cs,key=cv2.contourArea).reshape(-1,2).astype(np.float64)
    if len(c)>=12:
        s=max(2.0,frac*len(c))
        c[:,0]=gaussian_filter1d(c[:,0],s,mode='wrap'); c[:,1]=gaussian_filter1d(c[:,1],s,mode='wrap')
    canvas=np.zeros_like(padded); cv2.fillPoly(canvas,[c.astype(np.int32)],1)
    cropped=canvas[pad:pad+H,pad:pad+W]>0
    cs2,_=cv2.findContours(cropped.astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    return cropped, (max(cs2,key=cv2.contourArea) if cs2 else None)

def get_axons(n):
    g=cv2.cvtColor(cv2.imread(f'/home/user/gRatio/data/samples/sample_0{n}.png'),cv2.COLOR_BGR2GRAY)
    gf=cv2.bilateralFilter(g,9,75,75)
    cand=sorted(canon.detect(g),key=lambda a:(round(a['cy']/80),a['cx']))
    for i,a in enumerate(cand,1): a['num']=i
    chosen=sorted([a for a in cand if a['num'] in ps.SEL[n]],key=lambda a:(round(a['cy']/80),a['cx']))
    axons=[]
    for i,a in enumerate(chosen,1):
        m,_=ps.refine(gf,a['mask'])
        axons.append(dict(num=i,axon=m))
    return g,gf,axons

def add_myelin(g,gf,axons, myel_pct=18, speckle=40, myel_close=11):
    H,W=g.shape
    T=np.percentile(gf,myel_pct); myel=(gf<T).astype(np.uint8)
    nn,lab,st,_=cv2.connectedComponentsWithStats(myel,8); keep=np.zeros(nn,bool)
    keep[1:]=st[1:,cv2.CC_STAT_AREA]>=speckle; myel=keep[lab].astype(np.uint8)
    km=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(myel_close,)*2)
    mm=cv2.morphologyEx(myel,cv2.MORPH_CLOSE,km)>0    # dark myelin band (inter-lamellar bridged)
    axon_lbl=np.zeros((H,W),np.int32)
    for a in axons: axon_lbl[a['axon']]=a['num']
    # Voronoi split of the field between axons (the touching-cell boundary)
    _,(iy,ix)=distance_transform_edt(axon_lbl==0,return_indices=True); nearest=axon_lbl[iy,ix]
    kc=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(15,15))
    G=13  # bridge the bright periaxonal gap so the grow can reach the myelin ring
    kg=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(2*G+1,)*2)
    for a in axons:
        terr=(nearest==a['num'])|(axon_lbl==a['num'])
        seed=(cv2.dilate(a['axon'].astype(np.uint8),kg)>0)&terr
        # grow through the connected dark band (from the bridged seed) until it
        # meets bright extracellular; that dark->bright transition is the outer edge.
        region=((mm|seed) & terr)
        fiber=binary_propagation(seed, mask=region)
        # solid thick layer (holes are Phase 3): close + fill, clip to own territory
        fiber=binary_fill_holes(cv2.morphologyEx(fiber.astype(np.uint8),cv2.MORPH_CLOSE,kc).astype(bool)) & terr
        fiber=fiber | a['axon']
        a['outer'],a['outer_poly']=smooth_clip(fiber, frac=0.04)   # clean (no edge spikes)
        cs,_=cv2.findContours(a['axon'].astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        a['axon_poly']=max(cs,key=cv2.contourArea) if cs else None
    return axons

def render(g,axons):
    base=cv2.cvtColor(g,cv2.COLOR_GRAY2BGR); ov=base.copy()
    for a in axons:
        col=PAL[(a['num']-1)%len(PAL)]
        annulus=a['outer']&~a['axon']                       # myelin band = fiber minus axon
        ov[annulus]=tuple(int(c*0.5) for c in col)          # myelin = darker shade
        ov[a['axon']]=col
    out=cv2.addWeighted(ov,0.30,base,0.70,0)
    H,W=g.shape
    for a in axons:
        col=PAL[(a['num']-1)%len(PAL)]
        if a['outer_poly'] is not None: cv2.polylines(out,[a['outer_poly']],True,col,2,cv2.LINE_AA)
        if a['axon_poly'] is not None: cv2.polylines(out,[a['axon_poly']],True,(255,255,255),2,cv2.LINE_AA)
    for a in axons:
        ys,xs=np.where(a['axon']); cy,cx=ys.mean(),xs.mean(); r=np.sqrt(a['axon'].sum()/np.pi)
        t=f"#{a['num']}"; sc=max(0.6,r/60); th=max(2,int(sc*2))
        (tw,tht),_=cv2.getTextSize(t,cv2.FONT_HERSHEY_SIMPLEX,sc,th)
        ox=min(max(4,int(cx-tw/2)),W-tw-4); oy=min(max(45,int(cy+tht/2)),H-6)
        cv2.putText(out,t,(ox,oy),cv2.FONT_HERSHEY_SIMPLEX,sc,(0,0,0),th+3,cv2.LINE_AA)
        cv2.putText(out,t,(ox,oy),cv2.FONT_HERSHEY_SIMPLEX,sc,(255,255,255),th,cv2.LINE_AA)
    sep=np.full((H,8,3),255,np.uint8)
    def ban(im,t):
        o=im.copy(); cv2.rectangle(o,(0,0),(o.shape[1],32),(0,0,0),-1)
        cv2.putText(o,t,(8,23),cv2.FONT_HERSHEY_SIMPLEX,0.6,(255,255,255),2,cv2.LINE_AA); return o
    return np.hstack([ban(base,'original'),sep,ban(out,'Phase 2: axon (white) + myelin outer border')])

if __name__=="__main__":
    for n in [1,2,3]:
        g,gf,ax=get_axons(n); ax=add_myelin(g,gf,ax)
        cv2.imwrite(f'phase2_s{n}.png',render(g,ax))
        print(f's{n}: {len(ax)} axons')
