import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { Criteria, CustomJobSource, Settings, StructuredProfile } from "../shared.js";
import { defaultSourceMaxAgeDays, jobSourceKeys, jobSourceLabel } from "../shared.js";
import {
  CriteriaFields,
  ProfileFields,
  ProfileSaveBar,
  RepeatableSections,
  ResumeImportPanel,
  SkillsChipBank,
  cloneProfile,
  type RepeatableSectionId,
} from "../profile-editor.js";
import { api, getAvailableModels, getCriteria, getProfile, getSettings, importProfile, type PiModelOption } from "../api.js";
import { isNarrowLayout, NARROW_LAYOUT_MQ } from "./narrow.js";
import {
  CustomSourceEditor,
  blankCustomSource,
  cloneSettings,
  enabledSources,
  hasValidProviderModel,
  removeCustomSourceSettings,
  settingsAreDirty,
  sourceMaxAge,
  toggleEnabledSource,
  upsertCustomSource,
  useUnsavedNavigationGuard,
} from "../settings-editor.js";

type DocumentStatus = {
  tools: Record<string, { available: boolean }>;
  templates: {
    cv: { available: boolean; names: string[] };
    coverLetter: { available: boolean };
  };
};
const variant = "tracker" as const;

const DISK_BANKS = [
  { id: "a", label: "A·ID", hint: "identity bank" },
  { id: "b", label: "B·WORK", hint: "experience + education" },
  { id: "c", label: "C·EXTRA", hint: "skills + more" },
  { id: "d", label: "D·CRIT", hint: "search criteria" },
] as const;

type DiskBankId = (typeof DISK_BANKS)[number]["id"];

const MIN_TUNE_WIDTH = 260;
const MAX_TUNE_WIDTH = 420;
const COLLAPSED_TUNE_WIDTH = 48;

function clampTuneWidth(value: number) {
  return Math.max(MIN_TUNE_WIDTH, Math.min(MAX_TUNE_WIDTH, value));
}

const EXTRA_BANKS: { id: RepeatableSectionId; label: string }[] = [
  { id: "skills", label: "SKL" },
  { id: "certifications", label: "CRT" },
  { id: "projects", label: "PRJ" },
  { id: "awards", label: "AWD" },
  { id: "languages", label: "LNG" },
];

function DiskMasterStrip({ profile, profileDirty, criteriaDirty }: { profile: StructuredProfile; profileDirty: boolean; criteriaDirty: boolean }) {
  const name = `${profile.identity.firstName} ${profile.identity.lastName}`.trim() || "Unnamed sample";
  return (
    <div className="disk-master">
      <div className="disk-icon disk-icon--sm" aria-hidden="true" />
      <div className="disk-master__copy">
        <strong>{name}</strong>
        <span>{profile.identity.headline || "Headline not set"} · {profile.identity.email || "no email"}</span>
      </div>
      <div className="disk-stats disk-stats--inline">
        <span>EXP <b>{profile.experience.length}</b></span>
        <span>EDU <b>{profile.education.length}</b></span>
        <span>SKL <b>{profile.skills.length}</b></span>
      </div>
      {(profileDirty || criteriaDirty) && <span className="disk-dirty">{profileDirty && criteriaDirty ? "DIRTY" : profileDirty ? "PROFILE" : "CRIT"}</span>}
    </div>
  );
}

function DiskLegacyPanel({ available, open, content, error, onOpen, onImport, onClose }: { available: boolean; open: boolean; content: string | null; error: string; onOpen: () => void; onImport: () => void; onClose: () => void }) {
  if (!available && !open) return null;
  return <section className="pe-section pe-theme-tracker disk-review-card">
    <div className="pe-section-head"><h2>LEGACY PROFILE BACKUP</h2><span className="pe-eyebrow">REVIEW ONLY</span></div>
    <div className="pe-section-body">
      <p className="pe-muted">The original profile.md stays unchanged. Load it, review it, then explicitly place its text into the editable summary.</p>
      {!open ? <button type="button" className="disk-action" onClick={onOpen}>Review legacy backup</button> : <>
        {error && <p className="disk-settings-error" role="alert">{error}</p>}
        {content !== null && <pre className="disk-readonly-text">{content}</pre>}
        <div className="sel-actions">
          <button type="button" className="disk-action ghost" onClick={onClose}>Close</button>
          {content !== null && <button type="button" className="disk-action" onClick={onImport}>Place in summary</button>}
        </div>
      </>}
    </div>
  </section>;
}

