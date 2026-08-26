import { useEffect, useRef, useState } from "react";
import { startTrackerTune, stopTrackerTune } from "./audio.js";
import { addTapeTrack, formatTapeTime, listTapeTracks, removeTapeTrack, getTapeTrackBlob, type TapeTrackMeta } from "./tape-store.js";

type TapeSource = "demo" | "mp3";

export function TapeDeck({ open, onToggle, onLiveChange, toast }: {
  open: boolean;
  onToggle: () => void;
  onLiveChange: (live: boolean) => void;
  toast: (message: string) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const selectTrackRef = useRef<(id: string, autoplay?: boolean) => Promise<void>>(async () => undefined);
  const [tracks, setTracks] = useState<TapeTrackMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [source, setSource] = useState<TapeSource>("demo");
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.72);

  const currentIndex = currentId ? tracks.findIndex((track) => track.id === currentId) : -1;
  const currentTrack = currentIndex >= 0 ? tracks[currentIndex] : null;
  const live = playing && (source === "demo" || Boolean(currentTrack));
  const tracksRef = useRef(tracks);
  const currentIndexRef = useRef(currentIndex);
  const sourceRef = useRef(source);
  const playingRef = useRef(playing);
  tracksRef.current = tracks;
  currentIndexRef.current = currentIndex;
  sourceRef.current = source;
  playingRef.current = playing;

  useEffect(() => { onLiveChange(live); }, [live, onLiveChange]);
  useEffect(() => {
    const duck = () => {
      stopTrackerTune();
      audioRef.current?.pause();
      setPlaying(false);
    };
    window.addEventListener("greenfield:workflow-cue", duck);
    return () => window.removeEventListener("greenfield:workflow-cue", duck);
  }, []);

  useEffect(() => {
    let disposed = false;
    void listTapeTracks()
      .then((rows) => { if (!disposed) setTracks(rows); })
      .catch((caught) => toast(caught instanceof Error ? caught.message : "Could not read tape library."))
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [toast]);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = "metadata";
    audioRef.current = audio;
    const onTime = () => setProgress(audio.currentTime);
    const onMeta = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const onEnded = () => {
      if (sourceRef.current !== "mp3" || !tracksRef.current.length) {
        setPlaying(false);
        return;
      }
      const idx = currentIndexRef.current;
      const next = tracksRef.current[(idx + 1 + tracksRef.current.length) % tracksRef.current.length];
      if (next) void selectTrackRef.current(next.id, playingRef.current);
      else setPlaying(false);
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.pause();
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("ended", onEnded);
      audioRef.current = null;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  useEffect(() => {
    audioRef.current && (audioRef.current.volume = volume);
  }, [volume]);

  useEffect(() => {
    if (source === "demo") {
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
      audioRef.current?.pause();
      if (playing) startTrackerTune();
      else stopTrackerTune();
      return () => stopTrackerTune();
    }
    stopTrackerTune();
    return undefined;
  }, [source, playing]);

  function revokeUrl() {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }

  async function selectTrack(id: string, autoplay = false) {
    const track = tracks.find((item) => item.id === id);
    if (!track) return;
    setSource("mp3");
    setCurrentId(id);
    setPlaying(false);
    try {
      const blob = await getTapeTrackBlob(id);
      revokeUrl();
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = audioRef.current;
      if (!audio) return;
      audio.src = url;
      audio.currentTime = 0;
      setProgress(0);
      setDuration(track.duration || 0);
      if (autoplay) {
        await audio.play();
        setPlaying(true);
      }
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : "Track could not be loaded.");
    }
  }
  selectTrackRef.current = selectTrack;

  async function togglePlay() {
    if (source === "demo") {
      setPlaying((value) => !value);
      return;
    }
    if (!currentTrack && tracks[0]) {
      await selectTrack(tracks[0].id, true);
      return;
    }
    const audio = audioRef.current;
    if (!audio || !currentTrack) {
      toast("Load an MP3 onto tape first.");
      return;
    }
    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }
    try {
      await audio.play();
      setPlaying(true);
    } catch {
      toast("Playback blocked. Click play again.");
    }
  }

  async function armTrack(id: string) {
    if (currentId === id && source === "mp3") {
      const audio = audioRef.current;
      if (!audio) return;
      if (playing) {
        audio.pause();
        setPlaying(false);
        return;
      }
      try {
        await audio.play();
        setPlaying(true);
      } catch {
        toast("Playback blocked. Click play again.");
      }
      return;
    }
    await selectTrack(id, true);
  }

  function stopAll() {
    setPlaying(false);
    stopTrackerTune();
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    setProgress(0);
  }

  function step(delta: number) {
    if (source === "demo" || !tracks.length) return;
    const base = currentIndex >= 0 ? currentIndex : 0;
    const next = tracks[(base + delta + tracks.length) % tracks.length];
    if (next) void selectTrack(next.id, playing);
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setImporting(true);
    try {
      const added: TapeTrackMeta[] = [];
      for (const file of Array.from(files)) {
        added.push(await addTapeTrack(file));
      }
      const rows = await listTapeTracks();
      setTracks(rows);
      if (!currentId && added[0]) await selectTrack(added[0].id, false);
      toast(`${added.length} track${added.length === 1 ? "" : "s"} loaded onto tape.`);
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : "Import failed.");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function cutTrack(id: string) {
    try {
      await removeTapeTrack(id);
      const rows = await listTapeTracks();
      setTracks(rows);
      if (currentId === id) {
        revokeUrl();
        setCurrentId(null);
        setPlaying(false);
        setProgress(0);
        setDuration(0);
        if (audioRef.current) audioRef.current.removeAttribute("src");
      }
      toast("Track cut from tape.");
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : "Could not remove track.");
    }
  }

  function useDemo() {
    revokeUrl();
    audioRef.current?.pause();
    setSource("demo");
    setCurrentId(null);
    setProgress(0);
    setDuration(0);
  }

  const statusLabel = source === "demo"
    ? playing ? "DEMO · playing" : "DEMO · stopped"
    : currentTrack
      ? `${playing ? "▶" : "⏸"} ${currentTrack.name}`
      : tracks.length ? "ARM a track" : "empty tape";

  return <>
    <div className="tape-bar">
      <button type="button" className={`chip tape-toggle ${open ? "on" : ""}`} onClick={onToggle} aria-expanded={open}>
        TAPE {live ? "▶" : "⏸"}
      </button>
      <button type="button" className="ico tape-ico" title={playing ? "Pause" : "Play"} aria-label={playing ? "Pause tape" : "Play tape"} onClick={() => void togglePlay()}>
        {playing ? <svg viewBox="0 0 14 14"><rect x="3" y="2" width="3" height="10" /><rect x="8" y="2" width="3" height="10" /></svg> : <svg viewBox="0 0 14 14"><path d="M3 1v12l10-6z" /></svg>}
      </button>
      <button type="button" className="ico tape-ico stop" title="Stop" aria-label="Stop tape" onClick={stopAll}>
        <svg viewBox="0 0 14 14"><rect x="3" y="3" width="8" height="8" /></svg>
      </button>
      <span className="tape-status">{statusLabel}</span>
      <span className="tape-time">{formatTapeTime(progress)}{duration ? ` / ${formatTapeTime(duration)}` : ""}</span>
    </div>
    {open && <section className="tape-deck" aria-label="Tape deck">
      <div className="tape-deck__head">
        <strong>TAPE DECK</strong>
        <span>local MP3 · stored in browser</span>
        <label className="tape-load">
          <input ref={fileRef} type="file" accept="audio/mpeg,audio/mp3,.mp3" multiple hidden onChange={(event) => void onFiles(event.target.files)} />
          <span className="disk-action">{importing ? "Loading…" : "+ Load MP3"}</span>
        </label>
      </div>
      <div className="tape-deck__transport">
        <button type="button" className="tape-btn" onClick={() => step(-1)} disabled={!tracks.length || source === "demo"}>⏮</button>
        <button type="button" className="tape-btn tape-btn--play" onClick={() => void togglePlay()}>{playing ? "⏸" : "▶"}</button>
        <button type="button" className="tape-btn" onClick={() => step(1)} disabled={!tracks.length || source === "demo"}>⏭</button>
        <input
          className="tape-scrub"
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(progress, duration || 0)}
          disabled={source === "demo" || !duration}
          onChange={(event) => {
            const next = Number(event.target.value);
            setProgress(next);
            if (audioRef.current) audioRef.current.currentTime = next;
          }}
        />
        <label className="tape-vol">
          <span>VOL</span>
          <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(event) => setVolume(Number(event.target.value))} />
        </label>
      </div>
      <div className="tape-deck__body">
        <button type="button" className={`tape-row tape-row--demo ${source === "demo" ? "on" : ""}`} onClick={() => { useDemo(); setPlaying(false); }}>
          <span className="tape-row__hex">D0</span>
          <span className="tape-row__name">Demo loop</span>
          <span className="tape-row__meta">chiptune · built-in</span>
        </button>
        {loading ? <p className="empty">Reading tape library…</p> : tracks.length === 0 ? (
          <p className="empty">No MP3 on tape yet. Load one or more files — they stay on this machine.</p>
        ) : tracks.map((track, index) => (
          <div className={`tape-row ${currentId === track.id && source === "mp3" ? "on" : ""}`} key={track.id}>
            <button type="button" className="tape-row__main" onClick={() => void armTrack(track.id)}>
              <span className="tape-row__hex">{(index + 1).toString(16).toUpperCase().padStart(2, "0")}</span>
              <span className="tape-row__name">{track.name}</span>
              <span className="tape-row__meta">{formatTapeTime(track.duration)}</span>
            </button>
            <button type="button" className="tape-row__cut" aria-label={`Remove ${track.name}`} onClick={() => void cutTrack(track.id)}>×</button>
          </div>
        ))}
      </div>
    </section>}
  </>;
}
