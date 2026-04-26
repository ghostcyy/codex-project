"use client";

import React, { useState, useEffect } from "react";
import { Inter } from "next/font/google";
import Link from "next/link";

const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600", "700"] });

type IconProps = {
  className?: string;
};

const Star = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
    <path d="M12 2.7l2.8 5.8 6.4.9-4.6 4.5 1.1 6.4L12 17.4 6.3 20.3l1.1-6.4L2.8 9.4l6.4-.9L12 2.7z" />
  </svg>
);

const ChevronDown = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
);

const BarChart3 = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
    <path d="M3 3v18h18" />
    <path d="M7 15v-4M12 15V7M17 15v-6" />
  </svg>
);

const BookOpen = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
    <path d="M4 5a3 3 0 0 1 3-3h13v18H7a3 3 0 0 0-3 3V5z" />
    <path d="M12 6h6" />
  </svg>
);

const Users = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
    <circle cx="9" cy="8" r="3" />
    <path d="M2 19c0-3.3 2.7-6 6-6h2c3.3 0 6 2.7 6 6" />
    <circle cx="18" cy="8" r="2" />
  </svg>
);

const Rocket = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
    <path d="M6 14l4 4M10 18l-2 4M14 10l4-4c1.9-1.9 2.5-4.7 2.7-6.2-1.5.2-4.3.8-6.2 2.7l-4 4c-1.8 1.8-2.6 4.4-2.2 6.9 2.5.4 5.1-.4 6.9-2.2z" />
    <circle cx="15.5" cy="8.5" r="1.5" />
  </svg>
);

const CheckCircle2 = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className} aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12.5l2.5 2.5L16 9.5" />
  </svg>
);

const tabs = [
  { id: "analyse", label: "首页说明", icon: BarChart3 },
  { id: "train", label: "HTML-PPT", icon: BookOpen },
  { id: "testing", label: "视频处理", icon: Users },
  { id: "deploy", label: "作者协作", icon: Rocket },
];

