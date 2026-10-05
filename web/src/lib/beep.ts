/**
 * A short two-tone chime synthesised with WebAudio — no audio asset to ship.
 * Browsers keep an AudioContext suspended until the page has seen a user
 * gesture; by the time an urgent Gazeta item arrives the user has almost
 * always clicked something, and if not, resume() just fails silently.
 */
let ctx: AudioContext | null = null;

export function beep(): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    void ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = now + i * 0.12;
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.15, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.12);
    }
  } catch {
    // No audio is fine — the badge still shows.
  }
}
