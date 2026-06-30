"""Phase 2: myelin outer border for each Phase-1 axon.

Per axon, grow outward through the dark myelin to its outer edge. Myelin shared
by two touching axons is split by nearest axon (Voronoi) -- this is the
touching-cell boundary decision. Output: inner (axon) border + outer (myelin)
border per axon, numbered."""
import cv2, numpy as np, sys; sys.path.insert(0,'.')
import canon, phase1_select as ps
from scipy.ndimage import distance_transform_edt, label as cc_label, binary_fill_holes

PAL=canon.PAL

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

def add_myelin(g,gf,axons, myel_pct=23, speckle=40, myel_close=11, touch=5, band=0.8):
    H,W=g.shape
    T=np.percentile(gf,myel_pct); myel=(gf<T).astype(np.uint8)
    nn,lab,st,_=cv2.connectedComponentsWithStats(myel,8); keep=np.zeros(nn,bool)
    keep[1:]=st[1:,cv2.CC_STAT_AREA]>=speckle; myel=keep[lab].astype(np.uint8)
    km=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(myel_close,)*2)
    mm=cv2.morphologyEx(myel,cv2.MORPH_CLOSE,km)>0
    axon_lbl=np.zeros((H,W),np.int32)
    for a in axons: axon_lbl[a['axon']]=a['num']
    # myelin connected (touching) to an axon, split by nearest axon, capped thickness
    kd=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(touch,)*2)
    seed=cv2.dilate((axon_lbl>0).astype(np.uint8),kd)>0
    myl_lab,_=cc_label(mm); tl=np.unique(myl_lab[seed&mm]); tl=tl[tl>0]
    myelin_keep=np.isin(myl_lab,tl)
    dist,(iy,ix)=distance_transform_edt(axon_lbl==0,return_indices=True); nearest=axon_lbl[iy,ix]
    rarr=np.zeros(max(a['num'] for a in axons)+1)
    for a in axons: rarr[a['num']]=np.sqrt(a['axon'].sum()/np.pi)
    cap=band*rarr[nearest]
    assigned=np.where(myelin_keep&(nearest>0)&(dist<=cap),nearest,0)
    kc=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(17,17))
    for a in axons:
        am=(assigned==a['num'])
        # enclose the (possibly patchy) myelin into a smooth fiber, then clip to
        # this axon's Voronoi territory so touching neighbours split cleanly
        fiber=binary_fill_holes(a['axon']|am)
        fiber=binary_fill_holes(cv2.morphologyEx(fiber.astype(np.uint8),cv2.MORPH_CLOSE,kc).astype(bool))
        fiber=fiber & ((nearest==a['num'])|(axon_lbl==a['num']))
        a['outer']=fiber
        a['outer_poly']=ps.smooth_edge_aware(fiber.astype(np.uint8),H,W,frac=0.04)
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
