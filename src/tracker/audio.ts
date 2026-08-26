let audio: AudioContext | null = null;
let timer = 0;

export function startTrackerTune() {
  stopTrackerTune();
  const Ctx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  audio = new Ctx();
  const master = audio.createGain();
  master.gain.value = 0.03;
  master.connect(audio.destination);
  const seq = [523.25, 659.25, 783.99, 659.25, 587.33, 523.25, 392, 523.25];
  let i = 0;
  const tick = () => {
    if (!audio) return;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "square";
    osc.frequency.value = seq[i % seq.length];
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(1, audio.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.09);
    osc.connect(gain);
    gain.connect(master);
    osc.start();
    osc.stop(audio.currentTime + 0.1);
    i += 1;
    timer = window.setTimeout(tick, 110);
  };
  void audio.resume().then(tick);
}

export function stopTrackerTune() {
  window.clearTimeout(timer);
  if (audio) {
    void audio.close();
    audio = null;
  }
}

export function drawSquareWave(canvas: HTMLCanvasElement, live: boolean, now: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#07070b";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = live ? "#6dff9a" : "#2c2c3a";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < canvas.width; x += 1) {
    const duty = ((x + now / 8) % 16) < 8 ? 1 : -1;
    const y = canvas.height / 2 + duty * (live ? 8 : 3);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
