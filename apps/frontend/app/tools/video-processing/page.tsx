import { VideoProcessingStudio } from "../../../components/tools/video-processing-studio";

export default function VideoProcessingPage() {
  return (
    <div className="page-shell pb-12 pt-8">
      <section className="glass-panel reveal-up rounded-[38px] px-6 py-8 md:px-8">
        <div className="eyebrow">实用工具</div>
        <h1 className="display-title mt-5 text-4xl font-semibold md:text-5xl">视频处理</h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-[var(--muted)] md:text-base">
          现在这个页面除了本地上传和当前页播放，还会在右侧给出基于 FFmpeg / ffprobe 的完整视频探测信息。下面也已经按九大处理模块铺好了功能选择区，后续可以直接往真实处理链路接。
        </p>

        <VideoProcessingStudio />
      </section>
    </div>
  );
}
