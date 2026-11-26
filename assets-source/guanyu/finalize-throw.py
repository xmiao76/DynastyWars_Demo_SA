"""Finalize Guan Yu's video-derived throw action onto the EXISTING guanyu
canvas transform, so the new action aligns pixel-for-pixel with idle/walk/
attack already shipped in public/assets/frames/guanyu/.

Existing transform (from normalize.py): SCALE=1.02, source ground 472 ->
canvas groundY 472, dy = 472 - 1.02*472. Its dx was derived from the union
bbox of the original three actions; the keyed originals are not in the repo,
so dx is recovered here from the shipped attack_0: all original videos share
an identical first frame, and attack selection frame[0] is that source
frame-0001 with PER_ACTION_OFFSET (0,0). So dx = shippedBboxX - SCALE*srcBboxX
(left and right edges are printed and averaged).

Attempt choice: attempt 1 (video-throw/) is used — frames 13-19 show a clear
extended-arm hold (grip), 21-25 the haul-in, 29-31 the heave/release, 33-35
recovery back to the ready stance. Attempt 2 (video-throw-a2/) keeps the
guandao in hand but its hold phase is just the ready stance and the weapon
vanishes during the heave, which reads worse. In attempt 1 the guandao lies
on the ground during the grapple (he sets it down to seize the soldier);
this is kept honestly rather than painted out.

Selected source frames (1-based): [13, 17, 21, 23, 25, 29, 31, 33, 35]
Release tick: output index 5 (source 29, heave extension) -> releaseFrac
5/(9-1) = 0.625 of the one-shot animation.
Grip marker: rightmost opaque pixel of source frame 13 in the chest band
(y 200..280) = the extended hand; stored in the manifest as canvas px offset
from (originX, groundY) so game code can pin the victim to the hand.

Run with the game-tools venv python. Writes throw_N.png + updated
manifest.json in public/assets/frames/guanyu/ and throw-contact-sheet.png
next to this script.
"""
import json
import os

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(ROOT, "public", "assets", "frames", "guanyu")
KEYED = os.path.join(HERE, "frames-throw-keyed")

CANVAS = 512
GROUND_Y = 472
SCALE = 1.02
DY = GROUND_Y - SCALE * 472
ORIGIN_X = 223  # from the shipped manifest
SELECTION = [13, 17, 21, 23, 25, 29, 31, 33, 35]
RELEASE_INDEX = 5


def despill(im):
    arr = np.asarray(im).astype(np.int16)
    r, g, b, a = arr[..., 0], arr[..., 1], arr[..., 2], arr[..., 3]
    magenta_dom = np.minimum(r, b) - g
    solid = a > 10
    near_edge = np.zeros_like(solid)
    band = solid.copy()
    for _ in range(2):
        eroded = band.copy()
        eroded[1:, :] &= band[:-1, :]
        eroded[:-1, :] &= band[1:, :]
        eroded[:, 1:] &= band[:, :-1]
        eroded[:, :-1] &= band[:, 1:]
        near_edge |= band & ~eroded
        band = eroded
    kill = near_edge & (magenta_dom > 40)
    a = np.where(kill, 0, a)
    spill = np.maximum(np.minimum(r, b) - g, 0)
    r = r - spill
    b = b - spill
    out = np.dstack([r, g, b, a]).clip(0, 255).astype(np.uint8)
    out[out[..., 3] == 0] = 0
    return Image.fromarray(out, "RGBA")


def load_keyed(n):
    return Image.open(os.path.join(KEYED, f"frame-{n:04d}.png")).convert("RGBA")


def main():
    # Recover dx from shipped attack_0 vs this clip's identical first frame.
    shipped = Image.open(os.path.join(OUT_DIR, "attack_0.png")).convert("RGBA")
    sb = shipped.getchannel("A").getbbox()
    src1 = despill(load_keyed(1))
    fb = src1.getchannel("A").getbbox()
    dx_left = sb[0] - SCALE * fb[0]
    dx_right = sb[2] - SCALE * fb[2]
    dx = (dx_left + dx_right) / 2
    print(f"shipped attack_0 bbox={sb}  throw frame1 bbox={fb}")
    print(f"dx_left={dx_left:.1f} dx_right={dx_right:.1f} -> dx={dx:.1f}  dy={DY:.1f} scale={SCALE}")

    finals = []
    for i, n in enumerate(SELECTION):
        im = despill(load_keyed(n))
        w, h = im.size
        im = im.resize((round(w * SCALE), round(h * SCALE)), Image.LANCZOS)
        big = Image.new("RGBA", (CANVAS + 200, CANVAS + 200), (0, 0, 0, 0))
        big.alpha_composite(im, (100 + round(dx), 100 + round(DY)))
        final = big.crop((100, 100, 100 + CANVAS, 100 + CANVAS))
        final.save(os.path.join(OUT_DIR, f"throw_{i}.png"))
        finals.append(final)
        print(f"throw_{i}.png  src frame-{n:04d}  bbox={final.getchannel('A').getbbox()}")

    # Grip marker from the hold pose (output frame 0 = source 13): rightmost
    # opaque pixel in the chest band of the FINAL canvas frame.
    arr = np.asarray(finals[0])[..., 3]
    band = arr[190:280, :]
    ys, xs = np.where(band > 10)
    grip_x = int(xs.max())
    grip_y = int(190 + ys[xs.argmax()])
    grip = {"dx": grip_x - ORIGIN_X, "dy": grip_y - GROUND_Y}
    print(f"grip canvas=({grip_x},{grip_y}) relative=({grip['dx']},{grip['dy']})")

    with open(os.path.join(OUT_DIR, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    manifest["actions"]["throw"] = len(SELECTION)
    manifest["strikeFrac"] = {"attack": 0.55, "throw": RELEASE_INDEX / (len(SELECTION) - 1)}
    manifest["grip"] = grip
    manifest["throwReleaseIndex"] = RELEASE_INDEX
    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    print("manifest:", manifest)

    tile = 256
    k = tile / CANVAS
    sheet = Image.new("RGB", (len(finals) * tile, tile), (32, 32, 38))
    d = ImageDraw.Draw(sheet)
    for col, fr in enumerate(finals):
        thumb = fr.resize((tile, tile), Image.LANCZOS)
        sheet.paste(thumb, (col * tile, 0), thumb)
        d.text((col * tile + 5, 4), f"throw_{col}", fill=(255, 255, 120))
    gy = round(GROUND_Y * k)
    d.line([(0, gy), (len(finals) * tile, gy)], fill=(255, 80, 80), width=1)
    gx = round((ORIGIN_X + grip["dx"]) * k)
    gy2 = round((GROUND_Y + grip["dy"]) * k)
    d.ellipse([gx - 4, gy2 - 4, gx + 4, gy2 + 4], outline=(80, 255, 80), width=2)
    sheet.save(os.path.join(HERE, "throw-contact-sheet.png"))
    print("contact sheet saved", sheet.size)


if __name__ == "__main__":
    main()