function DiskProviderPreview({ value, error, onLoad }: { value: string; error: string; onLoad: () => void }) {
  return <section className="pe-section pe-theme-tracker disk-review-card">
    <div className="pe-section-head"><h2>PROVIDER CONTEXT</h2><span className="pe-eyebrow">READ ONLY</span></div>
    <div className="pe-section-body">
      <p className="pe-muted">Preview the deterministic profile context used by provider workflows. This does not write the profile.</p>
      <button type="button" className="disk-action ghost" onClick={onLoad}>Load provider preview</button>
      {error && <p className="disk-settings-error" role="alert">{error}</p>}
      {value && <pre className="disk-readonly-text">{value}</pre>}
    </div>
  </section>;
}

export function DiskView({ toast, onSettings }: { toast: (message: string) => void; onSettings: (settings: Settings) => void }) {
  const [bank, setBank] = useState<DiskBankId>("a");
  const [extra, setExtra] = useState<RepeatableSectionId>("skills");
  const [profile, setProfile] = useState<StructuredProfile | null>(null);
  const [savedProfile, setSavedProfile] = useState<StructuredProfile | null>(null);
  const [criteria, setCriteria] = useState<Criteria | null>(null);
  const [savedCriteria, setSavedCriteria] = useState<Criteria | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [savedSettings, setSavedSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<DocumentStatus | null>(null);
  const [models, setModels] = useState<PiModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [criteriaError, setCriteriaError] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [legacyAvailable, setLegacyAvailable] = useState(false);
  const [legacy, setLegacy] = useState<string | null>(null);
  const [legacyError, setLegacyError] = useState("");
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [providerPreview, setProviderPreview] = useState("");
  const [providerPreviewError, setProviderPreviewError] = useState("");
  const [customDraft, setCustomDraft] = useState<CustomJobSource | null>(null);
  const [editingCustomKey, setEditingCustomKey] = useState<string | null>(null);
  const [customError, setCustomError] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [tuneWidth, setTuneWidth] = useState(280);
  const [tuneCollapsed, setTuneCollapsed] = useState(isNarrowLayout);
  const [resizingTune, setResizingTune] = useState(false);
  const tuneResizeStart = useRef<{ clientX: number; width: number } | null>(null);
  useEffect(() => {
    const media = window.matchMedia(NARROW_LAYOUT_MQ);
    const collapseWhenNarrow = () => { if (media.matches) setTuneCollapsed(true); };
    collapseWhenNarrow();
    media.addEventListener("change", collapseWhenNarrow);
    return () => media.removeEventListener("change", collapseWhenNarrow);
  }, []);

  useEffect(() => {
    void Promise.all([getProfile(), getCriteria(), getSettings(), api<DocumentStatus>("/api/document-status")])
      .then(([profileResult, nextCriteria, nextSettings, documentStatus]) => {
        setProfile(profileResult.profile);
        setSavedProfile(cloneProfile(profileResult.profile));
        setLegacyAvailable(profileResult.legacyImportAvailable);
        setCriteria(nextCriteria);
        setSavedCriteria(cloneProfile(nextCriteria));
        setSettings(nextSettings);
        setSavedSettings(cloneSettings(nextSettings));
        setStatus(documentStatus);
        setError("");
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "DISK could not load."));
  }, []);

  const provider = settings?.provider ?? "";
  useEffect(() => {
    let cancelled = false;
    if (!provider) {
      setModels([]);
      setModelsError("");
      setModelsLoading(false);
      return () => { cancelled = true; };
    }
    setModelsLoading(true);
    setModelsError("");
    setModels([]);
    void getAvailableModels(provider).then((result) => {
      if (!cancelled) setModels(result.models);
    }).catch((caught) => {
      if (!cancelled) {
        setModels([]);
        setModelsError(caught instanceof Error ? caught.message : "Could not load authenticated models.");
      }
    }).finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [provider]);

  const profileDirty = Boolean(profile && savedProfile && JSON.stringify(profile) !== JSON.stringify(savedProfile));
  const criteriaDirty = Boolean(criteria && savedCriteria && JSON.stringify(criteria) !== JSON.stringify(savedCriteria));
  const settingsDirty = settingsAreDirty(settings, savedSettings);
  const modelValid = Boolean(settings && hasValidProviderModel(settings, models));
  const enabled = settings ? enabledSources(settings) : [];
  useUnsavedNavigationGuard(settingsDirty);

  useEffect(() => {
    if (!resizingTune) return;
    const onMove = (event: globalThis.PointerEvent) => {
      const start = tuneResizeStart.current;
      if (!start) return;
      setTuneWidth(clampTuneWidth(start.width + start.clientX - event.clientX));
      setTuneCollapsed(false);
    };
    const stop = () => {
      tuneResizeStart.current = null;
      setResizingTune(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [resizingTune]);

  function beginTuneResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    tuneResizeStart.current = { clientX: event.clientX, width: tuneCollapsed ? COLLAPSED_TUNE_WIDTH : tuneWidth };
    setResizingTune(true);
  }

  function resizeTuneWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 40 : 16;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = tuneWidth + step;
    if (event.key === "ArrowRight") next = tuneWidth - step;
    if (event.key === "Home") next = MIN_TUNE_WIDTH;
    if (event.key === "End") next = MAX_TUNE_WIDTH;
    if (next === null) return;
    event.preventDefault();
    setTuneWidth(clampTuneWidth(next));
    setTuneCollapsed(false);
  }

  async function saveProfile() {
    if (!profile) return;
    try {
      const result = await api<{ profile: StructuredProfile }>("/api/profile", { method: "PUT", body: JSON.stringify({ profile }) });
      setProfile(result.profile);
      setSavedProfile(cloneProfile(result.profile));
      toast("Profile written to disk.");
    } catch (caught) { toast(caught instanceof Error ? caught.message : "Profile was not saved."); }
  }

  async function saveCriteria() {
    if (!criteria) return;
    setCriteriaError("");
    try {
      const result = await api<Criteria>("/api/criteria", { method: "PUT", body: JSON.stringify(criteria) });
      setCriteria(result);
      setSavedCriteria(cloneProfile(result));
      toast("Criteria written to disk.");
    } catch (caught) { setCriteriaError(caught instanceof Error ? caught.message : "Criteria were not saved."); }
  }

  async function saveSettings() {
    if (!settings) return;
    if (!modelValid) {
      setSettingsError(modelsLoading ? "Wait for authenticated models to load." : modelsError || "Select an authenticated model for the selected provider before writing settings.");
      return;
    }
    setSettingsError("");
    try {
      const value = await api<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
      setSettings(value);
      setSavedSettings(cloneSettings(value));
      onSettings(value);
      toast("Settings saved.");
    } catch (caught) { toast(caught instanceof Error ? caught.message : "Settings were not saved."); }
  }

  function revertSettings() {
    if (!savedSettings) return;
    setSettings(cloneSettings(savedSettings));
    setSettingsError("");
    setCustomDraft(null);
    setEditingCustomKey(null);
    setCustomError("");
  }

  async function showLegacy() {
    setLegacyOpen(true);
    if (legacy !== null || legacyError) return;
    try {
      setLegacy((await api<{ content: string }>("/api/profile/legacy")).content);
    } catch (caught) {
      setLegacyError(caught instanceof Error ? caught.message : "No legacy backup is available.");
    }
  }

  function importLegacy() {
    if (legacy === null || !profile) return;
    const next = cloneProfile(profile);
    next.identity.summary = legacy;
    setProfile(next);
    setLegacyOpen(false);
    toast("Legacy text placed in the editable summary. Review, then write the profile bank.");
  }

  async function showProviderPreview() {
    setProviderPreviewError("");
    try {
      setProviderPreview((await api<{ text: string }>("/api/profile/export?purpose=preview")).text);
    } catch (caught) {
      setProviderPreviewError(caught instanceof Error ? caught.message : "Provider preview is not available.");
    }
  }

  function setEnabledSource(source: string, nextEnabled: boolean) {
    if (!settings) return;
    const result = toggleEnabledSource(settings, source, nextEnabled);
    if (!result.value) {
      toast(result.error);
      return;
    }
    setSettings(result.value);
    setSettingsError("");
  }

  function setSourceMaxAge(source: (typeof jobSourceKeys)[number], value: number) {
    if (!settings) return;
    setSettings({ ...settings, sourceMaxAgeDays: { ...defaultSourceMaxAgeDays, ...(settings.sourceMaxAgeDays ?? {}), [source]: value } });
  }

  function startCustomSource() {
    setEditingCustomKey(null);
    setCustomDraft(blankCustomSource());
    setCustomError("");
  }

  function editCustomSource(source: CustomJobSource) {
    setEditingCustomKey(source.key);
    setCustomDraft(JSON.parse(JSON.stringify(source)) as CustomJobSource);
    setCustomError("");
  }

  function saveCustomSource() {
    if (!settings || !customDraft) return;
    const result = upsertCustomSource(settings, customDraft, editingCustomKey);
    if (!result.value) {
      setCustomError(result.error);
      return;
    }
    setSettings(result.value);
    setEditingCustomKey(customDraft.key.trim());
    setCustomDraft(null);
    setCustomError("");
  }

  function removeCustomSource(key: string) {
    if (!settings || !window.confirm("Remove this custom source? Saved jobs from it will remain.")) return;
    setSettings(removeCustomSourceSettings(settings, key));
    if (editingCustomKey === key) {
      setEditingCustomKey(null);
      setCustomDraft(null);
    }
  }

  async function parseResume(file: File | null) {
    if (!file) return;
    setImporting(true);
    try {
      const result = await importProfile(file);
      setProfile(result.profile);
      setBank("a");
      toast(`${result.source.fileName} loaded. Patch fields, then write to disk.`);
    } catch (caught) { toast(caught instanceof Error ? caught.message : "Resume/CV could not be parsed."); }
    finally { setImporting(false); }
  }

  if (error || !profile || !criteria || !settings) return <section className="panel" style={{ gridColumn: "1 / -1" }}><p className="empty">{error || "Loading DISK…"}</p></section>;

  return <>
    <section className="panel disk-main">
      <div className="panel-h">DISK · SAMPLE BANK <span>one bank at a time · patch then write</span></div>
      <DiskMasterStrip profile={profile} profileDirty={profileDirty} criteriaDirty={criteriaDirty} />
      <nav className="disk-banks" aria-label="Profile banks">
        {DISK_BANKS.map((item) => <button
          type="button"
          key={item.id}
          className={bank === item.id ? "on" : ""}
          title={item.hint}
          aria-current={bank === item.id ? "page" : undefined}
          onClick={() => setBank(item.id)}
        >{item.label}</button>)}
      </nav>
      <div className={`disk-bank-pane pe-disk pe-theme-tracker disk-bank-pane--${bank}`}>
        {bank === "a" && <>
          <ProfileSaveBar dirty={profileDirty} label="Profile bank" onSave={() => void saveProfile()} onDiscard={() => savedProfile && setProfile(cloneProfile(savedProfile))} variant={variant} />
          <ResumeImportPanel importing={importing} onFile={(file) => void parseResume(file)} variant={variant} />
          <ProfileFields profile={profile} setProfile={setProfile} variant={variant} />
          <div className="disk-review-stack">
            <DiskLegacyPanel available={legacyAvailable} open={legacyOpen} content={legacy} error={legacyError} onOpen={() => void showLegacy()} onImport={importLegacy} onClose={() => setLegacyOpen(false)} />
            <DiskProviderPreview value={providerPreview} error={providerPreviewError} onLoad={() => void showProviderPreview()} />
          </div>
        </>}
        {bank === "b" && <>
          <ProfileSaveBar dirty={profileDirty} label="Profile bank" onSave={() => void saveProfile()} onDiscard={() => savedProfile && setProfile(cloneProfile(savedProfile))} variant={variant} />
          <RepeatableSections profile={profile} setProfile={setProfile} variant={variant} sections={["experience", "education"]} />
        </>}
        {bank === "c" && <>
          <nav className="disk-extra-banks" aria-label="Extra banks">
            {EXTRA_BANKS.map((item) => <button
              type="button"
              key={item.id}
              className={extra === item.id ? "on" : ""}
              onClick={() => setExtra(item.id)}
            >{item.label}</button>)}
          </nav>
          <ProfileSaveBar dirty={profileDirty} label="Profile bank" onSave={() => void saveProfile()} onDiscard={() => savedProfile && setProfile(cloneProfile(savedProfile))} variant={variant} />
          {extra === "skills" ? (
            <SkillsChipBank skills={profile.skills} setSkills={(skills) => setProfile({ ...profile, skills })} variant={variant} />
          ) : (
            <RepeatableSections profile={profile} setProfile={setProfile} variant={variant} sections={[extra]} />
          )}
        </>}
        {bank === "d" && <>
          <ProfileSaveBar dirty={criteriaDirty} label="Criteria" onSave={() => void saveCriteria()} onDiscard={() => { if (savedCriteria) setCriteria(cloneProfile(savedCriteria)); setCriteriaError(""); }} variant={variant} />
          <section className="pe-section pe-theme-tracker">
            <div className="pe-section-head"><h2>BANK D · SEARCH CRIT</h2><span className="pe-eyebrow">SCRAPE TARGETS</span></div>
            <div className="pe-section-body">
              <CriteriaFields criteria={criteria} setCriteria={setCriteria} error={criteriaError} variant={variant} />
            </div>
          </section>
        </>}
      </div>
    </section>
    <aside className={`panel disk-tune-panel ${tuneCollapsed ? "is-collapsed" : ""} ${resizingTune ? "is-resizing" : ""}`} style={{ width: tuneCollapsed ? COLLAPSED_TUNE_WIDTH : tuneWidth }} aria-label="DISK fine-tune sidebar">
      <div
        className="disk-tune-panel__resize"
        role="separator"
        tabIndex={0}
        aria-label="Resize fine-tune sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_TUNE_WIDTH}
        aria-valuemax={MAX_TUNE_WIDTH}
        aria-valuenow={tuneWidth}
        aria-valuetext={tuneCollapsed ? "Collapsed" : `${tuneWidth} pixels`}
        onPointerDown={beginTuneResize}
        onKeyDown={resizeTuneWithKeyboard}
      />
      <div className="panel-h disk-tune-panel__head">
        <span className="disk-tune-panel__title">FINE-TUNE <span>{settingsDirty ? "settings dirty" : "settings synced"}</span></span>
        <button type="button" className="disk-tune-panel__toggle" aria-controls="disk-tune" aria-expanded={!tuneCollapsed} aria-label={tuneCollapsed ? "Open fine-tune sidebar" : "Collapse fine-tune sidebar"} onClick={() => setTuneCollapsed((value) => !value)}>{tuneCollapsed ? "‹" : "›"}</button>
      </div>
      <div id="disk-tune" className="disk-tune-panel__content" hidden={tuneCollapsed}>
      <div className="disk-tune">
        {settingsDirty && <div className="disk-settings-state" role="status">UNSAVED SETTINGS</div>}
        <section className="pe-section pe-theme-tracker">
          <div className="pe-section-head"><h2>PROVIDER</h2><span className="pe-eyebrow">MODEL</span></div>
          <div className="pe-section-body">
            <label className="field">Provider
              <select value={settings.provider} onChange={(event) => { setSettings({ ...settings, provider: event.target.value, model: "" }); setSettingsError(""); }}>
                <option value="google">Google</option>
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI API key</option>
                <option value="openai-codex">OpenAI Codex</option>
              </select>
            </label>
            <label className="field">Model
              <select value={settings.model} disabled={modelsLoading || Boolean(modelsError) || !models.length} onChange={(event) => { setSettings({ ...settings, model: event.target.value }); setSettingsError(""); }}>
                <option value="">{modelsLoading ? "Loading authenticated models..." : modelsError ? "Models unavailable" : models.length ? "Select a model" : "No authenticated models"}</option>
                {models.map((model) => <option key={model.id} value={model.id}>{model.name === model.id ? model.id : `${model.name} · ${model.id}`}</option>)}
              </select>
              <small>{modelsLoading ? "Loading authenticated models..." : modelsError || (models.length ? `${models.length} authenticated model${models.length === 1 ? "" : "s"} available.` : "No authenticated models. Run Pi /login or configure provider credentials.")}</small>
            </label>
            {settingsError && <p className="disk-settings-error" role="alert">{settingsError}</p>}
          </div>
        </section>
        <section className="pe-section pe-theme-tracker">
          <div className="pe-section-head"><h2>SEARCH KNOBS</h2><span className="pe-eyebrow">FIT</span></div>
          <div className="pe-section-body">
            <div className="slats">
              <div className="slat"><span>FIT</span><input type="range" min={1} max={99} value={settings.scoreThreshold} onChange={(event) => setSettings({ ...settings, scoreThreshold: Number(event.target.value) })} /><span>{settings.scoreThreshold}</span></div>
            </div>
          </div>
        </section>
        <section className="pe-section pe-theme-tracker">
          <div className="pe-section-head"><h2>ARMED SOURCES</h2><span className="pe-eyebrow">BOARDS</span></div>
          <div className="pe-section-body">
            <div className="disk-source-rack">
              {jobSourceKeys.map((source) => {
                const armed = enabled.includes(source);
                return <label className={`disk-source ${armed ? "armed" : ""}`} key={source}>
                  <input type="checkbox" checked={armed} onChange={(event) => setEnabledSource(source, event.target.checked)} />
                  <span className="disk-source__led" aria-hidden="true" />
                  <span>{jobSourceLabel(source)}</span>
                  <span className="disk-source__age">MAX <input aria-label={`${jobSourceLabel(source)} max age in days`} type="number" min={1} max={9999} step={1} value={sourceMaxAge(settings, source)} onChange={(event) => setSourceMaxAge(source, Number(event.target.value))} /></span>
                </label>;
              })}
              {(settings.customSources ?? []).map((custom) => {
                const armed = enabled.includes(custom.key);
                return <label className={`disk-source disk-source--custom ${armed ? "armed" : ""}`} key={custom.key}>
                  <input type="checkbox" checked={armed} onChange={(event) => setEnabledSource(custom.key, event.target.checked)} />
                  <span className="disk-source__led" aria-hidden="true" />
                  <span>{custom.label} <small>({custom.key})</small></span>
                </label>;
              })}
            </div>
            <div className="disk-custom-source-actions">
              <button type="button" className="disk-action ghost" onClick={startCustomSource}>Add custom source</button>
              {customError && <p className="disk-settings-error" role="alert">{customError}</p>}
            </div>
            {(settings.customSources ?? []).length > 0 && <div className="disk-custom-source-list">
              {(settings.customSources ?? []).map((custom) => <div className="disk-custom-source" key={custom.key}>
                <span><strong>{custom.label}</strong><small>{custom.key} / {custom.parser.format.toUpperCase()}</small></span>
                <span className="sel-actions"><button type="button" className="disk-action ghost" onClick={() => editCustomSource(custom)}>Edit</button><button type="button" className="disk-action ghost" onClick={() => removeCustomSource(custom.key)}>Remove</button></span>
              </div>)}
            </div>}
            {customDraft && <CustomSourceEditor draft={customDraft} onChange={setCustomDraft} onCancel={() => { setCustomDraft(null); setCustomError(""); }} onSave={saveCustomSource} editing={Boolean(editingCustomKey)} variant="tracker" />}
          </div>
        </section>
        <section className="disk-document-settings pe-section pe-theme-tracker">
          <div className="pe-section-head"><h2>DOCUMENT SETTINGS</h2><span className="pe-eyebrow">OUTPUT TARGETS</span></div>
          <div className="pe-section-body">
            <div className="pe-two"><label className="field">CV pages<input type="number" min={1} max={10} value={settings.cvPages} onChange={(event) => setSettings({ ...settings, cvPages: Number(event.target.value) })} /></label><label className="field">Cover-letter pages<input type="number" min={1} max={10} value={settings.coverLetterPages} onChange={(event) => setSettings({ ...settings, coverLetterPages: Number(event.target.value) })} /></label></div>
          </div>
        </section>
        <section className="pe-section pe-theme-tracker">
          <div className="pe-section-head"><h2>ACTIONS</h2><span className="pe-eyebrow">WRITE</span></div>
          <div className="pe-section-body">
            <div className="sel-actions">
              <button type="button" className="disk-action" disabled={!settingsDirty || !modelValid || modelsLoading} onClick={() => void saveSettings()}>Write settings</button>
              <button type="button" className="disk-action ghost" disabled={!settingsDirty} onClick={revertSettings}>Revert</button>
              <button type="button" className="disk-action ghost" disabled={settingsDirty || !modelValid || modelsLoading} onClick={() => void api("/api/ai/test", { method: "POST" }).then(() => toast("Connection test succeeded.")).catch((caught) => toast(caught instanceof Error ? caught.message : "Connection test failed."))}>Test link</button>
            </div>
          </div>
        </section>
        <section className="pe-section pe-theme-tracker">
          <div className="pe-section-head"><h2>STATUS</h2><span className="pe-eyebrow">TOOLS</span></div>
          <div className="pe-section-body">
            <div className="disk-tools">
              {["lualatex", "xelatex", "pdfinfo", "pdftotext"].map((name) => {
                const ok = status?.tools[name]?.available;
                return <span className={`disk-tool ${ok ? "ok" : ""}`} key={name}><i aria-hidden="true" /><span>{name.toUpperCase()}</span><b>{ok ? "AVAILABLE" : "MISSING"}</b></span>;
              })}
            </div>
            <div className="disk-template-status">
              <div><span>CV templates</span><b>{status?.templates.cv.available ? status.templates.cv.names.join(", ") || "Available" : "Missing"}</b></div>
              <div><span>Cover-letter template</span><b>{status?.templates.coverLetter.available ? "Available" : "Missing"}</b></div>
            </div>
          </div>
        </section>
      </div>
      </div>
    </aside>
  </>;
}
