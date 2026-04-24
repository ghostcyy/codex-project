"use client";

import { VideoCropEditor } from "./video-crop-editor";
import { VideoPadEditor } from "./video-pad-editor";
import { VideoRotateEditor } from "./video-rotate-editor";
import { VideoScaleEditor } from "./video-scale-editor";
import { DEFAULT_GEOMETRY_STATE, buildGeometryCommandPreview, type GeometryOperation, type GeometryState } from "../../lib/video-geometry";
import type { VideoMetadata } from "../../lib/video-metadata";
import { DEFAULT_TRANSCODE_OPTIONS, buildTranscodeCommandPreview, type TranscodeOptions } from "../../lib/video-transcode";

type ModuleControl =
  | {
      type: "select";
      label: string;
      options: string[];
      defaultValue?: string;
    }
  | {
      type: "text";
      label: string;
      placeholder: string;
      defaultValue?: string;
    }
  | {
      type: "multiselect";
      label: string;
      options: string[];
    };

type ModuleGroup = {
  id: string;
  title: string;
  code: string;
  description: string;
  features: string[];
  controls: ModuleControl[];
};

const GEOMETRY_EXPLAINERS: Record<
  Exclude<GeometryOperation, "none">,
  {
    title: string;
    description: string;
    tips: string[];
  }
> = {
  scale: {
    title: "缩放",
    description: "调整输出分辨率，可以保持宽高比，也可以固定目标尺寸输出。",
    tips: ["适合统一清晰度", "可按宽或按高等比缩放", "固定宽高时会强制拉伸"]
  },
  pad: {
    title: "补边",
    description: "在不裁切主体的前提下，把原视频补到目标画布尺寸或比例。",
    tips: ["适合横竖屏适配", "可选黑边、白边等填充", "支持居中或边缘对齐"]
  },
  crop: {
    title: "裁剪",
    description: "按指定区域裁掉边缘内容，保留画面重点区域。",
    tips: ["适合做局部聚焦", "需要明确 x/y 和宽高", "常用于横转竖或去边角内容"]
  },
  hflip: {
    title: "旋转",
    description: "统一承载水平翻转、垂直翻转和各类旋转，用于方向修正和镜像处理。",
    tips: ["支持水平和垂直翻转", "支持 90°、180° 与自定义角度", "右侧会直接演示第一帧效果"]
  },
  vflip: {
    title: "旋转",
    description: "统一承载水平翻转、垂直翻转和各类旋转，用于方向修正和镜像处理。",
    tips: ["支持水平和垂直翻转", "支持 90°、180° 与自定义角度", "右侧会直接演示第一帧效果"]
  },
  rotate: {
    title: "旋转",
    description: "统一承载水平翻转、垂直翻转和各类旋转，用于方向修正和镜像处理。",
    tips: ["支持水平和垂直翻转", "支持 90°、180° 与自定义角度", "右侧会直接演示第一帧效果"]
  }
};

const TRANSCODE_CONTAINER_OPTIONS = [
  { label: "MP4", value: "MP4" },
  { label: "MOV", value: "MOV" },
  { label: "MKV", value: "MKV" },
  { label: "WebM", value: "WebM" }
] as const;

const TRANSCODE_CODEC_OPTIONS = [
  { label: "不变", value: "copy" },
  { label: "H.264", value: "libx264" },
  { label: "H.265", value: "libx265" },
  { label: "VP9", value: "libvpx-vp9" },
  { label: "AV1", value: "libaom-av1" },
  { label: "MPEG-4", value: "mpeg4" },
  { label: "Xvid", value: "libxvid" },
  { label: "VP8", value: "libvpx" }
] as const;

const TRANSCODE_AUDIO_OPTIONS = [
  { label: "不变", value: "copy" },
  { label: "AAC", value: "AAC" },
  { label: "Opus", value: "Opus" },
  { label: "静音导出", value: "mute" }
] as const;

const TRANSCODE_PACKAGING_OPTIONS = [
  { label: "标准封装", value: "标准封装" },
  { label: "网页优化", value: "faststart" }
] as const;

