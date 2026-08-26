import type { Job, JobStage } from "../shared.js";
import type { OrderFocus, TrackerRoute } from "./hash.js";
import { WORKFLOW_CHANNELS, channelJobCount, isChannelActive, type WorkflowChannelId } from "./workflow.js";

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
  return (
    <aside className="panel workflow-rack">
      <div className="panel-h">
        WORKFLOW
        <span>Klik langkah · angka = jumlah job</span>
      </div>
      {WORKFLOW_CHANNELS.map((channel) => {
        const count = channelJobCount(channel.id, jobs);
        const active = isChannelActive(channel, route, filter, orderFocus);
        return (
          <button
            type="button"
            className={`ch ${active ? "on" : ""} ${channel.armed ? "armed" : ""}`}
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
                <i className={`led ${channel.led}`} />
              </span>
            </span>
          </button>
        );
      })}
      <p className="workflow-note">
        Tab atas = editor. Kolom ini = alur kerja. SCRAPE/RANK/SELECT buka PATTERN. DOCS/APPLY/FOLLOW buka ORDER LIST di posisi berbeda (B00–B04).
      </p>
    </aside>
  );
}
