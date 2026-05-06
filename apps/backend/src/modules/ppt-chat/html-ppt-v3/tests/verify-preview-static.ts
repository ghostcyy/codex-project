import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPreviewRequestPath } from "../preview/preview.controller";
import { resolvePreviewFile } from "../preview/preview-static";

const fixtureRoot = join(__dirname, "..", ".tmp", "preview-static");
const previewRoot = join(fixtureRoot, "job-output");

rmSync(fixtureRoot, { recursive: true, force: true });
mkdirSync(join(previewRoot, "assets", "themes", "dark"), { recursive: true });
mkdirSync(join(previewRoot, "fragments"), { recursive: true });
mkdirSync(join(previewRoot, "img"), { recursive: true });
mkdirSync(join(previewRoot, "_shared"), { recursive: true });
writeFileSync(join(previewRoot, "index.html"), [
  '<!doctype html><html data-html-ppt-v3-output="fragment-id"><body>',
  '<section class="slide" data-page-type="cover"></section>',
  '<section class="slide" data-page-type="grid-2" data-fragment-id="slide-02"></section>',
  '<section class="slide" data-page-type="closing"></section>',
  "</body></html>"
].join(""));
writeFileSync(join(previewRoot, "style.css"), "body{margin:0}");
writeFileSync(join(previewRoot, "assets", "style.css"), "body{margin:0}");
writeFileSync(join(previewRoot, "assets", "themes", "dark", "tokens.css"), ":root{--bg:#000}");
writeFileSync(join(previewRoot, "fragments", "cover.html"), "<section></section>");
writeFileSync(join(previewRoot, "fragments", "slide-02.html"), "<section></section>");
writeFileSync(join(previewRoot, "fragments", "closing.html"), "<section></section>");
writeFileSync(
  join(previewRoot, "manifest-v2.json"),
  JSON.stringify({
    schemaVersion: 2,
    pool: { "slide-02": { fragmentId: "slide-02", htmlFile: "fragments/slide-02.html" } },
    fixed: {
      cover: { htmlFile: "fragments/cover.html" },
      closing: { htmlFile: "fragments/closing.html" }
    }
  })
);
writeFileSync(join(previewRoot, "img", "_placeholder.jpg"), "not-really-a-jpeg");
writeFileSync(join(previewRoot, "_shared", "nav.js"), "export {};");

const stalePreviewRoot = join(fixtureRoot, "stale-job-output");
mkdirSync(join(stalePreviewRoot, "fragments"), { recursive: true });
writeFileSync(join(stalePreviewRoot, "index.html"), "<!doctype html><html><body>stale deck</body></html>");
writeFileSync(join(stalePreviewRoot, "fragments", "cover.html"), "<section></section>");
writeFileSync(join(stalePreviewRoot, "fragments", "closing.html"), "<section></section>");
writeFileSync(
  join(stalePreviewRoot, "manifest-v2.json"),
  JSON.stringify({
    schemaVersion: 2,
    pool: { "slide-02": { fragmentId: "slide-02", htmlFile: "fragments/grid-2.html" } },
    fixed: {
      cover: { htmlFile: "fragments/cover.html" },
      closing: { htmlFile: "fragments/closing.html" }
    }
  })
);

const staleIndexPreviewRoot = join(fixtureRoot, "stale-index-output");
mkdirSync(join(staleIndexPreviewRoot, "fragments"), { recursive: true });
writeFileSync(
  join(staleIndexPreviewRoot, "index.html"),
  '<!doctype html><html data-html-ppt-v3-output="fragment-id"><body><section class="slide" data-page-type="grid-3"></section><a href="fragments/grid-3.html">old</a></body></html>'
);
writeFileSync(join(staleIndexPreviewRoot, "fragments", "cover.html"), "<section></section>");
writeFileSync(join(staleIndexPreviewRoot, "fragments", "slide-02.html"), "<section></section>");
writeFileSync(join(staleIndexPreviewRoot, "fragments", "closing.html"), "<section></section>");
writeFileSync(
  join(staleIndexPreviewRoot, "manifest-v2.json"),
  JSON.stringify({
    schemaVersion: 2,
    pool: { "slide-02": { fragmentId: "slide-02", htmlFile: "fragments/slide-02.html" } },
    fixed: {
      cover: { htmlFile: "fragments/cover.html" },
      closing: { htmlFile: "fragments/closing.html" }
    }
  })
);

async function expectPreviewFile(requestPath: string, expectedContentType: string, expectedSuffix: string) {
  const file = await resolvePreviewFile(previewRoot, requestPath);
  if (file.contentType !== expectedContentType || !file.absolutePath.endsWith(expectedSuffix)) {
    throw new Error(`Preview resolver should serve '${requestPath}' with content type '${expectedContentType}'.`);
  }
}

async function main() {
  await expectPreviewFile("index.html", "text/html; charset=utf-8", "index.html");
  await expectPreviewFile("style.css", "text/css; charset=utf-8", "style.css");
  await expectPreviewFile("assets/style.css", "text/css; charset=utf-8", join("assets", "style.css"));
  await expectPreviewFile("img/_placeholder.jpg", "image/jpeg", join("img", "_placeholder.jpg"));
  await expectPreviewFile("_shared/nav.js", "application/javascript; charset=utf-8", join("_shared", "nav.js"));
  await expectPreviewFile(
    "assets/themes/dark/tokens.css",
    "text/css; charset=utf-8",
    join("assets", "themes", "dark", "tokens.css")
  );

  const joinedWildcardPath = getPreviewRequestPath({ params: { path: ["assets", "themes", "dark", "tokens.css"] } });
  if (joinedWildcardPath !== "assets/themes/dark/tokens.css") {
    throw new Error("Preview controller should preserve nested wildcard path segments.");
  }

  const unnamedWildcardPath = getPreviewRequestPath({ params: { 0: "assets/themes/dark/tokens.css" } });
  if (unnamedWildcardPath !== "assets/themes/dark/tokens.css") {
    throw new Error("Preview controller should support unnamed wildcard route parameters.");
  }

  const traversalCases = ["../secret.txt", "assets/../../secret.txt", "%2e%2e/secret.txt"];
  for (const unsafePath of traversalCases) {
    let rejected = false;
    try {
      await resolvePreviewFile(previewRoot, unsafePath);
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error(`Preview resolver should reject traversal path '${unsafePath}'.`);
    }
  }

  let staleRejected = false;
  try {
    await resolvePreviewFile(stalePreviewRoot, "index.html");
  } catch (error) {
    staleRejected = error instanceof Error
      && error.message.includes("旧模板结构")
      && error.message.includes("fragments/grid-2.html");
  }
  if (!staleRejected) {
    throw new Error("Preview resolver should reject stale manifest fragment files before leaking an ENOENT error.");
  }

  let staleIndexRejected = false;
  try {
    await resolvePreviewFile(staleIndexPreviewRoot, "index.html");
  } catch (error) {
    staleIndexRejected = error instanceof Error
      && error.message.includes("旧模板结构")
      && error.message.includes("fragments/grid-3.html");
  }
  if (!staleIndexRejected) {
    throw new Error("Preview resolver should reject a legacy index even when manifest-v2 is current.");
  }

  console.log("HTML-PPT v3 preview static verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