const VIDEO_MODULE_GROUPS: ModuleGroup[] = [
  {
    id: "transcode",
    title: "转码与封装",
    code: "XCODE / COPY / CMD",
    description: "围绕当前视频的容器和编码策略，先完成转码与封装的输出参数选择。",
    features: ["切换输出容器", "调整视频编码器", "选择音频编码", "生成封装参数"],
    controls: []
  },
  {
    id: "geometry",
    title: "画面几何处理",
    code: "SCALE / PAD / CROP / ROTATE",
    description: "负责分辨率、画布比例、裁剪和翻转旋转等几何操作。",
    features: ["缩放", "补边", "裁剪", "旋转"],
    controls: []
  },
  {
    id: "timeline",
    title: "时间轴与片段处理",
    code: "TRIM / FPS / SPEED / CONCAT",
    description: "处理起止时间、片段拼接、变速和帧率输出，是剪辑型任务的基础。",
    features: ["片段截取", "调整帧率", "视频加速", "视频慢放", "倒放", "多段拼接"],
    controls: [
      {
        type: "text",
        label: "时间范围",
        placeholder: "00:00:05 - 00:00:12"
      },
      {
        type: "select",
        label: "输出帧率",
        options: ["保持原始", "24 fps", "30 fps", "60 fps", "15 fps"],
        defaultValue: "保持原始"
      },
      {
        type: "select",
        label: "播放速度",
        options: ["0.5x", "1x", "1.5x", "2x", "4x"],
        defaultValue: "1x"
      }
    ]
  },
  {
    id: "compose",
    title: "画面合成与内容标注",
    code: "OVERLAY / PIP / TEXT / SUB",
    description: "适合做水印、画中画、字幕、标注框和对比展示等内容合成。",
    features: ["叠加水印", "画中画", "文字标注", "框线标注", "字幕烧录", "分流对比图"],
    controls: [
      {
        type: "text",
        label: "叠加素材路径",
        placeholder: "例如: logo.png / subtitle.srt"
      },
      {
        type: "select",
        label: "画中画位置",
        options: ["右下角", "右上角", "左下角", "左上角", "自定义"],
        defaultValue: "右下角"
      },
      {
        type: "multiselect",
        label: "标注开关",
        options: ["标题文字", "时间戳", "说明框", "字幕烧录", "左右对比"]
      }
    ]
  },
  {
    id: "color",
    title: "色彩与视觉效果",
    code: "HUE / EQ / BW / ZOOMPAN",
    description: "负责基础调色、黑白化、通道混色和镜头推拉等视觉风格处理。",
    features: ["色相与饱和度", "亮度对比度饱和度", "黑白化", "色彩通道混合", "推拉镜头效果"],
    controls: [
      {
        type: "select",
        label: "风格预设",
        options: ["自然", "电影感", "黑白", "高饱和", "冷调"],
        defaultValue: "自然"
      },
      {
        type: "text",
        label: "亮度 / 对比度 / 饱和度",
        placeholder: "例如: 0.03 / 1.15 / 1.2"
      },
      {
        type: "multiselect",
        label: "视觉效果",
        options: ["去色", "色相偏移", "通道混合", "推镜", "拉镜"]
      }
    ]
  },
  {
    id: "frames",
    title: "帧、截图与图像序列",
    code: "THUMB / FRAME / V2F / F2V",
    description: "用于提取封面、按帧检查、拆帧做分析，或将图像序列重新合成为视频。",
    features: ["缩略图", "读取单帧为 JPEG", "视频导出为帧序列", "帧序列合成视频", "原始帧读入内存"],
    controls: [
      {
        type: "select",
        label: "截图模式",
        options: ["封面缩略图", "指定帧", "时间点截图", "连续拆帧"],
        defaultValue: "封面缩略图"
      },
      {
        type: "text",
        label: "时间点 / 帧号",
        placeholder: "例如: 00:00:01.5 或 frame 30"
      },
      {
        type: "select",
        label: "导出图像格式",
        options: ["JPG", "PNG", "WebP"],
        defaultValue: "JPG"
      }
    ]
  },
  {
    id: "av",
    title: "音视频协同处理",
    code: "AVKEEP / AVPIPE / AVCONCAT",
    description: "处理视频滤镜保留原音、音视频分别加工以及多段音视频拼接。",
    features: ["视频处理但保留原音频", "音视频分别处理后再合并", "多段音视频一起拼接"],
    controls: [
      {
        type: "select",
        label: "音频策略",
        options: ["保留原音频", "静音导出", "重新编码 AAC", "单独处理后合并"],
        defaultValue: "保留原音频"
      },
      {
        type: "select",
        label: "音量调整",
        options: ["保持原样", "0.8x", "1.2x", "2.0x"],
        defaultValue: "保持原样"
      },
      {
        type: "multiselect",
        label: "拼接策略",
        options: ["视频连续拼接", "音频连续拼接", "统一采样率", "统一帧率"]
      }
    ]
  },
  {
    id: "stream",
    title: "实时流、异步处理与管道",
    code: "ASYNC / PIPE / STREAM / PROGRESS",
    description: "适合实时流读取、推流、双进程管道、批量多输出和进度监控。",
    features: ["异步运行 FFmpeg", "双进程管道传帧", "读取网络视频流", "推送网络视频流", "一次命令多个输出", "获取进度信息"],
    controls: [
      {
        type: "select",
        label: "任务模式",
        options: ["本地文件", "网络拉流", "RTMP 推流", "多输出任务"],
        defaultValue: "本地文件"
      },
      {
        type: "text",
        label: "流地址 / 输出地址",
        placeholder: "例如: rtsp://example/live 或 rtmp://..."
      },
      {
        type: "multiselect",
        label: "监控与输出",
        options: ["显示进度", "保存日志", "多分辨率输出", "生成缩略图"]
      }
    ]
  },
  {
    id: "graph",
    title: "复杂滤镜图",
    code: "GRAPH / VIEW",
    description: "用于把多段处理链拼成复杂滤镜图，并导出图结构做调试。",
    features: ["多片段截取后拼接再叠图", "导出滤镜图结构", "复杂多节点链路编排"],
    controls: [
      {
        type: "select",
        label: "滤镜图模板",
        options: ["基础链路", "拼接叠图", "分屏对比", "自定义 graph"],
        defaultValue: "基础链路"
      },
      {
        type: "text",
        label: "graph 表达式",
        placeholder: "后续可直接填写 filter_complex 表达式"
      },
      {
        type: "multiselect",
        label: "调试选项",
        options: ["导出 graph 结构图", "保留中间节点", "显示命令行", "显示节点日志"]
      }
    ]
  }
];

