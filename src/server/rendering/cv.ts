import type { EducationEntry, ExperienceEntry, ProjectEntry, StructuredProfile } from "../../shared.js";
import { splitDescriptionIntoBullets } from "../agents/evidence.js";
import type { CVDocument } from "../agents/types.js";

function normalizeProse(value: string) {
  return value.replace(/\s*[\u2011\u2013\u2014]\s*/g, ", ").replace(/--+/g, ", ").replace(/[ \t]{2,}/g, " ").trim();
}

const latexEscapes: Record<string, string> = { "\\": "\\textbackslash{}", "#": "\\#", "$": "\\$", "%": "\\%", "&": "\\&", "_": "\\_", "{": "\\{", "}": "\\}", "^": "\\textasciicircum{}", "~": "\\textasciitilde{}" };
function latex(value: string) { return normalizeProse(value).replace(/[\\#$%&_{}^~]/g, character => latexEscapes[character] ?? character); }
function latexUrl(value: string) { return value.trim().replace(/[\\#$%&_{}^~]/g, character => latexEscapes[character] ?? character); }

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

function headerCommands(profile: StructuredProfile) {
  const identity = profile.identity;
  const firstName = identity.firstName.trim();
  const lastName = identity.lastName.trim();
  const headline = identity.headline.trim();
  const location = [identity.city, identity.country].filter(value => value.trim()).join(", ");
  const links = ([
    ["Website", identity.website],
    ["LinkedIn", identity.linkedinUrl],
    ["GitHub", identity.githubUrl],
  ] as const).filter(([, value]) => value.trim()).map(([label, value]) => `\\link[${label}]{${latexUrl(value)}}`);
  const contactValues = [identity.email, identity.phone, location, identity.website, identity.linkedinUrl, identity.githubUrl].filter(value => value.trim());
  return {
    NAME: latex([firstName, lastName].filter(Boolean).join(" ")),
    FIRST_NAME: latex(firstName),
    LAST_NAME: latex(lastName),
    HEADLINE: latex(headline),
    HEADLINE_BLOCK: headline ? ["\\vspace{-19pt}", "\\begin{center}", `\\small\\textbf{${latex(headline)}}`, "\\end{center}", "\\vspace{-8pt}"].join("\n") : "",
    ADDRESS_COMMAND: location ? `\\address{${latex(location)}}{}{}` : "",
    PHONE_COMMAND: identity.phone.trim() ? `\\phone[mobile]{${latex(identity.phone)}}` : "",
    EMAIL_COMMAND: identity.email.trim() ? `\\email{${latex(identity.email)}}` : "",
    EXTRAINFO_COMMAND: links.length ? `\\extrainfo{${links.join(" \\enspace|\\enspace ")}}` : "",
    CONTACT: contactValues.map(latex).join(" \\textbar{} "),
  };
}

function educationEntry(entry: EducationEntry) {
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

function experienceEntry(entry: ExperienceEntry, bullets: string[]) {
  if (!entry.title.trim() && !entry.company.trim() && !bullets.length) return "";
  const title = entry.title.trim() || entry.company.trim();
  const company = entry.company.trim() && entry.title.trim() ? latex(entry.company) : "";
  const date = dateRange(entry);
  return [
    "\\needspace{7\\baselineskip}",
    `\\cventry{${latex(date)}}{${latex(title)}}{${company}}{${latex(entry.location)}}{${latex(entry.employmentType)}}{%`,
    cvBullets(bullets),
    "}",
  ].join("\n");
}

function projectEntry(entry: ProjectEntry, bullets: string[]) {
  if (!entry.name.trim() && !entry.role.trim() && !bullets.length) return "";
  const title = entry.name.trim() || entry.role.trim();
  const role = entry.name.trim() && entry.role.trim() ? `Role: ${latex(entry.role)}` : "";
  const date = dateRange(entry);
  return [
    "\\needspace{4\\baselineskip}",
    `\\cventry{${latex(date)}}{${role}}{\\textbf{${latex(title)}}}{}{}{%`,
    cvBullets(bullets),
    "}",
  ].join("\n");
}

export function renderCVDocument(profile: StructuredProfile, document: CVDocument) {
  const experiences = new Map(profile.experience.map(entry => [entry.id, entry]));
  const skills = new Map(profile.skills.map(entry => [entry.id, entry]));
  const projects = new Map(profile.projects.map(entry => [entry.id, entry]));
  const experienceBody = document.experiences.map(item => {
    const entry = experiences.get(item.experienceId);
    if (!entry) return "";
    return experienceEntry(entry, item.bullets.map(bullet => bullet.text));
  }).filter(Boolean).join("\n");
  const skillNames = document.skillIds.map(id => skills.get(id)?.name.trim() ?? "").filter(Boolean).map(name => latex(name)).join(", ");
  const projectBody = document.projects.map(item => {
    const entry = projects.get(item.projectId);
    if (!entry) return "";
    const bullets = item.bullets ? item.bullets.map(bullet => bullet.text) : splitDescriptionIntoBullets(entry.description);
    return projectEntry(entry, bullets);
  }).filter(Boolean).join("\n");
  return {
    ...headerCommands(profile),
    SUMMARY_SECTION: cvSection("Professional Summary", latex(document.summary.text)),
    SKILLS_SECTION: cvSection("Core Skills", skillNames ? `\\cvitem{}{${skillNames}}` : ""),
    EXPERIENCE: experienceBody,
    EXPERIENCE_SECTION: cvSection("Professional Experience", experienceBody),
    PROJECTS_SECTION: cvSection("Selected Projects", projectBody, 8),
    EDUCATION_SECTION: cvSection("Education", profile.education.map(educationEntry).filter(Boolean).join("\n")),
    CERTIFICATIONS_SECTION: cvSection("Certifications", profile.certifications.map(certificationEntry).filter(Boolean).join("\n")),
    LANGUAGES_SECTION: cvSection("Languages", profile.languages.filter(entry => entry.name.trim()).map(entry => entry.proficiency.trim() ? `\\cvitemwithcomment{}{${latex(entry.name)}}{${latex(entry.proficiency)}}` : `\\cvitem{}{${latex(entry.name)}}`).join("\n")),
  };
}
