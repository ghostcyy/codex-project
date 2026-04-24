import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { readManifest } from "../../../../../../lib/video-server";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const manifest = readManifest(id);

  if (!manifest) {
    return NextResponse.json({ message: "输出视频不存在。" }, { status: 404 });
  }

  const fileBuffer = await readFile(manifest.absolutePath).catch(() => null);
  if (!fileBuffer) {
    return NextResponse.json({ message: "输出视频文件无法读取。" }, { status: 404 });
  }

  const url = new URL(request.url);
  const shouldDownload = url.searchParams.get("download") === "1";

  return new NextResponse(fileBuffer, {
    headers: {
      "Content-Type": manifest.mimeType,
      "Content-Length": String(fileBuffer.byteLength),
      "Content-Disposition": `${shouldDownload ? "attachment" : "inline"}; filename="${encodeURIComponent(manifest.fileName)}"`
    }
  });
}
