"""The cat kit: one head, two ears, one tail and five posed bodies per breed.

Shapes only. Colours, expressions and accessories are applied at runtime from the
CatSpec, so every mesh here carries colour zones (see sdf.ZONES) instead of colours,
and named anchors where the runtime attaches the rest.
"""

from dataclasses import dataclass, field
from math import cos, pi, sin

import numpy as np

from sdf import Model, Prim, ball, box, cone, ellipsoid, euler, mirror, moved, scaled, torus, tube, union

POSES = ("sit", "loaf", "crouch", "curl", "float")

# The runtime bends the tail as a chain of this many joints, this far apart.
TAIL_SEGMENTS = 7
TAIL_SEGMENT = 0.107
TAIL_LENGTH = TAIL_SEGMENTS * TAIL_SEGMENT

# Bodies are modelled at a comfortable size, then shrunk under a head that is not:
# the head is the character, the body is its pedestal.
BODY_SCALE = 0.8


@dataclass
class Breed:
    pattern: str
    style: str = "cat"  # cat | void | sphynx | bread | glitch
    fat: float = 1.0  # torso width
    leg: float = 1.0  # leg and paw thickness
    soft: float = 1.0  # how much the parts melt into each other
    head_w: float = 1.0
    head_h: float = 1.0
    cheek: float = 1.0
    muzzle: float = 1.0
    tufts: int = 0  # cheek tufts per side
    eye_gap: float = 0.15
    eye_y: float = 0.02
    eye_size: float = 1.2
    ear_h: float = 0.2
    ear_w: float = 0.115
    ear_at: float = 0.62  # 0 = top of the skull, 1 = the side
    ear_tilt: float = 0.3
    ear_round: bool = False
    ear_tuft: bool = False
    neck: float = 1.0  # collar size
    mane: bool = False
    # (position along the tail 0..1, radius)
    tail: list = field(default_factory=lambda: [(0, 0.05), (0.5, 0.05), (1, 0.04)])


BREEDS = {
    "tabby": Breed("tabby", tufts=1),
    "tuxedo": Breed("tuxedo", fat=0.92, leg=0.9, head_w=0.93, head_h=1.04, cheek=0.85, ear_h=0.21, neck=0.95,
                    tail=[(0, 0.045), (0.6, 0.045), (1, 0.05)]),
    "orange": Breed("tabby", fat=1.3, leg=1.15, head_w=1.16, head_h=0.94, cheek=1.3, eye_gap=0.115, eye_size=0.92,
                    eye_y=0.035, ear_h=0.15, ear_w=0.1, ear_at=0.7, neck=1.12, tail=[(0, 0.065), (0.6, 0.06), (1, 0.05)]),
    "calico": Breed("calico", fat=1.05, tufts=2, cheek=1.1, ear_h=0.18, tail=[(0, 0.05), (0.55, 0.075), (1, 0.06)]),
    "siamese": Breed("points", fat=0.8, leg=0.78, head_w=0.9, cheek=0.62, muzzle=1.35, eye_gap=0.135, eye_size=1.1, ear_h=0.27,
                     ear_w=0.13, ear_at=0.8, ear_tilt=0.55, neck=0.85, tail=[(0, 0.036), (0.5, 0.03), (1, 0.024)]),
    "void": Breed("solid", style="void", soft=2.6, cheek=0.9, muzzle=0.0, eye_gap=0.155, eye_size=1.4, ear_h=0.24,
                  ear_w=0.1, ear_tilt=0.2, tail=[(0, 0.05), (0.4, 0.045), (0.85, 0.03), (1, 0.008)]),
    "sphynx": Breed("hairless", style="sphynx", fat=0.86, leg=0.72, head_w=0.9, cheek=0.7, muzzle=1.15,
                    eye_gap=0.14, eye_size=1.2, ear_h=0.3, ear_w=0.165, ear_at=0.85, ear_tilt=0.7, neck=0.8,
                    tail=[(0, 0.05), (0.3, 0.036), (1, 0.02)]),
    "maineCoon": Breed("tabby", fat=1.12, leg=1.3, head_w=1.06, cheek=1.15, muzzle=1.25, tufts=2, ear_h=0.2,
                       ear_tuft=True, neck=1.3, mane=True, tail=[(0, 0.045), (0.25, 0.07), (0.65, 0.082), (1, 0.035)]),
    "loaf": Breed("loaf", style="bread", muzzle=0.7, eye_gap=0.125, eye_size=1.0, eye_y=0.0,
                  ear_h=0.12, ear_w=0.085, ear_at=0.75, ear_tilt=0.45, tail=[(0, 0.06), (0.7, 0.07), (1, 0.05)]),
    "glitch": Breed("glitch", style="glitch", tufts=1, tail=[(0, 0.05), (1, 0.045)]),
}


