import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { api, ApiError, type Me } from '../api';

type AuthState = { me: Me | null; loading: boolean; can: (perm: string) => boolean; refresh: () => void };
const AuthContext = createContext<AuthState>({ me: null, loading: true, can: () => false, refresh: () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Me>('/api/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
  useEffect(() => {
    const onUnauth = () => qc.setQueryData(['me'], null);
    window.addEventListener('hsl:unauthorized', onUnauth);
    return () => window.removeEventListener('hsl:unauthorized', onUnauth);
  }, [qc]);
  const me = q.data ?? null;
  return (
    <AuthContext.Provider value={{ me, loading: q.isLoading, can: (p) => !!me?.global_permissions.includes(p), refresh: () => qc.invalidateQueries({ queryKey: ['me'] }) }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
