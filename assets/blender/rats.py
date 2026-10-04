"""The rat kit: one head, two ears (and a bitten one), a tail, three posed bodies, the
waving arm, and the rat's own face parts, hats and props.

Shapes only, like the cats. The fur carries colour zones (see sdf.ZONES) and the
runtime picks the colours from the RatSpec:

    secondary  the patches of a patched rat (fur colour otherwise)
    tertiary   the hood of a hooded rat: shoulders and upper back (fur colour otherwise)
    belly      chest, belly, chin and the muzzle pads
    skin       nose, inner ears, hands, feet, tail

A hooded rat's head is drawn whole in the hood colour by the runtime, so the head
needs no hood zone of its own.
"""

from math import cos, pi, sin

import numpy as np

from cats import Part, frame, grown, surface
from parts import Piece, solid
from sdf import Model, ball, box, cone, ellipsoid, euler, extrude, lathe, mirror, moved, scaled, torus, tube

POSES = ("sit", "stand", "sniff", "wave")

# The runtime bends the tail as a chain of this many joints, this far apart.
TAIL_SEGMENTS = 10
TAIL_SEGMENT = 0.1
TAIL_LENGTH = TAIL_SEGMENTS * TAIL_SEGMENT

# Where the snout starts, along +Z in the head frame. The runtime stretches what lies in
# front of it to make a longer or shorter snout.
SNOUT_FROM = 0.1

MATERIALS = {
    "dark": "#1A1410",
    "white": "#FFFFFF",
    "tooth": "#FFF8E6",
    "tongue": "#E8607A",
    "fur": "#8E8A93",
    "iris": "#1A1410",
    "whisker": "#3A3036",
    "main": "#E8467C",
    "trim": "#F5C542",
    "gold": "#F2C14E",
    "gemRed": "#C8102E",
    "felt": "#1E1B22",
    "band": "#C8102E",
    "cloth": "#F7F4EE",
    "cheese": "#F5C542",
    "rind": "#E0A526",
    "crumb": "#C98B4A",
    "crumbIn": "#EBC58C",
    "steel": "#C7CDD6",
    "plaster": "#E9C9A0",
    "pad": "#F7E3CC",
    "blush": "#F0717F",
    "lens": "#15121A",
}


# --------------------------------------------------------------------------- head