function renderControl(control: ModuleControl) {
  if (control.type === "select") {
    return (
      <label key={control.label} className="block">
        <span className="mb-2 block text-sm font-medium text-[var(--ink)]">{control.label}</span>
        <select defaultValue={control.defaultValue} className="select-input">
          {control.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (control.type === "text") {
    return (
      <label key={control.label} className="block">
        <span className="mb-2 block text-sm font-medium text-[var(--ink)]">{control.label}</span>
        <input type="text" defaultValue={control.defaultValue} placeholder={control.placeholder} className="text-input" />
      </label>
    );
  }

  return (
    <fieldset key={control.label}>
      <legend className="mb-3 text-sm font-medium text-[var(--ink)]">{control.label}</legend>
      <div className="flex flex-wrap gap-3">
        {control.options.map((option) => (
          <label
            key={option}
            className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-[var(--line)] bg-white/75 px-4 py-2 text-sm text-[var(--muted)]"
          >
            <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" />
            <span>{option}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function renderTranscodeParameters(options: TranscodeOptions, onChange: (next: TranscodeOptions) => void) {
  const update = <Key extends keyof TranscodeOptions>(key: Key, value: TranscodeOptions[Key]) => {
    onChange({
      ...options,
      [key]: value
    });
  };

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="mb-3 text-sm font-medium text-[var(--ink)]">输出容器</legend>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {TRANSCODE_CONTAINER_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex min-h-[52px] cursor-pointer items-center gap-2 rounded-[16px] border border-[var(--line)] bg-white/78 px-3 py-2 text-sm text-[var(--ink)]"
            >
              <input
                type="radio"
                name="output-container"
                value={option.value}
                checked={options.outputContainer === option.value}
                onChange={() => update("outputContainer", option.value)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-3 text-sm font-medium text-[var(--ink)]">视频编码器</legend>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {TRANSCODE_CODEC_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex min-h-[52px] cursor-pointer items-center gap-2 rounded-[16px] border border-[var(--line)] bg-white/78 px-3 py-2 text-sm text-[var(--ink)]"
            >
              <input
                type="radio"
                name="video-codec"
                value={option.value}
                checked={options.videoCodec === option.value}
                onChange={() => update("videoCodec", option.value)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-3 text-sm font-medium text-[var(--ink)]">音频编码策略</legend>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {TRANSCODE_AUDIO_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex min-h-[52px] cursor-pointer items-center gap-2 rounded-[16px] border border-[var(--line)] bg-white/78 px-3 py-2 text-sm text-[var(--ink)]"
            >
              <input
                type="radio"
                name="audio-codec"
                value={option.value}
                checked={options.audioCodecStrategy === option.value}
                onChange={() => update("audioCodecStrategy", option.value)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-3 text-sm font-medium text-[var(--ink)]">封装优化</legend>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {TRANSCODE_PACKAGING_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex min-h-[52px] cursor-pointer items-center gap-2 rounded-[16px] border border-[var(--line)] bg-white/78 px-3 py-2 text-sm text-[var(--ink)]"
            >
              <input
                type="radio"
                name="packaging-mode"
                value={option.value}
                checked={options.packagingMode === option.value}
                onChange={() => update("packagingMode", option.value)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

function renderGeometryParameters(
  geometryState: GeometryState,
  onChange: (next: GeometryState) => void,
  sourceFile: File | null,
  sourcePreviewUrl: string | null,
  videoMetadata: VideoMetadata | null
) {
  const update = <Key extends keyof GeometryState>(key: Key, value: GeometryState[Key]) => {
    onChange({
      ...geometryState,
      [key]: value
    });
  };

  if (geometryState.operation === "scale") {
    return (
      <VideoScaleEditor
        geometryState={geometryState}
        onGeometryStateChange={onChange}
        sourcePreviewUrl={sourcePreviewUrl}
        videoMetadata={videoMetadata}
      />
    );
  }

  if (geometryState.operation === "pad") {
    return (
      <VideoPadEditor
        geometryState={geometryState}
        onGeometryStateChange={onChange}
        sourcePreviewUrl={sourcePreviewUrl}
        videoMetadata={videoMetadata}
      />
    );
  }

  if (geometryState.operation === "crop") {
    return (
      <VideoCropEditor
        sourceFile={sourceFile}
        sourcePreviewUrl={sourcePreviewUrl}
        videoMetadata={videoMetadata}
        geometryState={geometryState}
        onGeometryStateChange={onChange}
      />
    );
  }

  return (
    <VideoRotateEditor
      geometryState={geometryState.operation === "hflip"
        ? { ...geometryState, operation: "rotate", rotateMode: "水平翻转" }
        : geometryState.operation === "vflip"
          ? { ...geometryState, operation: "rotate", rotateMode: "垂直翻转" }
          : geometryState}
      onGeometryStateChange={onChange}
      sourcePreviewUrl={sourcePreviewUrl}
    />
  );
}

function renderLeftPanel(
  module: ModuleGroup,
  geometryState: GeometryState,
  onGeometryOperationChange: (operation: GeometryOperation) => void
) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-xl font-semibold text-[var(--ink)]">{module.title}</h3>
        <span className="data-pill">{module.code}</span>
      </div>
      <p className="mt-4 text-sm leading-7 text-[var(--muted)]">{module.description}</p>

      {module.id === "geometry" ? (
        <div className="mt-5 flex flex-wrap gap-3">
          {module.features.map((feature) => {
            const featureToOperation = {
              缩放: "scale",
              补边: "pad",
              裁剪: "crop",
              旋转: "rotate"
            } as const;
            const operation = featureToOperation[feature as keyof typeof featureToOperation];
            const isActive = geometryState.operation === operation;

            return (
              <button
                key={feature}
                type="button"
                onClick={() => onGeometryOperationChange(operation)}
                className={isActive ? "primary-button px-4 py-2 text-sm" : "soft-button px-4 py-2 text-sm"}
              >
                {feature}
              </button>
            );
          })}
        </div>
      ) : module.id !== "transcode" ? (
        <div className="mt-5 flex flex-wrap gap-3">
          {module.features.map((feature) => (
            <button key={feature} type="button" className="soft-button px-4 py-2 text-sm">
              {feature}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

export function VideoModuleSelector({
  activeModuleId,
  executionMode,
  onActiveModuleChange,
  sourceFile,
  sourcePreviewUrl,
  videoMetadata,
  options,
  onOptionsChange,
  geometryState,
  onGeometryStateChange
}: {
  activeModuleId: string;
  executionMode: "transcode" | "geometry";
  onActiveModuleChange: (nextModuleId: string) => void;
  sourceFile: File | null;
  sourcePreviewUrl: string | null;
  videoMetadata: VideoMetadata | null;
  options: TranscodeOptions;
  onOptionsChange: (next: TranscodeOptions) => void;
  geometryState: GeometryState;
  onGeometryStateChange: (next: GeometryState) => void;
}) {
  const activeModule = VIDEO_MODULE_GROUPS.find((moduleGroup) => moduleGroup.id === activeModuleId) ?? VIDEO_MODULE_GROUPS[0]!;
  const effectiveTranscodeOptions =
    executionMode === "transcode" ? options : DEFAULT_TRANSCODE_OPTIONS;
  const effectiveGeometryState =
    executionMode === "geometry" ? geometryState : DEFAULT_GEOMETRY_STATE;
  const geometryPreview = buildGeometryCommandPreview(effectiveGeometryState);
  const commandPreview = buildTranscodeCommandPreview(effectiveTranscodeOptions, geometryPreview);
  const activeGeometryExplainer = geometryState.operation === "none" ? null : GEOMETRY_EXPLAINERS[geometryState.operation];

  return (
    <section className="surface-card mt-8 min-h-[420px] rounded-[32px] px-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">功能选择区</p>
          <h2 className="mt-4 text-2xl font-semibold text-[var(--ink)]">九大 FFmpeg 模块</h2>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-[var(--muted)]">
            这里先把功能分类和参数控件铺好。当前优先接通第一块“转码与封装”，其它模块继续保留为后续入口。
          </p>
        </div>
        <div className="data-pill">{VIDEO_MODULE_GROUPS.length} 个功能大类</div>
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        {VIDEO_MODULE_GROUPS.map((moduleGroup) => {
          const isActive = moduleGroup.id === activeModule.id;
          return (
            <button
              key={moduleGroup.id}
              type="button"
              onClick={() => onActiveModuleChange(moduleGroup.id)}
              className={isActive ? "primary-button px-4 py-2 text-sm" : "ghost-button border border-[var(--line)] px-4 py-2 text-sm"}
            >
              {moduleGroup.title}
            </button>
          );
        })}
      </div>

      <div className="mt-8 rounded-[28px] border border-[var(--line)] bg-white/72 p-5">
        {activeModule.id === "geometry" ? (
          <div>
            <div>{renderLeftPanel(activeModule, geometryState, (operation) => onGeometryStateChange({ ...geometryState, operation }))}</div>

            <div className="mt-5 border-t border-[var(--line)] pt-5">
              <h3 className="text-lg font-semibold text-[var(--ink)]">几何处理参数</h3>
              {activeGeometryExplainer ? (
                <>
                  <p className="mt-2 text-sm leading-7 text-[var(--muted)]">{activeGeometryExplainer.description}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {activeGeometryExplainer.tips.map((tip) => (
                      <span key={tip} className="data-pill">
                        {tip}
                      </span>
                    ))}
                  </div>
                  <div className="mt-5">{renderGeometryParameters(geometryState, onGeometryStateChange, sourceFile, sourcePreviewUrl, videoMetadata)}</div>
                </>
              ) : (
                <div className="mt-5 rounded-[20px] border border-[var(--line)] bg-[var(--accent-softer)] px-4 py-4 text-sm leading-7 text-[var(--muted)]">
                  当前未启用几何处理。选择上方任意一个功能后，下面会显示对应的参数控件，转码命令也会同步加入对应的滤镜。
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div>{renderLeftPanel(activeModule, geometryState, (operation) => onGeometryStateChange({ ...geometryState, operation }))}</div>

            <div className="mt-5 border-t border-[var(--line)] pt-5">
              <h3 className="text-lg font-semibold text-[var(--ink)]">
                {activeModule.id === "transcode" ? "转换参数" : "参数控件草模"}
              </h3>
              <div className="mt-5">
                {activeModule.id === "transcode"
                  ? renderTranscodeParameters(options, onOptionsChange)
                  : <div className="space-y-5">{activeModule.controls.map((control) => renderControl(control))}</div>}
              </div>

            </div>
          </>
        )}

        <div className="mt-5 rounded-[20px] border border-[var(--line)] bg-[var(--accent-softer)] px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">提示行</p>
          <p className="mt-2 text-sm text-[var(--muted)]">
            {executionMode === "transcode"
              ? "当前执行模式：转码与封装。画面几何处理参数已被隔离，不会参与本次输出。"
              : "当前执行模式：画面几何处理。转码与封装参数已被隔离，不会参与本次输出。"}
          </p>
          <p className="mt-2 overflow-x-auto whitespace-nowrap text-sm text-[var(--ink)]">{commandPreview}</p>
        </div>
      </div>
    </section>
  );
}
