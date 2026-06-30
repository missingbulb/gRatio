"""Canonical Phase-1 axon detection:
  markers (distance-transform + h-maxima)  ->  marker-controlled watershed
  ->  per-basin filter  ->  active-contour refine  ->  contour smooth.
This module is built incrementally; `markers()` is validated first."""
import cv2, numpy as np
from scipy.ndimage import (binary_fill_holes, binary_erosion,
                           distance_transform_edt, label as cc_label)
from skimage.morphology import h_maxima
from skimage.filters import gaussian
from skimage.segmentation import watershed
from scipy.ndimage import gaussian_filter1d

DEF = dict(bilateral=(9,75,75), myel_pct=23, speckle=40, close_fiber=27, myelin_close=11,
           min_axon_frac=0.004, max_axon_frac=0.60,
           hmax=7.0,            # prominence for h-maxima (merges nearby maxima -> 1/axon)
           dist_sigma=3.0,      # smooth distance map (avoid spurious maxima on texture)
           min_core_r=10,       # a marker must be at least this far from a wall (px)
           marker_encl=0.5,     # marker enclosure fraction (loose -> high recall)
           min_solidity=0.72,   # basin convexity (loose -> high recall; drops only slivers)
           basin_encl=0.4)      # basin myelin-boundedness (loose -> high recall)

def walls_and_space(gray, P):
    gf=cv2.bilateralFilter(gray,*P['bilateral'])
    T=np.percentile(gf,P['myel_pct']); myel=(gf<T).astype(np.uint8)
    n,lab,st,_=cv2.connectedComponentsWithStats(myel,8); keep=np.zeros(n,bool)
    keep[1:]=st[1:,cv2.CC_STAT_AREA]>=P['speckle']; myel=keep[lab].astype(np.uint8)
    kf=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(P['close_fiber'],)*2)
    mc=cv2.morphologyEx(myel,cv2.MORPH_CLOSE,kf)
    fr=mc.copy(); fr[0,:]=fr[-1,:]=fr[:,0]=fr[:,-1]=1
    enclosed=binary_fill_holes(fr.astype(bool))
    space=enclosed & ~mc.astype(bool)            # axon-interior space (incl. merged + bg)
    space=binary_fill_holes(space)               # fill internal organelles/granules (one dome/axon)
    return gf, myel, mc, space

def _enclosed(cy, cx, reach, myel, H, W, n=48, frac=0.7):
    """True if myelin is hit within `reach` in >= frac of non-edge directions."""
    hits=valid=0
    for k in range(n):
        th=2*np.pi*k/n; dx,dy=np.cos(th),np.sin(th)
        got=edge=False
        for d in range(2,int(reach)):
            x,y=int(cx+dx*d),int(cy+dy*d)
            if x<0 or y<0 or x>=W or y>=H: edge=True; break
            if myel[y,x]: got=True; break
        if edge and not got: continue
        valid+=1; hits+=got
    return hits/max(1,valid) >= frac

def markers(gray, P=DEF):
    gf,myel,mc,space=walls_and_space(gray,P)
    H,W=gray.shape
    dist=gaussian(distance_transform_edt(space).astype(np.float64), P['dist_sigma'])
    hm=h_maxima(dist, P['hmax'])                  # binary maxima, prominence-merged
    hm[dist < P['min_core_r']]=0                  # drop shallow (thin periaxonal) maxima
    lab,nm=cc_label(hm)
    mk=np.zeros((H,W),np.int32); keep=0
    for i in range(1,nm+1):
        ys,xs=np.where(lab==i); cy,cx=int(ys.mean()),int(xs.mean())
        dv=dist[cy,cx]
        if _enclosed(cy,cx,1.7*dv+8, myel, H, W, frac=P['marker_encl']):  # axon center is ring-enclosed
            keep+=1; mk[lab==i]=keep
    return dict(gf=gf,space=space,dist=dist,markers=mk,nm=keep,myel=myel,mc=mc)

def viz_markers(gray, P=DEF):
    d=markers(gray,P)
    out=cv2.cvtColor(gray,cv2.COLOR_GRAY2BGR); ov=out.copy()
    ov[d['space']]=(60,120,60)
    out=cv2.addWeighted(ov,0.25,out,0.75,0)
    ys,xs=np.where(d['markers']>0)
    # one dot per marker (centroid)
    for i in range(1,d['nm']+1):
        yy,xx=np.where(d['markers']==i)
        cv2.circle(out,(int(xx.mean()),int(yy.mean())),6,(0,0,255),-1)
    return out, d['nm']