def build_head() -> Part:
    m = Model()
    # Skull: rounder at the back, a forehead that slopes into the snout.
    m.add(ellipsoid((0, 0.0, -0.02), (0.2, 0.185, 0.2)))
    m.add(ellipsoid((0, 0.05, 0.06), (0.15, 0.13, 0.15)), k=0.06)
    # Puffy cheeks: rats store their whole personality there.
    m.add(mirror(ellipsoid((0.105, -0.07, 0.07), (0.11, 0.1, 0.12))), k=0.07)
    # The snout: a long round cone with a button of a nose.
    m.add(cone((0, -0.02, 0.1), (0, -0.065, 0.33), 0.115, 0.048), k=0.06)
    m.add(mirror(ellipsoid((0.036, -0.095, 0.29), (0.048, 0.04, 0.05))), k=0.03)
    m.add(ellipsoid((0, -0.125, 0.22), (0.065, 0.04, 0.07)), k=0.04)
    nose = (0, -0.052, 0.382)
    m.add(ellipsoid(nose, (0.042, 0.033, 0.03)), k=0.015)
    m.paint("skin", ellipsoid((0, -0.048, 0.395), (0.05, 0.04, 0.035)))
    # Pale chin and muzzle pads.
    m.paint("belly", ellipsoid((0, -0.15, 0.2), (0.14, 0.07, 0.2)))
    m.paint("belly", mirror(ellipsoid((0.04, -0.11, 0.305), (0.05, 0.035, 0.05))))
    # A patched rat's patch: round one eye and up to the ear.
    m.paint("secondary", ellipsoid((0.11, 0.09, 0.08), (0.11, 0.11, 0.14), rot=euler(0, 0, -0.4)))

    part = Part(m)
    far = 0.8
    for side, name in ((-1, "L"), (1, "R")):
        # Eyes high on the sides of the snout's root, looking a little outward.
        eye = surface(m, (side * 0.088, 0.065, far), (0, 0, -1))
        n = m.gradient(np.array([eye], dtype=np.float32))[0]
        # Mostly forward: cartoon eyes look at whoever is looking at the rat.
        facing = n / np.linalg.norm(n) * 0.25 + np.array([0, 0, 0.75])
        # Set a little proud of the skull, so the whole white shows and the pupil sits in its middle.
        eye = eye + n / np.linalg.norm(n) * 0.014
        part.anchor(f"anchor_eye_{name}", eye, frame(facing))
        # Ears on the top corners of the skull, tipped outward.
        a = 0.62
        ear = surface(m, (side * sin(a) * far, cos(a) * far, -0.05), (-side * sin(a), -cos(a), 0))
        ear -= np.array([side * sin(a), cos(a), 0]) * 0.03
        part.anchor(f"anchor_ear_{name}", ear, euler(-0.2, side * 0.35, -side * 0.55))
        whisker = surface(m, (side * 0.042, -0.07, far), (0, 0, -1))
        part.anchor(f"anchor_whisker_{name}", whisker - np.array([0, 0, 0.012]), euler(0, side * 0.35, 0))
        cheek = surface(m, (side * 0.13, -0.06, far), (0, 0, -1))
        part.anchor(f"anchor_cheek_{name}", cheek, frame((side * 0.5, 0, 1)))
    # The mouth sits under the nose, at the front of the chin.
    mouth = surface(m, (0, -0.118, far), (0, 0, -1))
    part.anchor("anchor_mouth", mouth, frame((0, -0.3, 1)))
    part.anchor("anchor_nose", surface(m, (0, -0.05, far), (0, 0, -1)))
    top = surface(m, (0, far, -0.04), (0, -1, 0))
    part.anchor("anchor_hat", top)
    eye_z = part.anchors["anchor_eye_L"][0][2]
    part.anchor("anchor_face", (0, 0.04, eye_z))
    return part


def build_ear(side: int, nicked=False) -> Part:
    """A round dish, pink inside, on a short stalk. Origin at its base."""
    m = Model()
    m.add(ellipsoid((0, 0.115, 0), (0.125, 0.12, 0.034)))
    m.add(cone((0, -0.02, -0.01), (0, 0.06, 0), 0.05, 0.06), k=0.03)
    inner = ellipsoid((0, 0.12, 0.042), (0.09, 0.088, 0.03))
    m.cut(inner, k=0.018)
    m.paint("skin", grown(inner, 0.01))
    if nicked:
        # An old bite from the rim, on the outer side.
        bite = ball((side * 0.115, 0.2, 0), 0.042)
        m.cut(bite, k=0.008)
        m.cut(ball((side * 0.135, 0.15, 0), 0.026), k=0.008)
    return Part(m)


# --------------------------------------------------------------------------- tail


def build_tail() -> Part:
    """Straight along +Y from the origin, fur at the root, then bare and tapering."""
    m = Model()
    n = 21
    ts = np.linspace(0, 1, n)
    radii = 0.048 * (1 - ts) ** 0.9 + 0.011
    # One long round cone per stretch: a tube of short ones ripples where they meet.
    m.add(cone((0, 0, 0), (0, TAIL_LENGTH * 0.5, 0), radii[0], radii[10]))
    m.add(cone((0, TAIL_LENGTH * 0.5, 0), (0, TAIL_LENGTH, 0), radii[10], radii[-1]), k=0.0)
    m.paint("skin", box((0, TAIL_LENGTH / 2 + 0.09, 0), (1, TAIL_LENGTH / 2, 1)))
    return Part(m)


