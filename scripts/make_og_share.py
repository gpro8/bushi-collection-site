#!/usr/bin/env python3
"""Brand OG 1200×630 from locked 鍔. No t2i drift."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "og-share.jpg"
MARK = ROOT / "public" / "collection-mark.png"

W, H = 1200, 630
PAPER = (27, 25, 22)  # 漆黒
INK = (244, 241, 234)  # 白橡
GOLD = (198, 162, 79)  # #C6A24F
MUTED = (196, 184, 164)
LINE = (90, 78, 58)

FONT_DIR = Path("/System/Library/Fonts")
JP_W8 = FONT_DIR / "ヒラギノ角ゴシック W8.ttc"
JP_W4 = FONT_DIR / "ヒラギノ角ゴシック W4.ttc"
JP_W6 = FONT_DIR / "ヒラギノ角ゴシック W6.ttc"


def font(path: Path, size: int, index: int = 0) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size, index=index)


def main() -> None:
    im = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(im)

    # faint 七宝
    for y in range(-40, H + 80, 80):
        for x in range(-40, W + 80, 80):
            d.ellipse((x, y, x + 80, y + 80), outline=(198, 162, 79, 255))
    overlay = Image.new("RGB", (W, H), PAPER)
    im = Image.blend(overlay, im, 0.08)
    d = ImageDraw.Draw(im)

    # inner frame
    d.rectangle((36, 36, W - 37, H - 37), outline=LINE, width=2)
    d.rectangle((44, 44, W - 45, H - 45), outline=(70, 60, 44), width=1)

    mark = Image.open(MARK).convert("RGBA")
    mark = mark.resize((420, 420), Image.Resampling.LANCZOS)
    mx, my = 720, 95
    im.paste(mark, (mx, my), mark)

    title = font(JP_W8, 72)
    sub = font(JP_W4, 28)
    foot = font(JP_W4, 22)
    foot2 = font(JP_W6, 22)

    d.text((88, 200), "「武士コレ」", font=title, fill=INK)
    d.text((92, 292), "Bushi Collection  ·  BushiDAO", font=sub, fill=GOLD)
    d.line((88, 500, 680, 500), fill=LINE, width=1)
    d.text((88, 520), "Base  ·  ETH  ·  見るだけでもどうぞ", font=foot, fill=MUTED)
    d.text((88, 552), "作品は鍔を通る", font=foot2, fill=GOLD)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    im.save(OUT, "JPEG", quality=88, optimize=True)
    print(OUT, OUT.stat().st_size, im.size)


if __name__ == "__main__":
    main()
