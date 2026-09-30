"""Signed-distance modelling helpers.

Every shape in the kit is a smooth union of a few primitives, meshed with OpenVDB.
That guarantees what the renderer needs: closed meshes with smooth normals, so the
inverted-hull outline never tears.

Everything is authored in glTF space: +Y up, +Z forward, metres.
"""

import numpy as np
import openvdb as vdb

F = np.float32


def euler(rx=0.0, ry=0.0, rz=0.0):
    """Rotation matrix whose columns are the local axes. X is applied first, then Y, then Z."""
    cx, sx, cy, sy, cz, sz = np.cos(rx), np.sin(rx), np.cos(ry), np.sin(ry), np.cos(rz), np.sin(rz)
    mx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    my = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    mz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return mz @ my @ mx


def _v(x):
    return np.asarray(x, dtype=np.float64)


class Prim:
    """A distance function with a bounding box."""

    def __init__(self, fn, lo, hi):
        self.fn, self.lo, self.hi = fn, _v(lo), _v(hi)

    def __call__(self, p):
        return self.fn(p)


def _local(p, c, rot):
    q = p - c.astype(F)
    return q if rot is None else q @ rot.astype(F)


def ellipsoid(c, r, rot=None):
    c, r = _v(c), _v(r) * np.ones(3)
    rf = r.astype(F)

    def fn(p):
        q = _local(p, c, rot)
        k0 = np.linalg.norm(q / rf, axis=1)
        k1 = np.linalg.norm(q / (rf * rf), axis=1)
        # Near the centre the usual k0 (k0 - 1) / k1 estimate degenerates.
        return np.where(k1 > 1e-6, k0 * (k0 - 1.0) / np.maximum(k1, 1e-6), -rf.min())

    m = r.max()
    return Prim(fn, c - m, c + m)


def ball(c, r):
    return ellipsoid(c, [r, r, r])


def cone(a, b, ra, rb=None):
    """Round cone from `a` (radius ra) to `b` (radius rb). A capsule when the radii match."""
    a, b = _v(a), _v(b)
    rb = ra if rb is None else rb
    ba = (b - a).astype(F)
    l2 = float(ba @ ba)
    if l2 < 1e-10:
        return ball(a, max(ra, rb))
    rr = ra - rb
    a2 = l2 - rr * rr
    il2 = 1.0 / l2

    def fn(p):
        pa = p - a.astype(F)
        y = pa @ ba
        z = y - l2
        x = pa * l2 - np.outer(y, ba)
        x2 = np.einsum("ij,ij->i", x, x)
        y2 = y * y * l2
        z2 = z * z * l2
        k = np.sign(rr) * rr * rr * x2
        d_b = np.sqrt(x2 + z2) * il2 - rb
        d_a = np.sqrt(x2 + y2) * il2 - ra
        d_m = (np.sqrt(np.maximum(x2 * a2 * il2, 0)) + y * rr) * il2 - ra
        return np.where(np.sign(z) * a2 * z2 > k, d_b, np.where(np.sign(y) * a2 * y2 < k, d_a, d_m))

    m = max(ra, rb)
    return Prim(fn, np.minimum(a, b) - m, np.maximum(a, b) + m)


def box(c, half, r=0.0, rot=None):
    """Box with rounded edges. `half` is the full half-extent, rounding included."""
    c, half = _v(c), _v(half)
    inner = (half - r).astype(F)

    def fn(p):
        q = np.abs(_local(p, c, rot)) - inner
        return np.linalg.norm(np.maximum(q, 0), axis=1) + np.minimum(q.max(axis=1), 0) - r

    m = np.linalg.norm(half)
    return Prim(fn, c - m, c + m)


def torus(c, big, small, rot=None):
    """Ring around the local Y axis."""
    c = _v(c)

    def fn(p):
        q = _local(p, c, rot)
        ring = np.sqrt(q[:, 0] ** 2 + q[:, 2] ** 2) - big
        return np.sqrt(ring**2 + q[:, 1] ** 2) - small

    m = big + small
    return Prim(fn, c - m, c + m)