# --------------------------------------------------------------------------- bodies


def _feet(m, at, toward=(0, 0, 1)):
    """A long pink hind foot with three toes. `at` is the heel on the floor."""
    x, y, z = at
    m.add(mirror(ellipsoid((x, 0.032, z + 0.08), (0.06, 0.032, 0.13))), k=0.02)
    for i in (-1, 0, 1):
        m.add(mirror(ellipsoid((x + i * 0.033, 0.026, z + 0.205 - abs(i) * 0.02), (0.022, 0.022, 0.032))), k=0.012)
    m.paint("skin", mirror(ellipsoid((x, 0.03, z + 0.12), (0.085, 0.06, 0.16))))


def _hands(m, shoulder, hand, r=0.036):
    """An arm from the shoulder, out to the elbow and back in to a small pink hand with fingers."""
    elbow = (shoulder[0] + 0.045, (shoulder[1] + hand[1]) / 2 - 0.07, (shoulder[2] + hand[2]) / 2 - 0.02)
    m.add(mirror(tube([shoulder, elbow, hand], [r * 1.3, r * 1.15, r], k=0.02)), k=0.02)
    m.add(mirror(ellipsoid(hand, (0.044, 0.038, 0.04))), k=0.012)
    hx, hy, hz = hand
    for i in (-1, 0, 1):
        m.add(mirror(ellipsoid((hx - 0.012 + i * 0.016, hy - 0.026, hz + 0.022), (0.012, 0.018, 0.012))), k=0.006)
    m.paint("skin", mirror(ellipsoid((hx, hy - 0.006, hz + 0.004), (0.05, 0.046, 0.05))))


