import type { Job, JobStage } from "../shared.js";
import type { OrderFocus, TrackerRoute } from "./hash.js";

export type WorkflowChannelId = "scrape" | "rank" | "select" | "docs" | "apply" | "phrase" | "follow";

export type WorkflowChannel = {
  id: WorkflowChannelId;
  num: string;
  name: string;
  led: "g" | "o" | "b";
  armed?: boolean;
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
    led: "g",
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
    led: "g",
    hint: "Lihat kandidat yang direkomendasikan Pi",
    tab: "PATTERN",
    view: "pattern",
    filter: "Recommended",
  },
  {
    id: "select",
    num: "03",
    name: "SELECT",
    led: "o",
    armed: true,
    hint: "Job yang kamu pilih · klik baris untuk SAMPLE",
    tab: "PATTERN",
    view: "pattern",
    filter: "Selected",
  },
  {
    id: "docs",
    num: "04",
    name: "DOCS",
    led: "b",
    hint: "Generate CV + surat · posisi B00–B01 di ORDER",
    tab: "ORDER",
    view: "order",
    orderFocus: "draft",
  },
  {
    id: "apply",
    num: "05",
    name: "APPLY",
    led: "o",
    armed: true,
    hint: "Siap submit manual · posisi B02 di ORDER",
    tab: "ORDER",
    view: "order",
    orderFocus: "ready",
  },
  {
    id: "phrase",
    num: "06",
    name: "PHRASE",
    led: "b",
    hint: "Latihan interview · tab PHRASE",
    tab: "PHRASE",
    view: "phrase",
  },
  {
    id: "follow",
    num: "07",
    name: "FOLLOW",
    led: "o",
    armed: true,
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
      return jobs.filter((job) => job.stage === "Interview").length;
    case "follow":
      return jobs.filter((job) => job.stage === "Applied" || job.stage === "Interview").length;
  }
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
