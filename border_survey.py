import cv2, numpy as np, os
from scipy.ndimage import gaussian_laplace, gaussian_filter
os.makedirs('outputs/borders', exist_ok=True)
IMAGES=['data/samples/sample_01.png','data/samples/sample_02.png','data/samples/sample_03.png']
NAMES=['sample_01','sample_02','sample_03']

def norm(x, lo=1, hi=99):
    x=x.astype(np.float32)
    a,b=np.percentile(x,[lo,hi])
    if b<=a: b=a+1
    return np.clip((x-a)/(b-a),0,1)

def heat(e):  # e in 0..1 -> BGR inferno
    return cv2.applyColorMap((norm(e)*255).astype(np.uint8), cv2.COLORMAP_INFERNO)

def overlay(gray, e, thr=0.6, color=(0,255,0)):
    base=cv2.cvtColor(gray,cv2.COLOR_GRAY2BGR)
    m=norm(e)>thr
    ov=base.copy(); ov[m]=color
    return cv2.addWeighted(ov,0.55,base,0.45,0)

def label(img, txt, h=26):
    bar=np.zeros((h,img.shape[1],3),np.uint8)
    cv2.putText(bar,txt,(6,18),cv2.FONT_HERSHEY_SIMPLEX,0.5,(255,255,255),1,cv2.LINE_AA)
    return np.vstack([bar,img])

def row(gray, e, name, mid=None, right=None):
    base=cv2.cvtColor(gray,cv2.COLOR_GRAY2BGR)
    m = mid if mid is not None else heat(e)
    r = right if right is not None else overlay(gray,e)
    cols=[label(base,name+'  raw'), label(m,'border map'), label(r,'overlay')]
    return np.hstack(cols)

def montage(method, fn):
    rows=[]
    for path,name in zip(IMAGES,NAMES):
        gray=cv2.imread(path,0)
        try:
            e,mid,right=fn(gray)
        except Exception as ex:
            e=np.zeros_like(gray,np.float32); mid=None; right=None
            print(f'  {method}/{name} ERR {ex}')
        rows.append(row(gray,e,name,mid,right))
    W=max(r.shape[1] for r in rows)
    rows=[np.pad(r,((0,0),(0,W-r.shape[1]),(0,0))) for r in rows]
    out=np.vstack(rows)
    title=np.zeros((30,out.shape[1],3),np.uint8)
    cv2.putText(title,f'{method}   [ raw | border map | overlay ]',(8,20),cv2.FONT_HERSHEY_SIMPLEX,0.6,(0,255,255),2,cv2.LINE_AA)
    out=np.vstack([title,out])
    p=f'outputs/borders/{method}.png'; cv2.imwrite(p,out); print(f'{method}: {out.shape} -> {p}')

def bilat(g): return cv2.bilateralFilter(g,9,75,75)

# 1 canny
def f_canny(g):
    b=bilat(g); med=np.median(b)
    e=cv2.Canny(b,int(0.66*med),int(1.33*med))
    return e/255.0, None, overlay(g, cv2.dilate(e,np.ones((2,2),np.uint8))/255.0)
# 2 scharr
def f_scharr(g):
    b=bilat(g); gx=cv2.Scharr(b,cv2.CV_32F,1,0); gy=cv2.Scharr(b,cv2.CV_32F,0,1)
    mag=np.hypot(gx,gy); return mag,None,overlay(g,mag,0.88)
# 3 frangi 4 sato 5 meijering
from skimage.filters import frangi, sato, meijering
def f_frangi(g):
    e=frangi(bilat(g).astype(float)/255.0, sigmas=range(1,7,1), black_ridges=True); return e,None,overlay(g,e,0.7)
def f_sato(g):
    e=sato(bilat(g).astype(float)/255.0, sigmas=range(1,6), black_ridges=True); return e,None,overlay(g,e,0.7)
def f_meij(g):
    e=meijering(bilat(g).astype(float)/255.0, sigmas=range(1,6), black_ridges=True); return e,None,overlay(g,e,0.75)
# 6 LoG zero crossings
def f_log(g):
    b=bilat(g).astype(float); acc=np.zeros(g.shape,np.float32)
    for s in (1.5,3,5):
        l=gaussian_laplace(b,s); z=np.zeros_like(l,bool)
        z[:-1,:]|=(np.sign(l[:-1,:])!=np.sign(l[1:,:])); z[:,:-1]|=(np.sign(l[:,:-1])!=np.sign(l[:,1:]))
        acc+=z.astype(np.float32)
    return acc,None,overlay(g,acc,0.4)
