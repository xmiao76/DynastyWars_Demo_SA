"""Normalize selected keyed frames onto a shared 512x512 transparent canvas.

Archer (Wei bow infantry), adapted from assets-source/guanyu/normalize.py.

Contract:
- ONE global scale + translation for every frame of every action. Source
  frames are 544x544 and all three used videos (idle-a1, walk-a1,
  attack-a2) share the exact same coordinate system (identical first
  frame), so poses are never cropped or recentered individually.
- Ground (feet) line: source feet sit at y=494 (alpha-bbox bottom of the
  idle stance, frame-0001 of every clip; attack-a2 holds 494 in all 37
  frames). The transform maps source y=494 -> canvas y=472.
- Scale: idle head-to-feet is ~364px in source (bbox y 130..494). ~300px
  on canvas needs s=0.82 (298px). Nothing-gets-cropped caps are looser:
  the raised bow reaches y=48 in attack, i.e. 446px above the feet
  (cap s<=1.04 for a 10px top margin), and the union of all selected
  frames spans x 130..466 = 336px (cap s<=1.46). So s=0.82 is set by the
  ~300px target, not by cropping: bow tip ~106px below the top edge,
  widest selected frame (full draw, arrow nocked) ~276px wide.
- Horizontal: the union of all selected frames is centered on canvas
  x=256 with that single dx.
- Magenta despill: (1) strongly magenta-dominant pixels within 2px of
  the silhouette edge are dropped, (2) remaining pixels get min(R,B)
  pulled down to G where magenta dominates (the teal-blue uniform is
  unaffected because its red channel is low; the thin bowstring is
  heavily magenta-tinted in the source and partly thins out).
- originX: midpoint of the alpha extent in the feet band (bottom 30px
  above the ground line) of the final idle_0 frame.
- strikeFrac: attack output index 6 of 10 (source frame 28, the
  follow-through right after the loose; the actual release is source
  frame 27, where the arrow streaks out of frame, so frame 28 with the
  arrow already gone is the first post-release frame) -> 6/(10-1)=0.667.

Run with the game-tools venv python. Writes final PNGs + manifest.json to
public/assets/frames/archer/ and contact-sheet.png next to this script.
"""
import json
import os

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(ROOT, "public", "assets", "frames", "archer")

CANVAS = 512
GROUND_Y = 472
SRC_GROUND_Y = 494  # feet line in the 544x544 source frames
SCALE = 0.82

# action -> (keyed dir, [1-based source frame numbers])
SELECTION = {
    # idle is a one-way rightward sway/drift early in the clip (later
    # frames rotate toward the camera), so the loop is built ping-pong
    # from frames 2..10 for a seamless breathing cycle.
    "idle": ("frames-idle-a1-keyed", [2, 4, 6, 8, 10, 8, 6, 4]),
    # one full two-step gait cycle, frames 6..21 (knee-up A, extend,
    # stride, passing, knee-up B, extend, stride, passing; frame 23
    # repeats frame 6's knee-up) sampled to 8.
    "walk": ("frames-walk-a1-keyed", [6, 8, 10, 12, 15, 17, 19, 21]),
    # attack attempt 2 (attempt 1 zoomed in and cropped the feet):
    # rest, raise, bow up, nock/draw start, full draw, aim hold,
    # release follow-through (arrow already exited), lower x2, rest.
    # Frames 10-13 are skipped: the nocked arrow is drawn impossibly
    # long there and exits the right edge of the source frame.
    "attack": ("frames-attack-a2-keyed", [1, 6, 8, 9, 16, 24, 28, 31, 34, 36]),
}

# Index (0-based) of the selected attack frame where the arrow is loosed.
STRIKE_INDEX = 6

# Small per-action translation (canvas px) on top of the global
# transform: in walk the whole body floats up to ~10px (source) during
# knee-up phases (bbox bottoms 484-493 vs 494 ground), so walk is
# nudged down 3px as a compromise between float and sink.
PER_ACTION_OFFSET = {"idle": (0, 0), "walk": (0, 3), "attack": (0, 0)}


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
    # Union bbox over all selected frames -> single dx that centers it.
    ux0, ux1 = 10**9, -1
    for action_dir, nums in SELECTION.values():
        for n in nums:
            bbox = load_frame(action_dir, n).getchannel("A").getbbox()
            ux0, ux1 = min(ux0, bbox[0]), max(ux1, bbox[2])
    dx = CANVAS / 2 - SCALE * (ux0 + ux1) / 2
    dy = GROUND_Y - SCALE * SRC_GROUND_Y
    print(f"union x [{ux0},{ux1}]  scale={SCALE}  dx={dx:.1f}  dy={dy:.1f}")

    os.makedirs(OUT_DIR, exist_ok=True)
    counts = {}
    finals = {}
    for action, (action_dir, nums) in SELECTION.items():
        finals[action] = []
        for i, n in enumerate(nums):
            im = despill(load_frame(action_dir, n))
            w, h = im.size
            im = im.resize((round(w * SCALE), round(h * SCALE)), Image.LANCZOS)
            # paste on an oversized canvas then crop, so offsets never clip early
            big = Image.new("RGBA", (CANVAS + 200, CANVAS + 200), (0, 0, 0, 0))
            ox, oy = PER_ACTION_OFFSET[action]
            big.alpha_composite(im, (100 + round(dx) + ox, 100 + round(dy) + oy))
            final = big.crop((100, 100, 100 + CANVAS, 100 + CANVAS))
            name = f"{action}_{i}.png"
            final.save(os.path.join(OUT_DIR, name))
            finals[action].append(final)
            bb = final.getchannel("A").getbbox()
            print(f"{name}  src frame-{n:04d}  bbox={bb}")
        counts[action] = len(nums)

    # originX: midpoint of the feet alpha extent in idle_0 (bottom band).
    idle0 = np.asarray(finals["idle"][0])[..., 3]
    feet_band = idle0[GROUND_Y - 30 : GROUND_Y + 1, :] > 10
    xs = np.where(feet_band.any(axis=0))[0]
    origin_x = int(round((xs.min() + xs.max()) / 2))
    print(f"idle_0 feet x [{xs.min()},{xs.max()}] -> originX={origin_x}")

    strike_frac = STRIKE_INDEX / (counts["attack"] - 1)
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
        d.line([(ox, row * tile), (ox, row * tile + tile)], fill=(80, 255, 80), width=1)
    sheet.save(os.path.join(HERE, "contact-sheet.png"))
    print("contact sheet:", os.path.join(HERE, "contact-sheet.png"), sheet.size)


if __name__ == "__main__":
    main()