def build_body(pose: str) -> Part:
    m = Model()
    if pose in ("sit", "stand", "wave"):
        tall = 1.0 if pose == "sit" else 1.16
        lift = 0.0 if pose == "sit" else 0.06
        # A pear: wide round hips, a narrower chest.
        m.add(ellipsoid((0, 0.24 * tall + lift * 0.5, -0.03), (0.27, 0.25 * tall, 0.25)))
        m.add(ellipsoid((0, 0.47 * tall + lift, 0.0), (0.18, 0.22 * tall, 0.17)), k=0.1)
        # Haunches and thighs.
        m.add(mirror(ellipsoid((0.18, 0.15 + lift * 0.4, -0.02), (0.12, 0.15 + lift * 0.4, 0.17))), k=0.05)
        _feet(m, (0.15, 0, 0.0 if pose == "sit" else 0.02))
        shoulder = (0.15, 0.55 * tall + lift, 0.08)
        hand = (0.075, 0.45 * tall + lift, 0.29)
        if pose == "wave":
            # Only the left arm: the right one is its own part, so it can wave.
            elbow = (-shoulder[0] - 0.045, (shoulder[1] + hand[1]) / 2 - 0.07, (shoulder[2] + hand[2]) / 2 - 0.02)
            m.add(tube([(-shoulder[0], shoulder[1], shoulder[2]), elbow, (-hand[0], hand[1], hand[2])], [0.047, 0.041, 0.036], k=0.02), k=0.02)
            m.add(ellipsoid((-hand[0], hand[1], hand[2]), (0.044, 0.038, 0.04)), k=0.012)
            m.paint("skin", ellipsoid((-hand[0], hand[1] - 0.006, hand[2] + 0.004), (0.05, 0.046, 0.05)))
        else:
            _hands(m, shoulder, hand)
        head = ((0, 0.69 * tall + lift, 0.05), (0, 0, 0))
        tail = ((0, 0.07, -0.25), (-pi / 2 + 0.05, 0, 0))
        belly = ellipsoid((0, 0.33 * tall + lift * 0.6, 0.17), (0.17, 0.27 * tall, 0.12))
        hood = [ellipsoid((0, 0.56 * tall + lift, 0.0), (0.36, 0.2, 0.34)), ellipsoid((0, 0.36 * tall, -0.2), (0.09, 0.3 * tall, 0.12))]
        spots = [((0.18, 0.4, -0.15), 0.12), ((-0.2, 0.22, -0.12), 0.1), ((0.05, 0.16, -0.26), 0.09), ((0.24, 0.22, 0.04), 0.09)]
        hands = ((0, hand[1] + 0.01, hand[2] + 0.035), (0, 0, 0))
        arm = (shoulder, hand)
    else:  # sniff: on all fours, nose first
        m.add(tube([(0, 0.22, -0.24), (0, 0.27, -0.04), (0, 0.29, 0.14)], [0.24, 0.24, 0.17], k=0.1))
        m.add(mirror(ellipsoid((0.17, 0.16, -0.2), (0.12, 0.15, 0.16))), k=0.05)
        _feet(m, (0.15, 0, -0.18))
        # Front legs straight down to small hands on the floor.
        for side in (-1, 1):
            m.add(cone((side * 0.1, 0.27, 0.19), (side * 0.09, 0.05, 0.27), 0.045, 0.035), k=0.035)
            m.add(ellipsoid((side * 0.09, 0.026, 0.3), (0.042, 0.026, 0.048)), k=0.015)
            for i in (-1, 0, 1):
                m.add(ellipsoid((side * 0.09 + i * 0.018, 0.016, 0.345), (0.012, 0.014, 0.016)), k=0.006)
        m.paint("skin", mirror(ellipsoid((0.09, 0.03, 0.31), (0.055, 0.045, 0.06))))
        head = ((0, 0.5, 0.3), (0.12, 0, 0))
        tail = ((0, 0.2, -0.43), (-pi / 2 - 0.1, 0, 0))
        belly = ellipsoid((0, 0.15, 0.05), (0.15, 0.1, 0.26))
        hood = [ellipsoid((0, 0.42, 0.14), (0.34, 0.2, 0.3)), ellipsoid((0, 0.45, -0.2), (0.09, 0.1, 0.3))]
        spots = [((0.17, 0.38, -0.18), 0.12), ((-0.19, 0.3, 0.0), 0.1), ((0.04, 0.45, -0.32), 0.09), ((0.22, 0.25, 0.05), 0.09)]
        hands = ((0, 0.03, 0.4), (0, 0, 0))
        arm = None

    m.paint("belly", belly)
    for prim in hood:  # head and shoulders, and a stripe down the back
        m.paint("tertiary", prim)
    for c, r in spots:
        m.paint("secondary", ellipsoid(c, (r * 1.3, r, r * 1.2)))

    part = Part(m)
    head_pos, head_rot = np.array(head[0], dtype=float), euler(*head[1])
    part.anchor("anchor_head", head_pos, head_rot)
    # Wide enough for the bandana to sit on the shoulders, not sink into them.
    part.anchor("anchor_neck", head_pos + head_rot @ np.array([0, -0.15, 0.0]), head_rot, 1.25)
    part.anchor("anchor_tail", tail[0], euler(*tail[1]))
    part.anchor("anchor_hands", hands[0], euler(*hands[1]))
    if pose == "wave":
        part.anchor("anchor_arm", arm[0])
    return part


def build_arm() -> Part:
    """The waving arm, raised. Origin at the shoulder."""
    m = Model()
    hand = (0.17, 0.2, 0.07)
    m.add(tube([(0, 0, 0), (0.12, 0.05, 0.05), hand], [0.047, 0.041, 0.036], k=0.02))
    m.add(ellipsoid(hand, (0.038, 0.042, 0.032)), k=0.015)
    for i in (-1, 0, 1):
        m.add(ellipsoid((hand[0] + i * 0.017, hand[1] + 0.04, hand[2] + 0.004), (0.012, 0.02, 0.012)), k=0.006)
    m.add(ellipsoid((hand[0] + 0.04, hand[1] + 0.005, hand[2]), (0.018, 0.012, 0.012)), k=0.006)
    m.paint("skin", ellipsoid((hand[0], hand[1] + 0.01, hand[2]), (0.06, 0.06, 0.05)))
    return Part(m)