# 7 black tophat membranes
def f_tophat(g):
    b=bilat(g); k=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(15,15))
    bh=cv2.morphologyEx(b,cv2.MORPH_BLACKHAT,k); return bh.astype(np.float32),None,overlay(g,bh.astype(np.float32),0.6)
# 8 clahe local contrast edges
def f_clahe(g):
    cl=cv2.createCLAHE(3.0,(8,8)).apply(g); b=cv2.bilateralFilter(cl,9,50,50)
    gx=cv2.Scharr(b,cv2.CV_32F,1,0); gy=cv2.Scharr(b,cv2.CV_32F,0,1); mag=np.hypot(gx,gy)
    mid=cv2.cvtColor(cl,cv2.COLOR_GRAY2BGR)
    return mag, cv2.applyColorMap((norm(mag)*255).astype(np.uint8),cv2.COLORMAP_INFERNO), overlay(g,mag,0.85)
# 9 structure tensor orientation/coherence
from skimage.feature import structure_tensor, structure_tensor_eigenvalues
def f_struct(g):
    b=bilat(g).astype(float)
    Arr,Arc,Acc=structure_tensor(b,sigma=4,order='rc')
    l1,l2=structure_tensor_eigenvalues([Arr,Arc,Acc])
    coh=(l1-l2)/(l1+l2+1e-6)
    ori=0.5*np.arctan2(2*Arc,(Acc-Arr))  # radians
    hue=((ori+np.pi/2)/np.pi*179).astype(np.uint8)
    sat=np.full(g.shape,255,np.uint8); val=(norm(coh)*255).astype(np.uint8)
    hsv=cv2.merge([hue,sat,val]); mid=cv2.cvtColor(hsv,cv2.COLOR_HSV2BGR)
    return coh, mid, overlay(g,coh,0.6,(255,0,255))
# 10 gabor bank
def f_gabor(g):
    b=bilat(g).astype(np.float32); resp=np.zeros(g.shape,np.float32)
    for th in np.arange(0,np.pi,np.pi/8):
        for lam in (6,10,14):
            k=cv2.getGaborKernel((21,21),4.0,th,lam,0.5,0,ktype=cv2.CV_32F)
            resp=np.maximum(resp,np.abs(cv2.filter2D(b,cv2.CV_32F,k)))
    return resp,None,overlay(g,resp,0.8)
# 11 watershed boundaries
from skimage.segmentation import watershed, find_boundaries
from skimage.morphology import h_minima
def f_ws(g):
    b=bilat(g); gx=cv2.Scharr(b,cv2.CV_32F,1,0); gy=cv2.Scharr(b,cv2.CV_32F,0,1); grad=np.hypot(gx,gy)
    mark=h_minima((grad).astype(np.float32), h=grad.max()*0.15)
    from scipy.ndimage import label as lb; m,_=lb(mark)
    ws=watershed(grad, m)
    bnd=find_boundaries(ws,mode='thick').astype(np.float32)
    base=cv2.cvtColor(g,cv2.COLOR_GRAY2BGR); ov=base.copy(); ov[bnd>0]=(255,255,0)
    right=cv2.addWeighted(ov,0.6,base,0.4,0)
    return bnd, cv2.cvtColor((bnd*255).astype(np.uint8),cv2.COLOR_GRAY2BGR), right
# 12 phase congruency-ish local energy via gabor quadrature
def f_pc(g):
    b=bilat(g).astype(np.float32); energy=np.zeros(g.shape,np.float32)
    for th in np.arange(0,np.pi,np.pi/6):
        for lam in (8,14):
            ke=cv2.getGaborKernel((25,25),5,th,lam,0.5,0,cv2.CV_32F)
            ko=cv2.getGaborKernel((25,25),5,th,lam,0.5,np.pi/2,cv2.CV_32F)
            ev=cv2.filter2D(b,cv2.CV_32F,ke); od=cv2.filter2D(b,cv2.CV_32F,ko)
            energy+=np.sqrt(ev*ev+od*od)
    return energy,None,overlay(g,energy,0.75)

for name,fn in [('canny',f_canny),('scharr_gradient',f_scharr),('frangi_ridges',f_frangi),
                ('sato_tubeness',f_sato),('meijering',f_meij),('log_zero_crossings',f_log),
                ('blacktophat_membranes',f_tophat),('clahe_contrast_edges',f_clahe),
                ('structure_tensor',f_struct),('gabor_bank',f_gabor),
                ('watershed_boundaries',f_ws),('phase_energy',f_pc)]:
    try: montage(name,fn)
    except Exception as ex: print(f'{name} FAILED {ex}')
print('done')