def grown(prim, r):
    return Prim(lambda p: prim(p) - r, prim.lo - r, prim.hi + r)


def glitch_warp(p):
    """Shifts horizontal slices sideways, like a frame that failed to decode."""
    q = p.copy()
    t = q[:, 1] / 0.085
    i = np.floor(t)
    f = t - i
    off = lambda n: (np.modf(np.sin(n * 12.9898 + 4.1) * 43758.5453)[0]) * 0.055
    blend = np.clip((f - 0.82) / 0.18, 0, 1)
    blend = blend * blend * (3 - 2 * blend)
    q[:, 0] += (off(i) * (1 - blend) + off(i + 1) * blend).astype(q.dtype)
    return q


def glitched(model):
    """Wraps every solid and zone of a model in the slice warp."""
    from sdf import warped

    model.ops = [(warped(prim, glitch_warp, 0.06), k, is_cut) for prim, k, is_cut in model.ops]
    model.zones = {z: [warped(q, glitch_warp, 0.06) for q in prims] for z, prims in model.zones.items()}
    for i, y in enumerate((-0.2, -0.03, 0.12, 0.33, 0.5, 0.71)):
        model.paint("secondary" if i % 2 else "tertiary", box((0, y, 0), (2, 0.017 + 0.012 * (i % 3), 2)))
    return model


def surface(model, start, direction):
    """Walks from `start` along `direction` until it hits the surface."""
    p = np.array([start], dtype=np.float32)
    d = np.array(direction, dtype=np.float32)
    d /= np.linalg.norm(d)
    for _ in range(200):
        dist = float(model(p)[0])
        if abs(dist) < 2e-4:
            break
        p += d * dist * 0.7
    return p[0].astype(float)


def frame(z, up=(0, 1, 0)):
    """Rotation whose +Z is `z` and whose +Y is as close to `up` as that allows."""
    z = np.array(z, dtype=float)
    z /= np.linalg.norm(z)
    x = np.cross(up, z)
    x /= np.linalg.norm(x)
    return np.stack([x, np.cross(z, x), z], axis=1)


class Part:
    """A model plus the anchors that travel with it: name -> (position, rotation matrix, scale)."""

    def __init__(self, model):
        self.model = model
        self.anchors = {}

    def anchor(self, name, pos, rot=None, scale=1.0):
        self.anchors[name] = (np.array(pos, dtype=float), np.eye(3) if rot is None else rot, scale)


# --------------------------------------------------------------------------- head


