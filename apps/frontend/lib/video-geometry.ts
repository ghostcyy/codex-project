export type GeometryOperation = "none" | "scale" | "pad" | "crop" | "hflip" | "vflip" | "rotate";

export type GeometryState = {
  operation: GeometryOperation;
  scalePreset: string;
  scaleWidth: string;
  scaleHeight: string;
  scaleFitMode: string;
  padCanvas: string;
  padCustomWidth: string;
  padCustomHeight: string;
  padColor: string;
  padAlign: string;
  cropX: string;
  cropY: string;
  cropWidth: string;
  cropHeight: string;
  rotateMode: string;
  rotateDirection: string;
  rotateBackground: string;
  rotateCustomAngle: string;
};

export const DEFAULT_GEOMETRY_STATE: GeometryState = {
  operation: "none",
  scalePreset: "按宽度等比缩放",
  scaleWidth: "1280",
  scaleHeight: "720",
  scaleFitMode: "保持宽高比",
  padCanvas: "1280×720",
  padCustomWidth: "1280",
  padCustomHeight: "720",
  padColor: "black",
  padAlign: "居中",
  cropX: "100",
  cropY: "60",
  cropWidth: "640",
  cropHeight: "360",
  rotateMode: "none",
  rotateDirection: "cw",
  rotateBackground: "black",
  rotateCustomAngle: "90"
};

function normalizeDimension(value: string, fallback: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function getScalePreview(geometryState: GeometryState) {
  if (geometryState.scalePreset === "按宽度等比缩放") {
    return `-vf "scale=${normalizeDimension(geometryState.scaleWidth, "1280")}:-2"`;
  }

  if (geometryState.scalePreset === "按高度等比缩放") {
    return `-vf "scale=-2:${normalizeDimension(geometryState.scaleHeight, "720")}"`;
  }

  if (geometryState.scalePreset === "固定宽高输出") {
    return `-vf "scale=${normalizeDimension(geometryState.scaleWidth, "1280")}:${normalizeDimension(geometryState.scaleHeight, "720")}"`;
  }

  return `-vf "scale=${normalizeDimension(geometryState.scaleWidth, "1280")}:${normalizeDimension(geometryState.scaleHeight, "720")}:force_original_aspect_ratio=decrease:force_divisible_by=2"`;
}

function getPadPreview(geometryState: GeometryState) {
  const canvas =
    geometryState.padCanvas === "自定义画布"
      ? `${normalizeDimension(geometryState.padCustomWidth, "1280")}x${normalizeDimension(geometryState.padCustomHeight, "720")}`
      : geometryState.padCanvas.replace("×", "x");
  const [width, height] = canvas.split("x");
  let x = "(ow-iw)/2";
  let y = "(oh-ih)/2";

  if (geometryState.padAlign === "顶部居中") {
    y = "0";
  } else if (geometryState.padAlign === "底部居中") {
    y = "oh-ih";
  } else if (geometryState.padAlign === "左侧居中") {
    x = "0";
  } else if (geometryState.padAlign === "右侧居中") {
    x = "ow-iw";
  }

  return `-vf "pad=${width}:${height}:${x}:${y}:color=${geometryState.padColor === "blur" ? "black" : geometryState.padColor}"`;
}

function getCropPreview(geometryState: GeometryState) {
  return `-vf "crop=${normalizeDimension(geometryState.cropWidth, "960")}:${normalizeDimension(geometryState.cropHeight, "540")}:${normalizeDimension(geometryState.cropX, "160")}:${normalizeDimension(geometryState.cropY, "90")}"`;
}

function getRotatePreview(geometryState: GeometryState) {
  if (geometryState.rotateMode === "none") {
    return "";
  }

  if (geometryState.rotateMode === "水平翻转") {
    return `-vf "hflip"`;
  }

  if (geometryState.rotateMode === "垂直翻转") {
    return `-vf "vflip"`;
  }

  if (geometryState.rotateMode === "顺时针 90°") {
    const angle = Number.parseInt(normalizeDimension(geometryState.rotateCustomAngle, "90"), 10);
    const quarterTurns = ((((Number.isFinite(angle) ? angle : 90) / 90) % 4) + 4) % 4;
    if (quarterTurns === 0) {
      return "";
    }
    return `-vf "${Array.from({ length: quarterTurns }, () => "transpose=1").join(",")}"`;
  }

  if (geometryState.rotateMode === "逆时针 90°") {
    return `-vf "transpose=2"`;
  }

  if (geometryState.rotateMode === "180°") {
    return `-vf "transpose=2,transpose=2"`;
  }

  const fillColor = geometryState.rotateBackground === "保持原样" ? "black" : geometryState.rotateBackground;
  const angle = normalizeDimension(geometryState.rotateCustomAngle, "15");
  const signedAngle = geometryState.rotateDirection === "ccw" ? `-${angle}` : angle;
  return `-vf "rotate=${signedAngle}*PI/180:ow=rotw(iw):oh=roth(ih):fillcolor=${fillColor}"`;
}

export function buildGeometryCommandPreview(geometryState: GeometryState) {
  if (geometryState.operation === "none") {
    return "";
  }

  if (geometryState.operation === "scale") {
    return getScalePreview(geometryState);
  }

  if (geometryState.operation === "pad") {
    return getPadPreview(geometryState);
  }

  if (geometryState.operation === "crop") {
    return getCropPreview(geometryState);
  }

  if (geometryState.operation === "hflip") {
    return `-vf "hflip"`;
  }

  if (geometryState.operation === "vflip") {
    return `-vf "vflip"`;
  }

  return getRotatePreview(geometryState);
}
