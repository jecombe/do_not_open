"""The shared kit: face parts and accessories.

Face parts are modelled in the frame of their anchor: origin on the fur, +Z pointing
out of the face. Accessories are modelled in the frame of theirs (neck, face, eye,
hat), sized for the reference head, and scaled by the anchor on each breed.

A part is a list of pieces, one per material. The runtime picks the colour from the
material name; `flat` pieces are unlit, `outline` pieces get the inverted hull.
"""

from math import cos, pi, sin

import numpy as np

from cats import grown
from sdf import Model, ball, box, cone, ellipsoid, euler, extrude, lathe, mirror, moved, scaled, torus, tube

# Material name -> default colour. "main" is replaced by the accessory colour of the
# CatSpec, "fur", "iris" and "whisker" by the cat's own colours.
MATERIALS = {
    "dark": "#1A1410",
    "white": "#FFFFFF",
    "tongue": "#E8707A",
    "fur": "#9A7B5B",
    "iris": "#8FB339",
    "whisker": "#F4EFE6",
    "main": "#C2261D",
    "brass": "#E8B931",
    "trim": "#F2E85C",
    "gemRed": "#C2261D",
    "gemBlue": "#2B6CB0",
    "velvet": "#8B1A2B",
    "glass": "#CFE8F0",
    "wire": "#5A5048",
    "paper": "#DDE3BC",
    "filter": "#C9A878",
    "herb": "#5F8F3A",
    "ash": "#9A968E",
    "ember": "#FF7A1A",
    "smoke": "#DDEBD6",
    "spill": "#7A1F2B",
    "cork": "#C9A06A",
    "blush": "#F0717F",
    "bottle": "#2E7D4F",
    "label": "#E9DFC8",
    "bubble": "#CFE8F0",
}


DETAIL = 1.8


class Piece:
    def __init__(self, material, model, voxel=0.006, outline=True, flat=False, opacity=1.0):
        # Voxel sizes below are relative; one knob trades triangles for crispness across the kit.
        self.material, self.model, self.voxel = material, model, voxel * DETAIL
        self.outline, self.flat, self.opacity = outline, flat, opacity


def solid(*prims, k=0.0):
    m = Model()
    for p in prims:
        m.add(p, k=k)
    return m


def _bent(points, depth=0.0, curve=1.2):
    """Wraps a flat mouth line around the muzzle."""
    return [(x, y, depth - curve * x * x) for x, y in points]