def build_head(b: Breed) -> Part:
    m = Model()
    w, h = 0.3 * b.head_w, 0.26 * b.head_h
    bread = b.style == "bread"
    if bread:
        # The end slice of the loaf: crust all round, the face on the crumb.
        m.add(box((0, -0.06, 0), (0.25, 0.19, 0.13), r=0.05))
        m.add(ellipsoid((0, 0.1, 0), (0.31, 0.16, 0.155)), k=0.03)
    else:
        m.add(ellipsoid((0, 0, 0), (w, h, 0.27)))
        m.add(mirror(ellipsoid((0.17 * b.head_w, -0.1, 0.05), (0.16 * b.cheek, 0.13, 0.17))), k=0.08 * b.soft)
    if b.muzzle > 0:
        out = (0.1 if bread else 0.235) + 0.025 * b.muzzle
        m.add(mirror(ellipsoid((0.052, -0.105, out), (0.085, 0.066, 0.07))), k=0.03)
        m.add(ellipsoid((0, -0.17, out - 0.05), (0.07, 0.05, 0.07)), k=0.04)
        nose = (0, -0.052, out + 0.058)
        m.add(ellipsoid(nose, (0.036, 0.025, 0.024)), k=0.008)
        m.paint("skin", ellipsoid((nose[0], nose[1], nose[2] + 0.01), (0.04, 0.03, 0.03)))
    for i in range(b.tufts):
        a = -0.35 - 0.5 * i
        root = (0.24 * b.head_w * b.cheek**0.5, -0.1 - 0.06 * i, 0.04)
        tip = (root[0] + 0.15 * cos(a), root[1] + 0.15 * sin(a), 0.02)
        m.add(mirror(cone(root, tip, 0.065, 0.012)), k=0.03)

    if b.style == "sphynx":
        # Forehead furrows and a fold under each eye: the permanent frown.
        for i, y in enumerate((0.13, 0.175, 0.215)):
            ridge = tube([(-0.11 + 0.02 * i, y - 0.015, 0.2), (0, y, 0.26 - 0.035 * i), (0.11 - 0.02 * i, y - 0.015, 0.2)], 0.017)
            m.add(ridge, k=0.012)
            m.paint("secondary", grown(ridge, 0.004))
        fold = mirror(tube([(0.07, -0.075, 0.26), (0.15, -0.095, 0.235), (0.22, -0.07, 0.17)], 0.015))
        m.add(fold, k=0.012)
        m.paint("secondary", grown(fold, 0.004))
        m.add(mirror(ellipsoid((0.2, -0.02, 0.1), (0.09, 0.05, 0.1))), k=0.04)  # cheekbones

    if b.mane:
        # A ruff that frames the face, longest under the chin.
        tufts = []
        for i in range(11):
            a = pi * (0.06 + 0.88 * i / 10)  # left cheek, under the chin, right cheek
            length = 0.2 + 0.1 * sin(a)
            root = (0.2 * cos(a), -0.12 - 0.06 * sin(a), -0.02)
            tip = (root[0] + length * cos(a) * 0.9, root[1] - length * sin(a) * 0.95 - 0.04, 0.05 + 0.05 * sin(a))
            tufts.append(cone(root, tip, 0.1, 0.014))
        ruff = union(tufts, 0.02)
        m.add(ruff, k=0.03)
        m.paint("belly", grown(ruff, 0.006))

    # Colour zones.
    p = b.pattern
    muzzle_zone = ellipsoid((0, -0.13, 0.27), (0.15, 0.1, 0.12))
    if p == "tabby":
        m.paint("belly", muzzle_zone)
        for x in (-0.075, 0, 0.075):
            m.paint("secondary", box((x, 0.2, 0.12), (0.018, 0.1, 0.2), rot=euler(0, 0, -x * 3)))
        m.paint("secondary", mirror(box((0.3, -0.02, 0.1), (0.12, 0.017, 0.2), rot=euler(0, 0, 0.35))))
        m.paint("secondary", mirror(box((0.3, -0.1, 0.1), (0.1, 0.017, 0.2), rot=euler(0, 0, 0.1))))
    elif p == "tuxedo":
        # White muzzle running up into a blaze between the eyes.
        m.paint("secondary", ellipsoid((0, -0.15, 0.25), (0.17, 0.13, 0.14)))
        m.paint("secondary", ellipsoid((0, 0.03, 0.26), (0.04, 0.17, 0.1)))
    elif p == "calico":
        m.paint("secondary", ellipsoid((0.2, 0.12, 0.12), (0.2, 0.2, 0.24)))
        m.paint("tertiary", ellipsoid((-0.22, 0.1, 0.02), (0.17, 0.22, 0.22)))
        m.paint("belly", muzzle_zone)
    elif p == "points":
        m.paint("secondary", ellipsoid((0, -0.09, 0.3), (0.16, 0.13, 0.13)))
    elif p == "hairless":
        m.paint("belly", muzzle_zone)
    elif p == "loaf":
        m.paint("belly", box((0, -0.06, 0.13), (0.212, 0.152, 0.1), r=0.03))
        m.paint("belly", ellipsoid((0, 0.09, 0.13), (0.262, 0.115, 0.1)))
        m.paint("secondary", ellipsoid((0, 0.36, -0.03), (0.4, 0.17, 0.3)))
    if b.style == "glitch":
        glitched(m)

    part = Part(m)
    far = 0.8
    for side, name in ((-1, "L"), (1, "R")):
        eye = surface(m, (side * b.eye_gap, b.eye_y, far), (0, 0, -1))
        n = m.gradient(np.array([eye], dtype=np.float32))[0]
        facing = n / np.linalg.norm(n) * 0.45 + np.array([0, 0, 0.55])
        part.anchor(f"anchor_eye_{name}", eye, frame(facing), b.eye_size)
        brow = surface(m, (side * b.eye_gap, b.eye_y + 0.125 * b.eye_size, far), (0, 0, -1))
        part.anchor(f"anchor_brow_{name}", brow, frame(facing), b.eye_size)
        a = b.ear_at * 0.95
        ear = surface(m, (side * sin(a) * far, cos(a) * far + 0.02, -0.02), (-side * sin(a), -cos(a), 0))
        ear -= np.array([side * sin(a), cos(a), 0]) * 0.035
        part.anchor(f"anchor_ear_{name}", ear, euler(0, 0, -side * b.ear_tilt))
        whisker = surface(m, (side * 0.13, -0.11, far), (0, 0, -1))
        part.anchor(f"anchor_whisker_{name}", whisker - np.array([0, 0, 0.01]), euler(0, side * 0.5, 0))
    mouth_y = -0.15 if b.muzzle > 0 else -0.11
    # The mouth sits on the muzzle pads, not in the crease between them.
    mouth_z = max(surface(m, (x, mouth_y, far), (0, 0, -1))[2] for x in (-0.05, 0, 0.05))
    part.anchor("anchor_mouth", (0, mouth_y, mouth_z), frame((0, -0.25, 1)), 1.15)
    top = surface(m, (0, far, -0.03), (0, -1, 0))
    part.anchor("anchor_hat", top, scale=b.head_w)
    eye_z = max(part.anchors["anchor_eye_L"][0][2], part.anchors["anchor_eye_R"][0][2])
    part.anchor("anchor_face", (0, b.eye_y, eye_z), scale=b.eye_gap / 0.15 * (0.4 + 0.5 * b.eye_size))
    return part


