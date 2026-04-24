from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

import ffmpeg


VIDEO_CODEC_MAP = {
    "libx264": "libx264",
    "libx265": "libx265",
    "copy": "copy",
    "vp9": "libvpx-vp9",
    "libvpx-vp9": "libvpx-vp9",
    "av1": "libaom-av1",
    "libaom-av1": "libaom-av1",
    "mpeg4": "mpeg4",
    "libxvid": "libxvid",
    "libvpx": "libvpx",
}

AUDIO_CODEC_MAP = {
    "AAC": "aac",
    "aac": "aac",
    "copy": "copy",
    "Opus": "libopus",
    "mute": "mute",
}

OUTPUT_FORMAT_MAP = {
    "MP4": "mp4",
    "MOV": "mov",
    "MKV": "matroska",
    "WebM": "webm",
}

DEFAULT_GEOMETRY_CONFIG = {
    "operation": "none",
    "scalePreset": "按宽度等比缩放",
    "scaleWidth": "1280",
    "scaleHeight": "720",
    "scaleFitMode": "保持宽高比",
    "padCanvas": "1280×720",
    "padCustomWidth": "1280",
    "padCustomHeight": "720",
    "padColor": "black",
    "padAlign": "居中",
    "cropX": "100",
    "cropY": "60",
    "cropWidth": "640",
    "cropHeight": "360",
    "rotateMode": "none",
    "rotateDirection": "cw",
    "rotateBackground": "black",
    "rotateCustomAngle": "90",
}


def ensure_ffmpeg_python_bindings() -> None:
    required_attrs = ("input", "output", "probe", "run")
    missing = [name for name in required_attrs if not hasattr(ffmpeg, name)]
    if missing:
        raise SystemExit(
            "当前 `import ffmpeg` 导入的不是可用的 `ffmpeg-python` 绑定，"
            f"缺少属性: {', '.join(missing)}"
        )


