// Persisted camera/mic/speaker choices, and a device list that stays current.
//
// Two problems this fixes. First, device selections lived in ActiveMeetingView's
// component state, so they reset on every call — a user on a headset had to reopen
// settings and reselect it each time. Second, enumerateDevices() was called exactly
// once, lazily, only when the settings sheet opened, and nothing listened for
// `devicechange`: plugging in a headset mid-call did nothing at all until you
// reopened settings, and unplugging one left a dead entry selected in the list.

import { getPreferredSpeaker, setPreferredSpeaker } from './audioOutput';

const CAMERA_KEY = 'ibconnect_camera_id';
const MIC_KEY = 'ibconnect_mic_id';

export interface DevicePrefs {
  cameraId: string;
  micId: string;
  speakerId: string;
}

function read(key: string): string {
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}

function write(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* private mode */ }
}

/** Read once, synchronously — the pre-join screen needs these before it asks for media. */
export function loadDevicePrefs(): DevicePrefs {
  return { cameraId: read(CAMERA_KEY), micId: read(MIC_KEY), speakerId: getPreferredSpeaker() };
}

export function saveCameraId(id: string) { write(CAMERA_KEY, id); }
export function saveMicId(id: string) { write(MIC_KEY, id); }

/**
 * Turn a saved device id into a getUserMedia constraint.
 *
 * Deliberately `ideal`, not `exact`: a saved id that no longer resolves (the headset
 * is at home, the browser rotated its device ids after a permissions reset) would make
 * an `exact` constraint reject the whole getUserMedia call with OverconstrainedError,
 * and the user would be told their camera is unavailable when it is sitting right
 * there. `ideal` degrades to the default device instead, which is what someone
 * plugging in a different laptop actually wants.
 */
export function deviceConstraint(id: string): MediaTrackConstraints | true {
  return id ? { deviceId: { ideal: id } } : true;
}

export type DeviceKind = 'videoinput' | 'audioinput' | 'audiooutput';

export interface DeviceSnapshot {
  videoDevices: MediaDeviceInfo[];
  audioDevices: MediaDeviceInfo[];
  outputDevices: MediaDeviceInfo[];
  /** False until the first successful enumerate — treat missing devices as unknown, not absent. */
  synced: boolean;
}

export const EMPTY_SNAPSHOT: DeviceSnapshot = {
  videoDevices: [], audioDevices: [], outputDevices: [], synced: false,
};

export async function enumerate(): Promise<DeviceSnapshot> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      videoDevices: devices.filter((d) => d.kind === 'videoinput'),
      audioDevices: devices.filter((d) => d.kind === 'audioinput'),
      outputDevices: devices.filter((d) => d.kind === 'audiooutput'),
      synced: true,
    };
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

/**
 * Subscribe to device list changes. The callback fires once immediately with the
 * current list, then again on every `devicechange`.
 *
 * Note that labels are empty strings until some media permission has been granted —
 * that is a privacy rule, not a bug, so the picker shows "Device abc12345" until the
 * user has allowed the camera or mic at least once.
 */
export function watchDevices(onChange: (snapshot: DeviceSnapshot) => void): () => void {
  let cancelled = false;

  const refresh = () => {
    void enumerate().then((snapshot) => { if (!cancelled) onChange(snapshot); });
  };

  refresh();
  navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
  return () => {
    cancelled = true;
    navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
  };
}

/**
 * Pick which device id a control should show as selected.
 *
 * A saved id that is no longer in the list must not be rendered as the current value —
 * the <select> would fall back to showing its first option while the app still believed
 * the saved device was active, so the label and the actual routing would disagree.
 */
export function resolveSelection(savedId: string, devices: MediaDeviceInfo[]): string {
  if (savedId && devices.some((d) => d.deviceId === savedId)) return savedId;
  return devices[0]?.deviceId ?? '';
}

/** Re-apply the stored speaker choice — used at pre-join, before any peer audio exists. */
export async function restoreSpeaker(): Promise<void> {
  const id = getPreferredSpeaker();
  if (id) await setPreferredSpeaker(id);
}
