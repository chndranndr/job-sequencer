import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type {
  CertificationEntry,
  Criteria,
  EducationEntry,
  ExperienceEntry,
  LanguageEntry,
  ProfileEntry,
  ProjectEntry,
  SkillEntry,
  StructuredProfile,
} from "./shared.js";
import "./profile-editor.css";

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const newProfileEntryId = () => globalThis.crypto?.randomUUID?.() ?? `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
export const splitCommaList = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);

type CriteriaListKey = "roles" | "locations" | "keywords" | "excludeKeywords" | "employmentTypes";
export type ProfileFieldBank = "identity" | "links" | "summary" | "prefs";
export type RepeatableSectionId = "experience" | "education" | "skills" | "certifications" | "projects" | "awards" | "languages";
export type ProfileEditorVariant = "desk" | "tracker";

function variantRoot(variant: ProfileEditorVariant) {
  return variant === "tracker" ? "pe-theme-tracker" : "";
}

function rowHex(index: number) {
  return (index & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

function EditorField({ label, hint, error, children, className = "" }: { label: string; hint?: string; error?: string; children: ReactNode; className?: string }) {
  const id = useId().replace(/:/g, "");
  const errorId = `${id}-error`;
  return (
    <label className={`pe-field ${className}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
      {error && <small id={errorId} className="pe-field-error" role="alert">{error}</small>}
    </label>
  );
}

function PeButton({ children, kind = "secondary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "signal" | "secondary" | "ghost" | "danger" }) {
  return <button type="button" className={`pe-btn pe-btn-${kind} ${className}`} {...props}>{children}</button>;
}

function PeDialog({ open, title, children, actions, onClose }: { open: boolean; title: string; children: ReactNode; actions: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className="pe-dialog" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}>
      <div className="pe-dialog-head"><h2>{title}</h2></div>
      <div className="pe-dialog-body">{children}</div>
      <div className="pe-dialog-actions">{actions}</div>
    </dialog>
  );
}

function PeConfirmDialog({ open, title, children, onCancel, onConfirm }: { open: boolean; title: string; children: ReactNode; onCancel: () => void; onConfirm: () => void }) {
  return (
    <PeDialog open={open} title={title} onClose={onCancel} actions={<><PeButton kind="ghost" onClick={onCancel}>Cancel</PeButton><PeButton kind="primary" onClick={onConfirm}>Confirm</PeButton></>}>
      <p>{children}</p>
    </PeDialog>
  );
}

export function ProfileSaveBar({ dirty, label, onSave, onDiscard, variant = "desk" }: { dirty: boolean; label: string; onSave: () => void; onDiscard: () => void; variant?: ProfileEditorVariant }) {
  const tracker = variant === "tracker";
  return (
    <div className={`pe-save-bar ${variantRoot(variant)}`}>
      <strong>{tracker ? `PATCH · ${label.toUpperCase()}` : label} {dirty && <span className="pe-dirty">{tracker ? "DIRTY" : "UNSAVED"}</span>}</strong>
      <div>
        <PeButton kind="ghost" onClick={onDiscard} disabled={!dirty}>{tracker ? "Revert" : "Discard"}</PeButton>
        <PeButton kind={dirty ? "signal" : "secondary"} onClick={onSave} disabled={!dirty}>{dirty ? (tracker ? "Write to disk" : `Save ${label.toLowerCase()}`) : (tracker ? "Synced" : "Saved")}</PeButton>
      </div>
    </div>
  );
}

