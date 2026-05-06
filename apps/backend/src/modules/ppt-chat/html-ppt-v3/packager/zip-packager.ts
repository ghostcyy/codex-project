/**
 * html-ppt-v3 :: packager/zip-packager.ts
 *
 * Copies the template directory into a temp output folder,
 * writes the injected index.html, and produces a .zip file.
 *
 * Uses only Node.js built-ins + the archiver-compatible approach:
 * since the project has no archiver dep, we produce a zip via
 * a streaming raw-zip writer identical to V2's zip-writer pattern.
 */

import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { HTML_PPT_V3_OUTPUT_DIR } from "../shared";

/* ─── Types ─────────────────────────────────────────────────────── */

export type PackagerInput = {
  templateDir:   string;   // absolute path to original template directory
  injectedHtml:  string;   // final HTML string
  templateId:    string;
  deckTitle:     string;   // used for zip filename
  jobId?:        string;
  preparedWorkdir?: string; // when Stage 3 already copied assets into workdirs/<jobId>
};

export type PackagerResult = {
  zipPath:   string;   // absolute path to the output zip file
  outputDir: string;   // absolute path to the previewable deck directory
  jobId:     string;
};

/* ─── Main ───────────────────────────────────────────────────────── */

export async function packageDeck(input: PackagerInput): Promise<PackagerResult> {
  const jobId = input.jobId ?? randomUUID();
  const workdirsRoot = join(HTML_PPT_V3_OUTPUT_DIR, "workdirs");
  const zipRoot = join(HTML_PPT_V3_OUTPUT_DIR, "output");
  const expectedOutDir = join(workdirsRoot, jobId);
  const outDir = input.preparedWorkdir ? resolve(input.preparedWorkdir) : expectedOutDir;
  if (input.preparedWorkdir && outDir !== resolve(expectedOutDir)) {
    throw new Error("Prepared HTML-PPT v3 workdir must be the job output directory.");
  }

  if (input.preparedWorkdir) {
    assertPreparedWorkdir(outDir);
  } else {
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    // Copy entire template directory (assets/, img/, style.css, *.js, etc.).
    await copyDirectory(input.templateDir, outDir, ["manifest.json"]);
  }
  await assertNoLegacyFragmentFiles(outDir);

  // Overwrite index.html with the injected version and a structure marker.
  await writeFile(join(outDir, "index.html"), addOutputMarker(input.injectedHtml), "utf8");

  // 3. Write video README into img/
  const imgDir = join(outDir, "img");
  await mkdir(imgDir, { recursive: true });
  const readmePath = join(imgDir, "README.txt");
  if (!existsSync(readmePath)) {
    await writeFile(readmePath, VIDEO_README, "utf8");
  }

  // 4. Build zip
  await mkdir(zipRoot, { recursive: true });
  const zipPath = join(zipRoot, `${jobId}.zip`);
  await buildZip(outDir, zipPath);

  return { zipPath, outputDir: outDir, jobId };
}

function assertPreparedWorkdir(outDir: string) {
  for (const required of ["manifest-v2.json", "shell.html", "fragments"]) {
    if (!existsSync(join(outDir, required))) {
      throw new Error(`Prepared HTML-PPT v3 workdir is missing ${required}.`);
    }
  }
}

async function assertNoLegacyFragmentFiles(outDir: string) {
  const fragmentsDir = join(outDir, "fragments");
  if (!existsSync(fragmentsDir)) return;
  const entries = await readdir(fragmentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".html")) continue;
    if (/^(cover|closing|deck-effects|slide-\d{2,3})\.html$/i.test(entry.name)) continue;
    throw new Error(`Legacy pageType fragment '${entry.name}' is not allowed in HTML-PPT v3 output.`);
  }
}

function addOutputMarker(html: string) {
  if (/data-html-ppt-v3-output=/i.test(html)) return html;
  return html.replace(/<html\b([^>]*)>/i, `<html$1 data-html-ppt-v3-output="fragment-id">`);
}

/* ─── Directory copy (recursive) ────────────────────────────────── */

async function copyDirectory(src: string, dest: string, excludeNames: string[]): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (excludeNames.includes(entry.name)) continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true });
      await copyDirectory(srcPath, destPath, excludeNames);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

