import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEmptyProfile, type StructuredProfile } from "../src/shared.js";
import { configPaths, ProfileSchema, readStructuredProfile, serializeProviderContext, writeStructuredProfile } from "../src/server/config.js";

test("structured profile migration preserves profile.md and serializes one canonical context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-profile-"));
  const legacy = "# Candidate\nEmail: person@example.test\nPhone: +62 812 3456 7890\n";
  try {
    await writeFile(configPaths(dir).profile, legacy, "utf8");
    const before = await readStructuredProfile(dir);
    assert.equal(before.canonical, false);
    assert.equal(before.legacyImport, legacy);
    const profile = createEmptyProfile();
    profile.identity.firstName = "Candidate";
    profile.identity.email = "person@example.test";
    profile.experience.push({ id: "experience-1", title: "Engineer", company: "Example", employmentType: "Full-time", location: "Remote", startMonth: "2024-01", startYear: "2024", endMonth: "", endYear: "", currentRole: true, description: "Built verified services." });
    await writeStructuredProfile(dir, profile);
    assert.deepEqual(await readFile(configPaths(dir).profile, "utf8"), legacy);
    const after = await readStructuredProfile(dir);
    assert.equal(after.canonical, true);
    assert.equal(JSON.stringify(after.profile), JSON.stringify(profile));
    const preview = serializeProviderContext(profile, "preview");
    const scrape = serializeProviderContext(profile, "scrape");
    assert.match(preview, /person@example\.test/);
    assert.doesNotMatch(scrape, /person@example\.test/);
    assert.match(scrape, /Candidate/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("structured profile rejects duplicate repeatable IDs and unknown fields", async () => {
  const profile = createEmptyProfile() as StructuredProfile;
  profile.skills.push({ id: "skill-1", name: "TypeScript" }, { id: "skill-1", name: "Java" });
  assert.throws(() => ProfileSchema.parse(profile));
  assert.throws(() => ProfileSchema.parse({ ...createEmptyProfile(), unexpected: true }));
});

test("education uses the canonical month and GPA fields only", () => {
  const entry = {
    id: "education-1",
    institution: "Example University",
    degree: "Bachelor of Science",
    fieldOfStudy: "Computer Science",
    startMonth: "2012-09",
    startYear: "2012",
    endMonth: "2016-06",
    endYear: "2016",
    gpa: "3.8/4.0",
  };
  const parsed = ProfileSchema.parse({ ...createEmptyProfile(), education: [entry] });
  assert.deepEqual(parsed.education, [entry]);
  assert.throws(() => ProfileSchema.parse({ ...createEmptyProfile(), education: [{ ...entry, startMonth: "2012-13" }] }));
  assert.throws(() => ProfileSchema.parse({ ...createEmptyProfile(), education: [{ ...entry, gpa: "x".repeat(121) }] }));
  assert.throws(() => ProfileSchema.parse({ ...createEmptyProfile(), education: [{ ...entry, description: "old" }] }));
  assert.throws(() => ProfileSchema.parse({ ...createEmptyProfile(), education: [{ ...entry, expectedGraduation: "2016" }] }));
});

test("old education JSON migrates year fallbacks and writes only the canonical shape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pjs-education-migration-"));
  try {
    const oldProfile = {
      ...createEmptyProfile(),
      education: [{
        id: "education-legacy",
        institution: "Example University",
        degree: "Bachelor of Science",
        fieldOfStudy: "Computer Science",
        startYear: "2012",
        endYear: "2016",
        expectedGraduation: "2016",
        description: "Legacy education description",
      }],
    };
    await writeFile(configPaths(dir).profileJson, `${JSON.stringify(oldProfile)}\n`, "utf8");
    const migrated = await readStructuredProfile(dir);
    assert.equal(migrated.canonical, true);
    assert.deepEqual(migrated.profile.education[0], {
      id: "education-legacy",
      institution: "Example University",
      degree: "Bachelor of Science",
      fieldOfStudy: "Computer Science",
      startMonth: "",
      startYear: "2012",
      endMonth: "",
      endYear: "2016",
      gpa: "",
    });
    await writeStructuredProfile(dir, migrated.profile);
    const saved = JSON.parse(await readFile(configPaths(dir).profileJson, "utf8")) as StructuredProfile;
    assert.deepEqual(saved.education[0], migrated.profile.education[0]);
    assert.equal("expectedGraduation" in saved.education[0]!, false);
    assert.equal("description" in saved.education[0]!, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
