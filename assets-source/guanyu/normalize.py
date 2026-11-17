"""Normalize selected keyed frames onto a shared 512x512 transparent canvas.

Contract:
- ONE global scale + translation for every frame of every action. Source
  frames are 544x544 and all three videos share the exact same coordinate
  system (identical first frame), so poses are never cropped or recentered
  individually.
- Ground (feet) line: source feet sit at y=472 (alpha-bbox bottom of the
  idle stance). The transform maps source y=472 -> canvas y=472.
- Scale: idle head-to-feet is ~310px in source. 380px on canvas would need
  s=1.23, but the fully extended attack pose spans 482px wide in source
  (s=1.23 -> 591px > 512 canvas) and the wind-up reaches 442px above the
  feet (s=1.23 -> 542 > 472 available). So s is capped by the
  nothing-gets-cropped constraint: s=1.02 (character ~316px tall on canvas,
  widest frame ~492px, ~10px side margins, ~21px top margin at wind-up).
- Horizontal: the union of all selected frames is centered on canvas x=256
  with that single dx.
- Magenta despill: (1) strongly magenta-dominant pixels within 2px of the
  silhouette edge are dropped, (2) remaining pixels get min(R,B) pulled
  down to G where magenta dominates (red tassels / gold are unaffected
  because their blue channel is low).

Run with the game-tools venv python. Writes final PNGs + manifest.json to
public/assets/frames/guanyu/ and contact-sheet.png next to this script.
"""
import json
import os

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_DIR = os.path.join(ROOT, "public", "assets", "frames", "guanyu")

CANVAS = 512
GROUND_Y = 472
SRC_GROUND_Y = 472  # feet line in the 544x544 source frames
SCALE = 1.02

# action -> (keyed dir, [1-based source frame numbers])
SELECTION = {
    # idle sway is a one-way drift in the source clip, so the loop is built
    # ping-pong (forward then reverse) for a seamless breathing cycle.
    "idle": ("frames-idle-a1-keyed", [3, 6, 9, 12, 15, 12, 9, 6]),
    # one ~12-frame gait cycle (frames 6..17) sampled to 8.
    "walk": ("frames-walk-a1-keyed", [6, 8, 9, 11, 12, 14, 15, 17]),
    # ready, wind-up, wind-up peak, chop start, chop lands, full extension,
    # recovery x2, back to ready.
    "attack": ("frames-attack-a3-keyed", [1, 4, 8, 10, 12, 14, 33, 35, 37]),
}

# Small per-action translation (canvas px) on top of the global transform,
# measured from the first normalized pass: idle soles sit 2px below the
# ground line, and the walk cycle's torso centroid sits ~6px right of
# idle's (the walk clip drifts right after its identical first frame).
PER_ACTION_OFFSET = {"idle": (0, -2), "walk": (-6, 0), "attack": (0, 0)}


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

    manifest = {"canvas": [CANVAS, CANVAS], "groundY": GROUND_Y, "actions": counts}
    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f)
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
    sheet.save(os.path.join(HERE, "contact-sheet.png"))
    print("contact sheet:", os.path.join(HERE, "contact-sheet.png"), sheet.size)


if __name__ == "__main__":
    main()
