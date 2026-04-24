import type { Metadata } from "next";
import "./globals.css";
import { SiteFooter } from "../components/site-footer";
import { SiteHeader } from "../components/site-header";
import { ParticlesBg } from "../components/particles-bg";

export const metadata: Metadata = {
  title: "Mipo AI Brief",
  description: "面向个人品牌展示、HTML-PPT 生成与视频处理工具的个人网站。"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>
        <ParticlesBg />
        <SiteHeader />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
