import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AtsChecks, StructuredProfile } from "../shared.js";

export type CommandResult = { code:number; stdout:string; stderr:string };
export type CommandRunner = (executable:string,args:string[],timeoutMs?:number,cwd?:string,signal?:AbortSignal)=>Promise<CommandResult>;
export type DocumentVerification = { success:boolean; cvPages:number; coverLetterPages:number; cvTextPresent:boolean; coverLetterTextPresent:boolean; emailPresent:boolean; phonePresent:boolean; checkedAt:string; ats?: AtsChecks };

const legalEntityTerms = new Set(["berhad", "bv", "co", "company", "corp", "corporation", "cv", "gmbh", "inc", "incorporated", "limited", "ltd", "llc", "plc", "private", "pt", "pte", "pvt", "sa", "tbk", "ud"]);
const roleNoiseTerms = new Set(["a", "an", "and", "api", "apis", "architect", "at", "backend", "back", "boot", "by", "can", "co", "consultant", "developer", "development", "engineer", "engineering", "for", "front", "frontend", "from", "in", "into", "is", "java", "junior", "lead", "manager", "microservice", "microservices", "mobile", "of", "on", "or", "platform", "principal", "senior", "software", "spring", "staff", "technology", "technical", "the", "to", "web", "with"]);
const roleFallbackNoiseTerms = new Set(["a", "an", "and", "architect", "at", "by", "consultant", "developer", "development", "engineer", "engineering", "for", "from", "in", "into", "is", "junior", "lead", "manager", "of", "on", "or", "principal", "senior", "staff", "the", "to", "with"]);
const friendlyDocumentParts: Record<string, { prefix: string; extension: string }> = {
  "cv.tex": { prefix: "cv", extension: "tex" },
  "cv.pdf": { prefix: "cv", extension: "pdf" },
  "cover-letter.tex": { prefix: "cover_letter", extension: "tex" },
  "cover-letter.pdf": { prefix: "cover_letter", extension: "pdf" },
};

