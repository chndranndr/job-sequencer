import type {
  Criteria,
  Job,
  Run,
  RunTrajectoryEnvelope,
  Settings,
  StructuredProfile,
} from "./shared.js";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export type PiModelOption = { id: string; name: string };
export type ProfileImportIdentity = {
  conflict: boolean;
  currentName: string;
  incomingName: string;
  reason: string;
};
export type ProfileImportSummary = {
  profile: StructuredProfile;
  extracted: StructuredProfile;
  source: { fileName: string; format: "pdf" | "doc" | "docx"; textLength: number };
  identity: ProfileImportIdentity;
};

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !(typeof FormData !== "undefined" && init.body instanceof FormData) && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new ApiError(typeof body === "object" && body && "error" in body ? String((body as { error: unknown }).error) : "Request failed.", response.status);
  return body as T;
}

export const getProfile = () => api<{ profile: StructuredProfile; canonical: boolean; legacyImportAvailable: boolean; cvPageEstimate: number | null }>("/api/profile");
export const importProfile = (file: File, currentProfile?: StructuredProfile | null) => {
  const body = new FormData();
  body.append("file", file);
  if (currentProfile) body.append("currentProfile", JSON.stringify(currentProfile));
  return api<{ runId: string }>("/api/profile/import", { method: "POST", body });
};
export const getCriteria = () => api<Criteria>("/api/criteria");
export const getSettings = () => api<Settings>("/api/settings");
export const getAvailableModels = (provider: string) => api<{ provider: string; models: PiModelOption[] }>(`/api/ai/models?provider=${encodeURIComponent(provider)}`);
export const getJobs = (stages?: string[]) => api<{ jobs: Job[] }>(stages?.length ? `/api/jobs?stage=${encodeURIComponent(stages.join(","))}` : "/api/jobs");
export const getApplications = () => api<{ jobs: Job[] }>("/api/applications");
export const getJob = (id: string) => api<Job>(`/api/jobs/${encodeURIComponent(id)}`);
export const getRun = (id: string) => api<Run>(`/api/runs/${encodeURIComponent(id)}`);
export const getRuns = (limit = 50) => api<{ runs: Run[] }>(`/api/runs?limit=${limit}`);
export const getRunTrajectory = (id: string) => api<RunTrajectoryEnvelope>(`/api/runs/${encodeURIComponent(id)}/trajectory`);
export const getActiveRun = () => api<{ run: Run | null }>("/api/runs/active");

export function jsonBody(value: unknown): RequestInit { return { method: "POST", body: JSON.stringify(value) }; }
