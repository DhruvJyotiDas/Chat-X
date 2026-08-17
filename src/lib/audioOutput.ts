// Speaker (audio output) routing.
//
// The settings sheet has always had a Speaker dropdown, but its handler only ever
// called setSelectedSpeaker — React state and nothing else. There was no setSinkId
// call anywhere in the app, so picking a headset changed the label in the dropdown
// and left the audio coming out of wherever it already was. A control that lies.
//
// Output routing can't be done once at the point of selection either: a call mounts
// one <audio> per peer, they come and go as people join and leave, and the floating
// window mounts a second set of its own. Any element created *after* the user picked
// a device would come up on the system default. So elements register here and the
// module applies the current preference to each of them, including on future changes.

const SPEAKER_KEY = 'ibconnect_speaker_id';

/** `setSinkId` is not in lib.dom for every TS version, and is absent in some browsers. */
type SinkCapable = HTMLMediaElement & { setSinkId?: (deviceId: string) => Promise<void> };

const registered = new Set<SinkCapable>();

function load(): string {
  try { return localStorage.getItem(SPEAKER_KEY) ?? ''; } catch { return ''; }
}

let preferred = load();

/**
 * Firefox only shipped setSinkId recently and Safari still has not, so the picker
 * has to be hidden rather than left present and inert — which is the bug this
 * module exists to fix, and it would be perverse to reintroduce it as a fallback.
 */
export function isSpeakerSelectionSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof (HTMLMediaElement.prototype as SinkCapable).setSinkId === 'function';
}

/** Empty string means "system default", which is also what setSinkId('') selects. */
export function getPreferredSpeaker(): string {
  return preferred;
}

async function applyTo(el: SinkCapable, deviceId: string): Promise<void> {
  if (typeof el.setSinkId !== 'function') return;
  try {
    await el.setSinkId(deviceId);
  } catch (err) {
    const name = (err as { name?: string })?.name;
    // The saved device has been unplugged since it was chosen. Fall back to the
    // system default and forget it, otherwise every element mounted from here on
    // throws the same error and the user has no way to recover except clearing
    // storage by hand.
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      if (preferred !== '') {
        preferred = '';
        try { localStorage.removeItem(SPEAKER_KEY); } catch { /* private mode */ }
        await el.setSinkId('').catch(() => {});
      }
      return;
    }
    // NotAllowedError means output selection needs a permission the user hasn't
    // granted. Nothing to do but stay on the default.
    console.warn('[audioOutput] setSinkId failed:', name ?? err);
  }
}

/**
 * Route every registered element to `deviceId` and remember the choice.
 * Resolves once each element has been retargeted (or failed independently).
 */
export async function setPreferredSpeaker(deviceId: string): Promise<void> {
  preferred = deviceId;
  try {
    if (deviceId) localStorage.setItem(SPEAKER_KEY, deviceId);
    else localStorage.removeItem(SPEAKER_KEY);
  } catch { /* private mode — the choice just won't survive a reload */ }

  await Promise.all([...registered].map((el) => applyTo(el, deviceId)));
}

/**
 * Attach an element to the shared output preference for as long as it is mounted.
 * Returns the unregister function, so this drops straight into a useEffect.
 */
export function registerAudioSink(el: HTMLMediaElement | null): () => void {
  if (!el) return () => {};
  const sink = el as SinkCapable;
  registered.add(sink);
  void applyTo(sink, preferred);
  return () => { registered.delete(sink); };
}