export function ProfilePreview({ profile, variant = "desk" }: { profile: StructuredProfile; variant?: ProfileEditorVariant }) {
  const name = `${profile.identity.firstName} ${profile.identity.lastName}`.trim() || "Unnamed profile";
  const initials = name.split(/\s+/).map((item) => item[0]).join("").slice(0, 2).toUpperCase();
  if (variant === "tracker") {
    return (
      <section className={`pe-preview pe-preview-tracker ${variantRoot(variant)}`}>
        <div className="disk-icon" aria-hidden="true" />
        <div className="pe-preview-body">
          <span className="pe-preview-tag">MASTER SAMPLE</span>
          <h2>{name}</h2>
          <p>{profile.identity.headline || "Headline not set"}</p>
          <p>{[profile.identity.city, profile.identity.country].filter(Boolean).join(", ") || "Location not set"}{profile.identity.email ? ` · ${profile.identity.email}` : ""}</p>
          <div className="disk-meter" aria-hidden="true"><i /><i /><i /><i /></div>
        </div>
        <div className="disk-stats">
          <span>EXP <b>{profile.experience.length}</b></span>
          <span>EDU <b>{profile.education.length}</b></span>
          <span>SKL <b>{profile.skills.length}</b></span>
          <span>CRT <b>{profile.certifications.length}</b></span>
        </div>
      </section>
    );
  }
  return (
    <section className="pe-preview">
      <div className="pe-avatar">{initials || "—"}</div>
      <div>
        <h2>{name}</h2>
        <p>{profile.identity.headline || "Professional headline not set"}</p>
        <p>{[profile.identity.city, profile.identity.country].filter(Boolean).join(", ") || "Location not set"}{profile.identity.email ? ` · ${profile.identity.email}` : ""}</p>
      </div>
      <span className="pe-preview-tag">PROFILE</span>
    </section>
  );
}

export function ResumeImportPanel({ importing, onFile, variant = "desk" }: { importing: boolean; onFile: (file: File | null) => void; variant?: ProfileEditorVariant }) {
  const tracker = variant === "tracker";
  return (
    <section className={`pe-section pe-import ${variantRoot(variant)}`} aria-busy={importing}>
      <div className="pe-section-head"><h2>{tracker ? "SAMPLE IMPORT" : "Import resume / CV"}</h2><span className="pe-eyebrow">{tracker ? "LOAD WAV · PI PARSE" : "PI-ASSISTED"}</span></div>
      <div className="pe-section-body">
      <p className="pe-muted">{tracker ? "Drop a resume sample. Pi maps fields into the bank. Nothing commits until Write to disk." : "Upload PDF, DOC, or DOCX. Pi maps factual fields into an editable draft. Nothing is saved until you click Save profile."}</p>
      <EditorField label="Resume or CV file" hint="PDF, DOC, or DOCX · maximum 12 MB">
        <input type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={importing} onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ""; onFile(file); }} />
      </EditorField>
      {importing && <div className="pe-muted" role="status">Extracting text and mapping the resume into your profile…</div>}
      </div>
    </section>
  );
}

