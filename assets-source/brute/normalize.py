"""Normalize selected keyed brute frames onto a shared 512x512 canvas.

Adapted from assets-source/guanyu/normalize.py.

Contract:
- ONE global scale + translation for every frame of every action. Source
  frames are 544x544 and all three videos share the exact same coordinate
  system (identical first frame), so poses are never cropped or recentered
  individually.
- Ground (feet) line: source feet sit at y=428 (alpha-bbox bottom of the
  idle stance, frame-0001). The transform maps source y=428 -> canvas y=472.
- Scale: idle head-to-feet is ~260px in source. The requested ~345px on
  canvas would need s=1.33, but the club-raised wind-up frame
  (attack frame-0008, club straight up) reaches 392px above the feet
  (top y=36 vs feet y=428): s=1.33 -> 521px > 472px available above the
  ground line. So the scale is CAPPED by the nothing-gets-cropped
  constraint. The script computes all caps (target height, union width,
  raised-club top) and takes the minimum; the raised-club top is the
  binding constraint (s ~= 1.18, character ~307px tall on canvas - the
  brute still reads much bigger than a regular soldier through sheer
  body/club width, but 345px tall is geometrically impossible with the
  raised club uncropped: max body height = 472 / (392/260) ~= 313px).
- Horizontal: the union of all selected frames is centered on canvas
  x=256 with that single dx.
- Magenta despill identical to guanyu's: (1) strongly magenta-dominant
  pixels within 2px of the silhouette edge are dropped, (2) remaining
  pixels get min(R,B) pulled down to G where magenta dominates.
- originX: center of the feet span in the first idle frame on canvas
  (alpha pixels in the 30px band above groundY), written to manifest.
- strikeFrac.attack: the smash frame (source frame-0025, club head on
  the ground) is index 6 of 10 attack frames -> 6/9 = 0.67 of the way
  through the attack timeline (frame-interval fraction).

Frame selection notes (inspected via sheet-*.png):
- idle: breathing drift is one-way, so the loop is ping-pong.
- walk: 8 frames spread over the heavy gait.
- attack: ready -> raise -> club straight up (peak) -> tilting back ->
  swing starts -> club coming down -> SMASH on ground -> low recovery
  -> rising -> ready. The extreme behind-head hold frames (source
  13-20, club tip to x=52) and the farthest debris frames (26-27, club
  tip to x=540) are skipped so width does not become a second, harsher
  scale cap; the wind-up still reads long (4 of 10 frames before the
  downswing).

Run with the game-tools venv python. Writes final PNGs + manifest.json to
public/assets/frames/brute/ and contact-sheet.png next to this script.
"""
import json
import os

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(ROOT, "public", "assets", "frames", "brute")

CANVAS = 512
GROUND_Y = 472
SRC_GROUND_Y = 428  # feet line in the 544x544 source frames (idle frame-0001)
TARGET_HEIGHT = 345  # requested character height on canvas (px)
IDLE_SRC_HEIGHT = 260  # idle frame-0003 bbox height (166..426)
TOP_MARGIN = 8
SIDE_MARGIN = 8

# action -> (keyed dir, [1-based source frame numbers])
SELECTION = {
    "idle": ("frames-idle-a1-keyed", [3, 6, 9, 12, 9, 6]),
    "walk": ("frames-walk-a1-keyed", [5, 7, 9, 11, 13, 15, 17, 19]),
    # smash (club on ground) = source 25 at index 6 -> strikeFrac 6/9 = 0.67
    "attack": ("frames-attack-a1-keyed", [1, 5, 8, 11, 21, 23, 25, 29, 33, 37]),
}
STRIKE_INDEX = 6  # index into SELECTION["attack"] where the smash lands


def load_frame(action_dir, n):
    path = os.path.join(HERE, action_dir, f"frame-{n:04d}.png")
    return Image.open(path).convert("RGBA")


def despill(im):
    arr = np.asarray(im).astype(np.int16)
    r, g, b, a = arr[..., 0], arr[..., 1], arr[..., 2], arr[..., 3]
    magenta_dom = np.minimum(r, b) - g  # >0 means magenta/purple dominant

    # (1) drop strongly contaminated pixels in a 2px band inside the edge.
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

    # (2) neutralize remaining magenta dominance.
    spill = np.maximum(np.minimum(r, b) - g, 0)
    r = r - spill
    b = b - spill

    out = np.dstack([r, g, b, a]).clip(0, 255).astype(np.uint8)
    out[out[..., 3] == 0] = 0
    return Image.fromarray(out, "RGBA")