def ensure_binary(binary: str, label: str) -> None:
    try:
        subprocess.run(
            [binary, "-version"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError as exc:
        raise SystemExit(f"找不到 {label}: {binary}") from exc
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"{label} 无法正常运行: {binary}") from exc


def has_audio_stream(ffprobe_bin: str, input_path: Path) -> bool:
    metadata = ffmpeg.probe(str(input_path), cmd=ffprobe_bin)
    return any(stream.get("codec_type") == "audio" for stream in metadata.get("streams", []))


def get_primary_video_stream_info(ffprobe_bin: str, input_path: Path) -> dict[str, object]:
    metadata = ffmpeg.probe(str(input_path), cmd=ffprobe_bin)
    for stream in metadata.get("streams", []):
        if stream.get("codec_type") == "video":
            return stream

    raise SystemExit("未能从输入文件中识别到视频流。")


def normalize_int(value: object, fallback: int, minimum: int = 1) -> int:
    try:
        parsed = int(str(value).strip())
        if parsed < minimum:
            return fallback
        return parsed
    except (TypeError, ValueError):
        return fallback


def ensure_even(value: int, minimum: int = 2) -> int:
    candidate = value if value % 2 == 0 else value - 1
    if candidate < minimum:
        return minimum
    return candidate


def get_alignment_expression(align: str, *, overlay: bool = False) -> tuple[str, str]:
    if overlay:
        x = "(main_w-overlay_w)/2"
        y = "(main_h-overlay_h)/2"
        if align in {"顶部居中", "top"}:
            y = "0"
        elif align in {"底部居中", "bottom"}:
            y = "main_h-overlay_h"
        elif align in {"左侧居中", "left"}:
            x = "0"
        elif align in {"右侧居中", "right"}:
            x = "main_w-overlay_w"
        return x, y

    x = "(ow-iw)/2"
    y = "(oh-ih)/2"
    if align in {"顶部居中", "top"}:
        y = "0"
    elif align in {"底部居中", "bottom"}:
        y = "oh-ih"
    elif align in {"左侧居中", "left"}:
        x = "0"
    elif align in {"右侧居中", "right"}:
        x = "ow-iw"
    return x, y


def resolve_fill_color(value: str) -> str:
    if value == "white":
        return "white"
    if value == "transparent":
        return "black@0"
    if value == "keep":
        return "black"
    return "black"


def parse_canvas_size(value: str, geometry: dict[str, object] | None = None) -> tuple[int, int]:
    normalized = value.strip()
    if normalized in {"自定义画布", "custom"}:
        return (
            normalize_int((geometry or {}).get("padCustomWidth"), 1280),
            normalize_int((geometry or {}).get("padCustomHeight"), 720),
        )

    parts = re.findall(r"\d+", normalized)
    if len(parts) < 2:
        return (1280, 720)

    return (
        normalize_int(parts[0], 1280),
        normalize_int(parts[1], 720),
    )


def normalize_geometry_config(raw: str | None) -> dict[str, object]:
    if not raw:
        return dict(DEFAULT_GEOMETRY_CONFIG)

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return dict(DEFAULT_GEOMETRY_CONFIG)

    if not isinstance(parsed, dict):
        return dict(DEFAULT_GEOMETRY_CONFIG)

    return {
        **DEFAULT_GEOMETRY_CONFIG,
        **parsed,
    }


def apply_scale(video_stream, geometry: dict[str, object]):
    width = ensure_even(normalize_int(geometry.get("scaleWidth"), 1280))
    height = ensure_even(normalize_int(geometry.get("scaleHeight"), 720))
    preset = str(geometry.get("scalePreset"))

    if preset in {"按宽度等比缩放", "fit_width"}:
        return video_stream.filter("scale", width, -2)
    if preset in {"按高度等比缩放", "fit_height"}:
        return video_stream.filter("scale", -2, height)
    if preset in {"固定宽高输出", "fixed"}:
        return video_stream.filter("scale", width, height)

    return video_stream.filter("scale", width, height, force_original_aspect_ratio="decrease", force_divisible_by=2)


def apply_pad(video_stream, geometry: dict[str, object]):
    canvas_width, canvas_height = parse_canvas_size(str(geometry.get("padCanvas")), geometry)
    align = str(geometry.get("padAlign"))
    color = str(geometry.get("padColor"))
    foreground = video_stream.filter(
        "scale",
        f"min(iw,{canvas_width})",
        f"min(ih,{canvas_height})",
        force_original_aspect_ratio="decrease",
    )

    if color == "blur":
        background = (
            video_stream
            .filter("scale", canvas_width, canvas_height, force_original_aspect_ratio="increase")
            .filter("crop", canvas_width, canvas_height)
            .filter("boxblur", 24)
        )
        x_expr, y_expr = get_alignment_expression(align, overlay=True)
        return ffmpeg.overlay(background, foreground, x=x_expr, y=y_expr)

    x_expr, y_expr = get_alignment_expression(align)
    return foreground.filter("pad", canvas_width, canvas_height, x_expr, y_expr, color=resolve_fill_color(color))


def apply_crop(video_stream, geometry: dict[str, object], video_info: dict[str, object]):
    source_width = normalize_int(video_info.get("width"), 1280)
    source_height = normalize_int(video_info.get("height"), 720)
    crop_width = min(ensure_even(normalize_int(geometry.get("cropWidth"), min(source_width, 640))), source_width)
    crop_height = min(ensure_even(normalize_int(geometry.get("cropHeight"), min(source_height, 360))), source_height)
    crop_x = ensure_even(normalize_int(geometry.get("cropX"), 0, minimum=0), minimum=0)
    crop_y = ensure_even(normalize_int(geometry.get("cropY"), 0, minimum=0), minimum=0)

    max_x = max(source_width - crop_width, 0)
    max_y = max(source_height - crop_height, 0)
    crop_x = min(crop_x, max_x)
    crop_y = min(crop_y, max_y)

    return video_stream.crop(crop_x, crop_y, crop_width, crop_height)


def apply_rotate(video_stream, geometry: dict[str, object]):
    rotate_mode = str(geometry.get("rotateMode"))
    fill_color = resolve_fill_color(str(geometry.get("rotateBackground")))
    rotate_direction = str(geometry.get("rotateDirection") or "cw")

    if rotate_mode in {"none", ""}:
        return video_stream
    if rotate_mode in {"水平翻转", "hflip"}:
        return video_stream.hflip()
    if rotate_mode in {"垂直翻转", "vflip"}:
        return video_stream.vflip()
    if rotate_mode in {"顺时针 90°", "cw_90"}:
        angle = normalize_int(geometry.get("rotateCustomAngle"), 90, minimum=0)
        quarter_turns = (angle // 90) % 4
        result = video_stream
        for _ in range(quarter_turns):
            result = result.filter("transpose", 1)
        return result
    if rotate_mode in {"逆时针 90°", "ccw_90"}:
        return video_stream.filter("transpose", 2)
    if rotate_mode in {"180°", "flip_180"}:
        return video_stream.filter("transpose", 2).filter("transpose", 2)

    angle = normalize_int(geometry.get("rotateCustomAngle"), 15, minimum=0)
    signed_angle = -angle if rotate_direction == "ccw" else angle
    return (
        video_stream
        .filter(
            "rotate",
            f"{signed_angle}*PI/180",
            ow="rotw(iw)",
            oh="roth(ih)",
            fillcolor=fill_color,
        )
        .filter("pad", "ceil(iw/2)*2", "ceil(ih/2)*2", "(ow-iw)/2", "(oh-ih)/2", color=fill_color)
    )


def apply_geometry(video_stream, geometry: dict[str, object], video_info: dict[str, object]):
    operation = str(geometry.get("operation") or "none")

    if operation == "none":
        return video_stream, False
    if operation == "scale":
        return apply_scale(video_stream, geometry), True
    if operation == "pad":
        return apply_pad(video_stream, geometry), True
    if operation == "crop":
        return apply_crop(video_stream, geometry, video_info), True
    if operation == "hflip":
        return video_stream.hflip(), True
    if operation == "vflip":
        return video_stream.vflip(), True
    if operation == "rotate":
        if str(geometry.get("rotateMode") or "none") in {"none", ""}:
            return video_stream, False
        return apply_rotate(video_stream, geometry), True

    return video_stream, False


def build_output_args(
    args: argparse.Namespace,
    input_has_audio: bool,
    geometry_active: bool,
) -> dict:
    output_args: dict[str, object] = {
        "format": OUTPUT_FORMAT_MAP.get(args.output_container, args.output_container.lower())
    }

    if args.packaging_mode == "仅换容器":
        output_args["vcodec"] = "copy"
        if input_has_audio:
            output_args["acodec"] = "copy"
        return output_args

    video_codec = VIDEO_CODEC_MAP.get(args.video_codec, args.video_codec)
    if geometry_active and video_codec == "copy":
        video_codec = "libx264"
    output_args["vcodec"] = video_codec

    if args.audio_codec_strategy in {"静音导出", "mute"}:
        output_args["an"] = None
    elif input_has_audio:
        output_args["acodec"] = AUDIO_CODEC_MAP.get(args.audio_codec_strategy, "aac")

    if video_codec != "copy" and args.output_container in {"MP4", "MOV"}:
        output_args["pix_fmt"] = "yuv420p"

    if args.packaging_mode == "faststart" and args.output_container in {"MP4", "MOV"}:
        output_args["movflags"] = "faststart"

    if args.packaging_mode == "高压缩优先" and video_codec != "copy":
        if video_codec == "libx264":
            output_args["crf"] = 28
            output_args["preset"] = "slow"
        elif video_codec == "libx265":
            output_args["crf"] = 30
            output_args["preset"] = "slow"
        elif video_codec in {"libvpx-vp9", "libaom-av1"}:
            output_args["crf"] = 32
            output_args["b:v"] = "0"

    return output_args


def main() -> None:
    parser = argparse.ArgumentParser(description="使用 ffmpeg-python 执行本地视频转码")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--ffmpeg-bin", required=True)
    parser.add_argument("--ffprobe-bin", required=True)
    parser.add_argument("--output-container", required=True)
    parser.add_argument("--video-codec", required=True)
    parser.add_argument("--audio-codec-strategy", required=True)
    parser.add_argument("--packaging-mode", required=True)
    parser.add_argument("--geometry-config", default="")
    args = parser.parse_args()

    ensure_ffmpeg_python_bindings()
    ensure_binary(args.ffmpeg_bin, "ffmpeg")
    ensure_binary(args.ffprobe_bin, "ffprobe")

    input_path = Path(args.input)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    input_has_audio = has_audio_stream(args.ffprobe_bin, input_path)
    video_info = get_primary_video_stream_info(args.ffprobe_bin, input_path)
    geometry = normalize_geometry_config(args.geometry_config)

    input_stream = ffmpeg.input(str(input_path))
    processed_video, geometry_active = apply_geometry(input_stream.video, geometry, video_info)
    output_args = build_output_args(args, input_has_audio, geometry_active)
    audio_disabled = "an" in output_args

    if audio_disabled or not input_has_audio:
        stream = ffmpeg.output(processed_video, str(output_path), **output_args)
    else:
        stream = ffmpeg.output(processed_video, input_stream.audio, str(output_path), **output_args)

    stream.run(cmd=args.ffmpeg_bin, overwrite_output=True, capture_stdout=True, capture_stderr=True)


if __name__ == "__main__":
    try:
        main()
    except ffmpeg.Error as exc:
        stderr = exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else str(exc.stderr)
        raise SystemExit(stderr or str(exc))
    except Exception as exc:
        raise SystemExit(str(exc))
