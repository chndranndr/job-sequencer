import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { defaultGenerationDirection, effectiveCvPages, type GenerationDirection, type Rank, type StructuredProfile, type TrajectoryRecorder } from "../shared.js";
import { ProfileSchema, type Settings } from "./config.js";
import { compileAndVerify, containedPath, type CommandRunner } from "./documents.js";
import { createTaskReporter, getJobDetail, updateJobDirection } from "./db.js";
import { projectPromptContext, trustedSection, untrustedSection } from "./context.js";
import { loadGuidance } from "./guidance.js";
import { createRestrictedGenerationSession, runBoundedPi, type PiRunUsage } from "./pi.js";
import { buildAgentCandidateContext } from "./agents/context.js";
import { validateClaims } from "./agents/claim-validator.js";
import { splitDescriptionIntoBullets, validateApplicationStrategy } from "./agents/evidence.js";
import { renderCVDocument } from "./rendering/cv.js";
import { coverLetterClosing, renderCoverLetter } from "./rendering/cover-letter.js";
import { runCritic, type CriticFn } from "./agents/critic.js";
import { failClosedOnCriticalFactualAudit, runFactualAuditor, type FactualAuditorFn } from "./agents/factual-auditor.js";
import { MAX_REVISION_ROUNDS, revisionNeeded, runReviser, type ReviserFn } from "./agents/reviser.js";
import { runStrategist, type StrategistFn } from "./agents/strategist.js";
import { ApplicationStrategySchema, type ApplicationStrategy, type CVDocument, type EvidenceBank } from "./agents/types.js";
import { runWriter, type WriterFn } from "./agents/writer.js";
import { runCompanyResearch, type CompanyResearch, type ResearcherFn } from "./agents/research.js";
import { runAtsReviewer, type AtsReviewerFn } from "./agents/ats.js";
import type { AtsReview } from "./agents/types.js";
import { runStructured } from "./structured.js";
import { loadTemplateMetadata, selectCvTemplate } from "./templates.js";
import { runDocumentVerifier } from "./verifier.js";
import { rasterizePdfPages, runVisualReviewer, type VisualQaFn, type VisualReview } from "./visual.js";

export const GenerationOutputSchema = z.object({
  cvTemplate: z.string().min(1),
  roleEmphasis: z.array(z.string().trim().min(1)).max(20).optional().default([]),
  cvEdits: z.array(z.string().trim().min(1)).max(30).optional().default([]),
  profileFacts: z.array(z.string().trim().min(1)).min(1).max(30),
  coverLetterSubject: z.string().max(500).optional().default(""),
  coverLetterParagraphs: z.array(z.string().trim().min(1)).max(10).optional().default([]),
  coverLetterBullets: z.array(z.string().trim().min(1)).max(20).optional().default([]),
  gaps: z.array(z.string().trim().min(1)).max(20),
}).strict();
export type GenerationOutput = z.infer<typeof GenerationOutputSchema>;
export type GenerationExecutor = (context: { profile: string; job: Record<string, unknown>; rank: unknown; templates: unknown; guidance?: string; settings: Settings; cvPageEstimate?: number | null; signal: AbortSignal; runId?: string; trajectory?: TrajectoryRecorder; onUsage?: (usage: PiRunUsage) => void; direction?: GenerationDirection }) => Promise<unknown>;

function availableCvTemplateIds(templates: unknown) {
  if (!templates || typeof templates !== "object" || Array.isArray(templates) || !("cv" in templates)) return [];
  const cv = templates.cv;
  return cv && typeof cv === "object" && !Array.isArray(cv) ? Object.keys(cv) : [];
}

function knownGenerationGaps(rank: unknown) {
  if (!rank || typeof rank !== "object" || Array.isArray(rank) || !("gaps" in rank) || !Array.isArray(rank.gaps)) return [];
  return rank.gaps.filter((gap): gap is string => typeof gap === "string");
}

function asRank(value: unknown): Rank {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { reason: "", strengths: [], gaps: [] };
  const record = value as Record<string, unknown>;
  const strings = (input: unknown) => Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [];
  return {
    reason: typeof record.reason === "string" ? record.reason : "",
    strengths: strings(record.strengths),
    gaps: strings(record.gaps),
  };
}

function userDirectionText(direction: GenerationDirection, cvPages: number, coverLetterPages: number, cvPageEstimate: number | null) {
  const compactComplete = direction.cvLength === "complete" && cvPageEstimate !== null && cvPages < cvPageEstimate;
  const lines = [
    direction.cvLength === "short"
      ? `CV length is short. Target ${cvPages} CV page(s) and ${coverLetterPages} cover-letter page(s). Write denser copy. Prefer experience achievements and cover-letter evidence that overlap the posting's industry, product domain, and stack. Keep every employer. Drop unrelated bullets instead of summarizing them. Never invent facts. cvEdits must be factual achievement lines from the matching employer only, never planning instructions.`
      : compactComplete
        ? `CV length is complete, but the complete profile is estimated at ${cvPageEstimate} CV page(s) while the target is ${cvPages}. Keep every employer and the strongest grounded evidence, then shorten wording and remove redundant or lower-priority detail to fit. Target ${cvPages} CV page(s) and ${coverLetterPages} cover-letter page(s). Never invent facts. cvEdits must be factual achievement lines from the matching employer only, never planning instructions.`
        : `CV length is complete. Preserve the full profile and target ${cvPages} CV page(s). Keep the cover letter at ${coverLetterPages} page(s). cvEdits must be factual achievement lines from the matching employer only, never planning instructions.`,
    direction.letterMode === "exploratory"
      ? "Letter mode is exploratory. Frame the candidate for an adjacent role. Still list every entry from rank.gaps. Never invent employers, metrics, or titles."
      : "Letter mode is standard. Write to the posted role.",
  ];
  const narration = direction.letterNarration.trim();
  if (narration) lines.push(`Letter narration: ${narration}`);
  const notes = direction.revisionNotes.trim();
  if (notes) {
    lines.push("Revision notes are operator instructions. Never copy numbers, tokens, or claims from them into the CV or letter unless they already appear in the candidate profile. Never mention a rejected claim.");
    lines.push(`Revision notes: ${notes}`);
  }
  return lines.join("\n");
}

export function buildGenerationPrompt(context: { profile: string; job: Record<string, unknown>; rank: unknown; templates: unknown; settings?: Pick<Settings, "cvPages" | "coverLetterPages">; cvPageEstimate?: number | null; direction?: GenerationDirection }, guidance: string, direction = context.direction ?? defaultGenerationDirection) {
  const posting = context.job.posting;
  const jobMetadata = Object.fromEntries(Object.entries(context.job).filter(([key]) => key !== "posting" && key !== "notes" && key !== "application_notes"));
  const settings = context.settings ?? { cvPages: 2, coverLetterPages: 1 };
  const cvPages = effectiveCvPages(settings, direction);
  return [
    trustedSection("INSTRUCTIONS", `Return JSON only matching {"cvTemplate":"","roleEmphasis":["verified facts relevant to the role"],"cvEdits":["specific truthful edits"],"profileFacts":["exact verbatim excerpts from profile"],"coverLetterSubject":"","coverLetterParagraphs":["2-4 substantive truthful paragraphs carrying the main narrative and evidence"],"coverLetterBullets":["optional verified complementary points not already stated in paragraphs"],"gaps":["exact entries from rank.gaps"]}. Allowed local CV template IDs: ${JSON.stringify(availableCvTemplateIds(context.templates))}. Set cvTemplate to exactly one ID from this list, verbatim; do not invent, alias, or map template IDs. Use only supplied facts, job data, and gaps; never invent metrics, employers, technologies, responsibilities, or company claims. Keep bullets optional and complementary: omit them when no new evidence remains, and never repeat a paragraph's achievement, metric, or claim. Do not use em-dashes.`),
    trustedSection("USER DIRECTION", userDirectionText(direction, cvPages, settings.coverLetterPages, context.cvPageEstimate ?? null)),
    trustedSection("GUIDANCE", guidance),
    trustedSection("CANDIDATE PROFILE", context.profile),
    untrustedSection("JOB METADATA", JSON.stringify(projectPromptContext(jobMetadata))),
    untrustedSection("EXTERNAL JOB POSTING", typeof posting === "string" ? posting : JSON.stringify(projectPromptContext(posting)) ?? "null"),
    trustedSection("RANK DATA", JSON.stringify(projectPromptContext(context.rank))),
    trustedSection("LOCAL TEMPLATE DATA", JSON.stringify(projectPromptContext(context.templates))),
  ].join("\n");
}