export function ProfileFields({ profile, setProfile, variant = "desk", banks }: { profile: StructuredProfile; setProfile: (value: StructuredProfile) => void; variant?: ProfileEditorVariant; banks?: ProfileFieldBank[] }) {
  const identity = profile.identity;
  const work = profile.workPreferences;
  const tracker = variant === "tracker";
  const show = (bank: ProfileFieldBank) => !banks || banks.includes(bank);
  const updateIdentity = (key: keyof typeof identity, value: string) => setProfile({ ...profile, identity: { ...identity, [key]: value } });
  const updateWork = (key: keyof typeof work, value: string | string[]) => setProfile({ ...profile, workPreferences: { ...work, [key]: value } });
  return <>
    {show("identity") && <section className={`pe-section pe-bank-identity ${variantRoot(variant)}`}>
      <div className="pe-section-head"><h2>{tracker ? "BANK A · IDENTITY" : "Basic information"}</h2><span className="pe-eyebrow">{tracker ? "CONTACT + ABOUT" : "STRUCTURED"}</span></div>
      <div className="pe-section-body">
      <div className="pe-two">
        <EditorField label="First name"><input value={identity.firstName} onChange={(event) => updateIdentity("firstName", event.target.value)} /></EditorField>
        <EditorField label="Last name"><input value={identity.lastName} onChange={(event) => updateIdentity("lastName", event.target.value)} /></EditorField>
      </div>
      <EditorField label="Professional headline"><input value={identity.headline} onChange={(event) => updateIdentity("headline", event.target.value)} /></EditorField>
      <div className="pe-two">
        <EditorField label="Email address"><input type="email" value={identity.email} onChange={(event) => updateIdentity("email", event.target.value)} /></EditorField>
        <EditorField label="Phone number"><input value={identity.phone} onChange={(event) => updateIdentity("phone", event.target.value)} /></EditorField>
      </div>
      <div className="pe-two">
        <EditorField label="City or region"><input value={identity.city} onChange={(event) => updateIdentity("city", event.target.value)} /></EditorField>
        <EditorField label="Country"><input value={identity.country} onChange={(event) => updateIdentity("country", event.target.value)} /></EditorField>
      </div>
      </div>
    </section>}
    {show("links") && <section className={`pe-section pe-bank-links ${variantRoot(variant)}`}>
      <div className="pe-section-head"><h2>{tracker ? "BANK A · LINKS" : "Links"}</h2></div>
      <div className="pe-section-body">
      <EditorField label="Portfolio or website"><input type="url" value={identity.website} onChange={(event) => updateIdentity("website", event.target.value)} /></EditorField>
      <div className="pe-two">
        <EditorField label="LinkedIn URL"><input type="url" value={identity.linkedinUrl} onChange={(event) => updateIdentity("linkedinUrl", event.target.value)} /></EditorField>
        <EditorField label="GitHub URL"><input type="url" value={identity.githubUrl} onChange={(event) => updateIdentity("githubUrl", event.target.value)} /></EditorField>
      </div>
      </div>
    </section>}
    {show("summary") && <section className={`pe-section pe-bank-summary ${variantRoot(variant)}`}>
      <div className="pe-section-head"><h2>{tracker ? "BANK A · SUMMARY" : "About"}</h2></div>
      <div className="pe-section-body">
      <EditorField label="Professional summary" hint="Factual user wording only. No automatic rewrite.">
        <textarea rows={5} value={identity.summary} onChange={(event) => updateIdentity("summary", event.target.value)} />
      </EditorField>
      </div>
    </section>}
    {show("prefs") && <section className={`pe-section pe-bank-prefs ${variantRoot(variant)}`}>
      <div className="pe-section-head"><h2>{tracker ? "BANK A · PREFS" : "Work preferences"}</h2><span className="pe-eyebrow">{tracker ? "AUTHORIZATION + TARGETS" : undefined}</span></div>
      <div className="pe-section-body">
      <div className="pe-two">
        <EditorField label="Work authorization"><input value={work.authorizationStatus} onChange={(event) => updateWork("authorizationStatus", event.target.value)} /></EditorField>
        <EditorField label="Relocation preference"><input value={work.relocationPreference} onChange={(event) => updateWork("relocationPreference", event.target.value)} /></EditorField>
      </div>
      <div className="pe-two">
        <EditorField label="Remote-work preference"><input value={work.remotePreference} onChange={(event) => updateWork("remotePreference", event.target.value)} /></EditorField>
        <EditorField label="Target roles" hint="Comma-separated structured values"><input value={work.targetRoles.join(", ")} onChange={(event) => updateWork("targetRoles", splitCommaList(event.target.value))} /></EditorField>
      </div>
      <EditorField label="Deal-breakers" hint="Comma-separated constraints"><input value={work.dealBreakers.join(", ")} onChange={(event) => updateWork("dealBreakers", splitCommaList(event.target.value))} /></EditorField>
      </div>
    </section>}
  </>;
}

type EntryEditor<T extends ProfileEntry> = (entry: T, update: (value: Partial<T>) => void) => ReactNode;

