const MUSIC_VOLUME = 0.5;
const DUCKED_VOLUME = 0.18;
const FADE_MS = 1400;

export interface GameAudio {
  setMusic(p1Url: string, p2Url: string): void;
  /** Start (or crossfade to) the loop for a phase; safe to call before setMusic — it starts once music lands. */
  playPhase(phase: 1 | 2): void;
  setVoice(files: Record<string, string>): void;
  /** Play a spoken line by name (`intro`, `taunt1`…); music ducks while the boss speaks. Unknown names are ignored. */
  speak(name: string): void;
  stopMusic(): void;
}

const fadeTo = (audio: HTMLAudioElement, target: number, ms: number, onDone?: () => void) => {
  const start = audio.volume;
  const startedAt = performance.now();
  const tick = (now: number) => {
    const t = Math.min(1, (now - startedAt) / ms);
    audio.volume = start + (target - start) * t;
    if (t < 1) requestAnimationFrame(tick); else onDone?.();
  };
  requestAnimationFrame(tick);
};

export function createGameAudio(): GameAudio {
  const loops: Record<1 | 2, HTMLAudioElement | null> = { 1: null, 2: null };
  const voices = new Map<string, HTMLAudioElement>();
  let wantedPhase: 1 | 2 | null = null;
  let playing: 1 | 2 | null = null;
  let speaking: HTMLAudioElement | null = null;

  const musicTarget = () => (speaking ? DUCKED_VOLUME : MUSIC_VOLUME);

  const playPhase = (phase: 1 | 2) => {
    wantedPhase = phase;
    const next = loops[phase];
    if (!next || playing === phase) return;
    const previous = playing ? loops[playing] : null;
    playing = phase;
    next.currentTime = 0;
    next.volume = 0;
    void next.play().catch(() => undefined);
    fadeTo(next, musicTarget(), FADE_MS);
    if (previous) fadeTo(previous, 0, FADE_MS, () => previous.pause());
  };

  const speak = (name: string) => {
    const line = voices.get(name);
    if (!line) return;
    speaking?.pause();
    speaking = line;
    line.currentTime = 0;
    const current = playing ? loops[playing] : null;
    if (current) fadeTo(current, DUCKED_VOLUME, 250);
    line.onended = () => {
      if (speaking !== line) return;
      speaking = null;
      const loop = playing ? loops[playing] : null;
      if (loop) fadeTo(loop, MUSIC_VOLUME, 600);
    };
    void line.play().catch(() => undefined);
  };

  return {
    setMusic(p1Url, p2Url) {
      for (const phase of [1, 2] as const) {
        loops[phase]?.pause();
        const audio = new Audio(phase === 1 ? p1Url : p2Url);
        audio.loop = true;
        audio.preload = "auto";
        audio.crossOrigin = "anonymous";
        loops[phase] = audio;
      }
      playing = null;
      if (wantedPhase) playPhase(wantedPhase);
    },
    playPhase,
    setVoice(files) {
      voices.clear();
      for (const [name, url] of Object.entries(files)) {
        const audio = new Audio(url);
        audio.preload = "auto";
        audio.crossOrigin = "anonymous";
        voices.set(name, audio);
      }
    },
    speak,
    stopMusic() {
      wantedPhase = null;
      const current = playing ? loops[playing] : null;
      playing = null;
      if (current) fadeTo(current, 0, FADE_MS, () => current.pause());
    },
  };
}
