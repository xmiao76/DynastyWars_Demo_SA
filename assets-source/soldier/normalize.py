#!/usr/bin/env python3
"""Normalize selected soldier frames onto a shared 512x512 transparent canvas.

Method (per spec): ONE uniform scale + ONE translation for every frame of
every action (all source videos share the same 544x544 framing, ground at
source y=432). No per-pose crop/resize: each full source frame is scaled
once and pasted at the same offset; the canvas crop is identical for all.

Scale choice: source head-to-feet is 302px (y130..432). SCALE=1.10 gives
~332px on canvas (~5% under the 350px target). A larger scale would clip
the spear blade: butt-to-tip span is up to ~473px in source (walk), and
473*1.10 ~= 520 already slightly exceeds 512. 1.10 is the largest scale
that keeps the spear essentially intact; body is left-of-center because
the long spear extends to the right (feet midpoint lands ~x166).

Ground: source ground y=432 -> canvas y=472 for every frame.
"""
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent          # assets-source/soldier
WORK = ROOT.parents[1]                            # workspace root
OUT_DIR = WORK / "public" / "assets" / "frames" / "soldier"

CANVAS = 512
GROUND_Y = 472
SCALE = 1.10
SRC_GROUND = 432          # bottom of feet (bbox) in all source videos
TX = -54                  # balances spear butt (left) vs tip (right)
TY = GROUND_Y - round(SRC_GROUND * SCALE)   # 472 - 475 = -3

# Selected 1-based source frame numbers (12fps extracts).
# idle: spear-tip height rises to f16 then falls back -> smooth loop.
# walk: first full gait cycle (~f2..f19), 8 phases incl. both leg lifts.
# attack: attempt 1 (horizontal thrust). Peak-extension frames f23-32 are
#   omitted because the spear tip leaves the source frame there; f35
#   (early recovery, tip fully visible, still extended) is the peak shown.
SELECTIONS = {
    "idle":   ("frames-idle-rgba",   [4, 8, 12, 16, 20, 24]),
    "walk":   ("frames-walk-rgba",   [2, 4, 7, 9, 11, 14, 16, 18]),
    "attack": ("frames-attack-rgba", [1, 8, 14, 17, 22, 35, 37]),
}


def despill(img: Image.Image) -> Image.Image:
    """Neutralize magenta fringe: where min(R,B) exceeds G strongly
    (purple/magenta edge spill), pull R and B down toward G.
    Blue armor (low R) is unaffected."""
    a = np.asarray(img).astype(np.int16)
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    excess = np.minimum(r, b) - g
    mask = (al > 0) & (excess > 30)
    cut = (excess * 0.85).astype(np.int16)
    r2 = np.where(mask, r - cut, r)
    b2 = np.where(mask, b - cut, b)
    out = np.stack([r2, g, b2, al], axis=-1)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    scaled = round(544 * SCALE)
    for action, (src_dir, frames) in SELECTIONS.items():
        for n, f in enumerate(frames, start=1):
            src = ROOT / src_dir / f"frame-{f:04d}.png"
            im = Image.open(src).convert("RGBA")
            im = despill(im)
            im = im.resize((scaled, scaled), Image.LANCZOS)
            canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
            canvas.paste(im, (TX, TY), im)
            out = OUT_DIR / f"{action}_{n}.png"
            canvas.save(out)
            bb = canvas.getchannel("A").getbbox()
            print(f"{out.name}  src frame {f:04d}  bbox={bb}")
    print(f"scale={SCALE} offset=({TX},{TY}) canvas={CANVAS} groundY={GROUND_Y}")


if __name__ == "__main__":
    main()
