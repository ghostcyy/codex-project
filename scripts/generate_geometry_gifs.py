from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "apps" / "frontend" / "public" / "tools" / "geometry"
SOURCE = ASSET_DIR / "mona-lisa-source.jpg"
CANVAS = (480, 320)
FRAME_DURATION = 120


def fit_cover(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    source_ratio = image.width / image.height
    target_ratio = size[0] / size[1]
    if source_ratio > target_ratio:
        scaled_height = size[1]
        scaled_width = int(scaled_height * source_ratio)
    else:
        scaled_width = size[0]
        scaled_height = int(scaled_width / source_ratio)
    resized = image.resize((scaled_width, scaled_height), Image.Resampling.LANCZOS)
    left = (scaled_width - size[0]) // 2
    top = (scaled_height - size[1]) // 2
    return resized.crop((left, top, left + size[0], top + size[1]))


def add_caption(frame: Image.Image, title: str, note: str) -> Image.Image:
    font = ImageFont.load_default()
    overlay = frame.convert("RGBA")
    draw = ImageDraw.Draw(overlay)
    draw.rounded_rectangle((16, 16, 190, 72), radius=18, fill=(15, 20, 28, 195))
    draw.text((28, 28), title, fill=(255, 255, 255, 255), font=font)
    draw.text((28, 48), note, fill=(210, 220, 226, 255), font=font)
    return overlay.convert("P")


def save_gif(name: str, frames: list[Image.Image]) -> None:
    output_path = ASSET_DIR / f"{name}.gif"
    frames[0].save(
        output_path,
        save_all=True,
        append_images=frames[1:],
        optimize=False,
        duration=FRAME_DURATION,
        loop=0,
    )


def main() -> None:
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    base = fit_cover(Image.open(SOURCE).convert("RGB"), CANVAS)
    background = Image.new("RGB", CANVAS, "#0f1720")

    scale_frames: list[Image.Image] = []
    for scale in [0.72, 0.8, 0.9, 1.0, 1.08, 1.16, 1.08, 1.0, 0.9, 0.8]:
        scaled = base.resize((int(CANVAS[0] * scale), int(CANVAS[1] * scale)), Image.Resampling.LANCZOS)
        frame = background.copy()
        x = (CANVAS[0] - scaled.width) // 2
        y = (CANVAS[1] - scaled.height) // 2
        frame.paste(scaled, (x, y))
        scale_frames.append(add_caption(frame, "缩放", "scale"))
    save_gif("geometry-scale", scale_frames)

    pad_frames: list[Image.Image] = []
    inner_sizes = [(420, 236), (390, 220), (360, 202), (390, 220), (420, 236)]
    for inner_size in inner_sizes:
        frame = Image.new("RGB", CANVAS, "#111827")
        inner = fit_cover(base, inner_size)
        x = (CANVAS[0] - inner.width) // 2
        y = (CANVAS[1] - inner.height) // 2
        frame.paste(inner, (x, y))
        draw = ImageDraw.Draw(frame)
        draw.rounded_rectangle((x - 6, y - 6, x + inner.width + 6, y + inner.height + 6), radius=12, outline="#f8fafc", width=2)
        pad_frames.append(add_caption(frame, "补边", "pad"))
    save_gif("geometry-pad", pad_frames)

    crop_frames: list[Image.Image] = []
    crop_boxes = [
        (40, 18, 440, 302),
        (80, 36, 400, 284),
        (110, 48, 370, 270),
        (80, 36, 400, 284),
        (40, 18, 440, 302),
    ]
    for box in crop_boxes:
        frame = base.copy()
        draw = ImageDraw.Draw(frame)
        draw.rounded_rectangle(box, radius=20, outline="#f8fafc", width=4)
        crop_frames.append(add_caption(frame, "裁剪", "crop"))
    save_gif("geometry-crop", crop_frames)

    hflip_frames = [
        add_caption(base.copy(), "水平翻转", "hflip"),
        add_caption(ImageOps.mirror(base), "水平翻转", "hflip"),
    ] * 4
    save_gif("geometry-hflip", hflip_frames)

    vflip_frames = [
        add_caption(base.copy(), "垂直翻转", "vflip"),
        add_caption(ImageOps.flip(base), "垂直翻转", "vflip"),
    ] * 4
    save_gif("geometry-vflip", vflip_frames)

    rotate_frames: list[Image.Image] = []
    for angle in [0, 12, 24, 36, 48, 36, 24, 12]:
        rotated = base.convert("RGBA").rotate(angle, resample=Image.Resampling.BICUBIC, expand=False, fillcolor=(12, 18, 26, 255))
        rotate_frames.append(add_caption(rotated.convert("RGB"), "旋转", "rotate"))
    save_gif("geometry-rotate", rotate_frames)


if __name__ == "__main__":
    main()