/* ─── Minimal ZIP writer (no external deps) ─────────────────────── */
// Implements the ZIP local file header format (PKZIP 2.0 compatible).
// For binary correctness we use crc32 + DEFLATE-0 (store) for simplicity.
// If performance with large files is required, swap in `zlib.deflateSync`.

async function buildZip(srcDir: string, zipPath: string): Promise<void> {
  const files = await collectFiles(srcDir);
  const entries: ZipEntry[] = [];

  for (const { absPath, relPath } of files) {
    const data = await readFile(absPath);
    const crc = crc32(data);
    entries.push({ relPath, data, crc });
  }

  await writeZip(zipPath, entries);
}

type ZipEntry = { relPath: string; data: Buffer; crc: number };

async function collectFiles(dir: string): Promise<{ absPath: string; relPath: string }[]> {
  const result: { absPath: string; relPath: string }[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else {
        result.push({ absPath: abs, relPath: relative(dir, abs).replace(/\\/g, "/") });
      }
    }
  }
  return result.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function writeZip(zipPath: string, entries: ZipEntry[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(zipPath);
    const centralDir: Buffer[] = [];
    let offset = 0;

    out.on("error", reject);
    out.on("finish", () => resolve());

    for (const entry of entries) {
      const nameBytes = Buffer.from(entry.relPath, "utf8");
      const modTime = dosTime();

      // Local file header
      const local = Buffer.alloc(30 + nameBytes.length);
      local.writeUInt32LE(0x04034b50, 0);  // signature
      local.writeUInt16LE(20,  4);          // version needed
      local.writeUInt16LE(0x0800, 6);       // flags (UTF-8)
      local.writeUInt16LE(0,  8);           // compression (STORE)
      local.writeUInt16LE(modTime.time, 10);
      local.writeUInt16LE(modTime.date, 12);
      local.writeUInt32LE(entry.crc >>> 0, 14);
      local.writeUInt32LE(entry.data.length, 18); // compressed size
      local.writeUInt32LE(entry.data.length, 22); // uncompressed size
      local.writeUInt16LE(nameBytes.length, 26);
      local.writeUInt16LE(0, 28);           // extra field length
      nameBytes.copy(local, 30);

      // Central directory entry
      const cd = Buffer.alloc(46 + nameBytes.length);
      cd.writeUInt32LE(0x02014b50, 0);  // signature
      cd.writeUInt16LE(20, 4);           // version made by
      cd.writeUInt16LE(20, 6);           // version needed
      cd.writeUInt16LE(0x0800, 8);       // flags
      cd.writeUInt16LE(0, 10);           // compression
      cd.writeUInt16LE(modTime.time, 12);
      cd.writeUInt16LE(modTime.date, 14);
      cd.writeUInt32LE(entry.crc >>> 0, 16);
      cd.writeUInt32LE(entry.data.length, 20);
      cd.writeUInt32LE(entry.data.length, 24);
      cd.writeUInt16LE(nameBytes.length, 28);
      cd.writeUInt16LE(0, 30);           // extra
      cd.writeUInt16LE(0, 32);           // comment
      cd.writeUInt16LE(0, 34);           // disk start
      cd.writeUInt16LE(0, 36);           // internal attrs
      cd.writeUInt32LE(0, 38);           // external attrs
      cd.writeUInt32LE(offset, 42);      // relative offset
      nameBytes.copy(cd, 46);
      centralDir.push(cd);

      out.write(local);
      out.write(entry.data);
      offset += local.length + entry.data.length;
    }

    const cdBuffer = Buffer.concat(centralDir);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuffer.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    out.write(cdBuffer);
    out.end(eocd);
  });
}

function dosTime(): { time: number; date: number } {
  const now = new Date();
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1));
  const date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate());
  return { time, date };
}

/* ─── CRC-32 ─────────────────────────────────────────────────────── */
const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff);
}

/* ─── Constants ──────────────────────────────────────────────────── */

const VIDEO_README = `HTML-PPT Video Instructions
============================

This slide contains a video player.

To add your video:
  1. Place your video file in this directory (img/).
  2. Name it: video-main.mp4
  3. Open index.html in your browser — the video will load automatically.

Supported formats: .mp4 (recommended), .webm
The video will be scaled to fit the player container regardless of resolution.
`;
