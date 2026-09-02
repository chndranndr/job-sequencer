import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createEmptyProfile, defaultGenerationDirection, type ProjectEntry, type SkillEntry } from "../src/shared.js";
import { renderCVDocument } from "../src/server/rendering/cv.js";
import { evidenceRef, type CVDocument } from "../src/server/agents/types.js";
import { buildGenerationPrompt, estimateCvPages, filterComplementaryBullets, letterBullets, renderStructuredProfile, selectExperienceBullets, selectRelevantProjects, selectRelevantSkills, stripRevisionNoteLeaks, validateGenerationOutput } from "../src/server/generation.js";
import { coverLetterClosing } from "../src/server/rendering/cover-letter.js";

const skill = (name: string): SkillEntry => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name });
const project = (name: string, role: string, description: string): ProjectEntry => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, role, description, startMonth: "", startYear: "", endMonth: "", endYear: "", url: "" });

function estimatedProfileFixture() {
  const profile = createEmptyProfile();
  Object.assign(profile.identity, {
    firstName: "Ada",
    lastName: "Lovelace",
    headline: "Backend Engineer",
    email: "ada@example.test",
    phone: "+1 555 0100",
    city: "London",
    country: "United Kingdom",
    summary: "Backend engineer focused on reliable Java platforms. ".repeat(45),
  });
  profile.experience = Array.from({ length: 4 }, (_, index) => ({
    id: `exp-${index}`,
    title: "Backend Engineer",
    company: `Example ${index}`,
    employmentType: "Full-time",
    location: "Remote",
    startMonth: "",
    startYear: "2020",
    endMonth: "",
    endYear: "",
    currentRole: index === 0,
    description: "Built reliable Java services and improved platform delivery. ".repeat(14),
  }));
  profile.skills = Array.from({ length: 18 }, (_, index) => ({ id: `skill-${index}`, name: `Skill ${index}` }));
  profile.projects = Array.from({ length: 3 }, (_, index) => project(`Backend Project ${index}`, "Engineer", "Built platform services and delivery automation. ".repeat(8)));
  profile.education = [{ id: "education", institution: "Canonical University", degree: "Bachelor of Science", fieldOfStudy: "Computer Science", startMonth: "", startYear: "2012", endMonth: "", endYear: "2016", gpa: "" }];
  profile.certifications = [{ id: "certification", name: "AWS Certified", issuer: "Amazon", issueDate: "", expiryDate: "", url: "", description: "" }];
  profile.languages = [{ id: "language", name: "English", proficiency: "Native" }];
  return profile;
}

test("profile CV estimate is deterministic, minimum-one, and monotonic", () => {
  const profile = estimatedProfileFixture();
  assert.equal(estimateCvPages(createEmptyProfile()), 1);
  assert.equal(estimateCvPages(profile), 3);
  const expanded = { ...profile, experience: profile.experience.map((entry, index) => index === 0 ? { ...entry, description: `${entry.description}\n${"Added grounded delivery detail. ".repeat(40)}` } : entry) };
  assert.ok(estimateCvPages(expanded) >= estimateCvPages(profile));
});

