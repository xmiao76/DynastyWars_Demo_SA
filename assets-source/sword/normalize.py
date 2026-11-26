"""Normalize selected keyed frames onto a shared 512x512 transparent canvas.

Sword Soldier (dao infantry), adapted from assets-source/guanyu/normalize.py.

Contract:
- ONE global scale + translation for every frame of every action. Source
  frames are 544x544 and all three videos share the exact same coordinate
  system (identical first frame), so poses are never cropped or recentered
  individually.
- Ground (feet) line: source feet sit at y=426 (alpha-bbox bottom of the
  idle stance, frame-0001 of every clip). The transform maps source
  y=426 -> canvas y=472.
- Scale: idle head-to-feet is ~256px in source (bbox y 170..426). ~300px
  on canvas needs s=1.17. Nothing-gets-cropped caps: the attack raise
  tip reaches y=95, i.e. 331px above the feet (cap s<=1.40 for a 10px top
  margin), and the union of all selected frames spans x 154..400 = 246px
  (cap s<=2.00). So s=1.17 is set by the ~300px target, not by cropping:
  character ~300px tall on canvas, raise tip ~85px below the top edge,
  widest pose ~288px with ~110px side margins.
- Horizontal: the union of all selected frames is centered on canvas x=256
  with that single dx.
- Magenta despill: (1) strongly magenta-dominant pixels within 2px of the
  silhouette edge are dropped, (2) remaining pixels get min(R,B) pulled
  down to G where magenta dominates (the dark red-brown uniform is
  unaffected because its blue channel is low).
- originX: midpoint of the alpha extent in the feet band (bottom 30px
  above the ground line) of the final idle_0 frame.
- strikeFrac: attack output index 5 of 9 (source frame 20, blade fully
  forward at target height as the chop lands) -> 5/(9-1) = 0.625.

Run with the game-tools venv python. Writes final PNGs + manifest.json to
public/assets/frames/sword/ and contact-sheet.png next to this script.
"""
import json
import os

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(ROOT, "public", "assets", "frames", "sword")

CANVAS = 512
GROUND_Y = 472
SRC_GROUND_Y = 426  # feet line in the 544x544 source frames
SCALE = 1.17

# action -> (keyed dir, [1-based source frame numbers])
SELECTION = {
    # idle is a subtle one-way sway/sword drift early in the clip (later
    # frames drift right and sink), so the loop is built ping-pong from
    # frames 2..10 whose feet stay on the ground line (bbox bottom 422-426).
    "idle": ("frames-idle-a1-keyed", [2, 4, 6, 8, 10, 8, 6, 4]),
    # one ~13-frame marching gait cycle (frames 7..19; frame 20 repeats
    # frame 7's knee-up pose) sampled to 8.
    "walk": ("frames-walk-a1-keyed", [7, 9, 10, 12, 14, 15, 17, 19]),
    # attack attempt 2: ready, sword extending, raised vertical, wind-up
    # peak overhead, chop mid (vertical blade coming down), strike lands
    # (blade fully forward at target height), follow-through/recovery,
    # near-ready, back to the exact ready stance (held from frame 26 on).
    "attack": ("frames-attack-a2-keyed", [1, 7, 10, 14, 18, 20, 22, 25, 30]),
}

# Index (0-based) of the selected attack frame where the strike lands.
STRIKE_INDEX = 5

# Small per-action translation (canvas px) on top of the global transform:
# every walk frame's lowest foot sits 2-4px above the source ground line
# (bbox bottom 422-424 vs 426 in idle/attack), so walk is nudged down 2px
# (soles then straddle the ground line by ~2px either way through the gait).
PER_ACTION_OFFSET = {"idle": (0, 0), "walk": (0, 2), "attack": (0, 0)}


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
