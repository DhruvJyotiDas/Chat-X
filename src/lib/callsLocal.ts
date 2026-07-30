import { CallRecord } from '../types';

const key = (userId: string) => `ibconnect_calls_${userId}`;

export function loadCalls(userId: string): CallRecord[] {
  try { return JSON.parse(localStorage.getItem(key(userId)) || '[]'); } catch { return []; }
}

export function saveCalls(userId: string, calls: CallRecord[]) {
  localStorage.setItem(key(userId), JSON.stringify(calls));
}
