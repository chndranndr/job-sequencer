import { useEffect, useRef } from "react";
import type { Run } from "./shared.js";

export const WORKFLOW_CUES = {
  running: "/audio/workflow-run.mp3",
  succeeded: "/audio/workflow-success.mp3",
  failed: "/audio/workflow-fail.mp3",
} as const;

export type WorkflowCue = keyof typeof WORKFLOW_CUES;

export function cueForRunStatus(status: Run["status"]): WorkflowCue | null {
  if (status === "running") return "running";
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "cancelled" || status === "timed_out") return "failed";
  return null;
}

export function useWorkflowCues(run: Pick<Run, "id" | "status"> | null) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const prevRef = useRef<{ id: string; status: Run["status"] } | null>(null);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = "auto";
    audio.volume = 0.72;
    audioRef.current = audio;
    return () => {
      audio.pause();
      audio.removeAttribute("src");
      audioRef.current = null;
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    const previous = prevRef.current;
    prevRef.current = run ? { id: run.id, status: run.status } : null;
    if (!audio) return;

    async function play(player: HTMLAudioElement, src: string, loop: boolean) {
      window.dispatchEvent(new Event("greenfield:workflow-cue"));
      player.pause();
      player.loop = loop;
      player.src = src;
      player.currentTime = 0;
      try { await player.play(); } catch { /* autoplay blocked until a click starts a run */ }
    }

    if (!run) {
      audio.pause();
      return;
    }

    if (run.status === "running") {
      if (previous?.id === run.id && previous.status === "running") return;
      void play(audio, WORKFLOW_CUES.running, true);
      return;
    }

    const justFinished = previous?.id === run.id && previous.status === "running";
    if (justFinished && run.status === "succeeded") {
      void play(audio, WORKFLOW_CUES.succeeded, false);
      return;
    }
    if (justFinished && (run.status === "failed" || run.status === "cancelled" || run.status === "timed_out")) {
      void play(audio, WORKFLOW_CUES.failed, false);
      return;
    }
  }, [run?.id, run?.status]);
}