export function SkillsChipBank({ skills, setSkills, variant = "desk" }: { skills: SkillEntry[]; setSkills: (value: SkillEntry[]) => void; variant?: ProfileEditorVariant }) {
  const tracker = variant === "tracker";
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<SkillEntry | null>(null);
  const normalizedFilter = filter.trim().toLowerCase();
  const visible = normalizedFilter
    ? skills.filter((skill) => skill.name.toLowerCase().includes(normalizedFilter))
    : skills;

  function addSkill() {
    const name = draft.trim();
    if (!name) return;
    setSkills([...skills, { id: newProfileEntryId(), name }]);
    setDraft("");
  }

  function saveEdit() {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) return;
    setSkills(skills.map((skill) => skill.id === editing.id ? { ...editing, name } : skill));
    setEditing(null);
  }

  return (
    <section className={`pe-repeatable pe-skills-rack ${variantRoot(variant)}`}>
      <div className="pe-section-head">
        <h2>{tracker ? "BANK C · SKILLS" : "Skills"}</h2>
        <span className="pe-eyebrow">{skills.length} loaded</span>
      </div>
      <div className="pe-section-body">
        <div className="skill-rack-toolbar">
          <label className="skill-rack-filter">
            <span>Filter</span>
            <input type="search" value={filter} placeholder="Filter…" onChange={(event) => setFilter(event.target.value)} />
          </label>
          <label className="skill-rack-add">
            <span>New</span>
            <input value={draft} placeholder="Skill name" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addSkill(); } }} />
          </label>
          <PeButton kind="signal" onClick={addSkill}>+ Add</PeButton>
        </div>
        {skills.length === 0 ? <p className="pe-muted">No skills on disk. Type a name and Add.</p> : visible.length === 0 ? (
          <p className="pe-muted" role="status">No skills match &ldquo;{filter.trim()}&rdquo;.</p>
        ) : (
          <div className="skill-chips" role="list">
            {visible.map((skill) => (
              <div className="skill-chip" key={skill.id} role="listitem">
                <button type="button" className="skill-chip__name" onClick={() => setEditing(clone(skill))}>{skill.name || "—"}</button>
                <button type="button" className="skill-chip__cut" aria-label={`Remove ${skill.name}`} onClick={() => setSkills(skills.filter((item) => item.id !== skill.id))}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>
      <PeDialog open={Boolean(editing)} title={tracker ? "PATCH · SKILL" : "Edit skill"} onClose={() => setEditing(null)} actions={<><PeButton kind="ghost" onClick={() => setEditing(null)}>Cancel</PeButton><PeButton kind="signal" onClick={saveEdit}>Commit</PeButton></>}>
        {editing && <EditorField label="Skill"><input autoFocus value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveEdit(); } }} /></EditorField>}
      </PeDialog>
    </section>
  );
}