def build_ear(b: Breed, side: int) -> Part:
    m = Model()
    hgt, wid = b.ear_h, b.ear_w
    if b.ear_round:
        m.add(ellipsoid((0, 0.045, 0), (0.09, 0.085, 0.045)))
        inner = ellipsoid((0, 0.05, 0.05), (0.055, 0.05, 0.03))
        m.cut(inner, k=0.02)
    else:
        m.add(scaled(cone((0, -0.03, 0), (0, hgt, 0), wid, 0.022), (1, 1, 0.42)))
        inner = scaled(cone((0, 0.0, 0.055), (0, hgt * 0.72, 0.03), wid * 0.62, 0.012), (1, 1, 0.5), (0, 0, 0.05))
        m.cut(inner, k=0.015)
        m.paint("skin", grown(inner, 0.008))
    if b.ear_tuft:
        tuft = cone((0, hgt - 0.02, 0), (side * 0.015, hgt + 0.12, -0.01), 0.022, 0.004)
        m.add(tuft, k=0.015)
        m.paint("secondary", grown(tuft, 0.012))
        fluff = cone((0, 0.02, 0.03), (-side * 0.05, 0.11, 0.06), 0.03, 0.006)
        m.add(fluff, k=0.01)
        m.paint("belly", grown(fluff, 0.006))
    everything = ball((0, 0.1, 0), 1)
    if b.pattern == "points":
        m.paint("secondary", everything)
    elif b.pattern == "calico":
        m.paint("secondary" if side > 0 else "tertiary", everything)
    if b.style == "glitch":
        m.paint("tertiary" if side > 0 else "secondary", box((0, hgt * 0.62, 0), (1, 0.02, 1)))
    return Part(m)


# --------------------------------------------------------------------------- tail


