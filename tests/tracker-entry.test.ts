import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

test("Tracker is the only frontend entry and tracker.html is its compatibility alias", () => {
  const html = readFileSync(new URL("../tracker.html", import.meta.url), "utf8");
  const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  assert.match(index, /<title>TRACKER[^<]*<\/title>/i);
  assert.match(index, /<meta name="description" content="Tracker-first local job search workspace\." \/>/);
  assert.match(index, /src\/tracker\/main\.tsx/);
  assert.match(html, /src\/tracker\/main\.tsx/);
  assert.match(vite, /tracker: resolve\(root, "tracker\.html"\)/);
  assert.match(vite, /main: resolve\(root, "index\.html"\)/);
  assert.doesNotMatch(vite, /\bweb\s*:/);
  const legacySegment = ["w", "e", "b"].join("");
  assert.equal(readdirSync(new URL("..", import.meta.url)).includes(`${legacySegment}.html`), false);
  assert.equal(readdirSync(new URL("../src/", import.meta.url)).includes(legacySegment), false);
  assert.equal(packageJson.scripts["smoke:browser"], "node --import=tsx scripts/browser-smoke-tracker.ts");
  assert.equal(packageJson.scripts["smoke:browser:tracker"], "node --import=tsx scripts/browser-smoke-tracker.ts");
});

test("Tracker browser smoke covers every route and responsive error contract", () => {
  const smoke = readFileSync(new URL("../scripts/browser-smoke-tracker.ts", import.meta.url), "utf8");
  for (const route of ["#/pattern", "#/order", "#/phrase", "#/sample/", "#/disk", "#/trace"]) assert.ok(smoke.includes(route), `missing ${route} smoke route`);
  assert.match(smoke, /page\.on\("console"/);
  assert.match(smoke, /page\.on\("pageerror"/);
  assert.match(smoke, /setViewportSize/);
  assert.match(smoke, /scrollWidth/);
  assert.match(smoke, /Resize fine-tune sidebar/);
  assert.match(smoke, /Collapse fine-tune sidebar/);
});

test("tracker DISK loads profile-editor CSS so field labels stack above inputs", () => {
  const editor = readFileSync(new URL("../src/profile-editor.tsx", import.meta.url), "utf8");
  const studio = readFileSync(new URL("../src/tracker/studio.css", import.meta.url), "utf8");
  const beforeStudio = studio.slice(0, studio.indexOf(".studio {"));
  assert.match(editor, /import "\.\/profile-editor\.css"/);
  assert.doesNotMatch(beforeStudio, /@import/);
  assert.match(studio, /\.pe-theme-tracker \.pe-field \{\s*display: grid;/);
});

test("Tracker sources keep the frontend import boundary self-contained", () => {
  const trackerDir = new URL("../src/tracker/", import.meta.url);
  for (const name of readdirSync(trackerDir).filter((file) => /\.(ts|tsx)$/.test(file))) {
    const source = readFileSync(new URL(`../src/tracker/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, new RegExp(`\\.\\./${["w", "e", "b"].join("")}[\\\\/]`));
  }
});

test("Tracker table columns and SAMPLE inspector layout stay focused", () => {
  const pattern = readFileSync(new URL("../src/tracker/pattern.tsx", import.meta.url), "utf8");
  const order = readFileSync(new URL("../src/tracker/order.tsx", import.meta.url), "utf8");
  const sample = readFileSync(new URL("../src/tracker/sample.tsx", import.meta.url), "utf8");
  const studio = readFileSync(new URL("../src/tracker/studio.css", import.meta.url), "utf8");

  for (const source of [pattern, order]) {
    assert.doesNotMatch(source, /<th>NOTE<\/th>|className="note"|scoreToNote/);
  }
  assert.match(pattern, /Job pattern: SIG keyword signal/);
  assert.match(order, /<td colSpan=\{3\}/);

  const aside = sample.indexOf("<aside");
  assert.ok(aside >= 0);
  assert.ok(sample.indexOf("sample-document-summary") > aside);
  assert.ok(sample.indexOf("sample-verification") < aside);
  assert.match(sample.slice(aside), /Open CV PDF[\s\S]*Open letter PDF[\s\S]*Open CV source[\s\S]*Open letter source/);
  assert.match(sample, /role="separator"/);
  assert.match(sample, /onPointerDown/);
  assert.match(sample, /ArrowLeft/);
  assert.match(studio, /\.order-board/);
  assert.match(studio, /\.workspace\.sample \{ grid-template-columns: minmax\(0, 1fr\) auto; \}/);
});

test("DISK fine-tune sidebar stays collapsible and resizable", () => {
  const disk = readFileSync(new URL("../src/tracker/disk.tsx", import.meta.url), "utf8");
  const studio = readFileSync(new URL("../src/tracker/studio.css", import.meta.url), "utf8");

  assert.match(disk, /const MIN_TUNE_WIDTH = 260;/);
  assert.match(disk, /const MAX_TUNE_WIDTH = 420;/);
  assert.match(disk, /const COLLAPSED_TUNE_WIDTH = 48;/);
  assert.match(disk, /role="separator"/);
  assert.match(disk, /aria-label="Resize fine-tune sidebar"/);
  assert.match(disk, /onPointerDown=\{beginTuneResize\}/);
  assert.match(disk, /onKeyDown=\{resizeTuneWithKeyboard\}/);
  assert.match(disk, /event\.key === "ArrowLeft"/);
  assert.match(disk, /event\.key === "ArrowRight"/);
  assert.match(disk, /event\.key === "Home"/);
  assert.match(disk, /event\.key === "End"/);
  assert.match(disk, /aria-controls="disk-tune"/);
  assert.match(disk, /hidden=\{tuneCollapsed\}/);
  assert.match(studio, /\.workspace\.disk \{ grid-template-columns: minmax\(0, 1fr\) auto; \}/);
  assert.match(studio, /\.disk-tune-panel\.is-collapsed/);
});
