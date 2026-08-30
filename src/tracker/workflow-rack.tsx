import { useEffect, useState } from "react";
import type { Job, JobStage } from "../shared.js";
import type { OrderFocus, TrackerRoute } from "./hash.js";
import { isNarrowLayout, NARROW_LAYOUT_MQ } from "./narrow.js";
import { WORKFLOW_CHANNELS, channelJobCount, channelLedState, isChannelActive, type WorkflowChannelId } from "./workflow.js";

const COLLAPSED_RACK_WIDTH = 48;
const EXPANDED_RACK_WIDTH = 196;

export type PanelRailState = { collapsed: boolean; width: number };

export function WorkflowRack({
  jobs,
  route,
  filter,
  orderFocus,
  onChannel,
}: {
  jobs: Job[];
  route: TrackerRoute;
  filter: JobStage | "all";
  orderFocus: OrderFocus;
  onChannel: (id: WorkflowChannelId) => void;
}) {
  const [rackCollapsed, setRackCollapsed] = useState(isNarrowLayout);
  useEffect(() => {
    const media = window.matchMedia(NARROW_LAYOUT_MQ);
    const collapseWhenNarrow = () => { if (media.matches) setRackCollapsed(true); };
    collapseWhenNarrow();
    media.addEventListener("change", collapseWhenNarrow);
    return () => media.removeEventListener("change", collapseWhenNarrow);
  }, []);
  const rail: PanelRailState = {
    collapsed: rackCollapsed,
    width: rackCollapsed ? COLLAPSED_RACK_WIDTH : EXPANDED_RACK_WIDTH,
  };
  return (
    <aside className={`panel workflow-rack ${rail.collapsed ? "is-collapsed" : ""}`} style={rail.collapsed ? { width: rail.width } : undefined} aria-label="Workflow rack">
      <div className="panel-h workflow-rack__head">
        <span className="workflow-rack__title">
          WORKFLOW
          <span>Klik langkah · angka = jumlah job</span>
        </span>
        <button
          type="button"
          className="workflow-rack__toggle"
          aria-controls="workflow-rack"
          aria-expanded={!rail.collapsed}
          aria-label={rail.collapsed ? "Open workflow rack" : "Collapse workflow rack"}
          onClick={() => setRackCollapsed((value) => !value)}
        >
          {rail.collapsed ? "›" : "‹"}
        </button>
      </div>
      <div id="workflow-rack" className="workflow-rack__content" hidden={rail.collapsed}>
      {WORKFLOW_CHANNELS.map((channel) => {
        const count = channelJobCount(channel.id, jobs);
        const active = isChannelActive(channel, route, filter, orderFocus);
        const led = channelLedState(active, count);
        return (
          <button
            type="button"
            className={`ch ${active ? "on" : ""}`}
            key={channel.id}
            title={`${channel.hint} · buka tab ${channel.tab}`}
            aria-current={active ? "step" : undefined}
            onClick={() => onChannel(channel.id)}
          >
            <span className="n">{channel.num}</span>
            <span className="ch-copy">
              <strong>{channel.name}</strong>
              <small>{channel.tab}</small>
            </span>
            <span className="ch-meta">
              <span className="ch-count">{count}</span>
              <span className="leds">
                <i className={`led ${led}`} />
              </span>
            </span>
          </button>
        );
      })}
      <p className="workflow-note">
        Tab atas = editor. Kolom ini = alur kerja. SCRAPE/RANK/SELECT buka PATTERN. DOCS/APPLY/FOLLOW buka ORDER di posisi berbeda (B00–B04).
      </p>
      </div>
    </aside>
  );
}
