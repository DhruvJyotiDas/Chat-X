import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { IBUser } from '../types';
import { api, ApiUser } from '../lib/api';

interface AuthContextType {
  currentUser: IBUser | null;
  allUsers: IBUser[];
  isLoading: boolean;
  login: (email: string, password: string) => Promise<IBUser>;
  signup: (username: string, displayName: string, email: string, password: string, avatar?: string) => Promise<IBUser>;
  logout: () => void;
  updateUser: (updates: Partial<IBUser>) => void;
  updateProfile: (fields: { displayName?: string; bio?: string; avatar?: string }) => Promise<IBUser>;
  getUserById: (id: string) => IBUser | undefined;
}

const AuthContext = createContext<AuthContextType | null>(null);

const JWT_KEY = 'ibconnect_jwt';
const USER_KEY = 'ibconnect_me';

function toIBUser(u: ApiUser): IBUser {
  return { ...u, status: (u.status as IBUser['status']) ?? 'offline' };
}

function saveSession(token: string, user: ApiUser) {
  localStorage.setItem(JWT_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem(JWT_KEY);
  localStorage.removeItem(USER_KEY);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [currentUser, setCurrentUser] = useState<IBUser | null>(null);
  const [allUsers, setAllUsers] = useState<IBUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // On mount: restore session from stored JWT
  useEffect(() => {
    const jwt = localStorage.getItem(JWT_KEY);
    const cached = localStorage.getItem(USER_KEY);
    if (!jwt) { setIsLoading(false); return; }

    // Optimistically load cached user while verifying token
    if (cached) {
      try { setCurrentUser(toIBUser(JSON.parse(cached) as ApiUser)); } catch {}
    }

    api.me()
      .then(u => {
        setCurrentUser(toIBUser(u));
        localStorage.setItem(USER_KEY, JSON.stringify(u));
        // Also fetch full user list
        return api.getUsers();
      })
      .then(users => setAllUsers(users.map(toIBUser)))
      .catch(() => {
        // Token expired or invalid
        clearSession();
        setCurrentUser(null);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const signup = useCallback(async (
    username: string, displayName: string, email: string, password: string, avatar?: string,
  ): Promise<IBUser> => {
    const { token, user } = await api.signup(username, displayName, email, password, avatar);
    saveSession(token, user);
    const ibUser = toIBUser(user);
    setCurrentUser(ibUser);
    // Refresh user list
    api.getUsers().then(users => setAllUsers(users.map(toIBUser))).catch(() => {});
    return ibUser;
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<IBUser> => {
    const { token, user } = await api.login(email, password);
    saveSession(token, user);
    const ibUser = toIBUser(user);
    setCurrentUser(ibUser);
    api.getUsers().then(users => setAllUsers(users.map(toIBUser))).catch(() => {});
    return ibUser;
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setCurrentUser(null);
    setAllUsers([]);
  }, []);

  const updateProfile = useCallback(async (fields: { displayName?: string; bio?: string; avatar?: string }): Promise<IBUser> => {
    const updated = await api.updateProfile(fields);
    const ibUser = toIBUser(updated);
    setCurrentUser(ibUser);
    localStorage.setItem(USER_KEY, JSON.stringify(updated));
    setAllUsers(prev => prev.map(u => u.id === ibUser.id ? ibUser : u));
    return ibUser;
  }, []);

  const updateUser = useCallback((updates: Partial<IBUser>) => {
    setCurrentUser(prev => {
      if (!prev) return null;
      const updated = { ...prev, ...updates };
      localStorage.setItem(USER_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  // getUserById: checks allUsers first, then fetches from API
  const getUserById = useCallback((id: string): IBUser | undefined => {
    return allUsers.find(u => u.id === id);
  }, [allUsers]);

  // Update allUsers list when status events arrive via ChatContext (forwarded externally)
  const updateUserStatus = useCallback((userId: string, status: string) => {
    setAllUsers(prev => prev.map(u => u.id === userId ? { ...u, status: status as IBUser['status'] } : u));
    setCurrentUser(prev => prev?.id === userId ? { ...prev, status: status as IBUser['status'] } : prev);
  }, []);

  // Expose updateUserStatus on the context via a ref so ChatContext can call it
  (AuthProvider as unknown as { _updateStatus?: typeof updateUserStatus })._updateStatus = updateUserStatus;

  return (
    <AuthContext.Provider value={{ currentUser, allUsers, isLoading, login, signup, logout, updateUser, updateProfile, getUserById }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}

export function getStoredJWT(): string {
  return localStorage.getItem(JWT_KEY) ?? '';
}
