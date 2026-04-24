import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { buildMetadata, runFfprobe } from "../../../../../lib/video-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const formData = await request.formData().catch(() => null);
  const uploadedFile = formData?.get("file");

  if (!(uploadedFile instanceof File)) {
    return NextResponse.json({ message: "未收到可解析的视频文件。" }, { status: 400 });
  }

  const tempDirectory = await fs.mkdtemp(path.join(tmpdir(), "codex-video-"));
  const sanitizedFileName = uploadedFile.name.replace(/[^\w.-]+/g, "_");
  const tempFilePath = path.join(tempDirectory, `${randomUUID()}-${sanitizedFileName}`);

  try {
    const fileBuffer = Buffer.from(await uploadedFile.arrayBuffer());
    await fs.writeFile(tempFilePath, fileBuffer);

    const probePayload = await runFfprobe(tempFilePath);
    const metadata = buildMetadata(probePayload, {
      fileName: uploadedFile.name,
      mimeType: uploadedFile.type || "未知格式",
      fileSizeBytes: uploadedFile.size
    });

    return NextResponse.json({ metadata });
  } catch (error) {
    const message = error instanceof Error ? error.message : "视频探测失败。";
    return NextResponse.json({ message }, { status: 500 });
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
