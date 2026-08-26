export const TRACKER_VIEWS = ["pattern", "order", "phrase", "sample", "disk", "trace"] as const;
export type TrackerView = (typeof TRACKER_VIEWS)[number];
export const ORDER_FOCUSES = ["draft", "ready", "follow"] as const;
export type OrderFocus = (typeof ORDER_FOCUSES)[number];

/** @deprecated use OrderFocus */
export type MixFocus = OrderFocus;

export type TrackerRoute = { view: TrackerView; jobId?: string; runId?: string; orderFocus?: OrderFocus; mixFocus?: OrderFocus };

function resolveView(part: string | undefined): TrackerView {
  if (part === "mix") return "order";
  if (part === "song") return "pattern";
  if (part === "runs") return "trace";
  return TRACKER_VIEWS.find((item) => item === part) ?? "pattern";
}

function decodePart(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function parseTrackerHash(hash = typeof window === "undefined" ? "#/pattern" : window.location.hash): TrackerRoute {
  const path = hash.replace(/^#/, "") || "/pattern";
  const parts = path.split("/").filter(Boolean);
  const view = resolveView(parts[0]);
  const jobId = (view === "sample" || view === "phrase") && parts[1] && !ORDER_FOCUSES.includes(parts[1] as OrderFocus)
    ? decodePart(parts[1])
    : undefined;
  const orderFocus = view === "order" && parts[1] && ORDER_FOCUSES.includes(parts[1] as OrderFocus) ? parts[1] as OrderFocus : undefined;
  const route = { view, jobId, orderFocus, mixFocus: orderFocus };
  return view === "trace" ? { ...route, runId: parts[1] ? decodePart(parts[1]) : undefined } : route;
}

export function trackerHref(view: TrackerView, id?: string, orderFocus?: OrderFocus) {
  if (view === "order" && orderFocus) return `#/order/${orderFocus}`;
  if (id) return `#/${view}/${encodeURIComponent(id)}`;
  return `#/${view}`;
}

export function orderTabLabel(view: TrackerView) {
  return view === "order" ? "ORDER" : view.toUpperCase();
}