def face_parts():
    parts = {}

    ball_ = solid(ellipsoid((0, 0, -0.01), (0.085, 0.095, 0.045)))
    parts["eye_ball"] = [Piece("white", ball_, 0.006, flat=True)]
    parts["eye_iris"] = [Piece("iris", solid(ellipsoid((0, 0, 0.012), (0.06, 0.07, 0.03))), 0.005, outline=False, flat=True)]
    parts["eye_pupil"] = [Piece("dark", solid(ellipsoid((0, 0, 0.03), (0.036, 0.042, 0.02))), 0.004, outline=False, flat=True)]
    glint = solid(ellipsoid((-0.026, 0.034, 0.045), (0.017, 0.017, 0.012)), ellipsoid((0.022, -0.024, 0.049), (0.011, 0.011, 0.008)))
    parts["eye_glint"] = [Piece("white", glint, 0.003, outline=False, flat=True)]

    lid = Model().add(ellipsoid((0, 0, -0.012), (0.098, 0.108, 0.064)))
    lid.cut(box((0, -0.3, 0), (0.4, 0.3, 0.4)), k=0.012)
    parts["eye_lid"] = [Piece("fur", lid, 0.006)]

    arc = [(0.068 * cos(a), 0.05 * sin(a) - 0.02, 0.014 - 0.02 * cos(a) ** 2) for a in (pi * i / 8 for i in range(9))]
    parts["eye_arc"] = [Piece("dark", solid(tube(arc, 0.015)), 0.004, outline=False, flat=True)]
    parts["brow"] = [Piece("dark", solid(cone((-0.075, 0, 0.012), (0.075, 0, 0.012), 0.019, 0.019)), 0.005, outline=False, flat=True)]

    def line(points, r=0.012, **kw):
        return Piece("dark", solid(tube(_bent(points, 0.004, **kw), r)), 0.003, outline=False, flat=True)

    fang = lambda x, y: cone((x, y, 0.012), (x * 0.92, y - 0.042, 0.014), 0.014, 0.005)
    parts["mouth_neutral"] = [line([(-0.05, 0.004), (-0.028, -0.016), (0, 0.004), (0.028, -0.016), (0.05, 0.004)], 0.009)]
    parts["mouth_smile"] = [line([(-0.09, 0.03), (-0.07, -0.015), (-0.035, -0.032), (0, 0.004), (0.035, -0.032), (0.07, -0.015), (0.09, 0.03)])]
    parts["mouth_frown"] = [line([(-0.088, -0.055), (-0.06, -0.018), (0, 0), (0.06, -0.018), (0.088, -0.055)], 0.012)]
    parts["mouth_smirk"] = [
        line([(-0.06, -0.016), (-0.02, -0.014), (0.04, -0.004), (0.082, 0.028), (0.095, 0.05)]),
        Piece("white", solid(fang(-0.034, -0.016)), 0.003, outline=False, flat=True),
    ]
    maw = solid(ellipsoid((0, -0.04, -0.004), (0.066, 0.06, 0.024)))
    parts["mouth_open"] = [
        Piece("dark", maw, 0.004, outline=False, flat=True),
        Piece("tongue", solid(ellipsoid((0, -0.066, 0.008), (0.038, 0.027, 0.018))), 0.004, outline=False, flat=True),
        Piece("white", solid(fang(-0.032, -0.004), fang(0.032, -0.004)), 0.003, outline=False, flat=True),
    ]

    for side, name in ((-1, "L"), (1, "R")):
        hairs = [cone((0, 0, -0.01), (side * 0.27, 0.075 * i + 0.01, 0.025), 0.009, 0.006) for i in (-1, 0, 1)]
        freckles = [ellipsoid((-side * 0.035 + side * 0.022 * (i % 2), 0.018 * i, 0.004), (0.0075, 0.0075, 0.006)) for i in (-1, 0, 1)]
        parts[f"whiskers_{name}"] = [
            Piece("whisker", solid(*hairs), 0.004, outline=False, flat=True),
            Piece("dark", solid(*freckles), 0.0022, outline=False, flat=True),
        ]
    return parts


def _placed(pieces, offset=(0, 0, 0), rot=None):
    """Applies one rigid transform to every solid of every piece."""
    for piece in pieces:
        piece.model.ops = [(moved(prim, offset, rot), k, is_cut) for prim, k, is_cut in piece.model.ops]
    return pieces