export default function StellarPreview() {
  const [activeTab, setActiveTab] = useState("analyse");

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveTab((current) => {
        const currentIndex = tabs.findIndex((t) => t.id === current);
        const nextTab = tabs[(currentIndex + 1) % tabs.length];
        return nextTab?.id ?? tabs[0]?.id ?? "analyse";
      });
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  return (
    <main className={`${inter.className} min-h-screen bg-white text-black`}>
      {/* NAVIGATION */}
      <nav
        className="px-6 py-4 flex items-center justify-between max-w-7xl mx-auto animate-fade-in-up"
        style={{ animationDelay: "0.1s", opacity: 0 }}
      >
        <div className="flex items-center gap-2">
          <Star className="w-5 h-5 fill-black" />
          <span className="text-lg font-semibold tracking-tight">Codex</span>
        </div>

        <div className="hidden md:flex items-center gap-8">
          <button className="flex items-center gap-1 text-sm text-gray-700 hover:text-black transition-colors">
            平台功能 <ChevronDown className="w-4 h-4" />
          </button>
          <button className="flex items-center gap-1 text-sm text-gray-700 hover:text-black transition-colors">
            创作工具 <ChevronDown className="w-4 h-4" />
          </button>
          <Link href="/news" className="text-sm text-gray-700 hover:text-black transition-colors">今日资讯</Link>
          <Link href="/tools/html-ppt" className="text-sm text-gray-700 hover:text-black transition-colors">HTML-PPT</Link>
        </div>

        <div className="flex items-center gap-6">
          <Link href="/login" className="text-sm text-gray-700 hover:text-black transition-colors font-medium">
            登录
          </Link>
          <Link
            href="/tools/video-processing"
            className="bg-black text-white px-5 py-2.5 rounded-full text-sm font-medium hover:bg-gray-800 transition-colors"
          >
            打开视频工具
          </Link>
        </div>
      </nav>

      {/* HERO SECTION */}
      <section className="px-6 pt-24 pb-32 max-w-7xl mx-auto text-center">
        {/* Reviews Badge */}
        <div
          className="inline-flex items-center gap-2 mb-8 animate-fade-in-up"
          style={{ animationDelay: "0.2s", opacity: 0 }}
        >
          <div className="w-6 h-6 border border-gray-300 rounded flex items-center justify-center bg-white shadow-sm">
            <Star className="w-3.5 h-3.5 fill-black" />
          </div>
          <span className="text-sm font-medium text-black">Mipo 的内容与工具工作站</span>
        </div>

        {/* Main Heading */}
        <h1
          className="text-6xl md:text-7xl lg:text-[80px] font-normal leading-[1.1] tracking-tight mb-5 animate-fade-in-up"
          style={{ animationDelay: "0.3s", opacity: 0 }}
        >
          <div className="text-black">个人表达与资讯发布.</div>
          <div className="bg-gradient-to-r from-black via-gray-500 to-gray-400 bg-clip-text text-transparent">
            内容与工具持续演进.
          </div>
        </h1>

        {/* Subheading */}
        <p
          className="text-lg md:text-xl text-gray-600 mb-8 max-w-2xl mx-auto animate-fade-in-up"
          style={{ animationDelay: "0.4s", opacity: 0 }}
        >
          这里不是单纯的资讯页，也不是单纯的工具页。它同时承载个人表达、内容发布和创作工具，让网站本身变成一个持续演进的工作界面。
        </p>

        {/* CTA Button */}
        <Link href="/today" passHref>
          <button
            className="bg-black text-white px-8 py-3 rounded-full text-base font-medium hover:bg-gray-800 transition-colors mb-12 animate-fade-in-up shadow-sm hover:shadow-md"
            style={{ animationDelay: "0.5s", opacity: 0 }}
          >
            查看今日资讯
          </button>
        </Link>

        {/* Tab Bar */}
        <div
          className="mx-auto flex justify-center animate-fade-in-up"
          style={{ animationDelay: "0.6s", opacity: 0 }}
        >
          <div className="bg-gray-100 rounded-lg p-1 inline-block">
            {/* Mobile Tab Bar */}
            <div className="grid grid-cols-2 gap-1 md:hidden">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                      isActive ? "bg-white text-black shadow-sm" : "text-gray-600 hover:text-black"
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {tab.label}
                  </button>
                );
              })}
            </div>
            
            {/* Desktop Tab Bar */}
            <div className="hidden md:flex items-center">
              {tabs.map((tab, idx) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                return (
                  <React.Fragment key={tab.id}>
                    {idx > 0 && <div className="w-px h-5 bg-gray-300 mx-1" />}
                    <button
                      onClick={() => setActiveTab(tab.id)}
                      className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${
                        isActive ? "bg-white text-black shadow-sm" : "text-gray-600 hover:text-gray-900"
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      {tab.label}
                    </button>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        </div>

        {/* Video + Overlay Section */}
        <div
          className="mt-8 relative rounded-3xl overflow-hidden h-[400px] md:h-[500px] bg-gray-100 border border-gray-200/50 animate-fade-in-up"
          style={{ animationDelay: "0.7s", opacity: 0 }}
        >
          <video
            src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260319_165750_358b1e72-c921-48b7-aaac-f200994f32fb.mp4"
            autoPlay
            loop
            muted
            playsInline
            className="w-full h-full object-cover"
          />

          {/* Overlays */}
          {activeTab === "analyse" && (
            <div className="absolute inset-0 bg-black/5 backdrop-blur-[1px] animate-fade-in-overlay flex items-center justify-center">
              <div className="absolute top-1/2 left-1/2 bg-white rounded-2xl p-6 shadow-2xl w-[320px] animate-slide-up-overlay text-left">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-gray-900">站点构成说明</h3>
                  <span className="text-xs font-medium text-purple-600 bg-purple-100 px-2 py-1 rounded-full">25%</span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-1.5 mb-5 overflow-hidden">
                  <div className="bg-purple-600 h-1.5 rounded-full" style={{ width: "25%" }}></div>
                </div>
                <ul className="space-y-3">
                  {["个人品牌展示", "资讯发布平台", "HTML-PPT 工作流", "视频处理能力"].map((step, i) => (
                    <li key={i} className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${i === 0 ? "bg-purple-600 text-white" : "bg-gray-100 text-gray-400"}`}>
                        {i + 1}
                      </div>
                      <span className={`text-sm ${i === 0 ? "text-gray-900 font-medium" : "text-gray-500"}`}>{step}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {activeTab === "train" && (
            <div className="absolute inset-0 bg-black/5 backdrop-blur-[1px] animate-fade-in-overlay flex items-center justify-center">
              <div className="absolute top-1/2 left-1/2 bg-white rounded-2xl p-6 shadow-2xl w-[320px] animate-slide-up-overlay text-left">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-gray-900">HTML-PPT 生成中</h3>
                  <span className="text-xs font-medium text-orange-600 bg-orange-100 px-2 py-1 rounded-full">67%</span>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-1.5 mb-5 overflow-hidden">
                  <div className="bg-orange-500 h-1.5 rounded-full" style={{ width: "67%" }}></div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-gray-50 p-3 rounded-xl border border-gray-100">
                    <div className="text-xs text-gray-500 mb-1">大纲节点</div>
                    <div className="text-lg font-semibold text-gray-900">12</div>
                  </div>
                  <div className="bg-gray-50 p-3 rounded-xl border border-gray-100">
                    <div className="text-xs text-gray-500 mb-1">主题配置</div>
                    <div className="text-lg font-semibold text-gray-900">暗黑</div>
                  </div>
                  <div className="bg-gray-50 p-3 rounded-xl border border-gray-100">
                    <div className="text-xs text-gray-500 mb-1">动画方案</div>
                    <div className="text-lg font-semibold text-gray-900">丝滑</div>
                  </div>
                  <div className="bg-gray-50 p-3 rounded-xl border border-gray-100">
                    <div className="text-xs text-gray-500 mb-1">响应耗时</div>
                    <div className="text-lg font-semibold text-gray-900">2.4s</div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "testing" && (
            <div className="absolute inset-0 bg-black/5 backdrop-blur-[1px] animate-fade-in-overlay flex items-center justify-center">
              <div className="absolute top-1/2 left-1/2 bg-white rounded-2xl p-6 shadow-2xl w-[320px] animate-slide-up-overlay text-left">
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
                    <CheckCircle2 className="w-5 h-5 text-green-600" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900">视频处理完毕</h3>
                    <p className="text-xs text-green-600 font-medium">转码 & 几何缩放成功</p>
                  </div>
                </div>
                <div className="space-y-4">
                  <div>
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-gray-500">FFmpeg 转码</span>
                      <span className="text-gray-900 font-medium">100%</span>
                    </div>
                    <div className="w-full bg-gray-100 h-1 rounded-full"><div className="bg-green-500 h-1 rounded-full" style={{width: "100%"}}></div></div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-gray-500">视频流分析</span>
                      <span className="text-gray-900 font-medium">127/127 帧</span>
                    </div>
                    <div className="w-full bg-gray-100 h-1 rounded-full"><div className="bg-green-500 h-1 rounded-full" style={{width: "100%"}}></div></div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "deploy" && (
            <div className="absolute inset-0 bg-black/5 backdrop-blur-[1px] animate-fade-in-overlay flex items-center justify-center">
              <div className="absolute top-1/2 left-1/2 bg-white rounded-2xl p-6 shadow-2xl w-[320px] animate-slide-up-overlay text-left">
                <h3 className="font-semibold text-gray-900 mb-4">项目协作方</h3>
                <ul className="space-y-3 mb-5">
                  {[
                    {name: "Mipo", role: "创作者与主理人"},
                    {name: "Claude", role: "工程与架构协作"},
                    {name: "Antigravity", role: "智能代理与体验设计"},
                    {name: "Codex", role: "系统底座与工作流收口"}
                  ].map((item, i) => (
                    <li key={i} className="flex items-center gap-3">
                      <CheckCircle2 className="w-4 h-4 text-blue-500" />
                      <div>
                        <span className="text-sm font-medium text-gray-900 block">{item.name}</span>
                        <span className="text-xs text-gray-500">{item.role}</span>
                      </div>
                    </li>
                  ))}
                </ul>
                <button className="w-full bg-black text-white py-2.5 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors">
                  了解更多
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Company Logos */}
        <div
          className="mt-24 pt-8 animate-fade-in-up"
          style={{ animationDelay: "0.8s", opacity: 0 }}
        >
          <div className="flex flex-wrap justify-center items-center gap-8 md:gap-16 opacity-60 grayscale hover:grayscale-0 transition-all duration-500">
            {/* Mipo */}
            <div className="flex items-center gap-2">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-black">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              <span className="text-xl font-bold tracking-tight text-black">Mipo</span>
            </div>
            {/* Claude (M3 serif italic style) */}
            <div className="flex items-center gap-2">
              <span className="text-2xl font-serif font-bold italic text-black pr-2">Claude</span>
            </div>
            {/* Antigravity (INTERSCOPE tracking style) */}
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold tracking-[0.2em] text-black">ANTIGRAVITY</span>
            </div>
            {/* Codex (Nexera dot grid / vertex style) */}
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 border-2 border-black rounded-sm flex items-center justify-center">
                <div className="w-1.5 h-1.5 bg-black rounded-sm"></div>
              </div>
              <span className="text-xl font-semibold tracking-tighter text-black">Codex</span>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