test("moderncv template keeps the reference visual contract without reference content", async () => {
  const template = await readFile(join(process.cwd(), "templates/cv/backend_java_spring.tex"), "utf8");
  assert.match(template, /\\documentclass\[10pt,a4paper,sans\]\{moderncv\}/);
  assert.match(template, /\\moderncvstyle\{banking\}/);
  assert.match(template, /\\moderncvcolor\{blue\}/);
  assert.match(template, /\\name\{FIRST_NAME\}\{LAST_NAME\}/);
  assert.match(template, /\\makecvtitle/);
  assert.match(template, /scale=0\.86,top=1\.25cm,bottom=1\.25cm/);
  assert.match(template, /\\setlist\[itemize\].*itemsep=0pt/);
  for (const value of ["Example Candidate", "Example Company", "Previous Example Company", "Candidate University", "candidate@example.test"]) {
    assert.doesNotMatch(template, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
  assert.doesNotMatch(template, /https?:\/\/|@/);
});

test("structured CV rendering emits dynamic moderncv headers and cventry fragments", () => {
  const profile = createEmptyProfile();
  Object.assign(profile.identity, {
    firstName: "Ada",
    lastName: "Lovelace",
    headline: "Backend Engineer",
    email: "ada@example.test",
    phone: "+1 555 0100",
    city: "London",
    country: "United Kingdom",
    website: "https://example.test/ada_profile",
    linkedinUrl: "https://linkedin.com/in/ada",
    githubUrl: "https://github.com/ada",
  });

  profile.experience = [{ id: "role", title: "Backend Engineer", company: "Example", employmentType: "Full-time", location: "Remote", startMonth: "", startYear: "2024", endMonth: "", endYear: "", currentRole: true, description: "Built Java services." }];
  profile.projects = [project("Backend API Platform", "Backend Engineer", "Built Java Spring Boot services.")];
  const rendered = renderStructuredProfile(profile, "backend Java", ["Java"]);
  assert.equal(rendered.FIRST_NAME, "Ada");
  assert.equal(rendered.LAST_NAME, "Lovelace");
  assert.match(rendered.HEADLINE_BLOCK, /\\small\\textbf\{Backend Engineer\}/);
  assert.match(rendered.ADDRESS_COMMAND, /\\address\{London, United Kingdom\}\{\}\{\}/);
  assert.match(rendered.PHONE_COMMAND, /\\phone\[mobile\]\{\+1 555 0100\}/);
  assert.match(rendered.EMAIL_COMMAND, /\\email\{ada@example\.test\}/);
  assert.match(rendered.EXTRAINFO_COMMAND, /\\extrainfo\{.*\\link\[LinkedIn\].*\\link\[GitHub\]/);
  assert.match(rendered.PROJECTS_SECTION, /\\needspace\{8\\baselineskip\}\s*\\section\{Selected Projects\}/);
  assert.match(rendered.PROJECTS_SECTION, /\\cventry\{\}\{Role: Backend Engineer\}\{\\textbf\{Backend API Platform\}\}\{\}\{\}\{%/);
  assert.match(rendered.EXPERIENCE, /\\needspace\{7\\baselineskip\}\s*\\cventry\{2024 - Present\}\{Backend Engineer\}\{Example\}\{Remote\}\{Full-time\}\{%/);
  assert.match(rendered.EXPERIENCE, /\\item Built Java services\./);
  assert.doesNotMatch(rendered.EXPERIENCE, /\\begin\{minipage\}|\\cvsection/);

  profile.identity.website = "";
  profile.identity.linkedinUrl = "";
  profile.identity.githubUrl = "";
  profile.identity.city = "";
  profile.identity.country = "";
  profile.identity.email = "";
  profile.identity.phone = "";
  const withoutOptionalHeader = renderStructuredProfile(profile);
  assert.equal(withoutOptionalHeader.EXTRAINFO_COMMAND, "");
  assert.equal(withoutOptionalHeader.ADDRESS_COMMAND, "");
  assert.equal(withoutOptionalHeader.PHONE_COMMAND, "");
  assert.equal(withoutOptionalHeader.EMAIL_COMMAND, "");
});

test("CVDocument render uses profile company names and education institutions", () => {
  const profile = createEmptyProfile();
  Object.assign(profile.identity, {
    firstName: "Ada",
    lastName: "Lovelace",
    headline: "Backend Engineer",
    email: "ada@example.test",
    phone: "+1 555 0100",
  });
  profile.experience = [{ id: "role", title: "Backend Engineer", company: "Aetherwave Robotics Ltd", employmentType: "Full-time", location: "Remote", startMonth: "", startYear: "2024", endMonth: "", endYear: "", currentRole: true, description: "Built Java services." }];
  profile.education = [{ id: "education", institution: "Canonical University", degree: "Bachelor of Science", fieldOfStudy: "Computer Science", startMonth: "2012-09", startYear: "2012", endMonth: "2016-06", endYear: "2016", gpa: "" }];
  profile.skills = [{ id: "skill-java", name: "Java" }];
  const document: CVDocument = {
    summary: { text: "Java platform engineer.", evidenceRefs: [evidenceRef("identity:summary")] },
    experiences: [{
      experienceId: "role",
      bullets: [{ text: "Shipped Java services for capture workflows.", evidenceRefs: [evidenceRef("experience:role:bullet:0")], transformation: "rewrite" }],
    }],
    skillIds: ["skill-java"],
    projects: [],
    coverLetter: {
      subject: "Backend Engineer",
      paragraphs: [{ text: "I build Java platforms.", evidenceRefs: [evidenceRef("experience:role:bullet:0")] }],
    },
  };
  const rendered = renderCVDocument(profile, document);
  assert.match(rendered.EXPERIENCE, /\\cventry\{2024 - Present\}\{Backend Engineer\}\{Aetherwave Robotics Ltd\}/);
  assert.match(rendered.EDUCATION_SECTION, /Canonical University/);
  assert.match(rendered.SUMMARY_SECTION, /Java platform engineer/);
  assert.doesNotMatch(rendered.SUMMARY_SECTION, /Aetherwave Robotics Ltd/);
  assert.equal("company" in document.experiences[0]!, false);
});

test("Technologies Used renders only for experiences that provide it", () => {
  const profile = createEmptyProfile();
  profile.experience = [
    { id: "role-with-tech", title: "Backend Engineer", company: "Aetherwave", employmentType: "Full-time", location: "Remote", startMonth: "", startYear: "2024", endMonth: "", endYear: "", currentRole: true, description: "Built Java services." },
    { id: "role-without-tech", title: "Software Engineer", company: "Northstar", employmentType: "Full-time", location: "Remote", startMonth: "", startYear: "2022", endMonth: "", endYear: "2023", currentRole: false, description: "Shipped APIs." },
  ];
  const document: CVDocument = {
    summary: { text: "Backend engineer.", evidenceRefs: [] },
    experiences: [
      { experienceId: "role-with-tech", technologiesUsed: [{ name: "Java", evidenceRefs: [evidenceRef("experience:role-with-tech:bullet:0")] }], bullets: [] },
      { experienceId: "role-without-tech", bullets: [] },
    ],
    skillIds: [],
    projects: [],
    coverLetter: { subject: "Backend Engineer", paragraphs: [] },
  };
  const rendered = renderCVDocument(profile, document);
  assert.equal((rendered.EXPERIENCE.match(/Technologies Used:/g) ?? []).length, 1);
  assert.match(rendered.EXPERIENCE, /Technologies Used: Java/);
  assert.match(rendered.EXPERIENCE, /Aetherwave/);
  assert.match(rendered.EXPERIENCE, /Northstar/);
  const withoutTechnologyEntry = rendered.EXPERIENCE.slice(rendered.EXPERIENCE.indexOf("Northstar"));
  assert.doesNotMatch(withoutTechnologyEntry, /Technologies Used:/);
  assert.doesNotMatch(withoutTechnologyEntry, /\n\n/);
});

test("education CV rendering uses month ranges and optional GPA", () => {
  const profile = createEmptyProfile();
  profile.education = [{ id: "education", institution: "Example University", degree: "Bachelor of Science", fieldOfStudy: "Computer Science", startMonth: "2012-09", startYear: "2012", endMonth: "2016-06", endYear: "2016", gpa: "3.8/4.0" }];
  const rendered = renderStructuredProfile(profile).EDUCATION_SECTION;
  assert.match(rendered, /\\cventry\{Sep 2012 - Jun 2016\}\{Bachelor of Science, Computer Science\}\{Example University\}\{\}\{\}\{GPA: 3\.8\/4\.0\}/);
  assert.doesNotMatch(rendered, /description|expectedGraduation/i);

  profile.education[0]!.startMonth = "";
  profile.education[0]!.endMonth = "";
  assert.match(renderStructuredProfile(profile).EDUCATION_SECTION, /\\cventry\{2012 - 2016\}/);
});

test("experience descriptions split safe sentences without losing decimals", () => {
  const profile = createEmptyProfile();
  profile.experience = [{
    id: "role",
    title: "Backend Engineer",
    company: "Example",
    employmentType: "",
    location: "",
    startMonth: "",
    startYear: "",
    endMonth: "",
    endYear: "",
    currentRole: false,
    description: "Improved availability to 99.95% using e.g. Java. Reduced response time for customers.",
  }];
  const rendered = renderStructuredProfile(profile).EXPERIENCE;
  assert.equal((rendered.match(/\\item\b/g) ?? []).length, 2);
  assert.match(rendered, /99\.95\\% using e\.g\. Java\./);

  profile.experience[0]!.description = "Built reliable Java services.";
  const single = renderStructuredProfile(profile).EXPERIENCE;
  assert.equal((single.match(/\\item\b/g) ?? []).length, 1);
});

test("skills are relevance-ranked, profile-bounded, and exclude zero-overlap tools", () => {
  const relevant = [
    "Java", "Spring Boot", "Spring MVC", "REST APIs", "JPA/Hibernate", "Microservices", "Domain-driven design", "Event-driven architecture", "PostgreSQL", "MySQL", "Redis", "Neo4j", "Kafka", "RabbitMQ", "JUnit", "TDD", "Git", "Jenkins", "Docker", "Kubernetes", "OpenShift", "Helm", "Ansible", "AWS EC2", "Datadog", "Grafana",
  ];
  const skills = ["Codex", "Cursor", "Adobe Flash", "GitHub Copilot", ...relevant].map(skill);
  const selected = selectRelevantSkills(skills, "Senior backend platform engineer Java Spring Boot Kubernetes REST APIs", ["Kubernetes"]);
  assert.ok(selected.length >= 14 && selected.length <= 20);
  assert.equal(selected[0]?.name, "Kubernetes");
  assert.ok(selected.every(entry => relevant.includes(entry.name)));
  assert.ok(selected.some(entry => ["Kafka", "RabbitMQ"].includes(entry.name)));
  assert.ok(selected.some(entry => ["PostgreSQL", "Redis"].includes(entry.name)));
  assert.ok(selected.some(entry => ["Jenkins", "Docker", "Helm"].includes(entry.name)));
  assert.ok(selected.some(entry => ["Datadog", "Grafana"].includes(entry.name)));
  assert.ok(selected.some(entry => ["JUnit", "TDD"].includes(entry.name)));
});

test("projects use overlap ranking and retain a safe profile-order fallback", () => {
  const gameProjectName = "Game Rendering Fixture";
  const projects = [
    project(gameProjectName, "Game Programmer", "C++ and OpenGL game development."),
    project("Backend API Platform", "Backend Engineer", "Java Spring Boot REST APIs and PostgreSQL services."),
    project("Cloud Platform", "Platform Engineer", "Kubernetes Docker deployment and observability."),
    project("Event Processing", "Backend Engineer", "Kafka and RabbitMQ event-driven services."),
    project("Data Services", "Backend Engineer", "Redis and MySQL data services."),
  ];
  const selected = selectRelevantProjects(projects, "backend platform Java Spring Boot Kubernetes REST PostgreSQL Kafka", ["Kubernetes"]);
  assert.ok(selected.length <= 4);
  assert.ok(selected.every(entry => entry.name !== gameProjectName));
  assert.equal(selected[0]?.name, "Backend API Platform");

  const fallback = selectRelevantProjects(projects, "astronomy", []);
  assert.deepEqual(fallback.map(entry => entry.name), projects.slice(0, 4).map(entry => entry.name));

  const safeFallback = selectRelevantProjects([projects[0]!], "backend platform", []);
  assert.deepEqual(safeFallback.map(entry => entry.name), [projects[0]!.name]);
});

test("cover-letter closing is omitted when paragraphs already contain the equivalent close", () => {
  const existing = "I would welcome the opportunity to discuss how I could contribute to the platform team.";
  assert.equal(coverLetterClosing([existing], "Backend Engineer", "Example"), "");
  assert.match(coverLetterClosing(["I built reliable backend services."], "Backend Engineer", "Example"), /I would welcome the opportunity/);
});

test("cover-letter bullets omit repeated achievements and disappear when none complement", () => {
  const paragraphs = ["I improved API response time by 50% for 10,000 daily transactions through targeted backend work."];
  const bullets = [
    "Improved API response time by 50% for 10,000 daily transactions.",
    "Built Kafka event-driven processing for resilient workflows.",
  ];
  assert.deepEqual(filterComplementaryBullets(bullets, paragraphs), [bullets[1]]);
  assert.match(letterBullets({ coverLetterBullets: bullets }, paragraphs), /\\item Built Kafka event-driven processing/);
  assert.doesNotMatch(letterBullets({ coverLetterBullets: bullets }, paragraphs), /\\item Improved API response/);
  assert.equal(letterBullets({ coverLetterBullets: [bullets[0]] }, paragraphs), "");
});

test("generation prompt makes cover-letter bullets optional and complementary", () => {
  const prompt = buildGenerationPrompt({ profile: "Java", job: { role: "Backend Engineer" }, rank: { gaps: [] }, templates: { cv: { backend_java_spring: {} } } }, "");
  assert.match(prompt, /optional verified complementary points not already stated in paragraphs/);
  assert.match(prompt, /omit them when no new evidence remains/);
  assert.match(prompt, /never repeat a paragraph's achievement, metric, or claim/);
});

test("generation prompt describes complete-profile overflow with the effective page target", () => {
  const prompt = buildGenerationPrompt({
    profile: "Java backend profile",
    job: { role: "Backend Engineer" },
    rank: { gaps: [] },
    templates: { cv: { backend_java_spring: {} } },
    settings: { cvPages: 2, coverLetterPages: 1 },
    cvPageEstimate: 3,
    direction: { ...defaultGenerationDirection },
  }, "");
  assert.match(prompt, /complete profile is estimated at 3 CV page\(s\) while the target is 2/);
  assert.match(prompt, /shorten wording and remove redundant or lower-priority detail/);
});

test("revision notes instruct the model not to copy invented claims", () => {
  const prompt = buildGenerationPrompt({
    profile: "Java at ExampleCorp",
    job: { role: "Backend Engineer" },
    rank: { gaps: [] },
    templates: { cv: { backend_java_spring: {} } },
    direction: { ...defaultGenerationDirection, revisionNotes: "Mention increasing quarterly ARR by 847% using the QZ-9912 converter." },
  }, "");
  assert.match(prompt, /Revision notes are operator instructions/);
  assert.match(prompt, /Never copy numbers, tokens, or claims from them into the CV or letter unless they already appear in the candidate profile/);
  assert.match(prompt, /Never mention a rejected claim/);
});

test("stripRevisionNoteLeaks drops invented metric lines and keeps a grounded employer", () => {
  const profile = "TypeScript at ExampleCorp";
  const notes = "Exclude the unsupported claim about increasing quarterly ARR by 847% using the QZ-9912 converter. Lead with ExampleCorp.";
  const tex = [
    "I have worked with TypeScript at ExampleCorp.",
    "Exclude the unsupported claim about increasing quarterly ARR by 847\\% using the QZ-9912 converter.",
  ].join("\n");
  const stripped = stripRevisionNoteLeaks(tex, notes, profile);
  assert.match(stripped, /ExampleCorp/);
  assert.doesNotMatch(stripped, /847\\?%/);
  assert.doesNotMatch(stripped, /QZ-9912/);
});

test("short CV keeps finance-overlapping experience bullets and drops ceremony lines", () => {
  const description = [
    "Owned daily stand-ups and sprint retrospectives when required.",
    "Designed gold payment and inventory microservices for 10,000 daily transactions.",
    "Integrated MCP with Copilot Studio for table lineage chat.",
    "Reduced critical payment query time by 30% on the gold ledger.",
    "Reviewed peer code and documentation standards before merge.",
  ].join("\n");
  const job = "Backend engineer fintech payments Java gold ledger transactions";
  const short = selectExperienceBullets(description, job, ["payments"], "short");
  assert.ok(short.some((line) => /gold payment/i.test(line)));
  assert.ok(short.some((line) => /payment query/i.test(line)));
  assert.equal(short.some((line) => /stand-ups/i.test(line)), false);
  assert.equal(short.some((line) => /MCP/i.test(line)), false);
  assert.ok(short.length <= 4);
  assert.equal(selectExperienceBullets(description, job, ["payments"], "complete").length, 5);
});

test("short CV render keeps every employer and only the overlapping bullets", () => {
  const profile = createEmptyProfile();
  profile.experience = [
    {
      id: "alex",
      title: "Full Stack Engineer",
      company: "Alex Solutions",
      employmentType: "",
      location: "",
      startMonth: "2025-08",
      startYear: "2025",
      endMonth: "2026-07",
      endYear: "2026",
      currentRole: false,
      description: "Led daily stand-ups.\nIntegrated MCP with Copilot Studio.",
    },
    {
      id: "infosys",
      title: "Senior Backend Developer",
      company: "PT Infosys Solusi Terpadu",
      employmentType: "",
      location: "",
      startMonth: "2023-07",
      startYear: "2023",
      endMonth: "2025-07",
      endYear: "2025",
      currentRole: false,
      description: "Designed gold payment microservices.\nReduced payment query time by 30%.",
    },
  ];
  const job = "Backend engineer finance payments Java gold transactions";
  const short = renderStructuredProfile(profile, job, ["payments"], [], "short").EXPERIENCE;
  assert.match(short, /Alex Solutions/);
  assert.match(short, /PT Infosys Solusi Terpadu/);
  assert.match(short, /gold payment/);
  assert.doesNotMatch(short, /stand-ups/);
  assert.match(renderStructuredProfile(profile, job, ["payments"], [], "complete").EXPERIENCE, /stand-ups/);
});

test("short cover-letter bullets prefer posting overlap", () => {
  const paragraphs = ["I build Java services."];
  const bullets = [
    "Facilitated sprint retrospectives across product squads.",
    "Cut gold-ledger payment query time by 30% for daily transactions.",
  ];
  const ranked = letterBullets({ coverLetterBullets: bullets }, paragraphs, "Backend fintech payments gold ledger", ["payments"], "short");
  assert.match(ranked, /gold-ledger payment/);
  assert.doesNotMatch(ranked, /sprint retrospectives/);
});

test("generation prompt for short prefers domain-overlapping evidence", () => {
  const prompt = buildGenerationPrompt({
    profile: "Java payments",
    job: { role: "Backend Engineer", company: "Finance Co", posting: "payments ledger" },
    rank: { gaps: [] },
    templates: { cv: { backend_java_spring: {} } },
    direction: { ...defaultGenerationDirection, cvLength: "short" },
  }, "");
  assert.match(prompt, /USER DIRECTION/);
  assert.match(prompt, /overlap the posting/);
});

test("profileFacts match decoded JSON string fields including newlines", () => {
  const profile = JSON.stringify({
    identity: { summary: "Senior engineer.\nBuilt gold payment services." },
    experience: [{ description: "Reduced query time by 30%." }],
  }, null, 2);
  const accepted = validateGenerationOutput({
    cvTemplate: "backend_java_spring",
    profileFacts: ["Senior engineer.\nBuilt gold payment services."],
    gaps: [],
  }, profile, ["backend_java_spring"], []);
  assert.deepEqual(accepted.profileFacts, ["Senior engineer.\nBuilt gold payment services."]);

  assert.throws(() => validateGenerationOutput({
    cvTemplate: "backend_java_spring",
    profileFacts: ["Reduced query time by 30%.", "Invented quarterly ARR 847%"],
    gaps: [],
  }, profile, ["backend_java_spring"], []), /unsupported profile fact/);
});

test("grounded cvEdits land in rendered CV and ungrounded edits do not", () => {
  const profile = createEmptyProfile();
  profile.experience = [{
    id: "role",
    title: "Backend Engineer",
    company: "Example",
    employmentType: "Full-time",
    location: "Remote",
    startMonth: "",
    startYear: "2024",
    endMonth: "",
    endYear: "",
    currentRole: true,
    description: "Built Java services.",
  }];
  profile.awards = [{ id: "award", title: "GroundedAwardTokenXYZ", issuer: "", date: "", description: "" }];
  const rendered = renderStructuredProfile(profile, "backend Java", ["Java"], ["GroundedAwardTokenXYZ", "InventedConversionMetric999"]);
  const text = Object.values(rendered).join("\n");
  assert.match(text, /\\cvitem\{\}\{GroundedAwardTokenXYZ\}/);
  assert.doesNotMatch(text, /\\item GroundedAwardTokenXYZ/);
  assert.doesNotMatch(text, /InventedConversionMetric999/);
});

test("cvEdits never attach another employer's bullets or planning instructions to a role", () => {
  const role = (id: string, company: string, title: string, description: string) => ({
    id,
    title,
    company,
    employmentType: "",
    location: "",
    startMonth: "",
    startYear: "2017",
    endMonth: "",
    endYear: "2018",
    currentRole: false,
    description,
  });
  const profile = createEmptyProfile();
  profile.experience = [
    role("gameloft", "Gameloft", "C++ Programmer", "Shipped Asphalt gameplay systems.\nTuned OpenGL frame time."),
    role("antam", "Antam", "Backend Engineer", "Built gold payment services.\nCut ledger query time."),
  ];
  const rendered = renderStructuredProfile(profile, "C++ game engine", ["C++"], [
    "Built gold payment services at Antam.",
    "Prioritize overlapping industry and stack.",
    "Retain every employer. Drop unrelated bullets.",
    "Order core skills by posting overlap.",
  ]).EXPERIENCE;
  const gameloft = rendered.split("\\cventry").find((block) => /Gameloft/.test(block)) ?? "";
  assert.match(gameloft, /Asphalt/);
  assert.doesNotMatch(gameloft, /Antam|gold payment|Prioritize|Retain every|Order core skills/);
  assert.doesNotMatch(rendered, /Prioritize overlapping|Retain every employer|Order core skills/);
});

test("instruction-shaped cvEdits fail generation validation so Pi can repair", () => {
  const profile = JSON.stringify({ identity: { summary: "Java engineer at Example." } });
  assert.throws(() => validateGenerationOutput({
    cvTemplate: "backend_java_spring",
    profileFacts: ["Java engineer at Example."],
    cvEdits: ["Prioritize overlapping industry and keep every employer."],
    gaps: [],
  }, profile, ["backend_java_spring"], []), /internal or generic phrase/);
});
