import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createEmptyProfile, defaultSourceMaxAgeDays, jobSourceKeys, type Criteria, type Settings, type SourceMaxAgeDays, type StructuredProfile } from "../shared.js";

export type { Criteria, Settings } from "../shared.js";

const list = (max: number) => z.array(z.string().trim().min(1).max(500)).max(max);
const month = z.string().regex(/^(?:\d{4}-(?:0[1-9]|1[0-2]))?$/, "Use YYYY-MM or leave this blank.");
const year = z.string().regex(/^(?:\d{4})?$/, "Use YYYY or leave this blank.");
const gpa = z.string().max(120);
const id = z.string().trim().min(1).max(120);
const sourceKey = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, "Use 2-40 lowercase letters, numbers, or hyphens.");
const sourceMaxAgeValue = z.union([z.number().int().min(1).max(3650), z.literal(9999)]);
const SourceMaxAgeDaysSchema = z.object({
  freehire: sourceMaxAgeValue,
  linkedin: sourceMaxAgeValue,
  tokyodev: sourceMaxAgeValue,
  "japan-dev": sourceMaxAgeValue,
}).partial().strict().default({}).transform((value) => ({ ...defaultSourceMaxAgeDays, ...value }) as SourceMaxAgeDays);
const jsonPath = z.string().trim().min(1).max(160).regex(/^(?:\$\.)?[A-Za-z_][A-Za-z0-9_-]*(?:(?:\.[A-Za-z_][A-Za-z0-9_-]*)|(?:\[\d+\]))*$/, "Use a bounded dot path with numeric array indexes.");
const htmlSelector = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9_.#\-\s\[\]=\"':>]+$/, "Use a simple CSS selector without scripts or pseudo-classes.").refine((value) => !value.includes(",") && !value.includes(".."), "Use one simple CSS selector at a time.");
const htmlAttribute = z.string().trim().regex(/^[A-Za-z_:][A-Za-z0-9_.:-]{0,63}$/, "Use a simple HTML attribute name.");

const JsonSearchFieldsSchema = z.object({
  id: jsonPath,
  title: jsonPath,
  company: jsonPath.optional(),
  location: jsonPath.optional(),
  url: jsonPath,
}).strict();
const JsonDetailFieldsSchema = z.object({ id: jsonPath, title: jsonPath, url: jsonPath, description: jsonPath }).strict();
const HtmlFieldSchema = z.object({ selector: htmlSelector, attribute: htmlAttribute.optional() }).strict();
const HtmlSearchFieldsSchema = z.object({
  id: HtmlFieldSchema,
  title: HtmlFieldSchema,
  company: HtmlFieldSchema.optional(),
  location: HtmlFieldSchema.optional(),
  url: HtmlFieldSchema,
}).strict();
const HtmlDetailFieldsSchema = z.object({ id: HtmlFieldSchema, title: HtmlFieldSchema, url: HtmlFieldSchema, description: HtmlFieldSchema }).strict();

const CustomParserSchema = z.discriminatedUnion("format", [
  z.object({ format: z.literal("json"), search: z.object({ resultsPath: jsonPath, fields: JsonSearchFieldsSchema }).strict(), detail: z.object({ fields: JsonDetailFieldsSchema }).strict() }).strict(),
  z.object({ format: z.literal("html"), search: z.object({ itemSelector: htmlSelector, fields: HtmlSearchFieldsSchema }).strict(), detail: z.object({ fields: HtmlDetailFieldsSchema }).strict() }).strict(),
]);

const allowedTemplatePlaceholders = (template: string, allowed: readonly string[], label: string) => {
  if (/[\u0000-\u001f\u007f]/.test(template)) throw new Error(`${label} contains control characters.`);
  const matches = [...template.matchAll(/\{\{([^{}]+)\}\}/g)];
  const remainder = template.replace(/\{\{[^{}]+\}\}/g, "");
  if (/[{}]/.test(remainder)) throw new Error(`${label} contains an invalid template placeholder.`);
  for (const match of matches) if (!allowed.includes(match[1])) throw new Error(`${label} contains an unsupported placeholder.`);
};

