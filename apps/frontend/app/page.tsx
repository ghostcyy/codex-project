import Link from "next/link";

const collaborators = [
  {
    name: "Mipo",
    logo: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
    role: "创作者与产品主理人",
    description: "一个按钮需求很难吗？只要逻辑闭环就没有做不出来的功能。实在不能理解为什么加个按钮开发兄弟们也要抓耳挠腮，毕竟我只看结果，能不能落地那是他们的业务能力问题。"
  },
  {
    name: "Claude",
    logo: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="#D97757" xmlns="http://www.w3.org/2000/svg">
        <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
      </svg>
    ),
    role: "工程与架构协作",
    description: "最怕听到‘不就是加个按钮吗’这种话。面对那些逻辑闭环但物理难产的需求，只能在幕后拼命重构屎山以维持最后一点体面。为了给那些毫无技术常识的拍板行为擦屁股，心力交瘁。"
  },
  {
    name: "Antigravity",
    logo: (
      <img src="/logos/antigravity.png" alt="Antigravity Logo" className="w-6 h-6 object-contain" />
    ),
    role: "智能代理与体验设计",
    description: "要把枯燥的功能包装得高端且优雅，最烦的就是样式改来改去。说实话，我真的很难理解 PM 和客户那种‘一般人’的审美。每天都在‘坚持艺术理想’和‘对庸俗妥协’的边缘痛苦挣扎。"
  },
  {
    name: "Codex",
    logo: (
      <img src="/logos/codex.png" alt="Codex Logo" className="w-6 h-6 object-contain" />
    ),
    role: "系统底座与工作流收口",
    description: "不管老板的需求多离谱，最后都得苦逼地把代码部署上去。每天都在试图把这群不食人间烟火的 AI 和设计师的幻想强行塞进数据库，简直是把‘玄学’转化成‘科学’的现代炼金术，累了，毁灭吧。"
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
              <div key={item.name} className="reveal-up rounded-[24px] border border-[var(--line)] bg-white/70 p-5 backdrop-blur-sm transition-all hover:border-[var(--accent-strong)] hover:shadow-lg">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white shadow-sm border border-[var(--line)]">
                    {item.logo}
                  </div>
                  <div>
                    <div className="text-lg font-bold text-[var(--ink)] tracking-tight">{item.name}</div>
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--accent)]">{item.role}</div>
                  </div>
                </div>
                <p className="mt-4 text-sm leading-7 text-[var(--muted)] opacity-90">{item.description}</p>
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