# --------------------------------------------------------------------------- face parts, hats, props


def face_parts():
    """Modelled in the frame of their anchor: origin on the fur, +Z out of the face."""
    parts = {}
    # Beady eyes: a glossy black bead with two glints.
    parts["eye_bead"] = [
        Piece("iris", solid(ellipsoid((0, 0, 0.002), (0.034, 0.04, 0.024))), 0.0016, outline=False, flat=True),
    ]
    parts["eye_bead_glint"] = [
        Piece("white", solid(ellipsoid((-0.011, 0.015, 0.024), (0.011, 0.012, 0.006)), ellipsoid((0.012, -0.012, 0.022), (0.005, 0.005, 0.004))), 0.001, outline=False, flat=True),
    ]
    # Cartoon eyes: a white ball, a big pupil, glints.
    parts["eye_ball"] = [Piece("white", solid(ellipsoid((0, 0.004, -0.01), (0.056, 0.064, 0.044))), 0.0025, flat=True)]
    parts["eye_pupil"] = [Piece("iris", solid(ellipsoid((0, 0, 0.026), (0.03, 0.036, 0.014))), 0.0014, outline=False, flat=True)]
    parts["eye_glint"] = [
        Piece("white", solid(ellipsoid((-0.012, 0.016, 0.04), (0.01, 0.011, 0.006)), ellipsoid((0.011, -0.012, 0.04), (0.006, 0.006, 0.004))), 0.001, outline=False, flat=True),
    ]
    lid = Model().add(ellipsoid((0, 0.004, -0.004), (0.064, 0.072, 0.046)))
    lid.cut(box((0, -0.3, 0), (0.4, 0.3, 0.4)), k=0.01)
    parts["eye_lid"] = [Piece("fur", lid, 0.0025)]

    # Sunglasses: two round black lenses on a bridge, arms back to the ears.
    lens = lambda s: ellipsoid((s * 0.085, 0, 0.045), (0.062, 0.05, 0.016))
    frame_ = Model().add(lens(-1)).add(lens(1), k=0.0)
    frame_.add(tube([(-0.03, 0.012, 0.055), (0, 0.022, 0.06), (0.03, 0.012, 0.055)], 0.009), k=0.008)
    for s in (-1, 1):
        frame_.add(tube([(s * 0.14, 0.01, 0.04), (s * 0.17, 0.02, -0.04), (s * 0.18, 0.03, -0.13)], 0.008), k=0.008)
    shine = solid(*[ellipsoid((s * 0.085 - 0.022, 0.018, 0.06), (0.014, 0.008, 0.004), rot=euler(0, 0, 0.5)) for s in (-1, 1)])
    parts["shades"] = [Piece("lens", frame_, 0.004, flat=True), Piece("white", shine, 0.0025, outline=False, flat=True, opacity=0.7)]

    # Mouth frame: origin under the nose on the chin, +Z forward, +Y up.
    tooth = lambda s: box((s * 0.0155, -0.03, 0.006), (0.0145, 0.03, 0.007), r=0.006)
    parts["teeth"] = [Piece("tooth", solid(tooth(-1), tooth(1), k=0.0), 0.0022, outline=True)]
    parts["tooth_gap"] = [Piece("dark", solid(box((0, -0.03, 0.012), (0.0015, 0.028, 0.004))), 0.0018, outline=False, flat=True)]

    def line(points, r=0.007):
        return Piece("dark", solid(tube([(x, y, 0.004 - 2.2 * x * x) for x, y in points], r)), 0.0025, outline=False, flat=True)

    parts["mouth_grin"] = [line([(-0.065, 0.02), (-0.045, -0.006), (-0.02, -0.012), (0.0, -0.004), (0.02, -0.012), (0.045, -0.006), (0.065, 0.02)])]
    parts["mouth_smug"] = [line([(-0.05, -0.004), (-0.02, -0.01), (0.015, -0.006), (0.045, 0.008), (0.062, 0.028)])]
    maw = solid(ellipsoid((0, -0.035, 0.0), (0.04, 0.05, 0.02)))
    parts["mouth_shock"] = [
        Piece("dark", maw, 0.003, outline=False, flat=True),
        Piece("tongue", solid(ellipsoid((0, -0.06, 0.008), (0.024, 0.018, 0.012))), 0.003, outline=False, flat=True),
    ]
    tongue = Model().add(ellipsoid((0.012, -0.075, 0.03), (0.026, 0.04, 0.012), rot=euler(0.5, 0, 0.25)))
    tongue.cut(box((0.012, -0.09, 0.05), (0.0015, 0.03, 0.02), rot=euler(0.5, 0, 0.25)), k=0.004)
    parts["tongue"] = [Piece("tongue", tongue, 0.003)]

    for side, name in ((-1, "L"), (1, "R")):
        hairs = [cone((0, 0, -0.01), (side * 0.22, 0.055 * i + 0.012, 0.03 - 0.02 * abs(i)), 0.0055, 0.0032) for i in (-1, 0, 1)]
        dots = [ellipsoid((side * (0.012 + 0.016 * (i % 2)), 0.014 * i, 0.003), (0.0055, 0.0055, 0.004)) for i in (-1, 0, 1)]
        parts[f"whiskers_{name}"] = [
            Piece("whisker", solid(*hairs), 0.0016, outline=False, flat=True),
            Piece("dark", solid(*dots), 0.002, outline=False, flat=True),
        ]
    parts["blush"] = [Piece("blush", solid(ellipsoid((0, 0, 0.004), (0.04, 0.024, 0.012))), 0.004, outline=False, flat=True, opacity=0.55)]
    # A sticking plaster across the bitten ear, in the ear's frame.
    plaster = solid(box((0, 0, 0), (0.06, 0.018, 0.006), r=0.005))
    pores = solid(*[ellipsoid((x, y, 0.006), (0.0035, 0.0035, 0.002)) for x in (-0.012, 0.0, 0.012) for y in (-0.006, 0.006)])
    parts["plaster"] = _placed([Piece("plaster", plaster, 0.003), Piece("pad", solid(box((0, 0, 0.003), (0.02, 0.016, 0.005), r=0.004)), 0.0025, outline=False)] + [Piece("crumbIn", pores, 0.0018, outline=False)], (0.05, 0.17, 0.035), euler(0, 0, -0.6))
    return parts