def _smooth_contour(mask, frac=0.04):
    cs,_=cv2.findContours(mask.astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_NONE)
    if not cs: return None
    c=max(cs,key=cv2.contourArea).reshape(-1,2).astype(np.float64)
    if len(c)<12: return c.astype(np.int32)
    s=max(2.0,frac*len(c))
    x=gaussian_filter1d(c[:,0],s,mode='wrap'); y=gaussian_filter1d(c[:,1],s,mode='wrap')
    return np.stack([x,y],1).astype(np.int32)

def detect(gray, P=DEF):
    d=markers(gray,P); H,W=gray.shape; gf=d['gf']; myel=d['myel']
    labels=watershed(-d['dist'], d['markers'], mask=d['space'])
    minA,maxA=P['min_axon_frac']*H*W, P['max_axon_frac']*H*W; med=np.median(gf)
    myel_adj=cv2.dilate(myel,np.ones((3,3),np.uint8))>0
    on_edge=np.zeros((H,W),bool); on_edge[0,:]=on_edge[-1,:]=on_edge[:,0]=on_edge[:,-1]=True
    axons=[]
    for i in range(1,int(labels.max())+1):
        m=labels==i; A=int(m.sum())
        if not(minA<=A<=maxA) or gf[m].mean()<med-25: continue
        bnd=m&~binary_erosion(m); nbe=bnd&~on_edge
        if nbe.sum()>0 and (nbe&myel_adj).sum()/nbe.sum()<P['basin_encl']: continue  # myelin-bounded
        m=binary_fill_holes(m)
        cnt=max(cv2.findContours(m.astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)[0],key=cv2.contourArea)
        hull=cv2.contourArea(cv2.convexHull(cnt)); sol=A/hull if hull>0 else 0
        if sol < P['min_solidity']: continue                               # drop thin slivers
        ys,xs=np.where(m)
        axons.append(dict(mask=m,cx=float(xs.mean()),cy=float(ys.mean()),
                          area=A,r=float(np.sqrt(A/np.pi))))
    return axons

PAL=[(0,200,255),(235,180,0),(0,220,100),(255,90,200),(60,170,255),(200,130,255),
     (255,200,60),(120,220,0),(180,80,255),(80,255,180),(255,140,140),(140,255,255)]
def render(gray, axons):
    base=cv2.cvtColor(gray,cv2.COLOR_GRAY2BGR); ov=base.copy()
    axons=sorted(axons,key=lambda a:(round(a['cy']/80),a['cx']))
    polys=[]
    for i,a in enumerate(axons,1):
        a['num']=i; p=_smooth_contour(a['mask']); polys.append(p)
        if p is not None: cv2.fillPoly(ov,[p],PAL[(i-1)%len(PAL)])
    out=cv2.addWeighted(ov,0.22,base,0.78,0)
    for a,p in zip(axons,polys):
        if p is not None: cv2.polylines(out,[p],True,PAL[(a['num']-1)%len(PAL)],2,cv2.LINE_AA)
    Himg,Wimg=gray.shape
    for a in axons:
        t=f"#{a['num']}"; sc=max(0.6,a['r']/60); th=max(2,int(sc*2))
        (tw,tht),_=cv2.getTextSize(t,cv2.FONT_HERSHEY_SIMPLEX,sc,th)
        ox=min(max(4,int(a['cx']-tw/2)), Wimg-tw-4)            # keep inside image
        oy=min(max(45,int(a['cy']+tht/2)), Himg-6)            # below the top banner
        cv2.putText(out,t,(ox,oy),cv2.FONT_HERSHEY_SIMPLEX,sc,(0,0,0),th+3,cv2.LINE_AA)
        cv2.putText(out,t,(ox,oy),cv2.FONT_HERSHEY_SIMPLEX,sc,(255,255,255),th,cv2.LINE_AA)
    sep=np.full((gray.shape[0],8,3),255,np.uint8)
    def ban(im,t):
        o=im.copy(); cv2.rectangle(o,(0,0),(o.shape[1],32),(0,0,0),-1)
        cv2.putText(o,t,(8,23),cv2.FONT_HERSHEY_SIMPLEX,0.65,(255,255,255),2,cv2.LINE_AA); return o
    return np.hstack([ban(base,'original'),sep,ban(out,'Phase 1 canonical: markers->watershed->smooth')])

if __name__=="__main__":
    for n in [1,2,3]:
        g=cv2.cvtColor(cv2.imread(f'/home/user/gRatio/data/samples/sample_0{n}.png'),cv2.COLOR_BGR2GRAY)
        ax=detect(g)
        cv2.imwrite(f'canon_s{n}.png',render(g,ax))
        print(f's{n}: {len(ax)} axons')