export const liveGenerationExecutor: GenerationExecutor = async context => {
  const guidance = await loadGuidance(["writingStyle", "cvTemplates", "coverLetterTemplates"]);
  const prompt = buildGenerationPrompt(context, guidance, context.direction);
  return runStructured({
    prompt,
    schema: GenerationOutputSchema,
    execute: async attemptPrompt => {
      let text = "";
      await runBoundedPi({
        prompt: attemptPrompt,
        timeoutMs: 120_000,
        signal: context.signal,
        createSession: () => createRestrictedGenerationSession(context.settings),
        runId: context.runId,
        trajectory: context.trajectory,
        onUsage: context.onUsage,
        onEvent: event => {
          const value = event as { type?: string; assistantMessageEvent?: { type?: string; delta?: string } };
          if (value.type === "message_update" && value.assistantMessageEvent?.type === "text_delta") text += value.assistantMessageEvent.delta ?? "";
        },
      });
      return text;
    },
    signal: context.signal,
    trajectory: context.trajectory,
    runId: context.runId,
    validateBusiness: output => validateGenerationBusiness(
      output,
      context.profile,
      availableCvTemplateIds(context.templates),
      knownGenerationGaps(context.rank),
      `${String(context.job.role)} ${String(context.job.company)} ${String(context.job.posting ?? "")}`,
    ),
  });
};

