import type { Job, JobStage } from "../shared.js";
import type { OrderFocus, TrackerRoute } from "./hash.js";

export type WorkflowChannelId = "scrape" | "rank" | "select" | "docs" | "apply" | "phrase" | "follow";

export type ChannelLedState = "g" | "o" | "dim";

export type WorkflowChannel = {
  id: WorkflowChannelId;
  num: string;
  name: string;
  hint: string;
  tab: string;
  view: TrackerRoute["view"];
  filter?: JobStage | "all";
  orderFocus?: OrderFocus;
  /** @deprecated use orderFocus */
  mixFocus?: OrderFocus;
  action?: "scrape";
};

export const WORKFLOW_CHANNELS: WorkflowChannel[] = [
  {
    id: "scrape",
    num: "01",
    name: "SCRAPE",
    hint: "Cari lowongan baru · sama dengan tombol Play",
    tab: "PATTERN",
    view: "pattern",
    filter: "all",
    action: "scrape",
  },
  {
    id: "rank",
    num: "02",
    name: "RANK",
    hint: "Lihat kandidat yang direkomendasikan Pi",
    tab: "PATTERN",
    view: "pattern",
    filter: "Recommended",
  },
  {
    id: "select",
    num: "03",
    name: "SELECT",
    hint: "Job yang kamu pilih · klik baris untuk SAMPLE",
    tab: "PATTERN",
    view: "pattern",
    filter: "Selected",
  },
  {
    id: "docs",
    num: "04",
    name: "DOCS",
    hint: "Generate CV + surat · posisi B00–B01 di ORDER",
    tab: "ORDER",
    view: "order",
    orderFocus: "draft",
  },
  {
    id: "apply",
    num: "05",
    name: "APPLY",
    hint: "Siap submit manual · posisi B02 di ORDER",
    tab: "ORDER",
    view: "order",
    orderFocus: "ready",
  },
  {
    id: "phrase",
    num: "06",
    name: "PHRASE",
    hint: "Latihan interview · tab PHRASE",
    tab: "PHRASE",
    view: "phrase",
  },
  {
    id: "follow",
    num: "07",
    name: "FOLLOW",
    hint: "Pilih Applied / Interview · follow-up editor · posisi B03–B04 di ORDER",
    tab: "ORDER",
    view: "order",
    orderFocus: "follow",
  },
];

export function channelJobCount(channel: WorkflowChannelId, jobs: Job[]) {
  switch (channel) {
    case "scrape":
      return jobs.length;
    case "rank":
      return jobs.filter((job) => job.stage === "Recommended" || job.stage === "Discarded").length;
    case "select":
      return jobs.filter((job) => job.stage === "Selected").length;
    case "docs":
      return jobs.filter((job) => job.stage === "Selected" || job.stage === "Drafting").length;
    case "apply":
      return jobs.filter((job) => job.stage === "Ready").length;
    case "phrase":
      return jobs.filter((job) => job.stage === "Applied" || job.stage === "Interview").length;
    case "follow":
      return jobs.filter((job) => job.stage === "Applied" || job.stage === "Interview").length;
  }
}

export function channelLedState(active: boolean, count: number): ChannelLedState {
  if (active) return "g";
  if (count > 0) return "o";
  return "dim";
}

export function isChannelActive(
  channel: WorkflowChannel,
  route: TrackerRoute,
  filter: JobStage | "all",
  orderFocus: OrderFocus,
) {
  if (channel.view !== route.view) return false;
  if (channel.view === "pattern") return channel.filter === filter;
  if (channel.view === "order") return channel.orderFocus === orderFocus;
  return channel.view === "phrase";
}