function templateUrl(template: string, allowed: readonly string[], label: string) {
  allowedTemplatePlaceholders(template, allowed, label);
  const authority = template.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\/?#]*)/)?.[1] ?? "";
  if (/\{\{/.test(authority)) throw new Error(`${label} placeholders cannot change the host.`);
  const probe = template.replace(/\{\{[^{}]+\}\}/g, "placeholder");
  let url: URL;
  try { url = new URL(probe); } catch { throw new Error(`${label} must be an absolute HTTP(S) URL template.`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${label} must use HTTP or HTTPS.`);
  if (url.username || url.password) throw new Error(`${label} must not contain URL credentials.`);
  return url;
}

const CustomSourceSchema = z.object({
  key: sourceKey,
  label: z.string().min(1).max(80).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Label contains control characters."),
  searchUrlTemplate: z.string().min(1).max(1_000),
  detailUrlTemplate: z.string().min(1).max(1_000),
  parser: CustomParserSchema,
}).strict().superRefine((source, context) => {
  try {
    const searchUrl = templateUrl(source.searchUrlTemplate, ["query", "location", "limit"], "Search URL");
    const detailUrl = templateUrl(source.detailUrlTemplate, ["id", "url"], "Detail URL");
    if (searchUrl.origin === "null" || detailUrl.origin === "null") context.addIssue({ code: "custom", path: ["searchUrlTemplate"], message: "Custom source URLs must have an HTTP(S) origin." });
  } catch (error) {
    context.addIssue({ code: "custom", path: ["searchUrlTemplate"], message: error instanceof Error ? error.message : "Invalid URL template." });
  }
});

export { CustomSourceSchema };

export const CriteriaSchema = z.object({
  roles: list(20),
  locations: list(20),
  remoteOnly: z.boolean(),
  keywords: list(50),
  excludeKeywords: list(50),
  employmentTypes: list(10),
  maxJobsPerRun: z.number().int().min(1).max(50),
}).strict();

const SettingsInputSchema = z.object({
  provider: z.string().trim().min(1).max(80),
  model: z.string().trim().max(160),
  source: z.enum(jobSourceKeys).default("freehire"),
  enabledSources: z.array(sourceKey).max(24).optional(),
  customSources: z.array(CustomSourceSchema).max(20).default([]),
  sourceMaxAgeDays: SourceMaxAgeDaysSchema,
  scoreThreshold: z.number().int().min(0).max(100),
  maxResults: z.number().int().min(1).max(50).default(50),
  cvPages: z.number().int().min(1).max(10),
  coverLetterPages: z.number().int().min(1).max(10),
}).strict().superRefine((settings, context) => {
  const customKeys = settings.customSources.map((source) => source.key);
  if (new Set(customKeys).size !== customKeys.length) context.addIssue({ code: "custom", path: ["customSources"], message: "Custom source keys must be unique." });
  const builtInKeys = new Set(jobSourceKeys);
  for (const key of customKeys) if (builtInKeys.has(key as (typeof jobSourceKeys)[number])) context.addIssue({ code: "custom", path: ["customSources"], message: `Custom source key ${key} conflicts with a built-in source.` });
  if (settings.enabledSources && new Set(settings.enabledSources).size !== settings.enabledSources.length) context.addIssue({ code: "custom", path: ["enabledSources"], message: "Enabled sources must be unique." });
  if (settings.enabledSources) {
    const known = new Set<string>([...jobSourceKeys, ...customKeys]);
    for (const key of settings.enabledSources) if (!known.has(key)) context.addIssue({ code: "custom", path: ["enabledSources"], message: `Enabled source ${key} is not configured.` });
  }
}).transform((settings) => {
  const enabledSources = settings.enabledSources?.length ? settings.enabledSources : [settings.source];
  const firstBuiltIn = enabledSources.find((source): source is (typeof jobSourceKeys)[number] => (jobSourceKeys as readonly string[]).includes(source)) ?? "freehire";
  return { ...settings, source: firstBuiltIn, enabledSources, customSources: settings.customSources } as Settings;
});

export const SettingsSchema = SettingsInputSchema;

const BaseEntry = { id };
const ProfileSchemaBase = z.object({
  version: z.literal(1),
  identity: z.object({
    firstName: z.string().max(200),
    lastName: z.string().max(200),
    headline: z.string().max(300),
    email: z.string().max(320),
    phone: z.string().max(120),
    city: z.string().max(200),
    country: z.string().max(200),
    website: z.string().max(500),
    linkedinUrl: z.string().max(500),
    githubUrl: z.string().max(500),
    summary: z.string().max(30_000),
  }).strict(),
  workPreferences: z.object({
    authorizationStatus: z.string().max(500),
    relocationPreference: z.string().max(500),
    remotePreference: z.string().max(500),
    targetRoles: list(20),
    dealBreakers: list(30),
  }).strict(),
  experience: z.array(z.object({
    ...BaseEntry,
    title: z.string().max(300),
    company: z.string().max(300),
    employmentType: z.string().max(120),
    location: z.string().max(200),
    startMonth: month,
    startYear: year,
    endMonth: month,
    endYear: year,
    currentRole: z.boolean(),
    description: z.string().max(30_000),
  }).strict()).max(100),
  education: z.array(z.object({
    ...BaseEntry,
    institution: z.string().max(300),
    degree: z.string().max(300),
    fieldOfStudy: z.string().max(300),
    startMonth: month,
    startYear: year,
    endMonth: month,
    endYear: year,
    gpa,
  }).strict()).max(100),
  skills: z.array(z.object({ ...BaseEntry, name: z.string().max(200) }).strict()).max(200),
  certifications: z.array(z.object({
    ...BaseEntry,
    name: z.string().max(300),
    issuer: z.string().max(300),
    issueDate: z.string().max(120),
    expiryDate: z.string().max(120),
    url: z.string().max(500),
    description: z.string().max(30_000),
  }).strict()).max(100),
  projects: z.array(z.object({
    ...BaseEntry,
    name: z.string().max(300),
    role: z.string().max(300),
    description: z.string().max(30_000),
    startMonth: month,
    startYear: year,
    endMonth: month,
    endYear: year,
    url: z.string().max(500),
  }).strict()).max(100),
  awards: z.array(z.object({
    ...BaseEntry,
    title: z.string().max(300),
    issuer: z.string().max(300),
    date: z.string().max(120),
    description: z.string().max(30_000),
  }).strict()).max(100),
  languages: z.array(z.object({ ...BaseEntry, name: z.string().max(200), proficiency: z.string().max(200) }).strict()).max(100),
}).strict();

export const ProfileSchema = ProfileSchemaBase.superRefine((profile, context) => {
  for (const [collection, entries] of Object.entries(profile).filter(([key]) => ["experience", "education", "skills", "certifications", "projects", "awards", "languages"].includes(key))) {
    const ids = (entries as Array<{ id: string }>).map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: [collection], message: "Entry IDs must be unique within each collection." });
  }
});

export type ProfileSchemaValue = z.infer<typeof ProfileSchema>;
export type ProfilePurpose = "preview" | "scrape" | "generation" | "interview" | "follow_up" | "manual_import";

function normalizeStoredProfile(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const profile = value as Record<string, unknown>;
  if (!Array.isArray(profile.education)) return value;
  return {
    ...profile,
    education: profile.education.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const entry = value as Record<string, unknown>;
      if (!("expectedGraduation" in entry) && !("description" in entry)) return value;
      const normalized = { ...entry };
      delete normalized.expectedGraduation;
      delete normalized.description;
      normalized.startMonth = "";
      normalized.endMonth = "";
      normalized.gpa = "";
      return normalized;
    }),
  };
}

export const defaultCriteria: Criteria = { roles: [], locations: [], remoteOnly: false, keywords: [], excludeKeywords: [], employmentTypes: ["full-time"], maxJobsPerRun: 20 };
export const defaultSettings: Settings = { provider: "google", model: "", source: "freehire", enabledSources: ["freehire"], customSources: [], sourceMaxAgeDays: { ...defaultSourceMaxAgeDays }, scoreThreshold: 60, maxResults: 50, cvPages: 2, coverLetterPages: 1 };

export function configPaths(dataDir: string) {
  return {
    profile: join(dataDir, "profile.md"),
    profileJson: join(dataDir, "profile.json"),
    criteria: join(dataDir, "criteria.json"),
    settings: join(dataDir, "settings.json"),
  };
}

async function ensureFile(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true });
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(path, value, "utf8");
    return value;
  }
}

/** Compatibility helpers retained for the Phase 1–2 test/API surface. The UI never edits this file. */
export async function readProfile(dataDir: string) { return ensureFile(configPaths(dataDir).profile, "# Profile\n"); }
export async function writeProfile(dataDir: string, profile: unknown) {
  const value = z.string().max(200_000).parse(profile);
  await mkdir(dataDir, { recursive: true });
  await writeFile(configPaths(dataDir).profile, value, "utf8");
  return value;
}

export async function readStructuredProfile(dataDir: string): Promise<{ profile: StructuredProfile; canonical: boolean; legacyImport: string | null }> {
  const paths = configPaths(dataDir);
  try {
    const profile = ProfileSchema.parse(normalizeStoredProfile(JSON.parse(await readFile(paths.profileJson, "utf8")))) as StructuredProfile;
    return { profile, canonical: true, legacyImport: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof SyntaxError || error instanceof z.ZodError) throw new Error("Canonical profile.json is invalid; review or restore the structured profile.");
      throw error;
    }
    try { return { profile: createEmptyProfile(), canonical: false, legacyImport: await readFile(paths.profile, "utf8") }; }
    catch (legacyError) {
      if ((legacyError as NodeJS.ErrnoException).code !== "ENOENT") throw legacyError;
      return { profile: createEmptyProfile(), canonical: false, legacyImport: null };
    }
  }
}

export async function readLegacyProfile(dataDir: string): Promise<string | null> {
  try { return await readFile(configPaths(dataDir).profile, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeStructuredProfile(dataDir: string, value: unknown): Promise<StructuredProfile> {
  const profile = ProfileSchema.parse(value) as StructuredProfile;
  await mkdir(dataDir, { recursive: true });
  await writeFile(configPaths(dataDir).profileJson, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return profile;
}

/** Explicit legacy API compatibility for existing Phase 1–2 callers; it creates a canonical reviewed summary, never overwrites profile.md. */
export async function writeLegacyCompatibilityProfile(dataDir: string, value: unknown): Promise<StructuredProfile> {
  const legacy = z.string().max(200_000).parse(value);
  const profile = createEmptyProfile();
  profile.identity.summary = legacy;
  profile.identity.email = legacy.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "";
  profile.identity.phone = legacy.match(/(?:\+?\d[\d ()-]{6,}\d)/)?.[0] ?? "";
  return writeStructuredProfile(dataDir, profile);
}

export function serializeProviderContext(profile: StructuredProfile, purpose: ProfilePurpose = "preview"): string {
  const identity = purpose === "scrape" || purpose === "interview" || purpose === "follow_up" || purpose === "manual_import"
    ? {
        firstName: profile.identity.firstName,
        lastName: profile.identity.lastName,
        headline: profile.identity.headline,
        city: profile.identity.city,
        country: profile.identity.country,
        summary: profile.identity.summary,
      }
    : profile.identity;
  const payload = {
    version: profile.version,
    identity,
    workPreferences: profile.workPreferences,
    experience: profile.experience,
    education: profile.education,
    skills: profile.skills,
    certifications: profile.certifications,
    projects: profile.projects,
    awards: profile.awards,
    languages: profile.languages,
  };
  return JSON.stringify(payload, null, 2);
}

export async function readProviderContext(dataDir: string, purpose: ProfilePurpose): Promise<string> {
  const result = await readStructuredProfile(dataDir);
  if (!result.canonical) throw new Error("Profile review and save is required before provider actions.");
  return serializeProviderContext(result.profile, purpose);
}

async function readJson<T>(path: string, fallback: T, schema: z.ZodType<T>) {
  const value = JSON.parse(await ensureFile(path, `${JSON.stringify(fallback, null, 2)}\n`));
  return schema.parse(value);
}

async function writeJson<T>(path: string, value: unknown, schema: z.ZodType<T>) {
  const parsed = schema.parse(value);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return parsed;
}

export function readCriteria(dataDir: string) { return readJson(configPaths(dataDir).criteria, defaultCriteria, CriteriaSchema); }
export function writeCriteria(dataDir: string, value: unknown) { return writeJson(configPaths(dataDir).criteria, value, CriteriaSchema); }
export async function readSettings(dataDir: string) {
  const path = configPaths(dataDir).settings;
  const raw = JSON.parse(await ensureFile(path, `${JSON.stringify(defaultSettings, null, 2)}\n`)) as unknown;
  const input = raw && typeof raw === "object" ? { ...defaultSettings, ...(raw as Record<string, unknown>) } : raw;
  if (input && typeof input === "object" && !Object.prototype.hasOwnProperty.call(raw, "enabledSources")) delete (input as Record<string, unknown>).enabledSources;
  const parsed = SettingsSchema.parse(input);
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return parsed;
}
export function writeSettings(dataDir: string, value: unknown) { return writeJson(configPaths(dataDir).settings, value, SettingsSchema); }