def build_tail(b: Breed) -> Part:
    """Straight along +Y from the origin. The runtime bends it."""
    m = Model()
    n = 15
    ts = np.linspace(0, 1, n)
    prof_t, prof_r = zip(*b.tail)
    radii = np.interp(ts, prof_t, prof_r)
    if b.style == "bread":
        # A baguette.
        m.add(cone((0, 0, 0), (0, TAIL_LENGTH, 0), 0.06, 0.055))
        for i in range(4):
            y = TAIL_LENGTH * (0.18 + 0.2 * i)
            score = cone((-0.05, y - 0.03, 0.05), (0.05, y + 0.03, 0.05), 0.02)
            m.cut(score, k=0.01)
            m.paint("tertiary", grown(score, 0.012))
        m.paint("secondary", box((0, TAIL_LENGTH / 2, 0.09), (1, 1, 0.06)))
    elif b.style == "glitch":
        # Blocks that lost their neighbours.
        for i in range(TAIL_SEGMENTS):
            y = TAIL_SEGMENT * (i + 0.5)
            block = box((0, y, 0), (0.05, TAIL_SEGMENT * 0.4, 0.05), r=0.018)
            m.add(block, k=0.0)
            if i % 3:
                m.paint("secondary" if i % 2 else "tertiary", grown(block, 0.01))
    else:
        m.add(tube([(0, t * TAIL_LENGTH, 0) for t in ts], list(radii), k=0.02))
        if b.mane:
            # Plume: shaggy tufts sweeping back towards the tip.
            for i in range(9):
                t = 0.18 + 0.085 * i
                a = i * 2.4
                r = float(np.interp(t, prof_t, prof_r))
                root = (0, t * TAIL_LENGTH, 0)
                tip = (cos(a) * r * 1.7, (t + 0.13) * TAIL_LENGTH, sin(a) * r * 1.7)
                m.add(cone(root, tip, r * 0.75, 0.008), k=0.015)
    p = b.pattern
    whole = box((0, TAIL_LENGTH / 2, 0), (1, 2, 1))
    if p == "tabby":
        for i in range(1, TAIL_SEGMENTS, 2):
            m.paint("secondary", box((0, TAIL_SEGMENT * (i + 0.5), 0), (1, TAIL_SEGMENT * 0.36, 1)))
        m.paint("secondary", ball((0, TAIL_LENGTH, 0), 0.1))
    elif p == "tuxedo":
        m.paint("secondary", ball((0, TAIL_LENGTH + 0.02, 0), 0.13))
    elif p == "calico":
        m.paint("tertiary", box((0, TAIL_LENGTH, 0), (1, TAIL_LENGTH * 0.42, 1)))
        m.paint("secondary", box((0, TAIL_LENGTH * 0.3, 0), (1, TAIL_LENGTH * 0.12, 1)))
    elif p == "points":
        m.paint("secondary", whole)
    return Part(m)


# --------------------------------------------------------------------------- bodies