def accessories():
    acc = {}
    ring = 0.19  # collar radius on the reference neck

    # Bell collar: a proper strap with studs, and a bell a little too big for it.
    strap = lambda inner, outer, h: lathe((0, 0, 0), [(ring + inner, -h), (ring + outer, -h), (ring + outer, h), (ring + inner, h)], r=0.006)
    bell = Model().add(ball((0, -0.085, ring + 0.035), 0.07))
    bell.add(torus((0, -0.085, ring + 0.035), 0.07, 0.008), k=0.004)
    bell.add(torus((0, -0.015, ring + 0.03), 0.018, 0.007, rot=euler(0, 0, pi / 2)), k=0.0)
    bell.cut(box((0, -0.135, ring + 0.06), (0.009, 0.035, 0.08), r=0.004), k=0.004)
    bell.cut(ball((0, -0.105, ring + 0.1), 0.017), k=0.004)
    studs = [ellipsoid(((ring + 0.016) * sin(a), 0, (ring + 0.016) * cos(a)), (0.014, 0.014, 0.014)) for a in (i * 2 * pi / 10 for i in range(1, 10))]
    acc["bellCollar"] = [
        Piece("main", solid(strap(-0.008, 0.012, 0.03)), 0.006),
        Piece("brass", bell, 0.005),
        Piece("brass", solid(*studs), 0.004, outline=False),
    ]

    # Bow tie: oversized and not quite straight.
    wing = lambda side: scaled(cone((side * 0.03, 0, 0), (side * 0.17, 0, 0), 0.03, 0.085), (1, 1, 0.42))
    bow = Model().add(wing(-1)).add(wing(1), k=0.0).add(ellipsoid((0, 0, 0.012), (0.042, 0.05, 0.04)), k=0.012)
    for side in (-1, 1):
        bow.cut(scaled(cone((side * 0.09, 0, 0.05), (side * 0.2, 0, 0.05), 0.006, 0.03), (1, 1, 0.5), (0, 0, 0.05)), k=0.01)
    bow.ops = [(moved(prim, (0, -0.03, ring + 0.035), euler(0, 0, 0.16)), k, c) for prim, k, c in bow.ops]
    acc["bowTie"] = [Piece("main", solid(torus((0, 0, 0), ring, 0.016)), 0.007, outline=False), Piece("main", bow, 0.006)]

    # Bandana: folded band, a flat triangle down the chest, a knot at the back.
    on_chest = lambda prim: moved(prim, (0, 0.005, ring + 0.016), euler(-0.24, 0, 0))
    scarf = Model().add(strap(-0.008, 0.014, 0.024))
    scarf.add(on_chest(extrude((0, 0, 0), [(-0.175, 0), (0.175, 0), (0, -0.25)], 0.005, r=0.011)), k=0.006)
    scarf.add(ball((0.05, 0, -ring - 0.03), 0.04), k=0.01)
    scarf.add(cone((0.05, 0, -ring - 0.04), (0.17, -0.06, -ring - 0.1), 0.03, 0.012), k=0.01)
    scarf.add(cone((0.05, 0, -ring - 0.04), (0.0, -0.11, -ring - 0.11), 0.03, 0.012), k=0.01)
    dots = [on_chest(ellipsoid((x, y, 0.014), (0.018, 0.018, 0.008))) for x, y in ((-0.085, -0.04), (0.0, -0.045), (0.085, -0.04), (-0.042, -0.1), (0.042, -0.1), (0, -0.16))]
    acc["bandana"] = [Piece("main", scarf, 0.008), Piece("white", solid(*dots), 0.003, outline=False)]

    # Sunglasses: eight-bit shades that slid into place on their own.
    z = 0.07
    px = 0.03
    shades = Model()
    shades.add(box((0, 0.045, z), (0.27, px / 2, 0.014), r=0.004), k=0.0)
    for side in (-1, 1):
        for row, (x0, x1) in enumerate(((0.03, 0.24), (0.03, 0.24), (0.06, 0.21), (0.09, 0.18))):
            c = side * (x0 + x1) / 2
            shades.add(box((c, 0.045 - px * (row + 0.5), z), ((x1 - x0) / 2, px / 2 + 0.002, 0.014), r=0.004), k=0.0)
        shades.add(box((side * 0.262, 0.045, z - 0.15), (0.012, px / 2, 0.16), r=0.004), k=0.0)
    shine = [box((side * 0.135 + dx - 0.04, 0.02 - dy, z + 0.013), (0.014, 0.014, 0.006), r=0.002) for side in (-1, 1) for dx, dy in ((0, 0.03), (0.03, 0))]
    acc["sunglasses"] = _placed(
        [Piece("main", shades, 0.005, flat=True), Piece("white", solid(*shine), 0.003, outline=False, flat=True)],
        rot=euler(0, 0, -0.06),
    )
    for piece in acc["sunglasses"]:
        piece.model.ops = [(scaled(prim, (0.9, 1, 1)), k, c) for prim, k, c in piece.model.ops]

    # Monocle: worn on the eye anchor, with a chain that goes nowhere useful.
    rim = solid(torus((0, 0, 0.058), 0.1, 0.014, rot=euler(pi / 2, 0, 0)))
    chain = [(0.07, -0.075, 0.055), (0.12, -0.2, 0.03), (0.13, -0.33, -0.02), (0.09, -0.42, -0.06)]
    links = solid(*[ball(p, 0.013) for a, b in zip(chain, chain[1:]) for p in [tuple(a[i] + (b[i] - a[i]) * t / 3 for i in range(3)) for t in range(3)]])
    acc["monocle"] = [
        Piece("main", rim, 0.005),
        Piece("main", links, 0.004, outline=False),
        Piece("glass", solid(ellipsoid((0, 0, 0.058), (0.095, 0.095, 0.006))), 0.004, outline=False, flat=True, opacity=0.22),
    ]

    # Party hat: a true cone, worn at an angle it did not choose.
    tilt = dict(offset=(0.07, -0.02, 0), rot=euler(0, 0, -0.32))
    cone_ = solid(lathe((0, 0, 0), [(0, -0.03), (0.128, -0.03), (0.134, -0.01), (0.012, 0.345), (0, 0.35)], r=0.005))
    pompom = Model().add(ball((0, 0.37, 0), 0.042))
    for i in range(10):
        a, b = i * 2.4, (i % 5) * 0.62 - 1.2
        pompom.add(ball((0.036 * cos(a) * cos(b), 0.37 + 0.036 * sin(b), 0.036 * sin(a) * cos(b)), 0.02), k=0.006)
    for i in range(9):
        a = i * 2 * pi / 9
        pompom.add(ball((0.125 * cos(a), -0.012, 0.125 * sin(a)), 0.036), k=0.0)
    slope = lambda y: 0.134 - 0.122 * (y + 0.01) / 0.355
    spots = solid(*[ellipsoid((slope(y) * sin(a), y, slope(y) * cos(a)), (0.028, 0.028, 0.009), rot=euler(-0.34, a, 0)) for a, y in ((0.4, 0.07), (2.3, 0.11), (4.2, 0.06), (1.3, 0.19), (5.4, 0.17), (3.3, 0.23), (0.0, 0.26))])
    acc["partyHat"] = _placed([Piece("main", cone_, 0.006), Piece("trim", pompom, 0.0065), Piece("trim", spots, 0.004, outline=False)], **tilt)

    # Wizard hat: a wide limp brim, a tip that gave up, stars that are actually stars.
    hat = Model().add(lathe((0, 0, 0), [(0, -0.01), (0.3, -0.004), (0.315, 0.008), (0.3, 0.02), (0.17, 0.03), (0.11, 0.24), (0, 0.24)], r=0.006))
    for i in range(5):
        a = i * 2 * pi / 5 + 0.3
        hat.add(ellipsoid((0.27 * cos(a), 0.03 if i % 2 else -0.012, 0.27 * sin(a)), (0.09, 0.018, 0.09)), k=0.03)
    hat.add(tube([(0, 0.2, 0), (0.035, 0.36, -0.03), (0.125, 0.46, -0.04), (0.215, 0.44, -0.03)], [0.118, 0.072, 0.04, 0.014], k=0.03), k=0.03)
    band = Model().add(lathe((0, 0, 0), [(0.13, 0.04), (0.172, 0.04), (0.16, 0.09), (0.13, 0.09)], r=0.004))
    buckle = Model().add(box((0, 0.065, 0.168), (0.04, 0.036, 0.012), r=0.006, rot=euler(-0.24, 0, 0)))
    buckle.cut(box((0, 0.065, 0.175), (0.022, 0.018, 0.03), r=0.004, rot=euler(-0.24, 0, 0)), k=0.003)
    star_points = [(0.04 * (1 if i % 2 == 0 else 0.42) * sin(i * pi / 5), 0.04 * (1 if i % 2 == 0 else 0.42) * cos(i * pi / 5)) for i in range(10)]
    brim_r = lambda y: 0.17 - 0.06 * (y - 0.03) / 0.21
    stars = solid(*[scaled(extrude((brim_r(y) * sin(a), y, brim_r(y) * cos(a)), star_points, 0.004, r=0.004, rot=euler(-0.28, a, spin)), size, (brim_r(y) * sin(a), y, brim_r(y) * cos(a))) for a, y, spin, size in ((0.55, 0.15, 0.2, 1.0), (-0.6, 0.2, -0.3, 0.8), (2.3, 0.14, 0.5, 0.9), (3.6, 0.19, 0.0, 1.0), (-1.7, 0.13, 0.4, 0.75))])
    acc["wizardHat"] = _placed(
        [Piece("main", hat, 0.008), Piece("trim", band, 0.005), Piece("brass", buckle, 0.003), Piece("trim", stars, 0.004, outline=False)],
        offset=(0, -0.03, -0.02),
        rot=euler(-0.12, 0, 0.06),
    )

    # Crown: straight band, sharp points, ermine trim. A size too large, slipping over one ear.
    r = 0.15
    crown = Model().add(lathe((0, 0, 0), [(r - 0.012, 0.0), (r + 0.012, 0.0), (r + 0.016, 0.085), (r - 0.012, 0.085)], r=0.005))
    for i in range(5):
        a = i * 2 * pi / 5 + pi / 2
        crown.add(cone((r * cos(a), 0.06, r * sin(a)), (r * 1.1 * cos(a), 0.2, r * 1.1 * sin(a)), 0.04, 0.01), k=0.006)
        crown.add(ball((r * 1.11 * cos(a), 0.215, r * 1.11 * sin(a)), 0.024), k=0.003)
        b = a + pi / 5
        crown.add(cone((r * cos(b), 0.07, r * sin(b)), (r * 1.04 * cos(b), 0.125, r * 1.04 * sin(b)), 0.028, 0.01), k=0.006)
    gems = lambda odd: solid(*[ellipsoid(((r + 0.018) * cos(a), 0.05, (r + 0.018) * sin(a)), (0.022, 0.028, 0.022)) for a in (i * 2 * pi / 10 + pi / 2 for i in range(10) if i % 2 == odd)])
    ermine = solid(lathe((0, 0, 0), [(r - 0.02, -0.035), (r + 0.026, -0.035), (r + 0.026, 0.006), (r - 0.02, 0.006)], r=0.012))
    specks = solid(*[ellipsoid(((r + 0.036) * cos(a), -0.015, (r + 0.036) * sin(a)), (0.009, 0.016, 0.009)) for a in (i * 2 * pi / 9 + 0.2 for i in range(9))])
    acc["crown"] = _placed(
        [
            Piece("main", crown, 0.006),
            Piece("velvet", solid(ellipsoid((0, 0.07, 0), (r - 0.01, 0.1, r - 0.01))), 0.009, outline=False),
            Piece("gemRed", gems(0), 0.004, outline=False),
            Piece("gemBlue", gems(1), 0.004, outline=False),
            Piece("white", ermine, 0.008),
            Piece("dark", specks, 0.003, outline=False, flat=True),
        ],
        offset=(-0.05, -0.02, 0),
        rot=euler(0.05, 0, 0.27),
    )

    # Halo: held up by a wire and a clip. Innocence is a costume.
    halo = solid(scaled(torus((0, 0.3, 0.0), 0.17, 0.03), (1, 0.8, 1), (0, 0.3, 0)))
    wire = Model().add(tube([(0, -0.02, -0.1), (0.0, 0.12, -0.2), (0, 0.26, -0.2), (0, 0.3, -0.16)], 0.011, k=0.004))
    wire.add(box((0, -0.01, -0.1), (0.03, 0.02, 0.03), r=0.01), k=0.004)
    acc["halo"] = _placed([Piece("main", halo, 0.007, outline=False, flat=True), Piece("wire", wire, 0.004, outline=False)], rot=euler(0.5, 0, 0.14), offset=(0, -0.03, -0.08))
    return acc


