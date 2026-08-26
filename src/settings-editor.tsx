import { cloneElement, isValidElement, useEffect, useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { BuiltInJobSource, CustomHtmlField, CustomJobSource, CustomSourceParser, Settings } from "./shared.js";
import { defaultSourceMaxAgeDays, isJobSource, jobSourceKeys } from "./shared.js";

export type SettingsModelOption = { id: string; name: string };
export type SettingsEditorVariant = "desk" | "tracker";
export type SettingsMutationResult = { value: Settings | null; error: string };

export function cloneSettings(value: Settings): Settings {
  return JSON.parse(JSON.stringify(value)) as Settings;
}

export function settingsAreDirty(current: Settings | null, saved: Settings | null): boolean {
  return Boolean(current && saved && JSON.stringify(current) !== JSON.stringify(saved));
}

export function enabledSources(settings: Settings): string[] {
  return settings.enabledSources?.length ? [...settings.enabledSources] : [settings.source];
}

export function sourceMaxAge(settings: Settings, source: BuiltInJobSource): number {
  return settings.sourceMaxAgeDays?.[source] ?? defaultSourceMaxAgeDays[source];
}

export function updateEnabledSources(settings: Settings, next: readonly string[]): SettingsMutationResult {
  const enabled = [...new Set(next.filter(Boolean))];
  if (!enabled.length) return { value: null, error: "Keep at least one source enabled so a scrape can run." };
  const source = enabled.find(isJobSource) ?? "freehire";
  return { value: { ...settings, enabledSources: enabled, source }, error: "" };
}

export function toggleEnabledSource(settings: Settings, source: string, enabled: boolean): SettingsMutationResult {
  const current = enabledSources(settings);
  return updateEnabledSources(settings, enabled ? [...current, source] : current.filter((value) => value !== source));
}

export function upsertCustomSource(settings: Settings, draft: CustomJobSource, editingKey: string | null = null): SettingsMutationResult {
  const source = { ...draft, key: draft.key.trim(), label: draft.label.trim() };
  const customSources = settings.customSources ?? [];
  if (!source.key || !source.label) return { value: null, error: "Custom source key and label are required." };
  if (jobSourceKeys.includes(source.key as (typeof jobSourceKeys)[number])) return { value: null, error: "Custom source keys cannot use a built-in source key." };
  if (customSources.some((item) => item.key === source.key && item.key !== editingKey)) return { value: null, error: "Custom source keys must be unique." };
  const nextCustomSources = customSources.filter((item) => item.key !== editingKey && item.key !== source.key);
  const nextEnabledSources = editingKey && editingKey !== source.key
    ? enabledSources(settings).map((key) => key === editingKey ? source.key : key)
    : enabledSources(settings);
  return {
    value: {
      ...settings,
      customSources: [...nextCustomSources, source],
      enabledSources: nextEnabledSources,
      source: nextEnabledSources.find(isJobSource) ?? "freehire",
    },
    error: "",
  };
}

export function removeCustomSourceSettings(settings: Settings, key: string): Settings {
  const nextEnabledSources = enabledSources(settings).filter((value) => value !== key);
  const repairedEnabledSources = nextEnabledSources.length ? nextEnabledSources : ["freehire"];
  return {
    ...settings,
    customSources: (settings.customSources ?? []).filter((source) => source.key !== key),
    enabledSources: repairedEnabledSources,
    source: repairedEnabledSources.find(isJobSource) ?? "freehire",
  };
}

export function hasValidProviderModel(settings: Settings, models: readonly SettingsModelOption[]): boolean {
  return Boolean(settings.provider.trim() && settings.model.trim() && models.some((model) => model.id === settings.model));
}

export function useUnsavedNavigationGuard(dirty: boolean, message = "You have unsaved settings. Revert them and leave DISK?") {
  useEffect(() => {
    if (!dirty) return;
    const onRequest = (event: Event) => {
      const request = event as CustomEvent<{ allowed: boolean }>;
      if (!window.confirm(message)) request.detail.allowed = false;
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("jobdesk:navigation-request", onRequest);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("jobdesk:navigation-request", onRequest);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [dirty, message]);
}

export function blankCustomSource(): CustomJobSource {
  return {
    key: "",
    label: "",
    searchUrlTemplate: "https://example.com/jobs?query={{query}}&location={{location}}&limit={{limit}}",
    detailUrlTemplate: "https://example.com/jobs/{{id}}",
    parser: {
      format: "json",
      search: { resultsPath: "results", fields: { id: "id", title: "title", company: "company", location: "location", url: "url" } },
      detail: { fields: { id: "id", title: "title", url: "url", description: "description" } },
    },
  };
}

export function blankCustomParser(format: "json" | "html"): CustomSourceParser {
  if (format === "json") return blankCustomSource().parser;
  return {
    format: "html",
    search: { itemSelector: ".job", fields: { id: { selector: "[data-id]", attribute: "data-id" }, title: { selector: ".title" }, company: { selector: ".company" }, location: { selector: ".location" }, url: { selector: "a", attribute: "href" } } },
    detail: { fields: { id: { selector: "[data-id]", attribute: "data-id" }, title: { selector: "h1" }, url: { selector: "link[rel=canonical]", attribute: "href" }, description: { selector: ".description" } } },
  };
}

export function updateHtmlField(field: CustomHtmlField, key: "selector" | "attribute", value: string): CustomHtmlField {
  return { ...field, [key]: value || undefined };
}

function SettingsField({ variant, label, hint, children, className = "" }: { variant: SettingsEditorVariant; label: string; hint?: string; children: ReactNode; className?: string }) {
  const id = `settings-field-${useId().replace(/:/g, "")}`;
  const control = isValidElement<{ id?: string }>(children) ? cloneElement(children, { id: children.props.id ?? id }) : children;
  return <label className={`${variant === "tracker" ? "pe-field" : "field-label"} ${className}`}><span>{label}</span>{control}{hint && <small>{hint}</small>}</label>;
}

function SettingsButton({ variant, kind = "secondary", children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant: SettingsEditorVariant; kind?: "primary" | "signal" | "secondary" | "ghost" | "danger" }) {
  return <button type="button" className={variant === "tracker" ? `pe-btn pe-btn-${kind}` : `btn btn-${kind}`} {...props}>{children}</button>;
}

type JsonSearchField = "id" | "title" | "company" | "location" | "url";
type JsonDetailField = "id" | "title" | "url" | "description";
type HtmlSearchField = "id" | "title" | "company" | "location" | "url";
type HtmlDetailField = "id" | "title" | "url" | "description";

export function CustomSourceEditor({ draft, onChange, onCancel, onSave, editing, variant = "desk" }: { draft: CustomJobSource; onChange: (value: CustomJobSource) => void; onCancel: () => void; onSave: () => void; editing: boolean; variant?: SettingsEditorVariant }) {
  const parser = draft.parser;
  const tracker = variant === "tracker";
  const updateJsonSearch = (key: JsonSearchField, value: string) => {
    if (parser.format !== "json") return;
    const fields = { ...parser.search.fields, [key]: value } as typeof parser.search.fields;
    onChange({ ...draft, parser: { ...parser, search: { ...parser.search, fields } } });
  };
  const updateJsonDetail = (key: JsonDetailField, value: string) => {
    if (parser.format !== "json") return;
    const fields = { ...parser.detail.fields, [key]: value } as typeof parser.detail.fields;
    onChange({ ...draft, parser: { ...parser, detail: { fields } } });
  };
  const updateHtmlSearch = (key: HtmlSearchField, part: "selector" | "attribute", value: string) => {
    if (parser.format !== "html") return;
    const current = parser.search.fields[key] ?? { selector: "" };
    const fields = { ...parser.search.fields, [key]: updateHtmlField(current, part, value) } as typeof parser.search.fields;
    onChange({ ...draft, parser: { ...parser, search: { ...parser.search, fields } } });
  };
  const updateHtmlDetail = (key: HtmlDetailField, part: "selector" | "attribute", value: string) => {
    if (parser.format !== "html") return;
    const current = parser.detail.fields[key];
    const fields = { ...parser.detail.fields, [key]: updateHtmlField(current, part, value) } as typeof parser.detail.fields;
    onChange({ ...draft, parser: { ...parser, detail: { fields } } });
  };
  const changeFormat = (format: "json" | "html") => {
    if (format !== parser.format) onChange({ ...draft, parser: blankCustomParser(format) });
  };
  const jsonSearchLabels: Array<[JsonSearchField, string]> = [["id", "ID path"], ["title", "Title path"], ["company", "Company path"], ["location", "Location path"], ["url", "URL path"]];
  const jsonDetailLabels: Array<[JsonDetailField, string]> = [["id", "ID path"], ["title", "Title path"], ["url", "URL path"], ["description", "Description path"]];
  const htmlSearchLabels: Array<[HtmlSearchField, string]> = [["id", "ID"], ["title", "Title"], ["company", "Company"], ["location", "Location"], ["url", "URL"]];
  const htmlDetailLabels: Array<[HtmlDetailField, string]> = [["id", "ID"], ["title", "Title"], ["url", "URL"], ["description", "Description"]];
  return <section className={`custom-source-editor ${tracker ? "pe-theme-tracker pe-section" : ""}`} aria-label={editing ? "Edit custom source" : "Add custom source"}>
    <div className={tracker ? "pe-section-head" : "section-heading"}><h3>{editing ? "Edit custom source" : "Add custom source"}</h3><span className="eyebrow">DECLARATIVE HTTP ONLY</span></div>
    <div className={tracker ? "pe-section-body" : ""}>
      <div className="two-column"><SettingsField variant={variant} label="Safe key" hint="2-40 lowercase letters, numbers, or hyphens"><input value={draft.key} onChange={(event) => onChange({ ...draft, key: event.target.value })} placeholder="company-board" /></SettingsField><SettingsField variant={variant} label="Display label"><input value={draft.label} onChange={(event) => onChange({ ...draft, label: event.target.value })} placeholder="Company Board" /></SettingsField></div>
      <SettingsField variant={variant} label="Search URL template" hint="Allowed placeholders: {{query}}, {{location}}, {{limit}}. HTTP(S) only; no credentials."><input value={draft.searchUrlTemplate} onChange={(event) => onChange({ ...draft, searchUrlTemplate: event.target.value })} /></SettingsField>
      <SettingsField variant={variant} label="Detail URL template" hint="Allowed placeholders: {{id}}, {{url}}. Values are URL-encoded before use."><input value={draft.detailUrlTemplate} onChange={(event) => onChange({ ...draft, detailUrlTemplate: event.target.value })} /></SettingsField>
      <SettingsField variant={variant} label="Response format"><select value={parser.format} onChange={(event) => changeFormat(event.target.value as "json" | "html")}><option value="json">JSON</option><option value="html">HTML</option></select></SettingsField>
      {parser.format === "json" ? <>
        <div className="two-column"><SettingsField variant={variant} label="Search results path" hint="Example: data.jobs or results[0].items"><input value={parser.search.resultsPath} onChange={(event) => onChange({ ...draft, parser: { ...parser, search: { ...parser.search, resultsPath: event.target.value } } })} /></SettingsField><span className="field-help">JSON paths are data-only dot paths with bounded numeric array indexes.</span></div>
        <div className="parser-grid"><div><h4>Search result fields</h4>{jsonSearchLabels.map(([key, label]) => <SettingsField key={key} variant={variant} label={label}><input value={parser.search.fields[key] ?? ""} onChange={(event) => updateJsonSearch(key, event.target.value)} /></SettingsField>)}</div><div><h4>Detail fields</h4>{jsonDetailLabels.map(([key, label]) => <SettingsField key={key} variant={variant} label={label}><input value={parser.detail.fields[key] ?? ""} onChange={(event) => updateJsonDetail(key, event.target.value)} /></SettingsField>)}</div></div>
      </> : <>
        <SettingsField variant={variant} label="Search item selector" hint="Simple CSS only: tag, .class, #id, [attribute], descendant, or >."><input value={parser.search.itemSelector} onChange={(event) => onChange({ ...draft, parser: { ...parser, search: { ...parser.search, itemSelector: event.target.value } } })} /></SettingsField>
        <div className="parser-grid"><div><h4>Search result fields</h4>{htmlSearchLabels.map(([key, label]) => <HtmlFieldEditor key={key} variant={variant} label={label} field={parser.search.fields[key] ?? { selector: "" }} onChange={(part, value) => updateHtmlSearch(key, part, value)} />)}</div><div><h4>Detail fields</h4>{htmlDetailLabels.map(([key, label]) => <HtmlFieldEditor key={key} variant={variant} label={label} field={parser.detail.fields[key]} onChange={(part, value) => updateHtmlDetail(key, part, value)} />)}</div></div>
      </>}
      <p className={tracker ? "pe-muted" : "muted"}>This adapter never evaluates JavaScript, runs commands, accepts credentials, or exposes arbitrary tools. Responses and results stay bounded.</p>
      <div className="button-row"><SettingsButton variant={variant} kind="signal" onClick={onSave}>{editing ? "Save custom source" : "Add custom source"}</SettingsButton><SettingsButton variant={variant} kind="ghost" onClick={onCancel}>Cancel</SettingsButton></div>
    </div>
  </section>;
}

function HtmlFieldEditor({ variant, label, field, onChange }: { variant: SettingsEditorVariant; label: string; field: CustomHtmlField; onChange: (part: "selector" | "attribute", value: string) => void }) {
  return <div className="html-field-editor"><SettingsField variant={variant} label={`${label} selector`}><input value={field.selector} onChange={(event) => onChange("selector", event.target.value)} placeholder=".title" /></SettingsField><SettingsField variant={variant} label={`${label} attribute`} hint="Optional; blank reads text"><input value={field.attribute ?? ""} onChange={(event) => onChange("attribute", event.target.value)} placeholder="href" /></SettingsField></div>;
}