def main():
    # Union bbox over all selected frames, and the highest reach above feet.
    ux0, uy0, ux1 = 10**9, 10**9, -1
    for action_dir, nums in SELECTION.values():
        for n in nums:
            bbox = load_frame(action_dir, n).getchannel("A").getbbox()
            ux0, uy0, ux1 = min(ux0, bbox[0]), min(uy0, bbox[1]), max(ux1, bbox[2])

    s_target = TARGET_HEIGHT / IDLE_SRC_HEIGHT
    s_width = (CANVAS - 2 * SIDE_MARGIN) / (ux1 - ux0)
    s_top = (GROUND_Y - TOP_MARGIN) / (SRC_GROUND_Y - uy0)
    scale = min(s_target, s_width, s_top)
    binding = {s_target: "target height", s_width: "union width", s_top: "raised-club top"}[scale]
    print(f"union x [{ux0},{ux1}] top y={uy0}")
    print(f"s_target={s_target:.3f} s_width={s_width:.3f} s_top={s_top:.3f}")
    print(f"scale={scale:.4f} (binding: {binding}) -> char height ~{IDLE_SRC_HEIGHT * scale:.0f}px")

    dx = CANVAS / 2 - scale * (ux0 + ux1) / 2
    dy = GROUND_Y - scale * SRC_GROUND_Y
    print(f"dx={dx:.1f} dy={dy:.1f}")

    os.makedirs(OUT_DIR, exist_ok=True)
    counts = {}
    finals = {}
    for action, (action_dir, nums) in SELECTION.items():
        finals[action] = []
        for i, n in enumerate(nums):
            im = despill(load_frame(action_dir, n))
            w, h = im.size
            im = im.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
            # paste on an oversized canvas then crop, so offsets never clip early
            big = Image.new("RGBA", (CANVAS + 200, CANVAS + 200), (0, 0, 0, 0))
            big.alpha_composite(im, (100 + round(dx), 100 + round(dy)))
            final = big.crop((100, 100, 100 + CANVAS, 100 + CANVAS))
            name = f"{action}_{i}.png"
            final.save(os.path.join(OUT_DIR, name))
            finals[action].append(final)
            bb = final.getchannel("A").getbbox()
            print(f"{name}  src frame-{n:04d}  bbox={bb}")
        counts[action] = len(nums)

    # originX: center of the feet span in idle_0 (alpha in band above ground).
    alpha = np.asarray(finals["idle"][0].getchannel("A"))
    band = alpha[GROUND_Y - 30:GROUND_Y + 2, :] > 10
    xs = np.where(band.any(axis=0))[0]
    origin_x = int(round((xs.min() + xs.max()) / 2))
    print(f"idle feet span x [{xs.min()},{xs.max()}] -> originX={origin_x}")

    strike_frac = round(STRIKE_INDEX / (counts["attack"] - 1), 2)
    manifest = {
        "canvas": [CANVAS, CANVAS],
        "groundY": GROUND_Y,
        "originX": origin_x,
        "actions": counts,
        "strikeFrac": {"attack": strike_frac},
    }
    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    print("manifest:", manifest)

    # Combined contact sheet: one row per action over dark gray, ground line drawn.
    tile = 256
    k = tile / CANVAS
    cols = max(len(v) for v in finals.values())
    sheet = Image.new("RGB", (cols * tile, 3 * tile), (32, 32, 38))
    d = ImageDraw.Draw(sheet)
    for row, (action, frames) in enumerate(finals.items()):
        for col, fr in enumerate(frames):
            thumb = fr.resize((tile, tile), Image.LANCZOS)
            sheet.paste(thumb, (col * tile, row * tile), thumb)
            d.text((col * tile + 5, row * tile + 4), f"{action}_{col}", fill=(255, 255, 120))
        gy = row * tile + round(GROUND_Y * k)
        d.line([(0, gy), (cols * tile, gy)], fill=(255, 80, 80), width=1)
        ox = round(origin_x * k)
        d.line([(ox, row * tile), (ox, row * tile + tile)], fill=(80, 255, 120), width=1)
    sheet.save(os.path.join(HERE, "contact-sheet.png"))
    print("contact sheet:", os.path.join(HERE, "contact-sheet.png"), sheet.size)


if __name__ == "__main__":
    main()