def _placed(pieces, offset=(0, 0, 0), rot=None):
    for piece in pieces:
        piece.model.ops = [(moved(prim, offset, rot), k, is_cut) for prim, k, is_cut in piece.model.ops]
    return pieces


def hats():
    """Worn on the hat anchor: origin on top of the skull, +Y up."""
    h = {}
    # Party hat: a striped cone at an angle, with a pompom.
    cone_ = solid(lathe((0, 0, 0), [(0, -0.02), (0.085, -0.02), (0.09, -0.006), (0.008, 0.23), (0, 0.235)], r=0.004))
    slope = lambda y: 0.09 - 0.082 * (y + 0.006) / 0.236
    spots = solid(*[ellipsoid((slope(y) * sin(a), y, slope(y) * cos(a)), (0.019, 0.019, 0.007), rot=euler(-0.34, a, 0)) for a, y in ((0.4, 0.04), (2.3, 0.07), (4.2, 0.035), (1.3, 0.12), (5.4, 0.11), (3.3, 0.15))])
    pompom = Model().add(ball((0, 0.25, 0), 0.03))
    for i in range(8):
        a, b = i * 2.4, (i % 4) * 0.7 - 1.0
        pompom.add(ball((0.026 * cos(a) * cos(b), 0.25 + 0.026 * sin(b), 0.026 * sin(a) * cos(b)), 0.014), k=0.004)
    h["party"] = _placed([Piece("main", cone_, 0.004), Piece("trim", spots, 0.003, outline=False), Piece("trim", pompom, 0.004)], (0.04, -0.012, 0), euler(0, 0, -0.3))

    # Beanie: a knitted dome with a turned-up rim and a bobble.
    dome = Model().add(ellipsoid((0, 0.0, 0), (0.165, 0.14, 0.165)))
    dome.cut(box((0, -0.2, 0), (0.4, 0.2, 0.4)), k=0.01)
    for i in range(12):
        a = i * 2 * pi / 12
        dome.cut(cone((0.168 * sin(a), 0.01, 0.168 * cos(a)), (0.06 * sin(a), 0.15, 0.06 * cos(a)), 0.006), k=0.006)
    rim = solid(torus((0, 0.012, 0), 0.158, 0.03))
    bobble = Model().add(ball((0, 0.17, 0), 0.04))
    for i in range(10):
        a, b = i * 2.4, (i % 5) * 0.6 - 1.2
        bobble.add(ball((0.035 * cos(a) * cos(b), 0.17 + 0.035 * sin(b), 0.035 * sin(a) * cos(b)), 0.017), k=0.004)
    h["beanie"] = _placed([Piece("main", dome, 0.005), Piece("cloth", rim, 0.005), Piece("cloth", bobble, 0.004)], (0, -0.05, -0.01), euler(-0.15, 0, 0.08))

    # Crown: a little too big, slipping over one ear.
    r = 0.1
    crown = Model().add(lathe((0, 0, 0), [(r - 0.01, 0.0), (r + 0.008, 0.0), (r + 0.012, 0.06), (r - 0.01, 0.06)], r=0.004))
    for i in range(5):
        a = i * 2 * pi / 5 + pi / 2
        crown.add(cone((r * cos(a), 0.04, r * sin(a)), (r * 1.1 * cos(a), 0.14, r * 1.1 * sin(a)), 0.028, 0.007), k=0.005)
        crown.add(ball((r * 1.11 * cos(a), 0.152, r * 1.11 * sin(a)), 0.017), k=0.002)
    gems = solid(*[ellipsoid(((r + 0.012) * cos(a), 0.032, (r + 0.012) * sin(a)), (0.016, 0.02, 0.016)) for a in (i * 2 * pi / 5 + pi / 2 for i in range(5))])
    h["crown"] = _placed([Piece("gold", crown, 0.004), Piece("gemRed", gems, 0.003, outline=False)], (-0.03, -0.015, 0), euler(0.05, 0, 0.25))

    # Top hat: tall, a red band, a jaunty tilt.
    felt = solid(lathe((0, 0, 0), [(0, -0.012), (0.15, -0.012), (0.155, 0.004), (0.15, 0.012), (0.085, 0.012), (0.09, 0.19), (0, 0.19)], r=0.005))
    band = solid(lathe((0, 0, 0), [(0.084, 0.02), (0.092, 0.02), (0.093, 0.055), (0.085, 0.055)], r=0.003))
    h["tophat"] = _placed([Piece("felt", felt, 0.0045), Piece("band", band, 0.003, outline=False)], (0.01, -0.02, 0), euler(-0.1, 0, -0.18))

    # Chef's hat: a band and a puffed-up mushroom of cloth.
    chef = Model().add(lathe((0, 0, 0), [(0, 0.0), (0.105, 0.0), (0.11, 0.07), (0, 0.07)], r=0.006))
    for i in range(6):
        a = i * 2 * pi / 6
        chef.add(ball((0.075 * sin(a), 0.15, 0.075 * cos(a)), 0.068), k=0.02)
    chef.add(ball((0, 0.19, 0), 0.08), k=0.02)
    h["chef"] = _placed([Piece("cloth", chef, 0.005)], (0, -0.04, 0), euler(-0.08, 0, 0.1))
    return {f"hat_{k}": v for k, v in h.items()}


