import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

type TemplatePackage = {
  id?: string;
  aspectRatio?: string;
  rendererProfile?: string;
  thumbnailFile?: string;
};

type RenderTarget = {
  id: string;
  dir: string;
  packagePath: string;
  htmlPath: string;
  thumbnailPath: string;
  viewport: {
    width: number;
    height: number;
  };
};

const STANDARD_VIEWPORT = { width: 1280, height: 720 };
const SOCIAL_PORTRAIT_VIEWPORT = { width: 810, height: 1080 };

async function main() {
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  const fullDecksRoot = resolve(workspaceRoot, ".agents", "skills", "html-ppt", "templates", "full-decks");
  const targets = await discoverTargets(fullDecksRoot);
  if (!targets.length) {
    throw new Error(`No template packages found under ${fullDecksRoot}`);
  }

  const browser = await chromium.launch();
  try {
    const results = [];
    for (const target of targets) {
      const page = await browser.newPage({
        viewport: target.viewport,
        deviceScaleFactor: 1
      });
      try {
        await renderThumbnail(page, target);
        await updateTemplatePackage(target.packagePath);
        results.push({
          id: target.id,
          thumbnail: target.thumbnailPath,
          viewport: `${target.viewport.width}x${target.viewport.height}`
        });
      } finally {
        await page.close();
      }
    }
    console.log(JSON.stringify({ generated: results.length, results }, null, 2));
  } finally {
    await browser.close();
  }
}

async function discoverTargets(fullDecksRoot: string): Promise<RenderTarget[]> {
  const entries = await readdir(fullDecksRoot, { withFileTypes: true });
  const targets: RenderTarget[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(fullDecksRoot, entry.name);
    const packagePath = join(dir, "template-package.json");
    const htmlPath = join(dir, "index.html");
    if (!existsSync(packagePath) || !existsSync(htmlPath)) continue;

    const templatePackage = JSON.parse(await readFile(packagePath, "utf8")) as TemplatePackage;
    const id = templatePackage.id || entry.name;
    const isPortrait = templatePackage.aspectRatio === "3:4" || templatePackage.rendererProfile === "social-portrait";
    targets.push({
      id,
      dir,
      packagePath,
      htmlPath,
      thumbnailPath: join(dir, "thumbnail.png"),
      viewport: isPortrait ? SOCIAL_PORTRAIT_VIEWPORT : STANDARD_VIEWPORT
    });
  }
  return targets.sort((a, b) => a.id.localeCompare(b.id));
}

async function renderThumbnail(page: Page, target: RenderTarget) {
  const url = new URL(pathToFileURL(target.htmlPath).toString());
  url.searchParams.set("preview", "1");
  await page.goto(url.toString(), { waitUntil: "networkidle" });
  await page.evaluate(() => {
    document.documentElement.style.setProperty("background", "transparent");
    const activeSlide = document.querySelector<HTMLElement>(".slide.is-active") || document.querySelector<HTMLElement>(".slide");
    if (activeSlide) {
      activeSlide.style.transition = "none";
      activeSlide.style.animation = "none";
    }
  });
  await page.evaluate(() => document.fonts.ready);
  await mkdir(dirname(target.thumbnailPath), { recursive: true });
  await page.screenshot({
    path: target.thumbnailPath,
    type: "png",
    fullPage: false,
    animations: "disabled"
  });
}

async function updateTemplatePackage(packagePath: string) {
  const raw = await readFile(packagePath, "utf8");
  const templatePackage = JSON.parse(raw) as TemplatePackage;
  if (templatePackage.thumbnailFile === "thumbnail.png") return;
  templatePackage.thumbnailFile = "thumbnail.png";
  await writeFile(packagePath, `${JSON.stringify(templatePackage, null, 2)}\n`, "utf8");
}

function findWorkspaceRoot(start: string) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".agents", "skills", "html-ppt")) && existsSync(join(current, "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Unable to find workspace root from ${start}`);
    }
    current = parent;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