def vice_props():
    """What a stoned or a drunk cat carries. Driven by CatSpec.vice, not by a trait."""
    props = {}

    # Joint: hangs from the corner of the mouth. Mouth frame. Cardboard filter, paper
    # gone a little green from what is inside, herb spilling out of the lit end.
    start, tip = np.array([0.035, -0.012, 0.0]), np.array([0.2, -0.045, 0.1])
    axis = (tip - start) / np.linalg.norm(tip - start)
    side = np.cross(axis, [0, 1, 0])
    side /= np.linalg.norm(side)
    up = np.cross(side, axis)
    at = lambda t, a=0.0, r=0.0: tuple(start + axis * t + (side * cos(a) + up * sin(a)) * r)
    width = lambda t: 0.0125 + 0.0115 * t / 0.165
    flecks = [ellipsoid(at(t, a, width(t)), (0.009, 0.006, 0.006)) for t, a in ((0.05, 0.6), (0.075, 2.4), (0.095, 4.4), (0.115, 1.2), (0.135, 3.2), (0.15, 5.4), (0.06, 4.0), (0.125, 0.0))]
    crown = [ball(at(0.168, i * 2 * pi / 6, 0.015), 0.012) for i in range(6)] + [ball(at(0.172), 0.018)]
    props["prop_joint"] = [
        Piece("filter", solid(cone(at(-0.02), at(0.032), 0.0125, 0.0125)), 0.003, flat=True),
        Piece("paper", solid(cone(at(0.03), at(0.165), width(0.03), width(0.165))), 0.0035, flat=True),
        Piece("herb", solid(*flecks), 0.0025, outline=False, flat=True),
        Piece("herb", solid(*crown, k=0.004), 0.003, flat=True),
        Piece("ash", solid(ball(at(0.186), 0.015)), 0.003, outline=False, flat=True),
        Piece("ember", solid(ball(at(0.196), 0.0105)), 0.003, outline=False, flat=True),
    ]
    puff = solid(ball((0, 0, 0), 0.034), ball((0.03, 0.018, 0), 0.026), ball((-0.026, 0.02, 0.005), 0.024), k=0.01)
    props["prop_smoke"] = [Piece("smoke", puff, 0.006, outline=False, flat=True, opacity=0.6)]

    # Drunk: flushed cheeks (eye frame, below the eye), a mouth that lost its line.
    props["blush"] = [Piece("blush", solid(ellipsoid((0, -0.118, -0.012), (0.05, 0.03, 0.03))), 0.005, outline=False, flat=True, opacity=0.65)]
    wobble = [(-0.085, -0.004), (-0.055, -0.03), (-0.025, -0.002), (0.005, -0.03), (0.035, -0.004), (0.062, -0.03), (0.088, -0.01)]
    props["mouth_wobbly"] = [Piece("dark", solid(tube(_bent(wobble, 0.004), 0.011)), 0.003, outline=False, flat=True)]
    props["prop_bubble"] = [Piece("bubble", solid(ball((0, 0, 0), 0.03)), 0.005, outline=False, flat=True, opacity=0.55)]

    # Bottle: knocked over beside the cat, the last of it on the floor. Cat frame,
    # origin on the floor. Modelled upright, then laid down.
    glass = solid(lathe((0, 0, 0), [(0, 0.012), (0.03, 0.004), (0.05, 0.004), (0.056, 0.012), (0.056, 0.15), (0.05, 0.178), (0.024, 0.212), (0.02, 0.27), (0.026, 0.274), (0.026, 0.29), (0.019, 0.294), (0, 0.294)], r=0.004))
    label = solid(lathe((0, 0, 0), [(0.04, 0.05), (0.0585, 0.05), (0.0585, 0.125), (0.04, 0.125)], r=0.003))
    collar = solid(lathe((0, 0, 0), [(0.015, 0.236), (0.0245, 0.236), (0.0245, 0.262), (0.015, 0.262)], r=0.003))
    cross = lambda x: [ellipsoid((x, 0.0875, 0.062), (0.0045, 0.02, 0.006), rot=euler(0, 0, r)) for r in (0.62, -0.62)]
    marks = solid(*[stroke for x in (-0.028, 0, 0.028) for stroke in cross(x)])
    shine = solid(cone((-0.036, 0.03, 0.046), (-0.036, 0.04, 0.046), 0.006), cone((-0.036, 0.135, 0.046), (-0.033, 0.165, 0.042), 0.006))
    lying = euler(0, -0.3, 0) @ euler(0, 0, -pi / 2) @ euler(0, -1.15, 0)
    bottle = _placed(
        [
            Piece("bottle", glass, 0.0055),
            Piece("label", label, 0.005, outline=False),
            Piece("label", collar, 0.004, outline=False),
            Piece("dark", marks, 0.0025, outline=False, flat=True),
            Piece("white", shine, 0.003, outline=False, flat=True, opacity=0.55),
        ],
        offset=(0, 0.06, 0),
        rot=lying,
    )
    mouth = lying @ np.array([0, 0.3, 0]) + np.array([0, 0.06, 0])
    flat = lambda dx, dz, rx, rz: ellipsoid((mouth[0] + dx, 0.004, mouth[2] + dz), (rx, 0.007, rz))
    spill = solid(flat(0.05, 0.06, 0.085, 0.06), flat(0.12, 0.09, 0.05, 0.04), flat(0.0, 0.02, 0.04, 0.035), flat(0.15, 0.0, 0.022, 0.02), k=0.012)
    cork = solid(moved(lathe((0, 0, 0), [(0, -0.02), (0.017, -0.02), (0.019, 0.02), (0, 0.02)], r=0.003), (mouth[0] + 0.17, 0.022, mouth[2] - 0.07), euler(pi / 2, 0.7, 0)))
    props["prop_bottle"] = bottle + [
        Piece("spill", spill, 0.006, outline=False, flat=True, opacity=0.85),
        Piece("cork", cork, 0.004),
    ]
    return props


# Which anchor each accessory hangs from.
ACCESSORY_ANCHORS = {
    "bellCollar": "neck",
    "bowTie": "neck",
    "bandana": "neck",
    "sunglasses": "face",
    "monocle": "eye_R",
    "partyHat": "hat",
    "wizardHat": "hat",
    "crown": "hat",
    "halo": "hat",
}
