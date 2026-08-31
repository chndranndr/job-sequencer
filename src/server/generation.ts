import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { defaultGenerationDirection, type GenerationDirection, type StructuredProfile, type TrajectoryRecorder } from "../shared.js";
import { ProfileSchema, type Settings } from "./config.js";
import { compileAndVerify, containedPath, type CommandRunner } from "./documents.js";
import { createTaskReporter, getJobDetail, updateJobDirection } from "./db.js";
import { projectPromptContext, trustedSection, untrustedSection } from "./context.js";
import { loadGuidance } from "./guidance.js";
import { createRestrictedGenerationSession, runBoundedPi, type PiRunUsage } from "./pi.js";
import { runStructured } from "./structured.js";
import { loadTemplateMetadata } from "./templates.js";
import { runDocumentVerifier } from "./verifier.js";

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
export type GenerationExecutor = (context: { profile: string; job: Record<string, unknown>; rank: unknown; templates: unknown; guidance?: string; settings: Settings; signal: AbortSignal; runId?: string; trajectory?: TrajectoryRecorder; onUsage?: (usage: PiRunUsage) => void; direction?: GenerationDirection }) => Promise<unknown>;
export const generationRevisionCap = 3;
export const revisionCapError = `Revision cap of ${generationRevisionCap} already reached.`;

function availableCvTemplateIds(templates: unknown) {
  if (!templates || typeof templates !== "object" || Array.isArray(templates) || !("cv" in templates)) return [];
  const cv = templates.cv;
  return cv && typeof cv === "object" && !Array.isArray(cv) ? Object.keys(cv) : [];
}

function knownGenerationGaps(rank: unknown) {
  if (!rank || typeof rank !== "object" || Array.isArray(rank) || !("gaps" in rank) || !Array.isArray(rank.gaps)) return [];
  return rank.gaps.filter((gap): gap is string => typeof gap === "string");
}

