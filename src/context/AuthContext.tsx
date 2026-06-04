import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { IBUser } from '../types';

interface AuthContextType {
  currentUser: IBUser | null;
  allUsers: IBUser[];
  isLoading: boolean;
  login: (email: string, password: string) => Promise<IBUser>;
  signup: (username: string, displayName: string, email: string, password: string, avatar?: string) => Promise<IBUser>;
  logout: () => void;
  updateUser: (updates: Partial<IBUser>) => void;
  getUserById: (id: string) => IBUser | undefined;
}

const AuthContext = createContext<AuthContextType | null>(null);

const USERS_KEY = 'ibconnect_users';
const SESSION_KEY = 'ibconnect_session';
const PASSWORDS_KEY = 'ibconnect_passwords';

function loadUsers(): IBUser[] {
  try { return JSON.parse(localStorage.getItem(USERS_KEY) || '[]'); } catch { return []; }
}
function saveUsers(users: IBUser[]) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
  // Broadcast user list update
  try {
    const ch = new BroadcastChannel('ibconnect_realtime');
    ch.postMessage({ type: 'users_updated', users });
    ch.close();
  } catch {}
}
function loadPasswords(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(PASSWORDS_KEY) || '{}'); } catch { return {}; }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [currentUser, setCurrentUser] = useState<IBUser | null>(null);
  const [allUsers, setAllUsers] = useState<IBUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Listen for user list updates from other tabs
  useEffect(() => {
    let ch: BroadcastChannel | null = null;
    try {
      ch = new BroadcastChannel('ibconnect_realtime');
      ch.onmessage = (e) => {
        if (e.data?.type === 'users_updated') {
          setAllUsers(e.data.users);
          // Update current user status if changed
          if (currentUser) {
            const updated = e.data.users.find((u: IBUser) => u.id === currentUser.id);
            if (updated) setCurrentUser(updated);
          }
        }
      };
    } catch {}
    return () => ch?.close();
  }, [currentUser]);

  useEffect(() => {
    const users = loadUsers();
    setAllUsers(users);

    const sessionStr = localStorage.getItem(SESSION_KEY);
    if (sessionStr) {
      try {
        const session = JSON.parse(sessionStr);
        const user = users.find(u => u.id === session.userId);
        if (user) {
          const online = { ...user, status: 'online' as const };
          setCurrentUser(online);
          // Persist online status
          const updated = users.map(u => u.id === user.id ? online : u);
          saveUsers(updated);
          setAllUsers(updated);
        }
      } catch {}
    }
    setIsLoading(false);
  }, []);

  const signup = useCallback(async (
    username: string,
    displayName: string,
    email: string,
    password: string,
    avatar?: string
  ): Promise<IBUser> => {
    const users = loadUsers();
    if (users.find(u => u.email === email.toLowerCase())) throw new Error('Email already registered');
    if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) throw new Error('Username already taken');

    const newUser: IBUser = {
      id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      username: username.toLowerCase(),
      displayName: displayName.trim(),
      email: email.toLowerCase(),
      avatar,
      status: 'online',
      createdAt: new Date().toISOString(),
    };

    const passwords = loadPasswords();
    passwords[newUser.id] = password;
    localStorage.setItem(PASSWORDS_KEY, JSON.stringify(passwords));

    const updatedUsers = [...users, newUser];
    saveUsers(updatedUsers);
    setAllUsers(updatedUsers);

    // Set cookie-style persistent session
    document.cookie = `ibconnect_session=${newUser.id}; max-age=2592000; path=/; SameSite=Strict`;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ userId: newUser.id }));
    setCurrentUser(newUser);
    return newUser;
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<IBUser> => {
    const users = loadUsers();
    const user = users.find(u => u.email === email.toLowerCase());
    if (!user) throw new Error('No account found with this email');

    const passwords = loadPasswords();
    if (passwords[user.id] !== password) throw new Error('Incorrect password');

    const online = { ...user, status: 'online' as const };
    const updated = users.map(u => u.id === user.id ? online : u);
    saveUsers(updated);
    setAllUsers(updated);

    document.cookie = `ibconnect_session=${user.id}; max-age=2592000; path=/; SameSite=Strict`;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ userId: user.id }));
    setCurrentUser(online);
    return online;
  }, []);

  const logout = useCallback(() => {
    if (currentUser) {
      const users = loadUsers();
      const updated = users.map(u => u.id === currentUser.id ? { ...u, status: 'offline' as const } : u);
      saveUsers(updated);
    }
    document.cookie = 'ibconnect_session=; max-age=0; path=/';
    localStorage.removeItem(SESSION_KEY);
    setCurrentUser(null);
  }, [currentUser]);

  const updateUser = useCallback((updates: Partial<IBUser>) => {
    if (!currentUser) return;
    const users = loadUsers();
    const updated = users.map(u => u.id === currentUser.id ? { ...u, ...updates } : u);
    saveUsers(updated);
    setAllUsers(updated);
    setCurrentUser(prev => prev ? { ...prev, ...updates } : null);
  }, [currentUser]);

  const getUserById = useCallback((id: string) => {
    return loadUsers().find(u => u.id === id);
  }, []);

  return (
    <AuthContext.Provider value={{ currentUser, allUsers, isLoading, login, signup, logout, updateUser, getUserById }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}

// Helper for other contexts to read current user without hook
export function getAuthUser(): IBUser | null {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!session?.userId) return null;
    const users: IBUser[] = JSON.parse(localStorage.getItem(USERS_KEY) || '[]');
    return users.find(u => u.id === session.userId) || null;
  } catch { return null; }
}