def _polygon(px, py, pts):
    """Signed distance from 2D points to a closed polygon."""
    d = np.full(len(px), np.inf, dtype=F)
    inside = np.zeros(len(px), dtype=bool)
    for i in range(len(pts)):
        a, b = pts[i], pts[i - 1]
        ex, ey = b[0] - a[0], b[1] - a[1]
        wx, wy = px - a[0], py - a[1]
        t = np.clip((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1)
        d = np.minimum(d, (wx - ex * t) ** 2 + (wy - ey * t) ** 2)
        # Even-odd rule: flip each time a ray from the point crosses this edge.
        c1, c2, c3 = py >= a[1], py < b[1], ex * wy > ey * wx
        inside ^= (c1 & c2 & c3) | (~c1 & ~c2 & ~c3)
    return np.where(inside, -1, 1) * np.sqrt(d)


def lathe(c, profile, r=0.0, rot=None):
    """Solid of revolution around the local Y axis.

    `profile` is a closed polygon of (radius, height) points. `r` rounds every edge,
    which the outline needs: it tears on hard creases.
    """
    c = _v(c)
    pts = np.asarray(profile, dtype=F)

    def fn(p):
        q = _local(p, c, rot)
        return _polygon(np.sqrt(q[:, 0] ** 2 + q[:, 2] ** 2), q[:, 1], pts) - r

    m = float(np.abs(pts).max()) * 1.5 + r
    return Prim(fn, c - m, c + m)


def extrude(c, profile, half, r=0.0, rot=None):
    """A polygon drawn in the local XY plane, given thickness along Z, edges rounded by `r`."""
    c = _v(c)
    pts = np.asarray(profile, dtype=F)

    def fn(p):
        q = _local(p, c, rot)
        d2 = _polygon(q[:, 0], q[:, 1], pts)
        dz = np.abs(q[:, 2]) - half
        return np.sqrt(np.maximum(d2, 0) ** 2 + np.maximum(dz, 0) ** 2) + np.minimum(np.maximum(d2, dz), 0) - r

    m = float(np.abs(pts).max()) * 1.5 + half + r
    return Prim(fn, c - m, c + m)


def smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b + (a - b) * h - k * h * (1 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def union(prims, k=0.0):
    def fn(p):
        d = prims[0](p)
        for q in prims[1:]:
            d = smin(d, q(p), k)
        return d

    return Prim(fn, np.min([q.lo for q in prims], axis=0), np.max([q.hi for q in prims], axis=0))


def tube(points, radii, k=None):
    """Round cones chained along a polyline. `radii` is one number or one per point."""
    pts = [_v(q) for q in points]
    rs = [radii] * len(pts) if np.isscalar(radii) else list(radii)
    segs = [cone(pts[i], pts[i + 1], rs[i], rs[i + 1]) for i in range(len(pts) - 1)]
    return union(segs, min(rs) * 0.5 if k is None else k)


def mirror(prim):
    """The primitive and its reflection across x = 0."""

    def fn(p):
        q = p.copy()
        q[:, 0] = np.abs(q[:, 0])
        return prim(q)

    lo, hi = prim.lo.copy(), prim.hi.copy()
    m = max(abs(lo[0]), abs(hi[0]))
    lo[0], hi[0] = -m, m
    return Prim(fn, lo, hi)


def scaled(prim, s, about=(0, 0, 0)):
    """Non-uniform scale about a point. The distance is only approximate, which meshing tolerates."""
    s, about = _v(s) * np.ones(3), _v(about)
    sf, af = s.astype(F), about.astype(F)
    corners = np.array([about + (c - about) * s for c in (prim.lo, prim.hi)])
    return Prim(lambda p: prim((p - af) / sf + af) * F(s.min()), corners.min(axis=0), corners.max(axis=0))


def moved(prim, offset=(0, 0, 0), rot=None, about=(0, 0, 0)):
    """Rigid transform: rotate about a point, then translate."""
    offset, about = _v(offset), _v(about)
    r = np.eye(3) if rot is None else rot
    centre = (prim.lo + prim.hi) / 2
    radius = np.linalg.norm(prim.hi - prim.lo) / 2
    new_centre = about + r @ (centre - about) + offset

    def fn(p):
        return prim((p - (about + offset).astype(F)) @ r.astype(F) + about.astype(F))

    return Prim(fn, new_centre - radius, new_centre + radius)


def warped(prim, fn_warp, pad=0.0):
    """Evaluates the primitive at warped coordinates. `pad` grows the bounds to cover the warp."""
    return Prim(lambda p: prim(fn_warp(p)), prim.lo - pad, prim.hi + pad)


class Model:
    """An ordered list of smooth unions and cuts, plus the colour zones painted on the result."""

    def __init__(self):
        self.ops = []
        self.zones = {}

    def add(self, prim, k=0.03):
        self.ops.append((prim, k, False))
        return self

    def cut(self, prim, k=0.01):
        self.ops.append((prim, k, True))
        return self

    def paint(self, zone, prim):
        """Marks the part of the surface that falls inside `prim` as belonging to a colour zone."""
        self.zones.setdefault(zone, []).append(prim)
        return self

    def bounds(self):
        solids = [q for q, _, is_cut in self.ops if not is_cut]
        return np.min([q.lo for q in solids], axis=0), np.max([q.hi for q in solids], axis=0)

    def _eval(self, p):
        d = None
        for prim, k, is_cut in self.ops:
            v = prim(p)
            d = v if d is None else (smax(d, -v, k) if is_cut else smin(d, v, k))
        return d

    def __call__(self, p, chunk=400_000):
        p = np.ascontiguousarray(p, dtype=F)
        out = np.empty(len(p), dtype=F)
        for i in range(0, len(p), chunk):
            out[i : i + chunk] = self._eval(p[i : i + chunk])
        return out

    def gradient(self, p, eps=1e-3):
        g = np.empty((len(p), 3), dtype=F)
        for axis in range(3):
            step = np.zeros(3, dtype=F)
            step[axis] = eps
            g[:, axis] = (self(p + step) - self(p - step)) / (2 * eps)
        return g

    def zone_mask(self, zone, p, width):
        """0..1 field that crosses 0.5 on the zone boundary, linear over `width` either side."""
        prims = self.zones.get(zone)
        if not prims:
            return np.zeros(len(p), dtype=F)
        p = np.ascontiguousarray(p, dtype=F)
        d = prims[0](p)
        for q in prims[1:]:
            d = np.minimum(d, q(p))
        return np.clip(0.5 - d / (2 * width), 0, 1).astype(F)


ZONES = ("secondary", "tertiary", "belly", "skin")


def mesh(model, voxel, mask_width=0.03):
    """Meshes the zero level set. Returns (vertices, normals, triangles, rgba zone masks)."""
    lo, hi = model.bounds()
    lo = lo - 3 * voxel
    n = np.ceil((hi + 3 * voxel - lo) / voxel).astype(int) + 1
    axes = [(lo[i] + voxel * np.arange(n[i])).astype(F) for i in range(3)]
    field = np.empty(tuple(n), dtype=F)
    yy, zz = np.meshgrid(axes[1], axes[2], indexing="ij")
    plane = np.stack([np.zeros_like(yy), yy, zz], axis=-1).reshape(-1, 3)
    for i, x in enumerate(axes[0]):
        plane[:, 0] = x
        field[i] = model(plane).reshape(n[1], n[2])

    grid = vdb.FloatGrid(1.0)
    grid.copyFromArray(field)
    points, quads = grid.convertToQuads(0.0)
    verts = points.astype(F) * F(voxel) + lo.astype(F)

    # Pull every vertex onto the exact surface, then take the normal from the field itself.
    for _ in range(4):
        g = model.gradient(verts)
        d = model(verts)
        verts -= g * (d / np.maximum(np.einsum("ij,ij->i", g, g), 1e-6))[:, None]
    normals = model.gradient(verts)
    normals /= np.maximum(np.linalg.norm(normals, axis=1), 1e-6)[:, None]

    quads = quads.astype(np.int64)
    tris = np.concatenate([quads[:, [0, 1, 2]], quads[:, [0, 2, 3]]])
    # OpenVDB does not promise a winding; make faces agree with the field gradient.
    a, b, c = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    facing = np.einsum("ij,ij->i", np.cross(b - a, c - a), normals[tris[:, 0]])
    if facing.sum() < 0:
        tris = tris[:, ::-1]

    masks = np.stack([model.zone_mask(z, verts, mask_width) for z in ZONES], axis=1)
    return verts, normals, tris, masks
