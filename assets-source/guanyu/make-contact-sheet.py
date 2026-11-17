"""Make a contact sheet from a dir of frames over a dark background.
Usage: python make-contact-sheet.py <frames-dir> <out.png> [cols] [every_nth] [tile]
Frames are composited over dark gray so magenta spill / keying fringe is visible.
"""
import sys, os
from PIL import Image, ImageDraw

frames_dir, out = sys.argv[1], sys.argv[2]
cols = int(sys.argv[3]) if len(sys.argv) > 3 else 5
every = int(sys.argv[4]) if len(sys.argv) > 4 else 1
tile = int(sys.argv[5]) if len(sys.argv) > 5 else 256

files = sorted(f for f in os.listdir(frames_dir) if f.lower().endswith(".png"))[::every]
rows = (len(files) + cols - 1) // cols
sheet = Image.new("RGB", (cols * tile, rows * tile), (32, 32, 38))
d = ImageDraw.Draw(sheet)
for i, f in enumerate(files):
    im = Image.open(os.path.join(frames_dir, f)).convert("RGBA")
    im.thumbnail((tile - 8, tile - 8))
    x, y = (i % cols) * tile + 4, (i // cols) * tile + 4
    sheet.paste(im, (x, y), im)
    d.text((x + 4, y + 2), f, fill=(255, 255, 120))
sheet.save(out)
print(out, sheet.size, "tiles:", len(files))
