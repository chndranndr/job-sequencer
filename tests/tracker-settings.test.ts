import assert from "node:assert/strict";
import test from "node:test";
import { defaultSettings } from "../src/server/config.js";
import { defaultSourceMaxAgeDays } from "../src/shared.js";
import {
  blankCustomSource,
  cloneSettings,
  enabledSources,
  hasValidProviderModel,
  removeCustomSourceSettings,
  settingsAreDirty,
  sourceMaxAge,
  updateEnabledSources,
  upsertCustomSource,
} from "../src/settings-editor.js";

test("settings dirty state compares against an independent saved snapshot", () => {
  const saved = cloneSettings(defaultSettings);
  assert.equal(settingsAreDirty(defaultSettings, saved), false);
  saved.scoreThreshold += 1;
  assert.equal(settingsAreDirty(defaultSettings, saved), true);
  assert.equal(defaultSettings.scoreThreshold, 60);
});

test("source age uses configured values and built-in defaults", () => {
  assert.equal(sourceMaxAge(defaultSettings, "tokyodev"), 45);
  assert.equal(sourceMaxAge({ ...defaultSettings, sourceMaxAgeDays: { ...defaultSourceMaxAgeDays, tokyodev: 14 } }, "tokyodev"), 14);
});

test("enabled source updates deduplicate and refuse an empty source set", () => {
  const result = updateEnabledSources(defaultSettings, ["linkedin", "linkedin", "partner-board"]);
  assert.equal(result.error, "");
  assert.deepEqual(result.value && enabledSources(result.value), ["linkedin", "partner-board"]);
  assert.equal(result.value?.source, "linkedin");

  const empty = updateEnabledSources(defaultSettings, []);
  assert.equal(empty.value, null);
  assert.match(empty.error, /at least one source/i);
});

test("custom source helpers add, rename, reject conflicts, and repair removal", () => {
  const draft = { ...blankCustomSource(), key: "partner-board", label: "Partner Board" };
  const added = upsertCustomSource({ ...defaultSettings, enabledSources: ["partner-board"] }, draft);
  assert.equal(added.error, "");
  assert.equal(added.value?.customSources?.[0]?.label, "Partner Board");

  const renamed = upsertCustomSource(added.value!, { ...draft, key: "partner-board-v2" }, "partner-board");
  assert.equal(renamed.error, "");
  assert.deepEqual(renamed.value && enabledSources(renamed.value), ["partner-board-v2"]);

  const conflict = upsertCustomSource(defaultSettings, { ...draft, key: "linkedin" });
  assert.equal(conflict.value, null);
  assert.match(conflict.error, /built-in/i);

  const removed = removeCustomSourceSettings(renamed.value!, "partner-board-v2");
  assert.deepEqual(enabledSources(removed), ["freehire"]);
  assert.deepEqual(removed.customSources, []);
});

test("provider/model validity only accepts an authenticated model for the provider", () => {
  assert.equal(hasValidProviderModel({ ...defaultSettings, provider: "google", model: "gemini" }, [{ id: "gemini", name: "Gemini" }]), true);
  assert.equal(hasValidProviderModel({ ...defaultSettings, provider: "google", model: "other" }, [{ id: "gemini", name: "Gemini" }]), false);
  assert.equal(hasValidProviderModel({ ...defaultSettings, provider: "google", model: "" }, [{ id: "gemini", name: "Gemini" }]), false);
});
