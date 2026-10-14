"""Anatomy that BodyParts3D 4.0 does not include, built from what it does:

* lungs: voxel region grown from the segmental bronchial trees, clipped to
  the rib cage, kept above the diaphragm and away from the mediastinum;
* spinal cord: tube through the vertebral canals C1-L1 (cervical and lumbar
  enlargements, conus medullaris), then a cauda equina to the sacrum;
* peripheral nerves: tubes routed alongside the arteries they accompany
  (sciatic/tibial/common fibular, femoral, median, ulnar, radial, vagus,
  phrenic, intercostals).
All work is done in the reference (posed) space after warping."""
import numpy as np
from scipy import ndimage
from scipy.sparse.csgraph import dijkstra
from scipy.sparse import coo_matrix
from scipy.spatial import cKDTree


def unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


# ----------------------------------------------------------------- tubes
def resample(poly, step=0.004):
    poly = np.asarray(poly, float)
    seg = np.linalg.norm(np.diff(poly, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    n = max(int(s[-1] / step), 2)
    t = np.linspace(0, s[-1], n)
    return np.stack([np.interp(t, s, poly[:, k]) for k in range(3)], 1)


def smooth_poly(p, it=6):
    p = p.copy()
    for _ in range(it):
        p[1:-1] = 0.5 * p[1:-1] + 0.25 * (p[:-2] + p[2:])
    return p


def tube(poly, radius, sides=8):
    """Polyline -> closed-ish tube (P, F). radius: scalar or per point."""
    p = smooth_poly(resample(poly))
    n = len(p)
    r = np.broadcast_to(np.interp(np.linspace(0, 1, n), np.linspace(0, 1, np.size(radius)),
                                  np.atleast_1d(radius)), (n,))
    t = unit(np.gradient(p, axis=0))
    a = np.cross(t[0], [0, 1, 0.0])
    if np.linalg.norm(a) < 1e-3:
        a = np.cross(t[0], [1, 0, 0.0])
    u = unit(a)
    U = np.zeros_like(p)
    for i in range(n):  # parallel transport frame
        u = unit(u - t[i] * (u @ t[i]))
        U[i] = u
    Vv = np.cross(t, U)
    ang = np.linspace(0, 2 * np.pi, sides, endpoint=False)
    ring = (U[:, None] * np.cos(ang)[None, :, None] + Vv[:, None] * np.sin(ang)[None, :, None]) * r[:, None, None]
    P = (p[:, None] + ring).reshape(-1, 3)
    F = []
    for i in range(n - 1):
        for k in range(sides):
            a0, a1 = i * sides + k, i * sides + (k + 1) % sides
            b0, b1 = a0 + sides, a1 + sides
            F += [[a0, b0, a1], [a1, b0, b1]]
    # caps
    c0, c1 = len(P), len(P) + 1
    P = np.vstack([P, p[0], p[-1]])
    for k in range(sides):
        F.append([c0, (k + 1) % sides, k])
        F.append([c1, (n - 1) * sides + k, (n - 1) * sides + (k + 1) % sides])
    return P, np.array(F)


def centerline(P, start_hint=None):
    """Centreline of a tubular mesh: graph diameter path, then local means."""
    tree = cKDTree(P)
    d, i = tree.query(P, k=8)
    rows = np.repeat(np.arange(len(P)), 8)
    G = coo_matrix((d.ravel() + 1e-9, (rows, i.ravel())), shape=(len(P), len(P))).tocsr()
    if start_hint is not None:
        s0 = int(np.argmin(np.linalg.norm(P - start_hint, axis=1)))
    else:
        dist0 = dijkstra(G, indices=0, directed=False)
        dist0[~np.isfinite(dist0)] = -1
        s0 = int(np.argmax(dist0))
    dist, pred = dijkstra(G, indices=s0, directed=False, return_predecessors=True)
    dist[~np.isfinite(dist)] = -1
    e = int(np.argmax(dist))
    path = [e]
    while path[-1] != s0 and pred[path[-1]] >= 0:
        path.append(pred[path[-1]])
    path = P[path[::-1]]
    out = []
    for q in path[::3]:
        idx = tree.query_ball_point(q, 0.008)
        out.append(P[idx].mean(0) if idx else q)
    return smooth_poly(np.array(out), 4)


# ----------------------------------------------------------------- lungs
def lungs(parts, h=0.005, log=print):
    """parts: dict tissue/name lookups (name -> list of P arrays) in posed space."""
    def pts(pred):
        return np.concatenate([P for n, Ps in parts.items() if pred(n) for P in Ps])
    bron = pts(lambda n: 'bronchial tree' in n)
    ribs = pts(lambda n: (n.endswith(' rib') or 'costal cartilage' in n or 'sternum' in n.lower()
                          or 'Manubrium' in n or 'thoracic vertebra' in n))
    medi = pts(lambda n: any(k in n for k in ('Wall of', 'Cavity of', 'aorta', 'Esophagus', 'Trachea',
                                              'main bronch', 'vena cava', 'pulmonary trunk', 'Brachiocephalic')))
    diaph = pts(lambda n: n == 'Diaphragm')
    lo = ribs.min(0) - 0.01
    hi = ribs.max(0) + 0.01
    shape = np.ceil((hi - lo) / h).astype(int) + 1

    def vox(P):
        ijk = np.clip(((P - lo) / h).astype(int), 0, shape - 1)
        g = np.zeros(shape, bool)
        g[tuple(ijk.T)] = True
        return g
    # thoracic cavity: per axial slice, inside the rib cage's 2D hull
    from scipy.spatial import Delaunay
    cav = np.zeros(shape, bool)
    gx, gz = np.meshgrid(np.arange(shape[0]) * h + lo[0], np.arange(shape[2]) * h + lo[2], indexing='ij')
    for j in range(shape[1]):
        y = lo[1] + j * h
        sl = ribs[np.abs(ribs[:, 1] - y) < 0.025]
        if len(sl) < 30:
            continue
        try:
            hull = Delaunay(sl[:, [0, 2]])
        except Exception:
            continue
        cav[:, j, :] = hull.find_simplex(np.stack([gx, gz], -1).reshape(-1, 2)).reshape(gx.shape) >= 0
    cav = ndimage.binary_erosion(cav, iterations=3)  # stay inside ribs/intercostals
    # above the diaphragm dome
    top = np.full((shape[0], shape[2]), -np.inf)
    dij = np.clip(((diaph - lo) / h).astype(int), 0, shape - 1)
    np.maximum.at(top, (dij[:, 0], dij[:, 2]), dij[:, 1])
    top = ndimage.grey_dilation(np.where(np.isfinite(top), top, -1), size=3)
    yy = np.arange(shape[1])[None, :, None]
    above = yy > top[:, None, :] + 1
    region = cav & above & ~ndimage.binary_dilation(vox(medi), iterations=3)
    seed = ndimage.binary_dilation(vox(bron), iterations=int(0.03 / h)) & region
    lung = ndimage.binary_closing(seed, iterations=int(0.02 / h)) & region
    lung = ndimage.binary_fill_holes(lung)
    lung = ndimage.binary_opening(lung, iterations=1)
    from skimage import measure
    out = {}
    for side, sg in (('Left', 1), ('Right', -1)):
        g = lung.copy()
        xs = lo[0] + np.arange(shape[0]) * h
        g[(xs * sg) < 0.012] = False
        lab, n = ndimage.label(g)
        if n == 0:
            continue
        big = np.argmax(np.bincount(lab.ravel())[1:]) + 1
        g = ndimage.gaussian_filter((lab == big).astype(float), 1.2)
        V, F, _, _ = measure.marching_cubes(g, 0.5)
        V = V * h + lo
        log(f'{side} lung', f'{(lab == big).sum() * h ** 3 * 1000:.2f} L', len(F), 'tris')
        out[f'{side} lung'] = (V, F[:, ::-1].astype(np.int64))
    return out


# ----------------------------------------------------------- spinal cord
VERT = (['Atlas', 'Axis'] + [f'{o} cervical vertebra' for o in ('Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh')] +
        [f'{o} thoracic vertebra' for o in ('First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh',
                                             'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth')] +
        [f'{o} lumbar vertebra' for o in ('First', 'Second', 'Third', 'Fourth', 'Fifth')])


def canal_centre(P):
    """Centre of the vertebral foramen: the point in the vertebra's mid slab
    furthest from any bone, between body and spinous process."""
    c = P.mean(0)
    sl = P[np.abs(P[:, 1] - c[1]) < 0.012]
    tree = cKDTree(sl[:, [0, 2]])
    best, bp = -1, None
    for x in np.linspace(-0.012, 0.012, 7):
        for z in np.linspace(c[2] - 0.045, c[2] + 0.02, 40):
            d, _ = tree.query([x, z])
            if d > best:
                best, bp = d, np.array([x, c[1], z])
    return bp, best


def spinal_cord(parts, log=print):
    cs, rs = [], []
    for n in VERT:
        if n in parts:
            c, r = canal_centre(parts[n][0])
            cs.append(c)
            rs.append(r)
    cs = np.array(cs)
    names = [n for n in VERT if n in parts]
    # radius: cervical enlargement (C4-T1), lumbar enlargement (T10-T12), conus at L1
    rad = []
    for n in names:
        if 'cervical' in n or n in ('Atlas', 'Axis'):
            rad.append(0.0065)
        elif 'thoracic' in n:
            rad.append(0.0052 if not any(k in n for k in ('Tenth', 'Eleventh', 'Twelfth')) else 0.006)
        else:
            rad.append(0.003)
    l1 = names.index('First lumbar vertebra')
    cord_pts = cs[:l1 + 1]
    # continue up through the foramen magnum into the medulla
    med = parts.get('Medulla oblongata')
    if med:
        m = med[0]
        cord_pts = np.vstack([m[np.argmin(m[:, 1])] + [0, 0.01, 0], cord_pts])
        rad = [0.0075] + rad
    cord = tube(cord_pts[::-1], np.array(rad[:len(cord_pts)])[::-1] * 0.95, sides=12)
    # cauda equina: a bundle of nerve roots down to the sacrum
    cauda = []
    sac = parts.get('Sacrum')
    end = sac[0][np.argmax(sac[0][:, 1])] if sac else cs[-1] - [0, 0.05, 0]
    lumb = cs[l1:]
    rng = np.random.default_rng(3)
    for k in range(12):
        off = np.array([rng.uniform(-0.005, 0.005), 0, rng.uniform(-0.004, 0.004)])
        path = np.vstack([lumb + off * np.linspace(0.3, 1, len(lumb))[:, None], end + off + [0, -0.03, -0.01]])
        cauda.append(tube(path, 0.0011, sides=5))
    log('spinal cord', len(cord_pts), 'segments')
    return cord, cauda


# ----------------------------------------------------------------- nerves
def nerves(parts, log=print):
    out = {}

    def cl(name, start=None):
        if name not in parts:
            return None
        P = np.concatenate(parts[name])
        return centerline(P, start)

    def ctr(name):
        return np.concatenate(parts[name]).mean(0)

    def top_of(name):
        P = np.concatenate(parts[name])
        return P[np.argmax(P[:, 1])]

    def bottom_of(name):
        P = np.concatenate(parts[name])
        return P[np.argmin(P[:, 1])]

    def oriented(c, first_high=True):
        if c is None:
            return None
        return c if (c[0, 1] > c[-1, 1]) == first_high else c[::-1]

    for side, sg in (('Left', 1.0), ('Right', -1.0)):
        lo = side.lower()
        # ------------------------------------------------- lower limb
        fem = np.concatenate(parts[f'{side} femur'])
        hipj = fem[np.argmax(fem[:, 1] - 0.5 * np.abs(fem[:, 0]) * 0)]  # top of femoral head region
        sac = np.concatenate(parts['Sacrum']).mean(0)
        pop = oriented(cl(f'{side} popliteal artery'))
        ptib = oriented(cl(f'{side} posterior tibial artery'))
        atib = oriented(cl(f'{side} anterior tibial artery'))
        knee_z = pop[0, 2] if pop is not None else hipj[2]
        thigh = [sac + [0.025 * sg, 0.02, 0.02],
                 sac + [0.05 * sg, -0.02, -0.005],
                 [hipj[0] - 0.035 * sg, hipj[1] - 0.06, hipj[2] - 0.07],
                 [hipj[0] - 0.02 * sg, hipj[1] - 0.18, hipj[2] - 0.06]]
        if pop is not None:
            mid = 0.5 * (np.array(thigh[-1]) + pop[0])
            thigh += [mid + [0, 0, -0.01], pop[0] + [0, 0.03, -0.012]]
            out[f'{side} sciatic nerve'] = tube(thigh, np.linspace(0.0065, 0.0055, 6))
            if ptib is not None:
                tib = np.vstack([pop + [0, 0, -0.006], ptib + [-0.004 * sg, 0, -0.004]])
                out[f'{side} tibial nerve'] = tube(tib, np.linspace(0.004, 0.002, 4))
            fib = np.concatenate(parts[f'{side} fibula'])
            fib_head = fib[np.argmax(fib[:, 1])]
            if atib is not None:
                path = [pop[0] + [0, 0.02, -0.012], fib_head + [0.012 * sg, -0.01, -0.006],
                        fib_head + [0.006 * sg, -0.04, 0.012]] + list(atib[2:] + [0.004 * sg, 0, 0.003])
                out[f'{side} common fibular nerve'] = tube(path, np.linspace(0.003, 0.0015, 4))
        femart = oriented(cl(f'{side} femoral artery'))
        if femart is not None:
            out[f'{side} femoral nerve'] = tube(femart + [0.012 * sg, 0, -0.004], np.linspace(0.004, 0.0015, 4))
        # ------------------------------------------------- upper limb
        ax = oriented(cl(f'{side} axillary artery'), True)
        br = oriented(cl(f'{side} brachial artery'), True)
        ra = oriented(cl(f'{side} radial artery'), True)
        ul = oriented(cl(f'{side} ulnar artery'), True)
        c6 = ctr('Sixth cervical vertebra')
        hum = np.concatenate(parts[f'{side} humerus'])
        dist_h = hum[hum[:, 1] < hum[:, 1].min() + 0.03]
        med_epi = dist_h[np.argmin(dist_h[:, 0] * sg)]
        lat_epi = dist_h[np.argmax(dist_h[:, 0] * sg)]
        if ax is not None and br is not None:
            plexus = [c6 + [0.03 * sg, 0, 0], c6 + [0.06 * sg, -0.03, 0.005], ax[0]]
            out[f'{side} brachial plexus'] = tube(plexus + list(ax), np.linspace(0.007, 0.006, 4))
            if ra is not None and ul is not None:
                n = 30
                rr = resample(ra, 1)[:] if False else ra
                t = np.linspace(0, 1, n)
                def interp(c):
                    s = np.linspace(0, 1, len(c))
                    return np.stack([np.interp(t, s, c[:, k]) for k in range(3)], 1)
                midfore = 0.5 * (interp(ra) + interp(ul))
                hand = ctr(f'{side} third metacarpal bone')
                median = list(br + [-0.004 * sg, 0, 0.004]) + list(midfore[3:]) + [hand + [0, 0, 0.008]]
                out[f'{side} median nerve'] = tube(median, np.linspace(0.0035, 0.002, 5))
                ulnar = list(br[:len(br) // 2] + [-0.008 * sg, 0, -0.004]) + [med_epi + [0, 0, -0.008]] + \
                    list(ul[4:] + [-0.004 * sg, 0, 0]) + [ctr(f'{side} fifth metacarpal bone')]
                out[f'{side} ulnar nerve'] = tube(ulnar, np.linspace(0.003, 0.0018, 5))
                humc = hum.mean(0)
                radial = [ax[-1], humc + [0.005 * sg, 0.02, -0.022], humc + [0.02 * sg, -0.06, -0.012],
                          lat_epi + [0.0, 0.01, 0.012]] + list(ra[3:] + [0.005 * sg, 0, 0])
                out[f'{side} radial nerve'] = tube(radial, np.linspace(0.003, 0.0015, 5))
        # ------------------------------------------------- vagus / phrenic
        car = oriented(cl(f'{side} common carotid artery'), True)
        eso = cl('Esophagus')
        med = parts.get('Medulla oblongata')
        if car is not None and eso is not None and med is not None:
            eso = oriented(eso, True)
            start = bottom_of('Medulla oblongata') + [0.01 * sg, 0, 0.005]
            vag = [start] + list(car[::-1][::-1] + [0.006 * sg, 0, -0.01]) + list(eso[len(eso) // 4:] + [0.006 * sg, 0, 0.004 * sg])
            out[f'{side} vagus nerve'] = tube(vag, 0.0018)
        c4 = ctr('Fourth cervical vertebra')
        heart = np.concatenate([P for n, Ps in parts.items() if n.startswith('Wall of') for P in Ps])
        hside = heart[np.argmax(heart[:, 0] * sg)]
        dia = np.concatenate(parts['Diaphragm'])
        dtop = dia[(np.abs(dia[:, 0] - hside[0]) < 0.02)]
        if len(dtop):
            phr = [c4 + [0.035 * sg, 0, 0.02], c4 + [0.05 * sg, -0.06, 0.03],
                   hside + [0.012 * sg, 0.04, 0], hside + [0.012 * sg, 0, 0], dtop[np.argmax(dtop[:, 1])] + [0, 0.004, 0]]
            out[f'{side} phrenic nerve'] = tube(phr, 0.0012)
        # ------------------------------------------------- intercostals
        for o in ('first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
                  'eleventh', 'twelfth'):
            rn = f'{side} {o} rib'
            if rn not in parts:
                continue
            R = np.concatenate(parts[rn])
            spine_end = R[np.argmin(np.abs(R[:, 0]))]
            c = centerline(R, spine_end)
            out[f'{side} {o} intercostal nerve'] = tube(c + [0, -0.008, 0], 0.0012, sides=5)
    log('nerves', len(out))
    return out