function userDirectionText(direction: GenerationDirection) {
  const lines = [
    direction.cvLength === "short"
      ? "CV length is short. Write denser two-page copy. Keep the compiled CV at 2 pages and the cover letter at 1 page."
      : "CV length is complete. Write a full two-page CV. Keep the cover letter at 1 page.",
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

export function buildGenerationPrompt(context: { profile: string; job: Record<string, unknown>; rank: unknown; templates: unknown; direction?: GenerationDirection }, guidance: string, direction = context.direction ?? defaultGenerationDirection) {
  const posting = context.job.posting;
  const jobMetadata = Object.fromEntries(Object.entries(context.job).filter(([key]) => key !== "posting" && key !== "notes" && key !== "application_notes"));
  return [
    trustedSection("INSTRUCTIONS", `Return JSON only matching {"cvTemplate":"","roleEmphasis":["verified facts relevant to the role"],"cvEdits":["specific truthful edits"],"profileFacts":["exact verbatim excerpts from profile"],"coverLetterSubject":"","coverLetterParagraphs":["2-4 substantive truthful paragraphs carrying the main narrative and evidence"],"coverLetterBullets":["optional verified complementary points not already stated in paragraphs"],"gaps":["exact entries from rank.gaps"]}. Allowed local CV template IDs: ${JSON.stringify(availableCvTemplateIds(context.templates))}. Set cvTemplate to exactly one ID from this list, verbatim; do not invent, alias, or map template IDs. Use only supplied facts, job data, and gaps; never invent metrics, employers, technologies, responsibilities, or company claims. Keep bullets optional and complementary: omit them when no new evidence remains, and never repeat a paragraph's achievement, metric, or claim. Do not use em-dashes.`),
    trustedSection("USER DIRECTION", userDirectionText(direction)),
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
    validateBusiness: output => {
      validateGenerationBusiness(
        output,
        context.profile,
        availableCvTemplateIds(context.templates),
        knownGenerationGaps(context.rank),
        `${String(context.job.role)} ${String(context.job.company)} ${String(context.job.posting ?? "")}`,
      );
    },
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

function assertNoDocumentMarkers(values: string[]) {
  const forbidden = /requires human review|selected cv edits|acknowledged gaps|this editable draft|grounding disclaimer|verified profile facts|role emphasis|profile facts|target role|i am passionate about|i believe i would be a great fit|leverage my skills|hit the ground running|drive results|synergies/i;
  if (values.some(value => forbidden.test(value))) throw new Error("Generated document contains an internal or generic phrase.");
}

function validateGenerationBusiness(value: GenerationOutput, profile: string, templateNames: string[], knownGaps: string[], jobContext = ""): GenerationOutput {
  if (!templateNames.includes(value.cvTemplate)) throw new Error("Generated output selected an unknown template.");
  for (const fact of value.profileFacts) if (!profile.includes(fact)) throw new Error("Generated output contains an unsupported profile fact.");
  for (const gap of value.gaps) if (!knownGaps.includes(gap)) throw new Error("Generated output contains an unsupported gap.");
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
  try {
    const parsed = ProfileSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data as StructuredProfile : null;
  } catch {
    return null;
  }
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

const descriptionAbbreviations = new Set(["approx", "co", "corp", "dept", "dr", "e.g", "etc", "fig", "i.e", "inc", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "ltd", "misc", "mr", "mrs", "ms", "no", "nos", "prof", "ref", "rev", "sr", "jr", "st", "vs"]);

function isDescriptionAbbreviation(value: string, index: number) {
  if (value[index] !== ".") return false;
  const match = /(?:^|[\s([{"'])([A-Za-z](?:[A-Za-z.]*)?)\.$/.exec(value.slice(0, index + 1));
  if (!match) return false;
  const token = match[1]!.toLowerCase();
  return token.length === 1 || (token.includes(".") && !token.includes("..")) || descriptionAbbreviations.has(token);
}

function splitDescriptionIntoBullets(value: string) {
  return value.split(/\r\n?|\n/).flatMap(line => {
    const segments: string[] = [];
    let start = 0;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (!character || !".!?".includes(character) || !/^\s+[A-Z0-9]/.test(line.slice(index + 1)) || isDescriptionAbbreviation(line, index)) continue;
      const segment = line.slice(start, index + 1).trim();
      if (!segment) continue;
      segments.push(segment);
      start = index + 1;
    }
    const remainder = line.slice(start).trim();
    if (remainder) segments.push(remainder);
    return segments;
  });
}

function cvBullets(items: string[]) {
  return items.length ? `\\begin{itemize}[leftmargin=*,labelindent=0pt,labelsep=0.4em,itemindent=0pt,itemsep=0pt,topsep=1pt,parsep=0pt,partopsep=0pt]\n${items.map(item => `\\item ${latex(item)}`).join("\n")}\n\\end{itemize}` : "";
}

function experienceEntry(entry: StructuredProfile["experience"][number]) {
  if (!entry.title.trim() && !entry.company.trim() && !entry.description.trim()) return "";
  const title = entry.title.trim() || entry.company.trim();
  const company = entry.company.trim() && entry.title.trim() ? latex(entry.company) : "";
  const date = dateRange(entry);
  return [
    "\\needspace{7\\baselineskip}",
    `\\cventry{${latex(date)}}{${latex(title)}}{${company}}{${latex(entry.location)}}{${latex(entry.employmentType)}}{%`,
    cvBullets(splitDescriptionIntoBullets(entry.description)),
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

export function renderStructuredProfile(profile: StructuredProfile, jobText = "", roleEmphasis: readonly string[] = [], cvEdits: readonly string[] = []) {
  const experiences = profile.experience.filter(entry => entry.title.trim() || entry.company.trim() || entry.description.trim());
  const skills = selectRelevantSkills(profile.skills, jobText, roleEmphasis).map(entry => latex(entry.name.trim())).join(", ");
  const projects = selectRelevantProjects(profile.projects, jobText, roleEmphasis);
  const groundedEdits = keepGrounded(cvEdits, `${JSON.stringify(profile)}\n${jobText}`);
  const experienceBody = [experiences.map(experienceEntry).filter(Boolean).join("\n"), cvBullets(groundedEdits)].filter(Boolean).join("\n");
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

function renderLegacyProfile(output: GenerationOutput, email: string, phone: string) {
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

function hasEquivalentClosing(paragraphs: readonly string[]) {
  return paragraphs.some(paragraph => {
    const text = normalizeProse(paragraph);
    return /\bwelcom\w*\b/i.test(text) && /\b(?:opportunit\w*|contribut\w*)\b/i.test(text);
  });
}

export function coverLetterClosing(paragraphs: readonly string[], role: string, company: string) {
  return hasEquivalentClosing(paragraphs) ? "" : latex(`I would welcome the opportunity to discuss how I can contribute to ${role} at ${company}.`);
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

export function letterBullets(output: Pick<GenerationOutput, "coverLetterBullets">, paragraphs: readonly string[]) {
  // ponytail: cap provider bullets at three to keep the validated letter within one page.
  const bullets = filterComplementaryBullets(output.coverLetterBullets, paragraphs).slice(0, 3);
  return bullets.length ? `\\begin{itemize}[leftmargin=1.15em,itemsep=2pt,topsep=2pt,parsep=0pt,partopsep=0pt]\n${bullets.map(value => `\\item ${latex(value)}`).join("\n")}\n\\end{itemize}` : "";
}

async function archiveCurrent(appDir: string, currentDir: string, stamp: string) {
  try {
    if ((await readdir(currentDir)).length) {
      const history = containedPath(appDir, "history", stamp.replace(/[:.]/g, "-"));
      await mkdir(join(history, ".."), { recursive: true });
      await rename(currentDir, history);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(currentDir, { recursive: true });
}

function render(template: string, replacements: Record<string, string>) {
  const tokens = Object.keys(replacements).sort((left, right) => right.length - left.length);
  if (!tokens.length) return template;
  const pattern = new RegExp(tokens.map(token => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return template.replace(pattern, token => replacements[token] ?? token);
}

export async function generateJob(options: { db: DatabaseSync; dataDir: string; projectRoot?: string; jobId: string; settings: Settings; profile: string; execute: GenerationExecutor; signal: AbortSignal; runner?: CommandRunner; allowDrafting?: boolean; now?: string; runId?: string; trajectory?: TrajectoryRecorder; onUsage?: (usage: PiRunUsage) => void }) {
  const job = options.db.prepare("SELECT * FROM jobs WHERE id=?").get(options.jobId) as Record<string, unknown> | undefined;
  if (!job) throw new Error("Job not found.");
  const direction = getJobDetail(options.db, options.jobId)?.generation_direction ?? { ...defaultGenerationDirection };
  const allowed = options.allowDrafting ? ["Drafting", "Ready"] : ["Selected"];
  if (!allowed.includes(String(job.stage))) throw new Error(options.allowDrafting ? "Only Drafting or Ready jobs may regenerate." : "Only Selected jobs may generate.");
  if (options.allowDrafting && direction.revisionCount >= generationRevisionCap) throw Object.assign(new Error(revisionCapError), { statusCode: 409 });
  const tasks = createTaskReporter(options.trajectory, options.runId);
  const jobDetail = `${String(job.role)} · ${String(job.company)}`;
  tasks.start({ taskId: `generate:${options.jobId}:prepare`, label: "Prepare job", detail: jobDetail });
  try {
  const now = options.now ?? new Date().toISOString();
  options.db.exec("BEGIN IMMEDIATE");
  try {
    options.db.prepare("UPDATE jobs SET stage='Drafting',updated_at=? WHERE id=?").run(now, options.jobId);
    options.db.prepare("INSERT OR IGNORE INTO applications(job_id,updated_at) VALUES(?,?)").run(options.jobId, now);
    options.db.prepare("UPDATE applications SET verification_json=NULL,approved_at=NULL,updated_at=? WHERE job_id=?").run(now, options.jobId);
    options.db.exec("COMMIT");
  } catch (error) {
    options.db.exec("ROLLBACK");
    throw error;
  }
  const { templatesDir, metadata } = await loadTemplateMetadata(options.projectRoot);
  tasks.complete(`generate:${options.jobId}:prepare`, jobDetail);
  const rank = JSON.parse(String(job.rank_json));
  tasks.start({ taskId: `generate:${options.jobId}:content`, label: "Generate tailored content", detail: jobDetail });
  const raw = await options.execute({ profile: options.profile, job, rank, templates: metadata, settings: options.settings, signal: options.signal, runId: options.runId, trajectory: options.trajectory, onUsage: options.onUsage, direction });
  const output = validateGenerationOutput(raw, options.profile, Object.keys(metadata.cv), Array.isArray(rank.gaps) ? rank.gaps : [], `${String(job.role)} ${String(job.company)} ${String(job.posting)}`);
  const documentVerification = await runDocumentVerifier({
    output,
    profile: options.profile,
    jobContext: `${String(job.role)} ${String(job.company)} ${String(job.posting)}`,
    trajectory: options.trajectory,
    runId: options.runId,
  });
  if (documentVerification.needsReview) tasks.complete(`generate:${options.jobId}:content`, `${jobDetail} · needs review`);
  else tasks.complete(`generate:${options.jobId}:content`, jobDetail);
  const info = metadata.cv[output.cvTemplate]!;
  tasks.start({ taskId: `generate:${options.jobId}:documents`, label: "Compile and verify documents", detail: jobDetail });
  const appDir = containedPath(options.dataDir, "applications", options.jobId);
  const currentDir = containedPath(appDir, "current");
  await mkdir(appDir, { recursive: true });
  await archiveCurrent(appDir, currentDir, now);
  const structured = parseStructuredProfile(options.profile);
  const { email, phone } = contact(options.profile, structured);
  const role = String(job.role);
  const company = String(job.company);
  const paragraphs = letterParagraphValues(output, structured, role, company);
  const profileReplacements = structured ? renderStructuredProfile(structured, `${role} ${String(job.posting)}`, output.roleEmphasis, output.cvEdits) : renderLegacyProfile(output, email, phone);
  const location = structured ? [structured.identity.city, structured.identity.country].filter(value => value.trim()).join(", ") : "";
  const replacements = {
    ...profileReplacements,
    CONTACT: [email, phone, location].filter(Boolean).map(latex).join(" \\textbar{} "),
    ROLE: latex(role),
    COMPANY: latex(company),
    DATE: documentDate(now),
    SUBJECT: latex(output.coverLetterSubject || `Application for ${role} at ${company}`),
    SALUTATION: `Dear ${latex(company)} hiring team,`,
    PARAGRAPHS: paragraphs.map(latex).join("\\par\n"),
    BULLETS: letterBullets(output, paragraphs),
    CLOSING: coverLetterClosing(paragraphs, role, company),
  };
  const cv = stripRevisionNoteLeaks(render(await readFile(containedPath(templatesDir, info.file), "utf8"), replacements), direction.revisionNotes, options.profile);
  const letter = stripRevisionNoteLeaks(render(await readFile(containedPath(templatesDir, metadata.coverLetter), "utf8"), replacements), direction.revisionNotes, options.profile);
  await writeFile(containedPath(currentDir, "cv.tex"), cv, "utf8");
  await writeFile(containedPath(currentDir, "cover-letter.tex"), letter, "utf8");
  const verification = await compileAndVerify({ currentDir, cvPages: options.settings.cvPages, coverLetterPages: options.settings.coverLetterPages, email, phone, runner: options.runner, now });
  await writeFile(containedPath(currentDir, "verification.json"), `${JSON.stringify(verification, null, 2)}\n`, "utf8");
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