function tokenise(value: string) {
  return (value.match(/[A-Za-z][A-Za-z0-9+#.-]{2,}/g) ?? []).map(token => token.replace(/[.]+$/, "").toLowerCase());
}

function keepGrounded(values: readonly string[], source: string) {
  const tokens = new Set(tokenise(source));
  return values.filter(value => tokenise(value).some(token => tokens.has(token)));
}

function assertGrounded(values: string[], source: string, label: string) {
  if (keepGrounded(values, source).length !== values.length) throw new Error(`Generated ${label} contains an unsupported or ungrounded claim.`);
}

export function isInstructionShapedModelCopy(value: string) {
  const text = value.trim();
  return /^(prioritize|emphasize|retain|keep every|drop unrelated|order core skills|never invent)\b/i.test(text)
    || /\b(retain every employer|keep every employer|drop unrelated bullets|order core skills|prioritize overlapping|emphasize overlapping)\b/i.test(text);
}

function assertNoDocumentMarkers(values: string[]) {
  const forbidden = /requires human review|selected cv edits|acknowledged gaps|this editable draft|grounding disclaimer|verified profile facts|role emphasis|profile facts|target role|i am passionate about|i believe i would be a great fit|leverage my skills|hit the ground running|drive results|synergies|retain every employer|keep every employer|drop unrelated bullets|order core skills|prioritize overlapping|emphasize overlapping/i;
  if (values.some(value => forbidden.test(value) || isInstructionShapedModelCopy(value))) throw new Error("Generated document contains an internal or generic phrase.");
}

function compactFactText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function profileStringFields(profile: string) {
  const fields: string[] = [profile];
  try {
    const walk = (value: unknown) => {
      if (typeof value === "string") fields.push(value);
      else if (Array.isArray(value)) for (const item of value) walk(item);
      else if (value && typeof value === "object") for (const item of Object.values(value)) walk(item);
    };
    walk(JSON.parse(profile));
  } catch { /* markdown or other non-JSON profile text */ }
  return fields;
}

export function profileContainsFact(profile: string, fact: string) {
  const needle = fact.trim();
  if (!needle) return false;
  if (profile.includes(needle)) return true;
  const compactNeedle = compactFactText(needle);
  return profileStringFields(profile).some((field) => field.includes(needle) || compactFactText(field).includes(compactNeedle));
}

function validateGenerationBusiness(value: GenerationOutput, profile: string, templateNames: string[], knownGaps: string[], jobContext = ""): GenerationOutput {
  if (!templateNames.includes(value.cvTemplate)) throw new Error("Generated output selected an unknown template.");
  if (value.profileFacts.some((fact) => !profileContainsFact(profile, fact))) throw new Error("Generated output contains an unsupported profile fact.");
  for (const gap of value.gaps) if (!knownGaps.includes(gap)) throw new Error("Generated output contains an unsupported gap.");
  if ([...value.cvEdits, ...value.roleEmphasis].some(isInstructionShapedModelCopy)) throw new Error("Generated document contains an internal or generic phrase.");
  assertNoDocumentMarkers([...value.profileFacts, ...value.coverLetterParagraphs, ...value.coverLetterBullets, value.coverLetterSubject]);
  const source = `${profile}\n${jobContext}\n${knownGaps.join("\n")}`;
  assertGrounded([...value.roleEmphasis, ...value.coverLetterParagraphs, ...value.coverLetterBullets], source, "content");
  if (value.coverLetterSubject && !value.coverLetterSubject.toLowerCase().split(/\s+/).some(token => source.toLowerCase().includes(token))) throw new Error("Generated cover-letter subject contains an unsupported claim.");
  return { ...value, cvEdits: keepGrounded(value.cvEdits, source) };
}

export function validateGenerationOutput(value: unknown, profile: string, templateNames: string[], knownGaps: string[], jobContext = ""): GenerationOutput {
  const parsed = GenerationOutputSchema.parse(value);
  return validateGenerationBusiness(parsed, profile, templateNames, knownGaps, jobContext);
}

function normalizeProse(value: string) {
  return value.replace(/\s*[\u2011\u2013\u2014]\s*/g, ", ").replace(/--+/g, ", ").replace(/[ \t]{2,}/g, " ").trim();
}

const latexEscapes: Record<string, string> = { "\\": "\\textbackslash{}", "#": "\\#", "$": "\\$", "%": "\\%", "&": "\\&", "_": "\\_", "{": "\\{", "}": "\\}", "^": "\\textasciicircum{}", "~": "\\textasciitilde{}" };
function latex(value: string) { return normalizeProse(value).replace(/[\\#$%&_{}^~]/g, character => latexEscapes[character] ?? character); }
function latexUrl(value: string) { return value.trim().replace(/[\\#$%&_{}^~]/g, character => latexEscapes[character] ?? character); }

function parseStructuredProfile(value: string): StructuredProfile | null {
  const candidate = value.trim();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(candidate); }
  catch { throw new Error("Canonical structured profile is invalid."); }
  const result = ProfileSchema.safeParse(parsed);
  if (!result.success) throw new Error("Canonical structured profile is invalid.");
  return result.data as StructuredProfile;
}

function contact(profile: string, structured: StructuredProfile | null) {
  const email = structured ? structured.identity.email : profile.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const phone = structured ? structured.identity.phone : profile.match(/(?:\+?\d[\d ()-]{6,}\d)/)?.[0];
  if (!email || !phone) throw new Error("Profile must contain a literal email and phone before generation.");
  return { email, phone };
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatMonth(value: string) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  return match ? `${months[Number(match[2]) - 1]} ${match[1]}` : "";
}
function dateRange(entry: { startMonth: string; startYear: string; endMonth: string; endYear: string; currentRole?: boolean }) {
  const start = formatMonth(entry.startMonth) || entry.startYear;
  const end = formatMonth(entry.endMonth) || entry.endYear || (entry.currentRole && start ? "Present" : "");
  return [start, end].filter(Boolean).join(" - ");
}
function cvSection(title: string, body: string, minimumReservation = 3) { return body.trim() ? `\\needspace{${minimumReservation}\\baselineskip}\n\\section{${latex(title)}}\n${body}` : ""; }

function cvBullets(items: string[]) {
  return items.length ? `\\begin{itemize}[leftmargin=*,labelindent=0pt,labelsep=0.4em,itemindent=0pt,itemsep=0pt,topsep=1pt,parsep=0pt,partopsep=0pt]\n${items.map(item => `\\item ${latex(item)}`).join("\n")}\n\\end{itemize}` : "";
}

const SHORT_EXPERIENCE_BULLET_CAP = 4;

export function selectExperienceBullets(description: string, jobText: string, roleEmphasis: readonly string[], cvLength: GenerationDirection["cvLength"]) {
  const bullets = splitDescriptionIntoBullets(description).map(item => item.trim()).filter(Boolean);
  if (cvLength !== "short") return bullets;
  const ranked = bullets.map((bullet, index) => ({ bullet, index, score: overlapScore(bullet, jobText, roleEmphasis) }));
  const relevant = ranked.filter(item => item.score > 0).sort((left, right) => right.score - left.score || left.index - right.index);
  return relevant.slice(0, SHORT_EXPERIENCE_BULLET_CAP).sort((left, right) => left.index - right.index).map(item => item.bullet);
}

function experienceEntry(entry: StructuredProfile["experience"][number], jobText = "", roleEmphasis: readonly string[] = [], cvLength: GenerationDirection["cvLength"] = "complete", extraBullets: readonly string[] = []) {
  if (!entry.title.trim() && !entry.company.trim() && !entry.description.trim()) return "";
  const title = entry.title.trim() || entry.company.trim();
  const company = entry.company.trim() && entry.title.trim() ? latex(entry.company) : "";
  const date = dateRange(entry);
  const bullets = selectExperienceBullets(entry.description, jobText, roleEmphasis, cvLength);
  const seen = new Set(bullets.map((bullet) => bullet.toLowerCase()));
  for (const extra of extraBullets) {
    const line = extra.trim();
    if (!line || isInstructionShapedModelCopy(line) || seen.has(line.toLowerCase())) continue;
    bullets.push(line);
    seen.add(line.toLowerCase());
  }
  return [
    "\\needspace{7\\baselineskip}",
    `\\cventry{${latex(date)}}{${latex(title)}}{${company}}{${latex(entry.location)}}{${latex(entry.employmentType)}}{%`,
    cvBullets(bullets),
    "}",
  ].join("\n");
}

function projectEntry(entry: StructuredProfile["projects"][number]) {
  if (!entry.name.trim() && !entry.role.trim() && !entry.description.trim()) return "";
  const title = entry.name.trim() || entry.role.trim();
  const role = entry.name.trim() && entry.role.trim() ? `Role: ${latex(entry.role)}` : "";
  const date = dateRange(entry);
  return [
    "\\needspace{4\\baselineskip}",
    `\\cventry{${latex(date)}}{${role}}{\\textbf{${latex(title)}}}{}{}{%`,
    cvBullets(splitDescriptionIntoBullets(entry.description)),
    "}",
  ].join("\n");
}

function educationEntry(entry: StructuredProfile["education"][number]) {
  const title = [entry.degree, entry.fieldOfStudy].filter(value => value.trim()).join(", ");
  const date = dateRange(entry);
  const gpa = entry.gpa.trim() ? `GPA: ${entry.gpa.trim()}` : "";
  if (!title && !entry.institution.trim() && !date && !gpa) return "";
  return [
    "\\needspace{4\\baselineskip}",
    `\\cventry{${latex(date)}}{${latex(title)}}{${latex(entry.institution)}}{}{}{${latex(gpa)}}`,
  ].join("\n");
}

function certificationEntry(entry: StructuredProfile["certifications"][number]) {
  const title = entry.name.trim() || entry.issuer.trim();
  const issuer = entry.name.trim() && entry.issuer.trim() ? latex(entry.issuer) : "";
  const date = formatMonth(entry.issueDate) || entry.issueDate.trim();
  if (!title && !date && !entry.description.trim()) return "";
  return `\\cventry{${latex(date)}}{\\textbf{${latex(title)}}}{${issuer}}{}{}{${latex(entry.description)}}`;
}

const relevanceStopWords = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "can", "for", "from", "has", "have", "how", "in", "into", "is", "it", "its", "of", "on", "or", "our", "per", "that", "the", "their", "this", "to", "using", "via", "was", "were", "what", "when", "where", "which", "who", "with", "you", "your"]);

function revisionNoteTokens(value: string) {
  return value.match(/\d+(?:\.\d+)?%|[A-Za-z][A-Za-z0-9+#._-]{1,}/g) ?? [];
}

function revisionNoteLeaks(notes: string, profile: string) {
  if (!notes.trim()) return [];
  const profileTokens = new Set(revisionNoteTokens(profile).map(token => token.toLowerCase()));
  return revisionNoteTokens(notes).filter(token => /\d/.test(token) && !profileTokens.has(token.toLowerCase()));
}

function texTokenPattern(token: string) {
  const escaped = [...token].map(character => {
    if ("\\^$*+?()[]{}|.".includes(character)) return `\\${character}`;
    if ("#$%&_".includes(character)) return `\\\\?${character}`;
    return character;
  }).join("");
  return new RegExp(escaped, "i");
}

export function stripRevisionNoteLeaks(tex: string, revisionNotes: string, profile: string) {
  const leaks = revisionNoteLeaks(revisionNotes, profile);
  if (!leaks.length) return tex;
  const patterns = leaks.map(texTokenPattern);
  return tex.split("\n").filter(line => !patterns.some(pattern => pattern.test(line))).join("\n");
}

function relevanceTokens(value: string) {
  const tokens = value.toLowerCase().match(/[a-z0-9]+(?:[+#./-][a-z0-9]+|[+#])*/g) ?? [];
  return tokens.flatMap(token => [token, ...token.split(/[./-]/)]).filter(token => token.length > 1 && !relevanceStopWords.has(token));
}

function overlapScore(value: string, jobText: string, roleEmphasis: readonly string[]) {
  const valueTokens = new Set(relevanceTokens(value));
  const jobTokens = new Set(relevanceTokens(jobText));
  const emphasisTokens = new Set(relevanceTokens(roleEmphasis.join(" ")));
  return [...valueTokens].reduce((score, token) => score + (emphasisTokens.has(token) ? 5 : jobTokens.has(token) ? 1 : 0), 0);
}

function nonEmptyEntries<T>(entries: readonly T[], text: (entry: T) => string) {
  return entries.filter(entry => text(entry).trim());
}

const backendPlatformSignals = new Set(["api", "apis", "backend", "cloud", "devops", "infrastructure", "java", "kubernetes", "microservice", "microservices", "platform", "rest", "service", "services", "spring"]);
const projectDomainSignals = new Set(["api", "apis", "backend", "cloud", "data", "database", "devops", "infrastructure", "microservice", "microservices", "platform", "pipeline", "rest", "service", "services", "server"]);
const gameRenderingSignals = new Set(["directx", "fps", "frame-rate", "game", "gameplay", "graphics", "opengl", "render", "rendering", "renderer", "shader", "shaders", "unity", "unreal", "vulkan"]);
const backendPlatformSkillGroups = [
  { boost: 5, names: ["Java", "Spring Boot", "Spring MVC", "REST APIs", "JPA/Hibernate", "Microservices"] },
  { boost: 4, names: ["Event-driven architecture", "PostgreSQL", "Redis", "Kafka", "RabbitMQ"] },
  { boost: 3, names: ["Jenkins", "Docker", "Kubernetes", "Helm", "Ansible"] },
  { boost: 2, names: ["Datadog", "Sentry", "Grafana", "Kibana"] },
  { boost: 2, names: ["JUnit", "TDD"] },
] as const;

function backendPlatformBoost(name: string, context: string) {
  const contextTokens = new Set(relevanceTokens(context));
  if (![...contextTokens].some(token => backendPlatformSignals.has(token))) return 0;
  const normalized = name.trim().toLowerCase();
  return backendPlatformSkillGroups.find(group => group.names.some(skill => skill.toLowerCase() === normalized))?.boost ?? 0;
}

export function selectRelevantSkills(skills: StructuredProfile["skills"], jobText: string, roleEmphasis: readonly string[]) {
  const entries = nonEmptyEntries(skills, entry => entry.name).filter((entry, index, all) => all.findIndex(candidate => candidate.name.trim().toLowerCase() === entry.name.trim().toLowerCase()) === index);
  const context = `${jobText} ${roleEmphasis.join(" ")}`;
  const ranked = entries.map((entry, index) => ({ entry, index, score: overlapScore(entry.name, jobText, roleEmphasis) + backendPlatformBoost(entry.name, context) })).sort((left, right) => right.score - left.score || left.index - right.index);
  const relevant = ranked.some(item => item.score > 0) ? ranked.filter(item => item.score > 0) : ranked;
  // ponytail: cap skills at 20; raise only after a measured two-page layout review.
  return relevant.slice(0, 20).map(item => item.entry);
}

export function selectRelevantProjects(projects: StructuredProfile["projects"], jobText: string, roleEmphasis: readonly string[]) {
  const entries = nonEmptyEntries(projects, entry => `${entry.name} ${entry.role} ${entry.description}`);
  const contextTokens = new Set(relevanceTokens(jobText));
  const shouldFilterDomainMismatch = [...contextTokens].some(token => projectDomainSignals.has(token)) && ![...contextTokens].some(token => gameRenderingSignals.has(token));
  // ponytail: keyword taxonomy is deliberately small; expand only for observed false positives.
  const filteredEntries = shouldFilterDomainMismatch ? entries.filter(entry => ![...relevanceTokens(`${entry.name} ${entry.role} ${entry.description}`)].some(token => gameRenderingSignals.has(token))) : entries;
  const relevantEntries = filteredEntries.length ? filteredEntries : entries;
  const ranked = relevantEntries.map((entry, index) => ({ entry, index: entries.indexOf(entry), score: overlapScore(`${entry.name} ${entry.role} ${entry.description}`, jobText, roleEmphasis) })).sort((left, right) => right.score - left.score || left.index - right.index);
  const relevant = ranked.some(item => item.score > 0) ? ranked.filter(item => item.score > 0) : ranked;
  // ponytail: keep four projects so the validated CV remains two pages.
  return relevant.slice(0, 4).map(item => item.entry);
}

function headerCommands(profile: StructuredProfile | null, email = "", phone = "") {
  const identity = profile?.identity;
  const firstName = identity?.firstName.trim() ?? "";
  const lastName = identity?.lastName.trim() ?? "";
  const headline = identity?.headline.trim() ?? "";
  const location = [identity?.city ?? "", identity?.country ?? ""].filter(value => value.trim()).join(", ");
  const emailValue = email || identity?.email || "";
  const phoneValue = phone || identity?.phone || "";
  const links = profile ? ([
    ["Website", identity?.website ?? ""],
    ["LinkedIn", identity?.linkedinUrl ?? ""],
    ["GitHub", identity?.githubUrl ?? ""],
  ] as const).filter(([, value]) => value.trim()).map(([label, value]) => `\\link[${label}]{${latexUrl(value)}}`) : [];
  const contactValues = [emailValue, phoneValue, location, identity?.website ?? "", identity?.linkedinUrl ?? "", identity?.githubUrl ?? ""].filter(value => value.trim());
  return {
    NAME: latex([firstName, lastName].filter(Boolean).join(" ")),
    FIRST_NAME: latex(firstName),
    LAST_NAME: latex(lastName),
    HEADLINE: latex(headline),
    HEADLINE_BLOCK: headline ? ["\\vspace{-19pt}", "\\begin{center}", `\\small\\textbf{${latex(headline)}}`, "\\end{center}", "\\vspace{-8pt}"].join("\n") : "",
    ADDRESS_COMMAND: location ? `\\address{${latex(location)}}{}{}` : "",
    PHONE_COMMAND: phoneValue ? `\\phone[mobile]{${latex(phoneValue)}}` : "",
    EMAIL_COMMAND: emailValue ? `\\email{${latex(emailValue)}}` : "",
    EXTRAINFO_COMMAND: links.length ? `\\extrainfo{${links.join(" \\enspace|\\enspace ")}}` : "",
    CONTACT: contactValues.map(latex).join(" \\textbar{} "),
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsCompany(text: string, company: string) {
  const name = company.trim();
  if (name.length < 4) return false;
  return new RegExp(escapeRegExp(name), "i").test(text);
}

function assignCvEdits(experiences: StructuredProfile["experience"], edits: readonly string[]) {
  const assigned = new Map<string, string[]>();
  const leftover: string[] = [];
  const push = (id: string, edit: string) => {
    const current = assigned.get(id) ?? [];
    current.push(edit);
    assigned.set(id, current);
  };
  for (const edit of edits) {
    const mentioned = experiences.filter((entry) => mentionsCompany(edit, entry.company));
    if (mentioned.length === 1) {
      push(mentioned[0]!.id, edit);
      continue;
    }
    if (mentioned.length > 1) continue;
    const scored = experiences.map((entry) => ({
      entry,
      score: overlapScore(edit, `${entry.company} ${entry.title} ${entry.description}`, []),
    }));
    scored.sort((left, right) => right.score - left.score);
    const best = scored[0];
    if (best && best.score > 0) push(best.entry.id, edit);
    else leftover.push(edit);
  }
  return { assigned, leftover };
}

export function renderStructuredProfile(profile: StructuredProfile, jobText = "", roleEmphasis: readonly string[] = [], cvEdits: readonly string[] = [], cvLength: GenerationDirection["cvLength"] = "complete") {
  const experiences = profile.experience.filter(entry => entry.title.trim() || entry.company.trim() || entry.description.trim());
  const skills = selectRelevantSkills(profile.skills, jobText, roleEmphasis).map(entry => latex(entry.name.trim())).join(", ");
  const projects = selectRelevantProjects(profile.projects, jobText, roleEmphasis);
  const groundedEdits = keepGrounded(cvEdits, `${JSON.stringify(profile)}\n${jobText}`).filter((edit) => !isInstructionShapedModelCopy(edit));
  const { assigned, leftover } = assignCvEdits(experiences, groundedEdits);
  const experienceBody = [
    experiences.map(entry => experienceEntry(entry, jobText, roleEmphasis, cvLength, assigned.get(entry.id) ?? [])).filter(Boolean).join("\n"),
    leftover.map((edit) => `\\cvitem{}{${latex(edit)}}`).join("\n"),
  ].filter(Boolean).join("\n");
  return {
    ...headerCommands(profile),
    SUMMARY_SECTION: cvSection("Professional Summary", latex(profile.identity.summary)),
    SKILLS_SECTION: cvSection("Core Skills", skills ? `\\cvitem{}{${skills}}` : ""),
    EXPERIENCE: experienceBody,
    EXPERIENCE_SECTION: cvSection("Professional Experience", experienceBody),
    PROJECTS_SECTION: cvSection("Selected Projects", projects.map(projectEntry).filter(Boolean).join("\n"), 8),
    EDUCATION_SECTION: cvSection("Education", profile.education.map(educationEntry).filter(Boolean).join("\n")),
    CERTIFICATIONS_SECTION: cvSection("Certifications", profile.certifications.map(certificationEntry).filter(Boolean).join("\n")),
    LANGUAGES_SECTION: cvSection("Languages", profile.languages.filter(entry => entry.name.trim()).map(entry => entry.proficiency.trim() ? `\\cvitemwithcomment{}{${latex(entry.name)}}{${latex(entry.proficiency)}}` : `\\cvitem{}{${latex(entry.name)}}`).join("\n")),
  };
}

const PROFILE_ESTIMATE_CHARS_PER_LINE = 95;
const PROFILE_ESTIMATE_LINES_PER_PAGE = 72;

function estimateTextLines(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? Math.max(1, Math.ceil(normalized.length / PROFILE_ESTIMATE_CHARS_PER_LINE)) : 0;
}

function estimateEntryLines(values: readonly string[]) {
  return values.reduce((total, value) => total + estimateTextLines(value), 0);
}

/**
 * ponytail: this is a cheap, template-calibrated advisory estimate; exact PDF
 * verification remains authoritative if the template or font metrics change.
 */
export function estimateCvPages(profile: StructuredProfile) {
  const experience = profile.experience.filter(entry => entry.title.trim() || entry.company.trim() || entry.description.trim());
  const skills = selectRelevantSkills(profile.skills, "", []).map(entry => entry.name.trim()).filter(Boolean);
  const projects = selectRelevantProjects(profile.projects, "", []);
  const education = profile.education.filter(entry => Boolean(educationEntry(entry)));
  const certifications = profile.certifications.filter(entry => Boolean(certificationEntry(entry)));
  const languages = profile.languages.filter(entry => entry.name.trim());
  const header = [
    profile.identity.firstName,
    profile.identity.lastName,
    profile.identity.headline,
    profile.identity.email,
    profile.identity.phone,
    profile.identity.city,
    profile.identity.country,
    profile.identity.website,
    profile.identity.linkedinUrl,
    profile.identity.githubUrl,
  ];
  const contentLines = estimateTextLines(header.join(" "))
    + estimateTextLines(profile.identity.summary)
    + estimateTextLines(skills.join(", "))
    + experience.reduce((total, entry) => total
      + estimateTextLines([dateRange(entry), entry.title, entry.company, entry.location, entry.employmentType].join(" "))
      + estimateEntryLines(selectExperienceBullets(entry.description, "", [], "complete")), 0)
    + projects.reduce((total, entry) => total
      + estimateTextLines([dateRange(entry), entry.name, entry.role].join(" "))
      + estimateEntryLines(splitDescriptionIntoBullets(entry.description)), 0)
    + education.reduce((total, entry) => total + estimateTextLines([dateRange(entry), entry.degree, entry.fieldOfStudy, entry.institution, entry.gpa].join(" ")), 0)
    + certifications.reduce((total, entry) => total + estimateTextLines([entry.issueDate, entry.name, entry.issuer, entry.description].join(" ")), 0)
    + languages.reduce((total, entry) => total + estimateTextLines([entry.name, entry.proficiency].join(" ")), 0);
  const populatedSections = [
    profile.identity.summary,
    skills.join(" "),
    experience.length ? "experience" : "",
    projects.length ? "projects" : "",
    education.length ? "education" : "",
    certifications.length ? "certifications" : "",
    languages.length ? "languages" : "",
  ].filter(Boolean).length;
  const structuralLines = 5 + populatedSections * 2 + experience.length * 2 + projects.length + education.length * 2 + certifications.length * 2 + languages.length;
  return Math.max(1, Math.ceil((contentLines + structuralLines) / PROFILE_ESTIMATE_LINES_PER_PAGE));
}

function compactCvDocument(document: CVDocument, profile: StructuredProfile): CVDocument {
  // ponytail: cap bullets and restore omitted employer headings as the safety net; exact PDF verification remains authoritative.
  const present = new Set(document.experiences.map(item => item.experienceId));
  const omittedEmployers = profile.experience
    .filter(entry => (entry.title.trim() || entry.company.trim() || entry.description.trim()) && !present.has(entry.id))
    .map(entry => ({ experienceId: entry.id, bullets: [] }));
  return {
    ...document,
    experiences: [...document.experiences.map(item => ({ ...item, bullets: item.bullets.slice(0, SHORT_EXPERIENCE_BULLET_CAP) })), ...omittedEmployers],
  };
}

function renderProfileCompatibility(output: GenerationOutput, email: string, phone: string) {
  const facts = output.profileFacts.map(latex).join("\\\\\n");
  const factBody = facts ? `\\cvitem{}{${facts}}` : "";
  return { ...headerCommands(null, email, phone), SUMMARY_SECTION: cvSection("Professional Summary", factBody), SKILLS_SECTION: cvSection("Core Skills", factBody), EXPERIENCE: "", EXPERIENCE_SECTION: "", PROJECTS_SECTION: "", EDUCATION_SECTION: "", CERTIFICATIONS_SECTION: "", LANGUAGES_SECTION: "" };
}

function documentDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? latex(value) : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

function letterParagraphValues(output: GenerationOutput, structured: StructuredProfile | null, role: string, company: string) {
  const paragraphs = output.coverLetterParagraphs.slice(0, 4);
  if (paragraphs.length) return paragraphs;
  const fact = structured?.identity.summary || output.profileFacts[0];
  return [`I am applying for the ${role} role at ${company}. My background includes ${fact}.`];
}

function comparisonTokens(value: string) {
  return new Set(relevanceTokens(value));
}

function substantiallyRepeats(value: string, previous: readonly string[]) {
  const candidate = comparisonTokens(value);
  if (!candidate.size) return false;
  return previous.some(text => {
    const reference = comparisonTokens(text);
    const shared = [...candidate].filter(token => reference.has(token)).length;
    const coverage = shared / candidate.size;
    const union = new Set([...candidate, ...reference]).size;
    return coverage >= 0.8 || (candidate.size >= 6 && shared / union >= 0.6);
  });
}

export function filterComplementaryBullets(bullets: readonly string[], paragraphs: readonly string[]) {
  const accepted: string[] = [];
  for (const bullet of bullets) {
    if (!bullet.trim() || substantiallyRepeats(bullet, [...paragraphs, ...accepted])) continue;
    accepted.push(bullet);
  }
  return accepted;
}

export function letterBullets(output: Pick<GenerationOutput, "coverLetterBullets">, paragraphs: readonly string[], jobText = "", roleEmphasis: readonly string[] = [], cvLength: GenerationDirection["cvLength"] = "complete") {
  const complementary = filterComplementaryBullets(output.coverLetterBullets, paragraphs);
  const selected = cvLength === "short" && jobText.trim()
    ? complementary
      .map((bullet, index) => ({ bullet, index, score: overlapScore(bullet, jobText, roleEmphasis) }))
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, 3)
      .sort((left, right) => left.index - right.index)
      .map(item => item.bullet)
    : complementary.slice(0, 3);
  return selected.length ? `\\begin{itemize}[leftmargin=1.15em,itemsep=2pt,topsep=2pt,parsep=0pt,partopsep=0pt]\n${selected.map(value => `\\item ${latex(value)}`).join("\n")}\n\\end{itemize}` : "";
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const MAX_DOCUMENT_HISTORY = 3;

// ponytail: history pruning is best effort; a later publish retries transient filesystem cleanup instead of failing an already-published document.
async function pruneDocumentHistory(appDir: string) {
  const historyRoot = containedPath(appDir, "history");
  let entries;
  try { entries = await readdir(historyRoot, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const directories = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => ({ entry, modifiedAt: (await stat(containedPath(historyRoot, entry.name))).mtimeMs })));
  directories.sort((left, right) => right.modifiedAt - left.modifiedAt || right.entry.name.localeCompare(left.entry.name));
  for (const { entry } of directories.slice(MAX_DOCUMENT_HISTORY)) await rm(containedPath(historyRoot, entry.name), { recursive: true, force: true });
}

async function promoteRevision(appDir: string, currentDir: string, revisionDir: string, stamp: string, runId: string) {
  const safeRunId = runId.replace(/[^A-Za-z0-9_-]/g, "-");
  const stagingDir = containedPath(appDir, `.current-${safeRunId}`);
  const historyDir = containedPath(appDir, "history", `${stamp.replace(/[:.]/g, "-")}-${safeRunId}`);
  await rm(stagingDir, { recursive: true, force: true });
  await cp(revisionDir, stagingDir, { recursive: true });

  let hasCurrent = false;
  try { await readdir(currentDir); hasCurrent = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (hasCurrent) {
    await mkdir(dirname(historyDir), { recursive: true });
    try {
      await rename(currentDir, historyDir);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      // ponytail: Windows copy fallback is non-atomic; replace with a lock-aware swap if atomic publish becomes required.
      await cp(currentDir, historyDir, { recursive: true });
      try {
        await cp(stagingDir, currentDir, { recursive: true, force: true });
      } catch (promoteError) {
        await cp(historyDir, currentDir, { recursive: true, force: true }).catch(() => {});
        throw promoteError;
      }
      await rm(stagingDir, { recursive: true, force: true });
      await pruneDocumentHistory(appDir).catch(() => {});
      return;
    }
  }
  try {
    await rename(stagingDir, currentDir);
  } catch (error) {
    if (hasCurrent) await rename(historyDir, currentDir);
    throw error;
  }
  await pruneDocumentHistory(appDir).catch(() => {});
}

function render(template: string, replacements: Record<string, string>) {
  const tokens = Object.keys(replacements).sort((left, right) => right.length - left.length);
  if (!tokens.length) return template;
  const pattern = new RegExp(tokens.map(token => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return template.replace(pattern, token => replacements[token] ?? token);
}

function generationOutputFromDocument(
  document: CVDocument,
  strategy: ApplicationStrategy,
  cvTemplate: string,
  bank: EvidenceBank,
): GenerationOutput {
  const refs = [
    ...document.summary.evidenceRefs,
    ...document.experiences.flatMap(experience => [
      ...(experience.technologiesUsed ?? []).flatMap(technology => technology.evidenceRefs),
      ...experience.bullets.flatMap(bullet => bullet.evidenceRefs),
    ]),
    ...document.projects.flatMap(project => (project.bullets ?? []).flatMap(bullet => bullet.evidenceRefs)),
    ...document.coverLetter.paragraphs.flatMap(paragraph => paragraph.evidenceRefs),
  ];
  const texts = new Map(bank.items.map(item => [item.ref, item.text]));
  const profileFacts = [...new Set(refs.map(ref => texts.get(ref)).filter((text): text is string => Boolean(text)))].slice(0, 30);
  return {
    cvTemplate,
    roleEmphasis: [],
    cvEdits: [],
    profileFacts: profileFacts.length ? profileFacts : [document.summary.text || strategy.positioning],
    coverLetterSubject: document.coverLetter.subject,
    coverLetterParagraphs: document.coverLetter.paragraphs.map(paragraph => paragraph.text),
    coverLetterBullets: [],
    gaps: strategy.genuineGaps,
  };
}

export async function generateJob(options: { db: DatabaseSync; dataDir: string; projectRoot?: string; jobId: string; settings: Settings; profile: string; execute: GenerationExecutor; signal: AbortSignal; runner?: CommandRunner; allowDrafting?: boolean; now?: string; runId?: string; trajectory?: TrajectoryRecorder; onUsage?: (usage: PiRunUsage) => void; strategist?: StrategistFn; writer?: WriterFn; auditor?: FactualAuditorFn; critic?: CriticFn; reviser?: ReviserFn; researcher?: ResearcherFn; researchEnabled?: boolean; atsReviewer?: AtsReviewerFn; atsEnabled?: boolean; visualQa?: VisualQaFn; visualEnabled?: boolean }) {
  const job = options.db.prepare("SELECT * FROM jobs WHERE id=?").get(options.jobId) as Record<string, unknown> | undefined;
  if (!job) throw new Error("Job not found.");
  const direction = getJobDetail(options.db, options.jobId)?.generation_direction ?? { ...defaultGenerationDirection };
  const allowed = options.allowDrafting ? ["Drafting", "Ready"] : ["Selected"];
  if (!allowed.includes(String(job.stage))) throw new Error(options.allowDrafting ? "Only Drafting or Ready jobs may regenerate." : "Only Selected jobs may generate.");
  const structured = parseStructuredProfile(options.profile);
  const cvPageEstimate = structured ? estimateCvPages(structured) : null;
  const cvPages = effectiveCvPages(options.settings, direction);
  const tasks = createTaskReporter(options.trajectory, options.runId);
  const jobDetail = `${String(job.role)} · ${String(job.company)}`;
  tasks.start({ taskId: `generate:${options.jobId}:prepare`, label: "Prepare job", detail: jobDetail });
  try {
  const now = options.now ?? new Date().toISOString();
  options.db.exec("BEGIN IMMEDIATE");
  try {
    options.db.prepare("UPDATE jobs SET stage='Drafting',updated_at=? WHERE id=?").run(now, options.jobId);
    options.db.prepare("INSERT OR IGNORE INTO applications(job_id,updated_at) VALUES(?,?)").run(options.jobId, now);
    options.db.prepare("UPDATE applications SET approved_at=NULL,updated_at=? WHERE job_id=?").run(now, options.jobId);
    options.db.exec("COMMIT");
  } catch (error) {
    options.db.exec("ROLLBACK");
    throw error;
  }
  const { templatesDir, metadata } = await loadTemplateMetadata(options.projectRoot);
  tasks.complete(`generate:${options.jobId}:prepare`, jobDetail);
  const rank = JSON.parse(String(job.rank_json));
  const role = String(job.role);
  const company = String(job.company);
  const posting = typeof job.posting === "string" ? job.posting : String(job.posting ?? "");
  const jobContext = `${role} ${company} ${posting}`;
  const runId = options.runId ?? "local";
  const appDir = containedPath(options.dataDir, "applications", options.jobId);
  const revisionDir = containedPath(appDir, "revisions", runId);
  await mkdir(revisionDir, { recursive: true });
  const { email, phone } = contact(options.profile, structured);
  let output!: GenerationOutput;
  let profileReplacements: Record<string, string>;
  let paragraphs: string[];
  let coverLetterSubject: string;
  let coverLetterBullets: string;
  let coverLetterClosingText: string;
  let revisionArtifact: unknown;
  let auditArtifact: unknown = { issues: [] };
  let reviewArtifact: unknown = {};
  let atsArtifact: unknown = {};
  let visualArtifact: unknown = { status: "skipped", pages: [] };
  let draftArtifacts: unknown[] = [];
  let visualRevision: ((review: VisualReview) => Promise<void>) | undefined;
  let visualDocument: CVDocument | undefined;
  const visualEnabled = options.visualEnabled ?? (Boolean(options.visualQa) || process.env.VISUAL_QA_ENABLED === "1");
  const visualQa = visualEnabled ? options.visualQa ?? runVisualReviewer : undefined;
  if (structured) {
    const writingStyle = await loadGuidance(["writingStyle"]);
    const context = buildAgentCandidateContext({ profile: structured, writingStyle });
    let research: CompanyResearch | undefined;
    if (options.researchEnabled ?? process.env.COMPANY_RESEARCH_ENABLED === "1") {
      const researchTask = `generate:${options.jobId}:research`;
      tasks.start({ taskId: researchTask, label: "Research company context", detail: jobDetail });
      try {
        research = await (options.researcher ?? runCompanyResearch)({ company, posting, direction, signal: options.signal, trajectory: options.trajectory, runId, settings: options.settings, onUsage: options.onUsage });
        tasks.complete(researchTask, jobDetail);
      } catch (error) {
        tasks.fail(researchTask, "Company research failed.");
        throw error;
      }
    }
    const strategyTask = `generate:${options.jobId}:strategy`;
    tasks.start({ taskId: strategyTask, label: "Plan tailored content", detail: jobDetail });
    const strategy = await (options.strategist ?? runStrategist)({
      context,
      posting,
      rank: asRank(rank),
      direction,
      signal: options.signal,
      trajectory: options.trajectory,
      runId,
      settings: options.settings,
      onUsage: options.onUsage,
      research,
    });
    tasks.complete(strategyTask, jobDetail);
    const validated = validateApplicationStrategy(strategy, context.evidenceBank);
    const strategyPath = containedPath(revisionDir, "strategy.json");
    await writeFile(strategyPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    // Writer must consume the on-disk AG-2 artifact, not an in-memory rebuild from cvEdits.
    const stored = ApplicationStrategySchema.parse(JSON.parse(await readFile(strategyPath, "utf8")));
    const parsedStrategy = validateApplicationStrategy(stored, context.evidenceBank);
    const writerTask = `generate:${options.jobId}:writer`;
    tasks.start({ taskId: writerTask, label: "Write tailored content", detail: jobDetail });
    const document = await (options.writer ?? runWriter)({
      context,
      strategy: parsedStrategy,
      posting,
      direction,
      profile: structured,
      revisionNotes: direction.revisionNotes.trim() || undefined,
      signal: options.signal,
      trajectory: options.trajectory,
      runId,
      settings: options.settings,
      cvPageEstimate,
      onUsage: options.onUsage,
      research,
    });
    tasks.complete(writerTask, jobDetail);
    const claimsTask = `generate:${options.jobId}:claims`;
    tasks.start({ taskId: claimsTask, label: "Validate claims", detail: jobDetail });
    let validatedDocument = validateClaims({
      document,
      profile: structured,
      bank: context.evidenceBank,
    });
    tasks.complete(claimsTask, jobDetail);
    const drafts: CVDocument[] = [validatedDocument];
    const reviewInput = (document: CVDocument) => ({
      document,
      context,
      strategy: parsedStrategy,
      posting,
      profile: structured,
      signal: options.signal,
      trajectory: options.trajectory,
      runId,
      settings: options.settings,
      onUsage: options.onUsage,
      research,
    });
    const auditDocument = async (document: CVDocument, suffix: string) => {
      const auditTask = `generate:${options.jobId}:audit:${suffix}`;
      tasks.start({ taskId: auditTask, label: "Audit factual claims", detail: jobDetail });
      try {
        const audit = await (options.auditor ?? runFactualAuditor)(reviewInput(document));
        tasks.complete(auditTask, jobDetail);
        return audit;
      } catch (error) {
        tasks.fail(auditTask, "Factual audit failed.");
        throw error;
      }
    };
    const auditAfterMutation = async (document: CVDocument, suffix: string) => {
      const audit = await auditDocument(document, suffix);
      failClosedOnCriticalFactualAudit(audit);
      return audit;
    };
    const critiqueDocument = async (document: CVDocument, suffix: string) => {
      const criticTask = `generate:${options.jobId}:critic:${suffix}`;
      tasks.start({ taskId: criticTask, label: "Critique document quality", detail: jobDetail });
      try {
        const critique = await (options.critic ?? runCritic)(reviewInput(document));
        tasks.complete(criticTask, jobDetail);
        return critique;
      } catch (error) {
        tasks.fail(criticTask, "Quality critique failed.");
        throw error;
      }
    };
    const review = async (current: CVDocument, round: number) => {
      const suffix = String(round);
      const [audit, critique] = await Promise.all([auditDocument(current, suffix), critiqueDocument(current, suffix)]);
      return { audit, critique };
    };
    let findings = await review(validatedDocument, 0);
    for (let round = 1; round <= MAX_REVISION_ROUNDS && revisionNeeded(findings.audit, findings.critique); round += 1) {
      const revisionTask = `generate:${options.jobId}:revise:${round}`;
      tasks.start({ taskId: revisionTask, label: `Revise document (round ${round})`, detail: jobDetail });
      validatedDocument = await (options.reviser ?? runReviser)({
        document: validatedDocument,
        context,
        strategy: parsedStrategy,
        posting,
        direction,
        profile: structured,
        audit: findings.audit,
        critique: findings.critique,
        round,
        signal: options.signal,
        trajectory: options.trajectory,
        runId,
        settings: options.settings,
        cvPageEstimate,
        onUsage: options.onUsage,
        research,
      });
      validatedDocument = validateClaims({
        document: validatedDocument,
        profile: structured,
        bank: context.evidenceBank,
      });
      drafts.push(validatedDocument);
      tasks.complete(revisionTask, jobDetail);
      findings = await review(validatedDocument, round);
    }
    const atsEnabled = options.atsEnabled ?? (Boolean(options.atsReviewer) || process.env.ATS_REVIEW_ENABLED === "1");
    if (atsEnabled) {
      const atsTask = `generate:${options.jobId}:ats`;
      tasks.start({ taskId: atsTask, label: "Review ATS coverage", detail: jobDetail });
      let ats: AtsReview;
      try {
        ats = await (options.atsReviewer ?? runAtsReviewer)({
          document: validatedDocument,
          context,
          strategy: parsedStrategy,
          posting,
          profile: structured,
          signal: options.signal,
          trajectory: options.trajectory,
          runId,
          settings: options.settings,
          onUsage: options.onUsage,
        });
        tasks.complete(atsTask, jobDetail);
      } catch (error) {
        tasks.fail(atsTask, "ATS review failed.");
        throw error;
      }
      atsArtifact = ats;
      if (ats.issues.some(issue => issue.kind === "missing_but_supported")) {
        const atsRevisionTask = `generate:${options.jobId}:ats-revise`;
        tasks.start({ taskId: atsRevisionTask, label: "Revise ATS coverage", detail: jobDetail });
        try {
          validatedDocument = await (options.reviser ?? runReviser)({
            document: validatedDocument,
            context,
            strategy: parsedStrategy,
            posting,
            direction,
            profile: structured,
            audit: findings.audit,
            critique: findings.critique,
            ats,
            round: 1,
            research,
            signal: options.signal,
            trajectory: options.trajectory,
            runId,
            settings: options.settings,
            cvPageEstimate,
            onUsage: options.onUsage,
          });
          validatedDocument = validateClaims({ document: validatedDocument, profile: structured, bank: context.evidenceBank });
          drafts.push(validatedDocument);
          findings = { ...findings, audit: await auditAfterMutation(validatedDocument, "ats") };
          tasks.complete(atsRevisionTask, jobDetail);
        } catch (error) {
          tasks.fail(atsRevisionTask, "ATS revision failed.");
          throw error;
        }
      }
    }
    failClosedOnCriticalFactualAudit(findings.audit);
    revisionArtifact = validatedDocument;
    auditArtifact = findings.audit;
    reviewArtifact = findings.critique;
    draftArtifacts = drafts;
    const cvTemplate = selectCvTemplate(metadata, tokenise(`${role} ${posting}`));
    const compactComplete = direction.cvLength === "complete" && cvPageEstimate !== null && cvPages < cvPageEstimate;
    const renderStructuredDocument = (current: CVDocument) => {
      const renderable = compactComplete ? compactCvDocument(current, structured) : current;
      visualDocument = renderable;
      revisionArtifact = renderable;
      output = generationOutputFromDocument(renderable, parsedStrategy, cvTemplate, context.evidenceBank);
      profileReplacements = renderCVDocument(structured, renderable);
      const letter = renderCoverLetter(renderable, role, company);
      paragraphs = letter.paragraphs;
      coverLetterSubject = letter.subject;
      coverLetterBullets = "";
      coverLetterClosingText = letter.closing;
    };
    renderStructuredDocument(validatedDocument);
    if (visualQa) {
      visualRevision = async () => {
        validatedDocument = await (options.reviser ?? runReviser)({
          document: validatedDocument,
          context,
          strategy: parsedStrategy,
          posting,
          direction,
          profile: structured,
          audit: findings.audit,
          critique: findings.critique,
          round: 1,
          research,
          signal: options.signal,
          trajectory: options.trajectory,
          runId,
          settings: options.settings,
          cvPageEstimate,
          onUsage: options.onUsage,
        });
        validatedDocument = validateClaims({ document: validatedDocument, profile: structured, bank: context.evidenceBank });
        drafts.push(validatedDocument);
        findings = { ...findings, audit: await auditAfterMutation(validatedDocument, "visual") };
        auditArtifact = findings.audit;
        renderStructuredDocument(validatedDocument);
      };
    }
  } else {
    tasks.start({ taskId: `generate:${options.jobId}:content`, label: "Generate tailored content", detail: jobDetail });
    const raw = await options.execute({ profile: options.profile, job, rank, templates: metadata, settings: options.settings, cvPageEstimate, signal: options.signal, runId: options.runId, trajectory: options.trajectory, onUsage: options.onUsage, direction });
    output = validateGenerationOutput(raw, options.profile, Object.keys(metadata.cv), Array.isArray(rank.gaps) ? rank.gaps : [], jobContext);
    const documentVerification = await runDocumentVerifier({
      output,
      profile: options.profile,
      jobContext,
      trajectory: options.trajectory,
      runId: options.runId,
    });
    if (documentVerification.needsReview) tasks.complete(`generate:${options.jobId}:content`, `${jobDetail} · needs review`);
    else tasks.complete(`generate:${options.jobId}:content`, jobDetail);
    profileReplacements = renderProfileCompatibility(output, email, phone);
    paragraphs = letterParagraphValues(output, structured, role, company);
    coverLetterSubject = output.coverLetterSubject || `Application for ${role} at ${company}`;
    coverLetterBullets = letterBullets(output, paragraphs, `${role} ${posting}`, output.roleEmphasis, direction.cvLength);
    coverLetterClosingText = coverLetterClosing(paragraphs, role, company);
    revisionArtifact = output;
    draftArtifacts = [output];
  }
  const info = metadata.cv[output.cvTemplate]!;
  tasks.start({ taskId: `generate:${options.jobId}:documents`, label: "Compile and verify documents", detail: jobDetail });
  const currentDir = containedPath(appDir, "current");
  const draftsDir = containedPath(revisionDir, "drafts");
  await mkdir(draftsDir, { recursive: true });
  const writeAndCompile = async () => {
    await writeJson(containedPath(revisionDir, "document.json"), revisionArtifact);
    await writeJson(containedPath(revisionDir, "audit.json"), auditArtifact);
    await writeJson(containedPath(revisionDir, "review.json"), reviewArtifact);
    await writeJson(containedPath(revisionDir, "ats.json"), atsArtifact);
    for (const [index, draft] of draftArtifacts.entries()) await writeJson(containedPath(draftsDir, `${index + 1}.json`), draft);
    const location = structured ? [structured.identity.city, structured.identity.country].filter(value => value.trim()).join(", ") : "";
    const replacements = {
      ...profileReplacements,
      CONTACT: [email, phone, location].filter(Boolean).map(latex).join(" \\textbar{} "),
      ROLE: latex(role),
      COMPANY: latex(company),
      DATE: documentDate(now),
      SUBJECT: latex(coverLetterSubject),
      SALUTATION: `Dear ${latex(company)} hiring team,`,
      PARAGRAPHS: paragraphs.map(latex).join("\\par\n"),
      BULLETS: coverLetterBullets,
      CLOSING: coverLetterClosingText,
    };
    const cv = stripRevisionNoteLeaks(render(await readFile(containedPath(templatesDir, info.file), "utf8"), replacements), direction.revisionNotes, options.profile);
    const letter = stripRevisionNoteLeaks(render(await readFile(containedPath(templatesDir, metadata.coverLetter), "utf8"), replacements), direction.revisionNotes, options.profile);
    await writeFile(containedPath(revisionDir, "cv.tex"), cv, "utf8");
    await writeFile(containedPath(revisionDir, "cover-letter.tex"), letter, "utf8");
    const result = await compileAndVerify({ currentDir: revisionDir, cvPages, coverLetterPages: options.settings.coverLetterPages, email, phone, profile: structured ?? undefined, runner: options.runner, now, signal: options.signal });
    await writeFile(containedPath(revisionDir, "verification.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  };
  let verification = await writeAndCompile();
  if (visualEnabled && structured && visualDocument) {
    const visualTask = `generate:${options.jobId}:visual`;
    tasks.start({ taskId: visualTask, label: "Review rendered pages", detail: jobDetail });
    const raster = await rasterizePdfPages({ currentDir: revisionDir, runner: options.runner, signal: options.signal });
    if (raster.status === "ready" && visualQa) {
      try {
        let review = await visualQa({ pagePaths: raster.pages, document: visualDocument, signal: options.signal, trajectory: options.trajectory, runId, settings: options.settings, onUsage: options.onUsage });
        let pages = raster.pages;
        let revisionApplied = false;
        if (review.status === "needs_review" && review.issues.length && visualRevision) {
          const visualRevisionTask = `generate:${options.jobId}:visual-revise`;
          tasks.start({ taskId: visualRevisionTask, label: "Revise document layout", detail: jobDetail });
          try {
            await visualRevision(review);
            verification = await writeAndCompile();
            const finalRaster = await rasterizePdfPages({ currentDir: revisionDir, runner: options.runner, signal: options.signal });
            if (finalRaster.status !== "ready") throw new Error("Visual review of revised documents is unavailable.");
            review = await visualQa({ pagePaths: finalRaster.pages, document: visualDocument!, signal: options.signal, trajectory: options.trajectory, runId, settings: options.settings, onUsage: options.onUsage });
            pages = finalRaster.pages;
            revisionApplied = true;
            tasks.complete(visualRevisionTask, jobDetail);
          } catch (error) {
            tasks.fail(visualRevisionTask, "Visual revision failed.");
            throw error;
          }
        }
        visualArtifact = { status: review.status, issues: review.issues, summary: review.summary, pages: pages.map(page => `visual/${page.split(/[\\/]/).pop()}`), ...(visualRevision ? { revisionApplied } : {}) };
        tasks.complete(visualTask, jobDetail);
      } catch (error) {
        tasks.fail(visualTask, "Visual review failed.");
        throw error;
      }
    } else {
      visualArtifact = { status: "skipped", pages: [] };
      tasks.complete(visualTask, "Visual review skipped.");
    }
  }
  await writeJson(containedPath(revisionDir, "visual.json"), visualArtifact);
  await promoteRevision(appDir, currentDir, revisionDir, now, runId);
  tasks.complete(`generate:${options.jobId}:documents`, verification.success ? jobDetail : "Document verification needs review.");
  tasks.start({ taskId: `generate:${options.jobId}:finalize`, label: "Finalize job", detail: jobDetail });
  options.db.prepare("UPDATE applications SET cv_template=?,cv_source=?,cv_pdf=?,cover_letter_source=?,cover_letter_pdf=?,verification_json=?,approved_at=NULL,updated_at=? WHERE job_id=?").run(output.cvTemplate, "cv.tex", "cv.pdf", "cover-letter.tex", "cover-letter.pdf", JSON.stringify(verification), now, options.jobId);
  if (options.allowDrafting && verification.success) updateJobDirection(options.db, options.jobId, { revisionCount: direction.revisionCount + 1 }, now);
  tasks.complete(`generate:${options.jobId}:finalize`, jobDetail);
  return { jobId: options.jobId, verification };
  } finally {
    tasks.failActive(options.signal.aborted ? "Run cancelled." : "Task failed.");
  }
}
