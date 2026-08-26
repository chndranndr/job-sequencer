import { useState } from "react";
import "./surfer-loader.css";

const DRIVE_DELAYS = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  return (index % 3 + Math.abs(row - 1)) * 90;
});

export function SurferLoader({
  label = "Subway surfing",
  elapsed,
  variant = "desk",
}: {
  label?: string;
  elapsed: string;
  variant?: "desk" | "tracker";
}) {
  const [videoOk, setVideoOk] = useState(true);
  return (
    <div className={`surfer-loader surfer-loader--${variant}`} role="status" aria-live="polite">
      <div className="surfer-loader__meta">
        <span className="surfer-pixels" aria-hidden="true">
          {DRIVE_DELAYS.map((delay, index) => <i key={index} style={{ animationDelay: `${delay}ms` }} />)}
        </span>
        <strong className="surfer-loader__label">{label}</strong>
        <span className="surfer-loader__time">{elapsed}</span>
      </div>
      <div className="surfer-loader__stage">
        {videoOk ? (
          <video src="/subway-surfers.mp4" autoPlay muted loop playsInline onError={() => setVideoOk(false)} />
        ) : (
          <div className="surfer-loader__fallback">
            <span className="surfer-pixels" aria-hidden="true">
              {DRIVE_DELAYS.map((delay, index) => <i key={index} style={{ animationDelay: `${delay}ms` }} />)}
            </span>
            <small>Video unavailable</small>
          </div>
        )}
      </div>
    </div>
  );
}
