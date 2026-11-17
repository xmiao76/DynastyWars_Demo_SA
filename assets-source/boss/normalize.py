"""Normalize keyed boss frames onto a shared 640x640 transparent canvas.

- One global scale for all actions: computed so median idle head-to-feet
  bbox height becomes ~480px.
- One translation per action (never per frame): the first (neutral stance)
  frame's bbox bottom maps to groundY=600, clamped so no selected frame
  clips the canvas bottom; median bbox centre-x maps to 320. Source
  coordinates within each action are otherwise preserved (the attack
  video drifts down ~34 source px into the slam, which reads as a lunge).
- Magenta despill + 1px alpha erosion to remove chroma fringe.
- Selected source frames (frame-XXXX numbers, inspected via sheet-*.png):
    idle:   subtle breathing spread over the 2s clip
    walk:   every 2nd frame across two stomps
    attack: ready -> raise -> overhead telegraph hold -> slam -> recovery

Outputs public/assets/frames/boss/{action}_{i}.png (i is 0-based),
public/assets/frames/boss/manifest.json and assets-source/boss/contact-sheet.png.
Run from the repo root with the game-tools venv python.
"""
import json
import os
import statistics

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SRC = "assets-source/boss"
OUT = "public/assets/frames/boss"
CANVAS = 640
GROUND_Y = 600
TARGET_HEIGHT = 480

SELECT = {
    "idle": [2, 7, 12, 17, 22],
    "walk": [5, 7, 9, 11, 13, 15, 17, 19],
    # 11/27 avoided: sword tip touches the source frame's top edge there.
    "attack": [3, 8, 13, 15, 20, 24, 28, 29, 32, 36],
}


def load(action, n):
    p = os.path.join(SRC, f"frames-{action}-rgba", f"frame-{n:04d}.png")
    return Image.open(p).convert("RGBA")


def despill(im):
    """Neutralise magenta spill on visible pixels and shave the fringe."""
    a = np.asarray(im).astype(np.int16)
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    magenta = (al > 0) & (r > g + 25) & (b > g + 25)
    # Pull red/blue down toward green, keeping some of the original shading.
    r[magenta] = g[magenta] + (r[magenta] - g[magenta]) // 4
    b[magenta] = g[magenta] + (b[magenta] - g[magenta]) // 4
    out = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGBA")
    # Erode alpha by ~1px to drop the remaining coloured edge ring.
    alpha = out.getchannel("A").filter(ImageFilter.MinFilter(3))
    out.putalpha(alpha)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    # Global scale from idle character height.
    idle_heights = []
    for n in SELECT["idle"]:
        bb = load("idle", n).getchannel("A").getbbox()
        idle_heights.append(bb[3] - bb[1])
    scale = TARGET_HEIGHT / statistics.median(idle_heights)
    print(f"idle median bbox height={statistics.median(idle_heights):.1f}px scale={scale:.4f}")

    counts = {}
    finals = []  # (label, image) for the contact sheet
    for action, frames in SELECT.items():
        ims = [despill(load(action, n)) for n in frames]
        boxes = [im.getchannel("A").getbbox() for im in ims]
        ref_bottom = boxes[0][3]
        max_bottom = max(bb[3] for bb in boxes)
        med_cx = statistics.median((bb[0] + bb[2]) / 2 for bb in boxes)
        dx = round(CANVAS / 2 - med_cx * scale)
        dy = round(min(GROUND_Y - ref_bottom * scale, CANVAS - 4 - max_bottom * scale))
        print(f"{action}: ref bottom={ref_bottom} max bottom={max_bottom} cx={med_cx:.1f} -> dx={dx} dy={dy}")
        src_w, src_h = ims[0].size
        new_size = (round(src_w * scale), round(src_h * scale))
        for i, im in enumerate(ims):
            scaled = im.resize(new_size, Image.LANCZOS)
            canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
            canvas.alpha_composite(scaled, (dx, dy))
            name = f"{action}_{i}.png"
            canvas.save(os.path.join(OUT, name))
            finals.append((name, canvas))
        counts[action] = len(ims)

    manifest = {"canvas": [CANVAS, CANVAS], "groundY": GROUND_Y, "actions": counts}
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f)
    print("manifest:", manifest)

    # Contact sheet over dark background.
    tile, cols = 320, 5
    rows = (len(finals) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tile, rows * tile), (32, 32, 38))
    d = ImageDraw.Draw(sheet)
    for i, (name, im) in enumerate(finals):
        t = im.copy()
        t.thumbnail((tile - 8, tile - 8))
        x, y = (i % cols) * tile + 4, (i // cols) * tile + 4
        sheet.paste(t, (x, y), t)
        d.text((x + 4, y + 2), name, fill=(255, 255, 120))
    sheet.save(os.path.join(SRC, "contact-sheet.png"))
    print("contact sheet:", sheet.size, "tiles:", len(finals))


if __name__ == "__main__":
    main()
