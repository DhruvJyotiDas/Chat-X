import { diag } from './diagnostics';
import type {
  InterviewProfile, InterviewSession, InterviewAnswer,
  InterviewReport, InterviewEngineStatus, Seniority, InterviewKind,
} from '../types';

const BASE = '/api/interview';

function token(): string {
  return localStorage.getItem('ibconnect_jwt') ?? '';
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const started = performance.now();
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // nginx 413/502 pages are HTML, not JSON — say something useful rather than
    // surfacing a parse error.
    if (res.status === 413) throw new Error('That recording was too large to upload. Try a shorter answer.');
    if (res.status === 502 || res.status === 503) throw new Error('The interview service is unavailable right now.');
    throw new Error(`Server error (${res.status})`);
  }

  const ms = Math.round(performance.now() - started);
  if (!res.ok) {
    const msg = (json as { error?: string })?.error ?? `HTTP ${res.status}`;
    diag('media', 'error', `interview ${method} ${path} failed`, { status: res.status, ms, msg });
    throw new Error(msg);
  }
  diag('media', 'info', `interview ${method} ${path}`, { status: res.status, ms });
  return json as T;
}

export const interviewApi = {
  /** Whether the GPU machine is connected and loaded. Cheap; safe to poll. */
  status: () => request<InterviewEngineStatus>('GET', '/status'),

  /** Most recent parsed CV for this user, or null. */
  currentProfile: () => request<InterviewProfile | null>('GET', '/profile'),

  uploadCV: (fileName: string, dataB64: string) =>
    request<InterviewProfile>('POST', '/cv', { fileName, dataB64 }),

  createSession: (opts: {
    profileId: string; role: string; seniority: Seniority; kind: InterviewKind; count: number;
  }) => request<InterviewSession>('POST', '/sessions', opts),

  listSessions: () => request<InterviewSession[]>('GET', '/sessions'),

  getSession: (id: string) => request<InterviewSession>('GET', `/sessions/${id}`),

  submitAnswer: (sessionId: string, payload: {
    questionId: string; audioWavB64?: string; framesB64?: string[];
    durationSec: number; transcript?: string;
  }) => request<InterviewAnswer>('POST', `/sessions/${sessionId}/answer`, payload),

  finish: (sessionId: string) =>
    request<InterviewReport>('POST', `/sessions/${sessionId}/finish`),
};

/** Reads a File as base64 without the data: prefix. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? '');
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    r.onerror = () => reject(new Error('Could not read that file'));
    r.readAsDataURL(file);
  });
}