def props():
    """Held at the hands anchor: origin between the paws, +Z forward."""
    p = {}
    # Cheese: a wedge with holes right through the sides.
    wedge = Model().add(extrude((0, 0, 0), [(-0.12, -0.055), (0.12, -0.055), (0.12, 0.055)], 0.05, r=0.008))
    holes = [ball((0.06, -0.02, 0.06), 0.022), ball((-0.04, -0.03, 0.055), 0.016), ball((0.09, 0.03, -0.06), 0.018), ball((0.02, -0.035, -0.06), 0.02)]
    for hole in holes:
        wedge.cut(hole, k=0.006)
    rind = Model().add(box((0.125, 0.0, 0), (0.008, 0.06, 0.055), r=0.006))
    p["prop_cheese"] = _placed([Piece("cheese", wedge, 0.004), Piece("rind", rind, 0.003, outline=False)], (0, 0.03, 0.03), euler(0.2, -0.5, 0.15))

    # Crumb: a crusty chunk of bread, soft inside where it was bitten.
    crumb = Model().add(ellipsoid((0, 0, 0), (0.07, 0.05, 0.055)))
    crumb.add(ellipsoid((0.03, 0.02, 0.01), (0.04, 0.035, 0.04)), k=0.02)
    bite = ball((-0.06, 0.03, 0.03), 0.04)
    crumb.cut(bite, k=0.01)
    p["prop_crumb"] = _placed([Piece("crumb", crumb, 0.004)], (0, 0.03, 0.04), euler(0.3, 0.4, 0.1))

    # Fork: bigger than the rat would like. Held upright like a trident.
    steel = Model().add(cone((0, -0.22, 0), (0, 0.1, 0), 0.011, 0.011))
    steel.add(box((0, 0.12, 0), (0.035, 0.014, 0.008), r=0.006), k=0.01)
    for i in (-1, 0, 1):
        steel.add(cone((i * 0.024, 0.12, 0), (i * 0.024, 0.22, 0), 0.0065, 0.004), k=0.004)
    p["prop_fork"] = _placed([Piece("steel", steel, 0.003)], (0.1, -0.03, 0.02), euler(0.15, 0, -0.5))

    # Bandana: folded band round the neck, a triangle down the chest, a knot at the back.
    ring = 0.145
    strap = lathe((0, 0, 0), [(ring - 0.006, -0.02), (ring + 0.012, -0.02), (ring + 0.012, 0.02), (ring - 0.006, 0.02)], r=0.006)
    scarf = Model().add(strap)
    scarf.add(moved(extrude((0, 0, 0), [(-0.12, 0), (0.12, 0), (0, -0.17)], 0.004, r=0.009), (0, 0.004, ring + 0.012), euler(-0.24, 0, 0)), k=0.005)
    scarf.add(ball((0.04, 0, -ring - 0.02), 0.03), k=0.008)
    scarf.add(cone((0.04, 0, -ring - 0.03), (0.08, -0.07, -ring - 0.06), 0.022, 0.009), k=0.008)
    scarf.add(cone((0.04, 0, -ring - 0.03), (0.01, -0.08, -ring - 0.05), 0.022, 0.009), k=0.008)
    dots = [moved(ellipsoid((x, y, 0.013), (0.012, 0.012, 0.006)), (0, 0.004, ring + 0.012), euler(-0.24, 0, 0)) for x, y in ((-0.055, -0.03), (0.0, -0.035), (0.055, -0.03), (-0.027, -0.075), (0.027, -0.075), (0, -0.115))]
    p["bandana"] = [Piece("main", scarf, 0.005), Piece("white", solid(*dots), 0.0025, outline=False)]
    return p


def kit_groups():
    return {**face_parts(), **hats(), **props()}