function Repeatable<T extends ProfileEntry>({ title, bank, entries, setEntries, empty, summary, editor, variant = "desk" }: { title: string; bank?: string; entries: T[]; setEntries: (value: T[]) => void; empty: T; summary: (entry: T) => ReactNode; editor: EntryEditor<T>; variant?: ProfileEditorVariant }) {
  const tracker = variant === "tracker";
  const [editing, setEditing] = useState<T | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [remove, setRemove] = useState<T | null>(null);
  const [filter, setFilter] = useState("");
  const canFilter = title === "Skills";
  const normalizedFilter = filter.trim().toLowerCase();
  const visibleEntries = canFilter && normalizedFilter
    ? entries.filter((entry) => String((entry as ProfileEntry & { name?: string }).name ?? "").toLowerCase().includes(normalizedFilter))
    : entries;

  function open(entry: T, fresh = false) { setEditing(clone(entry)); setIsNew(fresh); }
  function save() {
    if (!editing) return;
    setEntries(isNew ? [...entries, editing] : entries.map((entry) => entry.id === editing.id ? editing : entry));
    setEditing(null);
  }
  function move(index: number, delta: number) {
    const next = [...entries];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setEntries(next);
  }

  const addLabel = title === "Experience" ? "position" : title.toLowerCase().replace(/s$/, "");
  return (
    <section className={`pe-repeatable ${variantRoot(variant)}`}>
      <div className="pe-section-head">
        <h2>{tracker && bank ? `${bank} · ${title.toUpperCase()}` : title}</h2>
        <PeButton onClick={() => open({ ...clone(empty), id: newProfileEntryId() }, true)}>{tracker ? `+ New ${addLabel}` : `+ Add ${addLabel}`}</PeButton>
      </div>
      <div className="pe-section-body">
      {canFilter && <EditorField label="Filter skills" className="pe-repeatable-filter"><input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter skills" /></EditorField>}
      {entries.length === 0 ? <p className="pe-muted">No {title.toLowerCase()} added.</p> : visibleEntries.length === 0 ? <p className="pe-muted" role="status">No {title.toLowerCase()} match &ldquo;{filter.trim()}&rdquo;.</p> : (
        <div className={`pe-entry-list ${tracker ? "pe-entry-list-tracker" : ""}`}>
          {visibleEntries.map((entry) => {
            const index = entries.findIndex((candidate) => candidate.id === entry.id);
            return (
              <article className="pe-entry-row" key={entry.id}>
                {tracker && <span className="pe-entry-hex">{rowHex(index)}</span>}
                <div className="pe-entry-copy">{summary(entry)}</div>
                <div className="pe-entry-actions">
                  <PeButton kind="ghost" onClick={() => move(index, -1)} disabled={index === 0}>{tracker ? "↑" : "Up"}</PeButton>
                  <PeButton kind="ghost" onClick={() => move(index, 1)} disabled={index === entries.length - 1}>{tracker ? "↓" : "Down"}</PeButton>
                  <PeButton kind="ghost" onClick={() => open(entry)}>{tracker ? "Patch" : "Edit"}</PeButton>
                  <PeButton kind="ghost" onClick={() => setRemove(entry)}>{tracker ? "Cut" : "Remove"}</PeButton>
                </div>
              </article>
            );
          })}
        </div>
      )}
      </div>
      <PeDialog open={Boolean(editing)} title={tracker ? `${isNew ? "NEW" : "PATCH"} · ${title.toUpperCase()}` : `${isNew ? "Add" : "Edit"} ${addLabel}`} onClose={() => setEditing(null)} actions={<><PeButton kind="ghost" onClick={() => setEditing(null)}>{tracker ? "Cancel" : "Cancel"}</PeButton><PeButton kind="signal" onClick={save}>{tracker ? "Commit row" : "Save entry"}</PeButton></>}>
        {editing && editor(editing, (value) => setEditing({ ...editing, ...value }))}
      </PeDialog>
      <PeConfirmDialog open={Boolean(remove)} title={`Remove ${addLabel}?`} onCancel={() => setRemove(null)} onConfirm={() => { if (remove) setEntries(entries.filter((entry) => entry.id !== remove.id)); setRemove(null); }}>
        This removes the entry from the next saved profile. You can cancel without changing the draft.
      </PeConfirmDialog>
    </section>
  );
}

export function RepeatableSections({ profile, setProfile, variant = "desk", sections }: { profile: StructuredProfile; setProfile: (value: StructuredProfile) => void; variant?: ProfileEditorVariant; sections?: RepeatableSectionId[] }) {
  const show = (section: RepeatableSectionId) => !sections || sections.includes(section);
  return (
    <div className={`pe-repeatables ${variantRoot(variant)}`}>
      {show("experience") && <Repeatable variant={variant} bank="BANK B" title="Experience" entries={profile.experience} setEntries={(entries) => setProfile({ ...profile, experience: entries })} empty={emptyExperience()} summary={(entry) => <><strong>{entry.title || "Untitled position"} · {entry.company || "Company not set"}</strong><span>{entry.startMonth || entry.startYear || "Start not set"} — {entry.currentRole ? "Present" : entry.endMonth || entry.endYear || "End not set"} · {entry.location || "Location not set"}</span><p>{entry.description || "No factual description yet."}</p></>} editor={(entry, update) => <>
        <div className="pe-two"><EditorField label="Job title"><input value={entry.title} onChange={(event) => update({ title: event.target.value })} /></EditorField><EditorField label="Company"><input value={entry.company} onChange={(event) => update({ company: event.target.value })} /></EditorField></div>
        <div className="pe-two"><EditorField label="Employment type"><input value={entry.employmentType} onChange={(event) => update({ employmentType: event.target.value })} /></EditorField><EditorField label="Location"><input value={entry.location} onChange={(event) => update({ location: event.target.value })} /></EditorField></div>
        <div className="pe-two"><EditorField label="Start month"><input type="month" value={entry.startMonth} onChange={(event) => update({ startMonth: event.target.value })} /></EditorField><EditorField label="End month"><input type="month" value={entry.endMonth} disabled={entry.currentRole} onChange={(event) => update({ endMonth: event.target.value, endYear: event.target.value.slice(0, 4) })} /></EditorField></div>
        <label className="pe-check"><input type="checkbox" checked={entry.currentRole} onChange={(event) => update({ currentRole: event.target.checked, endMonth: event.target.checked ? "" : entry.endMonth, endYear: event.target.checked ? "" : entry.endYear })} /> I currently work here</label>
        <EditorField label="Factual description and achievements"><textarea rows={7} value={entry.description} onChange={(event) => update({ description: event.target.value })} /></EditorField>
      </>} />}
      {show("education") && <Repeatable variant={variant} bank="BANK B" title="Education" entries={profile.education} setEntries={(entries) => setProfile({ ...profile, education: entries })} empty={emptyEducation()} summary={(entry) => <><strong>{entry.degree || "Degree not set"} · {entry.institution || "Institution not set"}</strong><span>{entry.fieldOfStudy || "Field not set"} · {entry.startMonth || entry.startYear || "Start not set"} - {entry.endMonth || entry.endYear || "End not set"}{entry.gpa.trim() ? ` · GPA: ${entry.gpa}` : ""}</span></>} editor={(entry, update) => <>
        <div className="pe-two"><EditorField label="Institution"><input value={entry.institution} onChange={(event) => update({ institution: event.target.value })} /></EditorField><EditorField label="Degree"><input value={entry.degree} onChange={(event) => update({ degree: event.target.value })} /></EditorField></div>
        <div className="pe-two"><EditorField label="Field of study"><input value={entry.fieldOfStudy} onChange={(event) => update({ fieldOfStudy: event.target.value })} /></EditorField><EditorField label="GPA" hint="Optional; e.g. 3.8/4.0 or First Class"><input value={entry.gpa} placeholder="3.8/4.0" onChange={(event) => update({ gpa: event.target.value })} /></EditorField></div>
        <div className="pe-two"><EditorField label="Start month" hint="Month and year"><input type="month" value={entry.startMonth} onChange={(event) => update({ startMonth: event.target.value, startYear: event.target.value.slice(0, 4) })} /></EditorField><EditorField label="End month" hint="Month and year"><input type="month" value={entry.endMonth} onChange={(event) => update({ endMonth: event.target.value, endYear: event.target.value.slice(0, 4) })} /></EditorField></div>
      </>} />}
      {show("skills") && <Repeatable variant={variant} bank="BANK C" title="Skills" entries={profile.skills} setEntries={(entries) => setProfile({ ...profile, skills: entries })} empty={emptySkill()} summary={(entry) => <strong>{entry.name || "Unnamed skill"}</strong>} editor={(entry, update) => <EditorField label="Skill"><input value={entry.name} onChange={(event) => update({ name: event.target.value })} /></EditorField>} />}
      {show("certifications") && <Repeatable variant={variant} bank="BANK C" title="Certifications" entries={profile.certifications} setEntries={(entries) => setProfile({ ...profile, certifications: entries })} empty={emptyCertification()} summary={(entry) => <><strong>{entry.name || "Certification not set"}</strong><span>{entry.issuer || "Issuer not set"} · {entry.issueDate || "Date not set"}</span><p>{entry.description}</p></>} editor={(entry, update) => <>
        <div className="pe-two"><EditorField label="Name"><input value={entry.name} onChange={(event) => update({ name: event.target.value })} /></EditorField><EditorField label="Issuer"><input value={entry.issuer} onChange={(event) => update({ issuer: event.target.value })} /></EditorField></div>
        <div className="pe-two"><EditorField label="Issue date"><input value={entry.issueDate} onChange={(event) => update({ issueDate: event.target.value })} /></EditorField><EditorField label="Expiry date"><input value={entry.expiryDate} onChange={(event) => update({ expiryDate: event.target.value })} /></EditorField></div>
        <EditorField label="URL"><input type="url" value={entry.url} onChange={(event) => update({ url: event.target.value })} /></EditorField>
        <EditorField label="Description"><textarea rows={4} value={entry.description} onChange={(event) => update({ description: event.target.value })} /></EditorField>
      </>} />}
      {show("projects") && <Repeatable variant={variant} bank="BANK C" title="Projects" entries={profile.projects} setEntries={(entries) => setProfile({ ...profile, projects: entries })} empty={emptyProject()} summary={(entry) => <><strong>{entry.name || "Project not set"}</strong><span>{entry.role || "Role not set"} · {entry.url || "No URL"}</span><p>{entry.description}</p></>} editor={(entry, update) => <>
        <div className="pe-two"><EditorField label="Project name"><input value={entry.name} onChange={(event) => update({ name: event.target.value })} /></EditorField><EditorField label="Role"><input value={entry.role} onChange={(event) => update({ role: event.target.value })} /></EditorField></div>
        <div className="pe-two"><EditorField label="Start month"><input type="month" value={entry.startMonth} onChange={(event) => update({ startMonth: event.target.value })} /></EditorField><EditorField label="End month"><input type="month" value={entry.endMonth} onChange={(event) => update({ endMonth: event.target.value })} /></EditorField></div>
        <EditorField label="URL"><input type="url" value={entry.url} onChange={(event) => update({ url: event.target.value })} /></EditorField>
        <EditorField label="Description"><textarea rows={5} value={entry.description} onChange={(event) => update({ description: event.target.value })} /></EditorField>
      </>} />}
      {show("awards") && <Repeatable variant={variant} bank="BANK C" title="Awards" entries={profile.awards} setEntries={(entries) => setProfile({ ...profile, awards: entries })} empty={emptyAward()} summary={(entry) => <><strong>{entry.title || "Award not set"}</strong><span>{entry.issuer || "Issuer not set"} · {entry.date || "Date not set"}</span><p>{entry.description}</p></>} editor={(entry, update) => <>
        <div className="pe-two"><EditorField label="Award title"><input value={entry.title} onChange={(event) => update({ title: event.target.value })} /></EditorField><EditorField label="Issuer"><input value={entry.issuer} onChange={(event) => update({ issuer: event.target.value })} /></EditorField></div>
        <EditorField label="Date"><input value={entry.date} onChange={(event) => update({ date: event.target.value })} /></EditorField>
        <EditorField label="Description"><textarea rows={4} value={entry.description} onChange={(event) => update({ description: event.target.value })} /></EditorField>
      </>} />}
      {show("languages") && <Repeatable variant={variant} bank="BANK C" title="Languages" entries={profile.languages} setEntries={(entries) => setProfile({ ...profile, languages: entries })} empty={emptyLanguage()} summary={(entry) => <><strong>{entry.name || "Language not set"}</strong><span>{entry.proficiency || "Proficiency not set"}</span></>} editor={(entry, update) => <>
        <EditorField label="Language"><input value={entry.name} onChange={(event) => update({ name: event.target.value })} /></EditorField>
        <EditorField label="Proficiency"><input value={entry.proficiency} onChange={(event) => update({ proficiency: event.target.value })} /></EditorField>
      </>} />}
    </div>
  );
}

export function CriteriaFields({ criteria, setCriteria, error, variant = "desk" }: { criteria: Criteria; setCriteria: (value: Criteria) => void; error: string; variant?: ProfileEditorVariant }) {
  const update = <K extends keyof Criteria>(key: K, value: Criteria[K]) => setCriteria({ ...criteria, [key]: value });
  const updateList = (key: CriteriaListKey, value: string) => setCriteria({ ...criteria, [key]: [value] } as Criteria);
  const commitList = (key: CriteriaListKey, value: string) => setCriteria({ ...criteria, [key]: splitCommaList(value) } as Criteria);
  return (
    <div className={`pe-criteria ${variantRoot(variant)}`}>
      <div className="pe-two">
        <EditorField label="Target roles" error={error && !criteria.roles.length ? "Add at least one target role." : undefined}>
          <input value={criteria.roles.join(", ")} onChange={(event) => updateList("roles", event.target.value)} onBlur={(event) => commitList("roles", event.target.value)} placeholder="Backend Engineer, Platform Engineer" />
        </EditorField>
        <EditorField label="Target locations" error={error && !criteria.locations.length ? "Add at least one target location." : undefined}>
          <input value={criteria.locations.join(", ")} onChange={(event) => updateList("locations", event.target.value)} onBlur={(event) => commitList("locations", event.target.value)} placeholder="Remote, Indonesia, APAC" />
        </EditorField>
      </div>
      <div className="pe-two">
        <EditorField label="Required / preferred keywords"><input value={criteria.keywords.join(", ")} onChange={(event) => updateList("keywords", event.target.value)} onBlur={(event) => commitList("keywords", event.target.value)} /></EditorField>
        <EditorField label="Excluded keywords"><input value={criteria.excludeKeywords.join(", ")} onChange={(event) => updateList("excludeKeywords", event.target.value)} onBlur={(event) => commitList("excludeKeywords", event.target.value)} /></EditorField>
      </div>
      <div className="pe-two">
        <EditorField label="Employment types"><input value={criteria.employmentTypes.join(", ")} onChange={(event) => updateList("employmentTypes", event.target.value)} onBlur={(event) => commitList("employmentTypes", event.target.value)} /></EditorField>
        <EditorField label="Maximum jobs per scrape"><input type="number" min="1" max="50" value={criteria.maxJobsPerRun} onChange={(event) => update("maxJobsPerRun", Number(event.target.value))} /></EditorField>
      </div>
      <label className="pe-check"><input type="checkbox" checked={criteria.remoteOnly} onChange={(event) => update("remoteOnly", event.target.checked)} /> Remote-only preference</label>
    </div>
  );
}

function emptyExperience(): ExperienceEntry { return { id: "", title: "", company: "", employmentType: "", location: "", startMonth: "", startYear: "", endMonth: "", endYear: "", currentRole: false, description: "" }; }
function emptyEducation(): EducationEntry { return { id: "", institution: "", degree: "", fieldOfStudy: "", startMonth: "", startYear: "", endMonth: "", endYear: "", gpa: "" }; }
function emptySkill(): SkillEntry { return { id: "", name: "" }; }
function emptyCertification(): CertificationEntry { return { id: "", name: "", issuer: "", issueDate: "", expiryDate: "", url: "", description: "" }; }
function emptyProject(): ProjectEntry { return { id: "", name: "", role: "", description: "", startMonth: "", startYear: "", endMonth: "", endYear: "", url: "" }; }
function emptyAward() { return { id: "", title: "", issuer: "", date: "", description: "" }; }
function emptyLanguage(): LanguageEntry { return { id: "", name: "", proficiency: "" }; }

export { clone as cloneProfile };
