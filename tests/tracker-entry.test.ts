import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

test("Tracker UI cleanup removes fake controls and keeps Workflow Rack as the flow nav", () => {
  const app = readFileSync(new URL("../src/tracker/App.tsx", import.meta.url), "utf8");
  const agent = readFileSync(new URL("../src/tracker/agent.tsx", import.meta.url), "utf8");
  const order = readFileSync(new URL("../src/tracker/order.tsx", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../src/tracker/workflow.ts", import.meta.url), "utf8");
  const rack = readFileSync(new URL("../src/tracker/workflow-rack.tsx", import.meta.url), "utf8");
  const studio = readFileSync(new URL("../src/tracker/studio.css", import.meta.url), "utf8");

  assert.doesNotMatch(app, /pat-chain/);
  assert.doesNotMatch(app, /aria-label="Arm"/);
  assert.doesNotMatch(app, /className="ico rec"/);
  assert.doesNotMatch(app, /aria-label="Stop"/);
  assert.doesNotMatch(app, /className="ico stop"/);
  assert.match(app, /CMD <b>Ctrl\+K<\/b>/);
  assert.match(app, /view !== "sample" \|\| \(route\.view === "sample" && Boolean\(route\.jobId\)\)/);
  assert.match(app, /ActiveRunStrip/);
  assert.match(app, /tapeOpen, setTapeOpen\] = useState\(false\)/);

  assert.doesNotMatch(agent, /Generate documents for armed SELECT/);
  assert.doesNotMatch(agent, /className="conf"/);
  assert.match(agent, /showReasoning/);
  assert.match(agent, /Start scrape\?/);

  assert.doesNotMatch(order, /className="conf"/);
  assert.match(order, /Accept · generate/);

  assert.match(workflow, /job\.stage === "Applied" \|\| job\.stage === "Interview"/);
  assert.match(workflow, /function channelLedState/);
  assert.match(rack, /channelLedState/);
  assert.doesNotMatch(rack, /channel\.armed|channel\.led/);
  assert.match(rack, /Tab atas = editor/);
  assert.doesNotMatch(rack, /pat-chain/);

  assert.doesNotMatch(studio, /\.pat-chain/);
  assert.doesNotMatch(studio, /\.conf\b/);
  assert.doesNotMatch(studio, /\.ico\.rec\b/);
  assert.doesNotMatch(studio, /\.ch\.armed\b/);
});

test("Tracker is the only frontend entry and tracker.html is its compatibility alias", () => {
  const html = readFileSync(new URL("../tracker.html", import.meta.url), "utf8");
  const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  assert.match(index, /<title>TRACKER[^<]*<\/title>/i);
  assert.match(index, /<meta name="description" content="Job Sequencer — tracker-first local job-search workspace\." \/>/);
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
  assert.match(smoke, /Resize agent panel/);
  assert.match(smoke, /Collapse agent panel/);
  assert.match(smoke, /Collapse workflow rack/);
  assert.match(smoke, /Resize fine-tune sidebar/);
  assert.match(smoke, /Collapse fine-tune sidebar/);
  assert.match(smoke, /\.pat-chain/);
  assert.match(smoke, /getByRole\("button", \{ name: "Arm", exact: true \}\)/);
  assert.match(smoke, /getByRole\("button", \{ name: "Stop", exact: true \}\)/);
  assert.match(smoke, /getByRole\("button", \{ name: "Play scrape" \}\)/);
  assert.match(smoke, /Start scrape\?/);
  assert.match(smoke, /modes a.*SAMPLE/);
  assert.match(smoke, /\.reco.*Generate|toContainText\("Generate"\)/);
  assert.match(smoke, /Accept · generate/);
});

test("Tracker PATTERN manual add uses the shared manual import flow", () => {
  const pattern = readFileSync(new URL("../src/tracker/pattern.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/tracker/App.tsx", import.meta.url), "utf8");

  assert.match(pattern, /ADD JOB/);
  assert.match(pattern, /onManualImport: \(input: string\) => Promise<void>/);
  assert.match(pattern, /Add job manually/);
  assert.match(pattern, /role="dialog"/);
  assert.match(pattern, /aria-modal="true"/);
  assert.match(pattern, /aria-label="Job URL or pasted posting"/);
  assert.match(pattern, /required/);
  assert.match(pattern, /noValidate/);
  assert.match(pattern, /event\.key === "Escape"/);
  assert.match(pattern, /setSubmitting\(true\)/);
  assert.match(pattern, /sample-dialog-error/);

  assert.match(app, /async function startManualImport\(input: string\)/);
  assert.match(app, /await api<\{ runId: string \}>\("\/api\/jobs\/manual"/);
  assert.match(app, /workflow: "manual_import"/);
  assert.match(app, /onManualImport=\{startManualImport\}/);
  assert.match(app, /if \(text\.startsWith\("\/import"\)\) \{[\s\S]*?await startManualImport\(input\)/);
  assert.equal((app.match(/\/api\/jobs\/manual/g) ?? []).length, 1);
});

test("Tracker browser smoke covers the manual add flow with isolated fixtures", () => {
  const smoke = readFileSync(new URL("../scripts/browser-smoke-tracker.ts", import.meta.url), "utf8");

  assert.match(smoke, /writeSettings\(dataDir/);
  assert.match(smoke, /writeStructuredProfile\(dataDir/);
  assert.match(smoke, /manualImporter: async/);
  assert.match(smoke, /getByRole\("button", \{ name: "ADD JOB" \}\)/);
  assert.match(smoke, /getByRole\("dialog", \{ name: "Add job manually" \}\)/);
  assert.match(smoke, /getByLabel\("Job URL or pasted posting"\)/);
  assert.match(smoke, /Enter a posting URL or paste job text/);
  assert.match(smoke, /Tracker Manual/);
  assert.match(smoke, /rm\(dataDir, \{ recursive: true, force: true \}\)/);
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
  assert.match(sample, /cvPagesOverride/);
  assert.match(sample, /sampleCvPageWarning/);
  assert.match(sample, /CV pages must be 1/);
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

test("DISK ARMED SOURCES keeps MAX age out of the name column", () => {
  const disk = readFileSync(new URL("../src/tracker/disk.tsx", import.meta.url), "utf8");
  const studio = readFileSync(new URL("../src/tracker/studio.css", import.meta.url), "utf8");

  assert.match(disk, /className="disk-source__name"/);
  assert.match(studio, /\.disk-source \{[\s\S]*?position:\s*relative;/);
  assert.match(studio, /\.disk-source \{[\s\S]*?grid-template-columns:\s*8px minmax\(0, 1fr\) auto;/);
  assert.match(studio, /\.disk-source__name \{[\s\S]*?min-width:\s*0;[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.match(studio, /\.studio \.disk-tune \.pe-two \{ grid-template-columns: 1fr; \}/);
  assert.doesNotMatch(studio, /\.disk-source__age \{ grid-column: 3;/);
  assert.match(studio, /\.disk-source__age \{ grid-column: 2;/);
});

test("Tracker AGENT panel stays collapsible and resizable", () => {
  const agent = readFileSync(new URL("../src/tracker/agent.tsx", import.meta.url), "utf8");
  const studio = readFileSync(new URL("../src/tracker/studio.css", import.meta.url), "utf8");

  assert.match(agent, /className=\{`panel agent/);
  assert.match(agent, /const MIN_AGENT_WIDTH = 260;/);
  assert.match(agent, /const MAX_AGENT_WIDTH = 420;/);
  assert.match(agent, /const COLLAPSED_AGENT_WIDTH = 48;/);
  assert.match(agent, /role="separator"/);
  assert.match(agent, /aria-label="Resize agent panel"/);
  assert.match(agent, /aria-orientation="vertical"/);
  assert.match(agent, /aria-valuemin=\{MIN_AGENT_WIDTH\}/);
  assert.match(agent, /aria-valuemax=\{MAX_AGENT_WIDTH\}/);
  assert.match(agent, /aria-valuenow=\{agentWidth\}/);
  assert.match(agent, /aria-valuetext=\{agentCollapsed \? "Collapsed"/);
  assert.match(agent, /onPointerDown=\{beginAgentResize\}/);
  assert.match(agent, /onKeyDown=\{resizeAgentWithKeyboard\}/);
  for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) assert.match(agent, new RegExp(`event\\.key === "${key}"`));
  assert.match(agent, /aria-controls="agent-panel"/);
  assert.match(agent, /aria-expanded=\{!agentCollapsed\}/);
  assert.match(agent, /hidden=\{agentCollapsed\}/);
  assert.match(studio, /\.workspace\.pattern \{ grid-template-columns: 196px minmax\(0, 1fr\) auto; \}/);
  assert.match(studio, /\.agent\.is-collapsed/);
});

test("Tracker collapse toggles use symbols and ORDER rows keep a slim meta summary", () => {
  const rack = readFileSync(new URL("../src/tracker/workflow-rack.tsx", import.meta.url), "utf8");
  const agent = readFileSync(new URL("../src/tracker/agent.tsx", import.meta.url), "utf8");
  const disk = readFileSync(new URL("../src/tracker/disk.tsx", import.meta.url), "utf8");
  const sample = readFileSync(new URL("../src/tracker/sample.tsx", import.meta.url), "utf8");
  const order = readFileSync(new URL("../src/tracker/order.tsx", import.meta.url), "utf8");
  const studio = readFileSync(new URL("../src/tracker/studio.css", import.meta.url), "utf8");

  for (const source of [rack, agent, disk, sample]) {
    assert.doesNotMatch(source, /\{[^}]*\? "OPEN" : "CLOSE"\}/);
    assert.doesNotMatch(source, />OPEN<|>CLOSE</);
  }
  assert.match(rack, /type PanelRailState = \{ collapsed: boolean; width: number \}/);
  assert.match(rack, /const COLLAPSED_RACK_WIDTH = 48;/);
  assert.match(rack, /rail\.collapsed \? "›" : "‹"/);
  assert.match(agent, /agentCollapsed \? "‹" : "›"/);
  assert.match(disk, /tuneCollapsed \? "‹" : "›"/);
  assert.match(sample, /inspectorCollapsed \? "‹" : "›"/);
  assert.match(studio, /\.workspace\.pattern:has\(\.workflow-rack\.is-collapsed\) \{ grid-template-columns: 48px minmax\(0, 1fr\) auto; \}/);
  assert.match(studio, /\.workspace\.order:has\(\.workflow-rack\.is-collapsed\) \{ grid-template-columns: 48px minmax\(0, 1fr\); \}/);
  assert.match(studio, /\.workspace\.phrase:has\(\.workflow-rack\.is-collapsed\) \{ grid-template-columns: 48px 220px minmax\(0, 1fr\); \}/);

  assert.match(order, /type OrderRowSummary = \{/);
  assert.match(order, /<dt>STAGE<\/dt>/);
  assert.match(order, /<dt>FIT<\/dt>/);
  assert.match(order, /<dt>SIGNAL<\/dt>/);
  assert.doesNotMatch(order, /<dt>DOCS<\/dt>/);
  assert.doesNotMatch(order, /<dt>APPROVAL<\/dt>/);
  assert.doesNotMatch(order, /<dt>SUBMITTED<\/dt>/);
  assert.doesNotMatch(order, /<dt>FOLLOW-UP<\/dt>/);
  assert.doesNotMatch(order, /<dt>OUTCOME<\/dt>/);
  assert.match(order, /export function orderMetadata/);
});

test("DISK bank A hosts resume import and LOAD bank is gone", () => {
  const disk = readFileSync(new URL("../src/tracker/disk.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/tracker/App.tsx", import.meta.url), "utf8");
  const editor = readFileSync(new URL("../src/profile-editor.tsx", import.meta.url), "utf8");
  const trace = readFileSync(new URL("../src/tracker/trace.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(disk, /id: "load"/);
  assert.match(disk, /ResumeImportPanel/);
  assert.match(disk, /workflow: "profile_import"/);
  assert.match(disk, /IdentityConflictDialog/);
  assert.match(disk, /processedImportRunId/);
  assert.match(app, /DiskView toast=\{setToast\} onSettings=\{setSettings\} run=\{run\} events=\{events\} onRun=\{announce\}/);
  assert.match(editor, /deriveRunTaskRows\(events, "profile_import"/);
  assert.match(trace, /workflow === "profile_import"\) return "PROFILE IMPORT"/);
  assert.doesNotMatch(disk, /label: "LOAD"/);
  assert.doesNotMatch(disk, /bank === "load"/);
  assert.match(disk, /useState<DiskBankId>\("a"\)/);
  assert.match(app, /coalesceObservedRun/);
  assert.match(disk, /setBank\("b"\)/);
  const bankA = disk.slice(disk.indexOf('{bank === "a"'));
  const importAt = bankA.indexOf("ResumeImportPanel");
  const fieldsAt = bankA.indexOf("ProfileFields");
  assert.ok(importAt >= 0, "bank A should render ResumeImportPanel");
  assert.ok(fieldsAt > importAt, "ResumeImportPanel should sit before ProfileFields");
  assert.match(disk, /<h2>PROVIDER<\/h2>/);
  assert.match(disk, /<h2>SEARCH KNOBS<\/h2>/);
  assert.match(disk, /<h2>ARMED SOURCES<\/h2>/);
  assert.match(disk, /<h2>DOCUMENT SETTINGS<\/h2>/);
  assert.match(disk, /<h2>ACTIONS<\/h2>/);
  assert.match(disk, /<h2>STATUS<\/h2>/);
});
