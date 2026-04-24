import Link from "next/link";

const collaborators = [
  {
    name: "Mipo",
    role: "创作者与产品主理人",
    description: "负责站点方向、功能目标与内容判断，定义这个网站要解决什么问题，以及它最终应该呈现成什么样。"
  },
  {
    name: "Codex",
    role: "工程实现与系统协作",
    description: "负责前后端开发、数据库、部署与工具链收口，把需求落实成稳定可运行的页面和服务。"
  },
  {
    name: "Antigravity",
    role: "设计研究与方案建议",
    description: "负责从结构、设计表达与产品组织方式上提出建议，帮助页面和工具模块保持清晰一致。"
  }
];

const features = [
  {
    eyebrow: "站点说明",
    title: "这是一个围绕内容、表达和工具协同构建的网站。",
    description:
      "它既承担个人品牌展示，也承担资讯发布与工具承载的作用，让内容工作流和创作工具在同一个站点中持续演进。"
  },
  {
    eyebrow: "HTML-PPT",
    title: "HTML-PPT 模块用于生成基于网页的演示文稿。",
    description:
      "这个模块后续将承接内容输入、结构生成、页面预览和导出，目标是让 PPT 不再依赖传统软件，而是直接以网页形式生成和展示。"
  },
  {
    eyebrow: "视频处理",
    title: "视频处理工具已经具备上传、探测、转码与几何处理能力。",
    description:
      "当前模块已经覆盖视频信息读取、转码与封装、缩放、补边、裁剪和旋转等功能，后续可以继续扩展为完整的视频工作台。"
  }
];

export default function HomePage() {
  return (
    <div className="page-shell pb-24 pt-12 md:pt-20">
      <section className="reveal-up grid gap-12 lg:grid-cols-[minmax(0,1.2fr)_360px] lg:gap-16">
        <div className="glass-panel rounded-[38px] px-6 py-8 md:px-8 md:py-10">
          <div className="eyebrow">首页</div>
          <h1 className="display-title mt-5 max-w-4xl text-5xl font-semibold leading-[1.05] md:text-[68px]">
            Mipo 的内容与工具工作站
          </h1>
          <p className="mt-6 max-w-3xl text-base leading-8 text-[var(--muted)] md:text-lg">
            这里不是单纯的资讯页，也不是单纯的工具页。它同时承载个人表达、内容发布和创作工具，让网站本身变成一个持续演进的工作界面。
          </p>

          <div className="mt-8 flex flex-wrap gap-4">
            <Link href="/today" className="primary-button">
              查看今日资讯
            </Link>
            <Link href="/tools/html-ppt" className="ghost-button">
              进入 HTML-PPT
            </Link>
            <Link href="/tools/video-processing" className="ghost-button">
              打开视频工具
            </Link>
          </div>
        </div>

        <aside className="glass-panel rounded-[38px] px-6 py-8 md:px-8">
          <div className="eyebrow">作者与协作</div>
          <div className="mt-6 space-y-5">
            {collaborators.map((item) => (
              <div key={item.name} className="rounded-[24px] border border-[var(--line)] bg-white/72 p-5">
                <div className="text-lg font-semibold text-[var(--ink)]">{item.name}</div>
                <div className="mt-1 text-sm font-medium text-[var(--accent)]">{item.role}</div>
                <p className="mt-3 text-sm leading-7 text-[var(--muted)]">{item.description}</p>
              </div>
            ))}
          </div>
        </aside>
      </section>

      <section className="mt-14 grid gap-6 lg:grid-cols-3">
        {features.map((item) => (
          <article key={item.title} className="glass-panel reveal-up rounded-[30px] px-6 py-7 md:px-7">
            <div className="eyebrow">{item.eyebrow}</div>
            <h2 className="mt-5 text-2xl font-semibold leading-snug text-[var(--ink)]">{item.title}</h2>
            <p className="mt-4 text-sm leading-7 text-[var(--muted)] md:text-base">{item.description}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