function filenameTokens(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function shortFilenameToken(value: string, ignored: ReadonlySet<string>, fallbackIgnored: ReadonlySet<string>, fallback: string, useLastToken = false) {
  const tokens = filenameTokens(value);
  const selected = tokens.find(token => token.length > 1 && !ignored.has(token)) ?? tokens.find(token => token.length > 1 && !fallbackIgnored.has(token)) ?? (useLastToken ? [...tokens].reverse().find(token => token.length > 1) : undefined) ?? fallback;
  return selected.slice(0, 24) || fallback;
}

export function friendlyDocumentFilename(name: string, company: string, role: string) {
  if (name === "verification.json") return name;
  const parts = friendlyDocumentParts[name];
  if (!parts) throw new Error("Unsupported document filename.");
  const companyToken = shortFilenameToken(company, legalEntityTerms, legalEntityTerms, "company");
  const roleToken = shortFilenameToken(role, roleNoiseTerms, roleFallbackNoiseTerms, "role", true);
  return `${parts.prefix}_${companyToken}_${roleToken}.${parts.extension}`;
}

export function containedPath(root:string,...parts:string[]):string {
  const base=resolve(root); const target=resolve(base,...parts); const rel=relative(base,target);
  if(rel.startsWith("..")||isAbsolute(rel)) throw new Error("Document path is outside the application directory.");
  return target;
}

export function latexSmokeCommands(texFile: string): Array<[string, string[]]> {
  return [
    ["lualatex", ["-interaction=nonstopmode", texFile]],
    ["xelatex", ["-interaction=nonstopmode", texFile]],
    ["pdfinfo", [texFile.replace(/\.tex$/i, ".pdf")]],
    ["pdftotext", [texFile.replace(/\.tex$/i, ".pdf"), "-"]],
  ];
}

export async function runCommand(executable: string, args: string[], timeoutMs = 10_000, cwd?: string, signal?: AbortSignal): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("Command was cancelled.")); return; }
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, signal });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${executable} timed out`)); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

function pageCount(output:string){ const match=/^Pages:\s*(\d+)\s*$/im.exec(output); if(!match)throw new Error("Could not read PDF page count."); return Number(match[1]); }
function dateVariants(value: string) {
  const variants = [value.trim()];
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value.trim());
  if (match) variants.push(`${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(match[2]) - 1]} ${match[1]}`);
  return variants.filter(Boolean);
}
export function deterministicAtsChecks(input: { cvText: string; coverLetterText: string; profile?: StructuredProfile }): AtsChecks {
  const cv = input.cvText;
  const all = `${cv}\n${input.coverLetterText}`;
  const lower = cv.toLowerCase();
  const email = input.profile?.identity.email.trim() || "";
  const phone = input.profile?.identity.phone.trim() || "";
  const employers = input.profile?.experience.map(entry => entry.company.trim()).filter(Boolean) ?? [];
  const dateSets = input.profile?.experience.map(entry => [entry.startMonth, entry.startYear, entry.endMonth, entry.endYear].filter(Boolean).map(dateVariants)) ?? [];
  const emailPresent = !email || all.includes(email);
  const phoneDigits = phone.replace(/\D/g, "");
  const phonePresent = !phoneDigits || all.replace(/\D/g, "").includes(phoneDigits);
  const employersPresent = employers.every(employer => lower.includes(employer.toLowerCase()));
  const datesPresent = dateSets.every(set => set.every(variants => variants.some(date => cv.includes(date))));
  const glyphError = /\(cid:/i.test(all);
  const replacementCharacter = /\uFFFD/.test(all);
  const bullets = cv.split(/\r?\n/).map(line => line.trim()).filter(line => /^(?:[-*•]|\u2022)\s+/.test(line)).map(line => line.replace(/^(?:[-*•]|\u2022)\s+/, "").trim().toLowerCase());
  const duplicateBullets = bullets.some((bullet, index) => bullets.indexOf(bullet) !== index);
  const issues = [
    ...(!emailPresent ? ["email_missing"] : []),
    ...(!phonePresent ? ["phone_missing"] : []),
    ...(!employersPresent ? ["employer_missing"] : []),
    ...(!datesPresent ? ["date_missing"] : []),
    ...(glyphError ? ["cid_glyph_error"] : []),
    ...(replacementCharacter ? ["replacement_character"] : []),
    ...(duplicateBullets ? ["duplicate_bullet"] : []),
  ];
  return { emailPresent, phonePresent, employersPresent, datesPresent, glyphError, replacementCharacter, duplicateBullets, issues };
}
async function checked(runner:CommandRunner,exe:string,args:string[],cwd:string,signal?:AbortSignal){ const result=await runner(exe,args,30_000,cwd,signal); if(result.code!==0)throw new Error(`${exe} failed.`); return result; }
export async function compileAndVerify(options:{currentDir:string;cvPages:number;coverLetterPages:number;email:string;phone:string;profile?:StructuredProfile;runner?:CommandRunner;now?:string;signal?:AbortSignal}):Promise<DocumentVerification>{
  const runner=options.runner??runCommand; const cvTex=containedPath(options.currentDir,"cv.tex"),letterTex=containedPath(options.currentDir,"cover-letter.tex");
  await checked(runner,"lualatex",["-interaction=nonstopmode","-halt-on-error","cv.tex"],options.currentDir,options.signal);
  await checked(runner,"xelatex",["-interaction=nonstopmode","-halt-on-error","cover-letter.tex"],options.currentDir,options.signal);
  const cvPdf=containedPath(options.currentDir,"cv.pdf"),letterPdf=containedPath(options.currentDir,"cover-letter.pdf");
  await Promise.all([access(cvTex),access(letterTex),access(cvPdf),access(letterPdf)]);
  const cvInfo=await checked(runner,"pdfinfo",["cv.pdf"],options.currentDir,options.signal), letterInfo=await checked(runner,"pdfinfo",["cover-letter.pdf"],options.currentDir,options.signal);
  const cvText=(await checked(runner,"pdftotext",["cv.pdf","-"],options.currentDir,options.signal)).stdout.trim();
  const letterText=(await checked(runner,"pdftotext",["cover-letter.pdf","-"],options.currentDir,options.signal)).stdout.trim();
  const cvCount=pageCount(cvInfo.stdout),letterCount=pageCount(letterInfo.stdout);
  if(cvCount>options.cvPages)throw new Error(`CV must be at most ${options.cvPages} pages.`);
  if(letterCount>options.coverLetterPages)throw new Error(`Cover letter must be at most ${options.coverLetterPages} pages.`);
  if(!cvText||!letterText)throw new Error("Generated PDF text is empty.");
  if(!cvText.includes(options.email)||!cvText.includes(options.phone)||!letterText.includes(options.email)||!letterText.includes(options.phone))throw new Error("Each generated PDF must contain the profile email and phone.");
  return {success:true,cvPages:cvCount,coverLetterPages:letterCount,cvTextPresent:true,coverLetterTextPresent:true,emailPresent:true,phonePresent:true,checkedAt:options.now??new Date().toISOString(),ats:deterministicAtsChecks({ cvText, coverLetterText: letterText, profile: options.profile })};
}