def _cat_body(b: Breed, pose: str):
    """The cat-shaped bodies. Returns the model and what the painters need to know about it."""
    m = Model()
    f, l, s = b.fat, b.leg, b.soft
    fs = f**0.5
    if pose == "sit":
        m.add(ellipsoid((0, 0.24, -0.04), (0.29 * f, 0.24, 0.27 * fs)))
        m.add(ellipsoid((0, 0.48, 0.03), (0.2 * fs, 0.25, 0.19 * fs)), k=0.1)
        m.add(mirror(ellipsoid((0.2 * f, 0.16, 0.04), (0.14, 0.16, 0.2))), k=0.05 * s)
        m.add(mirror(cone((0.095, 0.42, 0.15), (0.095, 0.07, 0.21), 0.068 * l, 0.06 * l)), k=0.04 * s)
        m.add(mirror(ellipsoid((0.095, 0.045, 0.25), (0.075 * l, 0.048, 0.095))), k=0.025 * s)
        m.add(mirror(ellipsoid((0.23 * f, 0.042, 0.2), (0.072 * l, 0.045, 0.125))), k=0.03 * s)
        info = dict(
            head=((0, 0.8, 0.07), (0, 0, 0)), tail=((0.1, 0.09, -0.26 * fs), (-1.2, 0, -0.95)), axis="y",
            paws=[(0.095, 0.05, 0.25), (-0.095, 0.05, 0.25), (0.23 * f, 0.042, 0.22), (-0.23 * f, 0.042, 0.22)],
            belly=ellipsoid((0, 0.36, 0.24), (0.16 * fs, 0.27, 0.17)),
            spots=[(0.22, 0.4, -0.15), (-0.2, 0.2, -0.2), (0.05, 0.12, -0.3), (-0.28, 0.45, 0.0)],
        )
    elif pose == "loaf":
        m.add(box((0, 0.22, -0.06), (0.36 * f, 0.22, 0.47), r=0.2))
        m.add(ellipsoid((0, 0.33, -0.1), (0.33 * f, 0.19, 0.4)), k=0.06)
        m.add(mirror(ellipsoid((0.13, 0.05, 0.4), (0.09 * l, 0.05, 0.07))), k=0.03 * s)
        info = dict(
            head=((0, 0.56, 0.3), (0, 0, 0)), tail=((0.2, 0.1, -0.48), (-pi / 2, 0, 0.5)), axis="z",
            paws=[(0.13, 0.05, 0.43), (-0.13, 0.05, 0.43)],
            belly=None,
            spots=[(0.28, 0.4, -0.1), (-0.3, 0.35, 0.05), (0.05, 0.45, -0.4), (-0.25, 0.2, -0.4)],
        )
    elif pose == "crouch":
        # Front down, rear up: the wiggle before the pounce.
        m.add(tube([(0, 0.2, 0.3), (0, 0.36, 0.0), (0, 0.62, -0.3)], [0.19 * fs, 0.24 * f, 0.29 * f], k=0.1))
        m.add(mirror(ellipsoid((0.23 * f, 0.42, -0.3), (0.15, 0.27, 0.2))), k=0.05 * s)
        m.add(mirror(cone((0.25 * f, 0.26, -0.24), (0.27 * f, 0.06, -0.22), 0.08 * l, 0.06 * l)), k=0.04 * s)
        m.add(mirror(ellipsoid((0.27 * f, 0.042, -0.15), (0.075 * l, 0.045, 0.13))), k=0.03 * s)
        m.add(mirror(cone((0.15, 0.13, 0.3), (0.2, 0.06, 0.62), 0.07 * l, 0.058 * l)), k=0.04 * s)
        m.add(mirror(ellipsoid((0.21, 0.048, 0.68), (0.078 * l, 0.05, 0.095))), k=0.025 * s)
        info = dict(
            head=((0, 0.36, 0.5), (0.1, 0, 0)), tail=((0, 0.84, -0.46), (-0.3, 0, 0)), axis="z",
            paws=[(0.21, 0.05, 0.7), (-0.21, 0.05, 0.7), (0.27 * f, 0.042, -0.12), (-0.27 * f, 0.042, -0.12)],
            belly=None,
            spots=[(0.25, 0.7, -0.35), (-0.22, 0.5, -0.05), (0.1, 0.45, 0.2), (-0.15, 0.85, -0.45)],
        )
    elif pose == "curl":
        # A doughnut with a cat's worth of fur.
        arc = [(0.34 * cos(a), 0.2, -0.05 + 0.3 * sin(a)) for a in np.linspace(-0.1, pi * 1.7, 12)]
        m.add(ellipsoid((0, 0.14, -0.05), (0.46 * fs, 0.14, 0.42)))
        m.add(tube(arc, [0.13 * fs] * 3 + [0.2 * fs] * 6 + [0.14 * fs] * 3, k=0.06), k=0.06)
        m.add(ellipsoid((0.46, 0.06, 0.2), (0.11 * l, 0.055, 0.08), rot=euler(0, 0.6, 0)), k=0.03 * s)
        info = dict(
            head=((0.2, 0.3, 0.36), (0.2, -0.3, -0.35)), tail=((-0.42, 0.1, -0.3), (-pi / 2, 0, -1.2)), axis="z",
            paws=[(0.48, 0.06, 0.22)],
            belly=None,
            spots=[(-0.35, 0.35, 0.0), (0.0, 0.35, -0.38), (0.36, 0.3, -0.2), (-0.15, 0.3, 0.25)],
        )
    else:  # float: cross-legged, paws on knees, above it all
        m.add(ellipsoid((0, 0.3, -0.01), (0.27 * f, 0.3, 0.25 * fs)))
        m.add(ellipsoid((0, 0.5, 0.03), (0.19 * fs, 0.2, 0.18 * fs)), k=0.1)
        m.add(mirror(ellipsoid((0.23 * f, 0.1, 0.08), (0.16, 0.1, 0.21), rot=euler(0, 0.35, 0))), k=0.03 * s)
        m.add(mirror(ellipsoid((0.1, 0.065, 0.31), (0.125, 0.05, 0.075 * l), rot=euler(0, -0.25, 0.1))), k=0.015 * s)
        m.add(mirror(cone((0.17, 0.45, 0.1), (0.24 * f, 0.19, 0.2), 0.062 * l, 0.055 * l)), k=0.04 * s)
        m.add(mirror(ellipsoid((0.24 * f, 0.17, 0.23), (0.065 * l, 0.05, 0.075))), k=0.025 * s)
        info = dict(
            head=((0, 0.78, 0.06), (0, 0, 0)), tail=((0, 0.1, -0.24 * fs), (-1.1, 0, 0)), axis="y",
            paws=[(0.24 * f, 0.17, 0.24), (-0.24 * f, 0.17, 0.24), (0.11, 0.07, 0.33), (-0.11, 0.07, 0.33)],
            belly=ellipsoid((0, 0.38, 0.22), (0.16 * fs, 0.25, 0.17)),
            spots=[(0.22, 0.4, -0.15), (-0.2, 0.2, -0.2), (0.05, 0.15, -0.28), (-0.27, 0.45, 0.0)],
        )

    if b.style == "void":
        # It is pooling slightly. Nobody mentions it.
        m.add(ellipsoid((0, 0.02, 0.02), (0.4, 0.035, 0.38)), k=0.13)
        for x, z, r in ((0.36, 0.2, 0.06), (-0.4, -0.08, 0.075), (0.1, -0.4, 0.05), (-0.22, 0.38, 0.045)):
            m.add(ellipsoid((x, 0.012, z), (r * 1.6, 0.022, r * 1.3)), k=0.07)
    return m, info


