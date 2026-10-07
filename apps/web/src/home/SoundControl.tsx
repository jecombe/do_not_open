import { setMuted, setVolume, useSoundSettings } from "./sound";

export interface SoundLabels {
  /** Names the row for screen readers. */
  group: string;
  /** On the speaker while the sound plays: what a click does. */
  mute: string;
  /** On the speaker while the sound is off. */
  unmute: string;
  /** The slider's name. */
  volume: string;
}

/**
 * A speaker that cuts every sound, and a slider for the music's volume. It lives in the menus,
 * the home page's and the game's, so on a phone it takes no room of its own.
 */
export function SoundControl({ labels }: { labels: SoundLabels }) {
  const { muted, volume } = useSoundSettings();
  const silent = muted || volume === 0;
  return (
    <div className="sound-control" role="group" aria-label={labels.group}>
      <button type="button" className="sound-speaker" aria-pressed={muted} aria-label={muted ? labels.unmute : labels.mute} title={muted ? labels.unmute : labels.mute} onClick={() => setMuted(!muted)}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 9h4l5-4v14l-5-4H3z" fill="currentColor" />
          {silent ? (
            <path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          ) : (
            <>
              <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              {volume > 0.5 && <path d="M18 7a7 7 0 0 1 0 10" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />}
            </>
          )}
        </svg>
      </button>
      <input
        type="range"
        className="sound-volume"
        min={0}
        max={100}
        step={5}
        value={muted ? 0 : Math.round(volume * 100)}
        aria-label={labels.volume}
        aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
        onChange={(e) => setVolume(Number(e.target.value) / 100)}
      />
    </div>
  );
}