def _bread_body(b: Breed, pose: str):
    """The loaf breed is bread all the way down, whatever it is doing."""
    m = Model()

    def score(a, c, r=0.028):
        groove = cone(a, c, r)
        m.cut(groove, k=0.014)
        m.paint("tertiary", grown(groove, 0.014))

    if pose == "loaf":
        # A tin loaf: straight sides, a top that rose over the edge.
        m.add(box((0, 0.2, -0.1), (0.29, 0.2, 0.47), r=0.05))
        m.add(ellipsoid((0, 0.4, -0.1), (0.38, 0.17, 0.53)), k=0.02)
        for z in (-0.4, -0.2, 0.0):
            score((-0.2, 0.57, z - 0.07), (0.2, 0.57, z + 0.07), 0.04)
        m.paint("secondary", ellipsoid((0, 0.47, -0.1), (0.42, 0.19, 0.57)))
        info = dict(head=((0, 0.33, 0.43), (0, 0, 0.0)), tail=((0.12, 0.2, -0.52), (-pi / 2, 0, 0.5)))
    elif pose == "curl":
        # A croissant.
        n = 9
        for i in range(n):
            t = i / (n - 1)
            a = -0.35 + t * (pi + 0.7)
            fat = 0.075 + 0.11 * sin(pi * t) ** 0.8
            c = (-0.26 * cos(a), fat * 0.95, 0.12 - 0.27 * sin(a))
            m.add(ellipsoid(c, (fat * 0.78, fat, fat * 1.25), rot=euler(0, a, 0)), k=0.018)
        m.paint("secondary", box((0, 0.3, 0), (1, 0.12, 1)))
        info = dict(head=((0.22, 0.24, 0.27), (0.15, -0.35, -0.3)), tail=((-0.22, 0.09, 0.2), (-pi / 2, 0, -2.4)))
    elif pose == "sit":
        # The same tin loaf, stood on end.
        m.add(box((0, 0.34, -0.02), (0.25, 0.34, 0.19), r=0.06))
        m.add(ellipsoid((0, 0.62, -0.02), (0.3, 0.2, 0.24)), k=0.035)
        for y in (0.2, 0.36, 0.52):
            score((-0.15, y - 0.05, 0.2), (0.15, y + 0.05, 0.2))
        m.add(mirror(ellipsoid((0.12, 0.04, 0.2), (0.075, 0.045, 0.09))), k=0.02)
        m.paint("secondary", ellipsoid((0, 0.8, -0.02), (0.32, 0.2, 0.26)))
        info = dict(head=((0, 0.84, 0.05), (0, 0, 0)), tail=((0.1, 0.12, -0.18), (-1.2, 0, -0.95)))
    elif pose == "crouch":
        # A baguette with intent.
        m.add(cone((0, 0.2, 0.3), (0, 0.42, -0.32), 0.19, 0.2))
        for t in (0.2, 0.45, 0.7):
            z = 0.3 - 0.62 * t
            y = 0.2 + 0.22 * t + 0.195
            score((-0.13, y, z + 0.06), (0.13, y, z - 0.06))
        m.add(mirror(ellipsoid((0.13, 0.045, 0.5), (0.07, 0.045, 0.09))), k=0.02)
        m.add(mirror(ellipsoid((0.19, 0.045, -0.2), (0.07, 0.045, 0.11))), k=0.02)
        m.add(mirror(cone((0.12, 0.15, 0.3), (0.13, 0.06, 0.47), 0.055, 0.05)), k=0.03)
        m.add(mirror(cone((0.17, 0.3, -0.25), (0.19, 0.06, -0.22), 0.06, 0.05)), k=0.03)
        m.paint("secondary", moved(box((0, 0.5, 0), (1, 0.12, 1)), rot=euler(0.34, 0, 0), about=(0, 0.31, 0)))
        info = dict(head=((0, 0.34, 0.42), (0.08, 0, 0)), tail=((0, 0.55, -0.4), (-0.45, 0, 0)))
    else:
        # A boule, scored with a cross. It has transcended the tin.
        m.add(ellipsoid((0, 0.25, 0), (0.33, 0.25, 0.33)))
        score((-0.2, 0.47, 0), (0.2, 0.47, 0))
        score((0, 0.47, -0.2), (0, 0.47, 0.2))
        m.paint("secondary", ellipsoid((0, 0.5, 0), (0.3, 0.2, 0.3)))
        info = dict(head=((0, 0.6, 0.1), (0, 0, 0)), tail=((0, 0.14, -0.3), (-1.1, 0, 0)))
    return m, info


def build_body(b: Breed, pose: str) -> Part:
    if b.style == "bread":
        m, info = _bread_body(b, pose)
    else:
        m, info = _cat_body(b, pose)
        _paint_body(m, b, info)
    head_pos, head_rot = np.array(info["head"][0], dtype=float), euler(*info["head"][1])

    if b.style == "sphynx":
        # Neck rolls, and a pot belly it is not ashamed of.
        for i, r in enumerate((0.17, 0.19)):
            c = head_pos + head_rot @ np.array([0, -0.2 - 0.05 * i, -0.02])
            roll = torus(c, r, 0.03, rot=head_rot)
            m.add(roll, k=0.02)
            m.paint("secondary", grown(roll, 0.003))
        if info.get("belly"):
            m.add(ellipsoid((0, 0.2, 0.12), (0.2, 0.17, 0.2)), k=0.06)
    if b.mane:
        # Chest ruff under the head, so the mane never floats when the head moves.
        tufts = []
        for i in range(7):
            a = pi * (0.15 + 0.7 * i / 6)
            root = head_pos + head_rot @ np.array([0.16 * cos(a), -0.2, 0.0])
            tip = head_pos + head_rot @ np.array([0.3 * cos(a), -0.4 - 0.08 * sin(a), 0.1 + 0.16 * sin(a)])
            tufts.append(cone(root, tip, 0.1, 0.016))
        ruff = union(tufts, 0.02)
        m.add(ruff, k=0.03)
        m.paint("belly", grown(ruff, 0.006))
    if b.tufts and not b.mane:
        # A scruff of chest fur under the chin.
        tufts = []
        for x, length in ((-0.07, 0.1), (0.0, 0.15), (0.07, 0.1)):
            root = head_pos + head_rot @ np.array([x, -0.2, 0.09])
            tip = head_pos + head_rot @ np.array([x * 1.5, -0.2 - length, 0.19])
            tufts.append(cone(root, tip, 0.055, 0.012))
        scruff = union(tufts, 0.015)
        m.add(scruff, k=0.025)
        m.paint("belly", grown(scruff, 0.006))
    if b.style == "glitch":
        glitched(m)

    k = BODY_SCALE
    m.ops = [(scaled(prim, k), blend * k, is_cut) for prim, blend, is_cut in m.ops]
    m.zones = {zone: [scaled(prim, k) for prim in prims] for zone, prims in m.zones.items()}
    head_pos = head_pos * k
    part = Part(m)
    part.anchor("anchor_head", head_pos, head_rot)
    part.anchor("anchor_neck", head_pos + head_rot @ np.array([0, -0.2, -0.03]), head_rot, b.neck)
    part.anchor("anchor_tail", np.array(info["tail"][0]) * k, euler(*info["tail"][1]))
    return part


def _paint_body(m: Model, b: Breed, info):
    p = b.pattern
    belly = info.get("belly")
    socks = [ball(c, 0.105) for c in info["paws"]]
    if p == "tabby":
        if belly:
            m.paint("belly", belly)
        if info["axis"] == "y":
            for y in (0.17, 0.31, 0.45):
                m.paint("secondary", box((0, y + 0.05, -0.22), (1, 0.024, 0.2), rot=euler(0.3, 0, 0)))
        else:
            for z in (-0.24, -0.08, 0.08):
                m.paint("secondary", box((0, 0.5, z), (1, 0.3, 0.025)))
    elif p == "tuxedo":
        if belly:
            m.paint("belly", grown(belly, 0.03))
        for sock in socks:
            m.paint("secondary", sock)
    elif p == "calico":
        for i, c in enumerate(info["spots"]):
            m.paint("secondary" if i % 2 == 0 else "tertiary", ellipsoid(c, (0.19, 0.17, 0.2)))
    elif p == "points":
        if belly:
            m.paint("belly", belly)
        for c in info["paws"]:
            m.paint("secondary", ball(c, 0.14))
    elif p == "hairless":
        if belly:
            m.paint("belly", belly)
