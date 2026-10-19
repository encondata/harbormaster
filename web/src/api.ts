// Thin fetch wrapper. Every write carries the CSRF header the API requires for cookie sessions.

export class ApiError extends Error {
  constructor(public status: number, message: string, public code: string) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} as Record<string, string> };
  const headers = init.headers as Record<string, string>;
  if (method !== 'GET') headers['x-hsl-csrf'] = '1';
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error ?? res.statusText, data?.code ?? 'error');
    if (res.status === 401 && !url.endsWith('/auth/login')) window.dispatchEvent(new Event('hsl:unauthorized'));
    if (err.code === 'password_change_required') window.dispatchEvent(new Event('hsl:password-change'));
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T,>(url: string) => request<T>('GET', url),
  post: <T,>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  patch: <T,>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T,>(url: string, body: unknown) => request<T>('PUT', url, body),
  del: <T,>(url: string) => request<T>('DELETE', url),
};

export const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

// ---------- Types ----------

export type FieldDef = { key: string; label: string; type: 'text' | 'longtext' | 'bool' | 'number' | 'date' | 'url' | 'select'; options?: string[] };

export type Column = { id: string; board_id: string; name: string; sort: number; color: string; category: 'todo' | 'active' | 'done' | 'closed'; parity_weight: number | null; wip_limit: number | null; card_count: number };

export type Board = { id: string; key: string; name: string; description: string; sort: number; field_defs: FieldDef[]; parity_enabled: boolean; archived_at: string | null; card_count: number; columns: Column[] };

export type Area = { id: string; name: string; sort: number; priority: string; expected_date: string; notes: string; updated_at: string };

export type Project = { id: string; key: string; name: string; description: string; archived_at: string | null; permissions: string[]; boards: Board[]; areas: Area[]; requests: { new: number; open: number } };

export type ProjectListItem = { id: string; key: string; name: string; description: string; archived_at: string | null; my_role: string | null; card_count: number; member_count: number };

export type Me = {
  id: string; email: string; name: string; kind: string; must_change_password: boolean; last_login_at: string | null; avatar_updated_at: string | null;
  global_roles: { id: string; name: string }[]; global_permissions: string[]; projects: ProjectListItem[];
};

export type Card = {
  id: string; key: string; number: number; project_id: string; board_id: string; column_id: string; column_name: string;
  title: string; description: string; area_id: string | null; area_name: string | null; priority: Priority | null;
  assignee_id: string | null; assignee_name: string | null; tags: string[]; fields: Record<string, any>; estimate: string;
  due_date: string | null; sort: number; external_key: string | null; created_at: string; updated_at: string; archived_at: string | null;
  created_by_name: string | null; updated_by_name: string | null; comment_count: number; attachment_count: number;
};

export type Priority = 'critical' | 'high' | 'medium' | 'low';
export const PRIORITIES: Priority[] = ['critical', 'high', 'medium', 'low'];

export type AuditItem = {
  id: number; at: string; actor_id: string | null; actor_name: string; via: string; ip: string | null; action: string; entity_type: string;
  entity_id: string | null; project_id: string | null; project_key: string | null; summary: string; changes: any; token_name: string | null;
};

export type Role = { id: string; name: string; description: string; scope: 'global' | 'project'; permissions: string[]; is_builtin: boolean; assignments: number };

export type Token = { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null; connector?: string | null };

export type Update = { id: string; title: string; period_start: string | null; period_end: string | null; body: string; hours: number | null; hours_note: string; created_at: string; updated_at: string; created_by_name: string | null; updated_by_name: string | null };

export type AdminUser = {
  id: string; email: string; name: string; kind: 'human' | 'service'; is_active: boolean; must_change_password: boolean; last_login_at: string | null; created_at: string;
  global_roles: { id: string; name: string }[]; projects: { project_id: string; project_key: string; project_name: string; role_id: string; role_name: string }[];
  active_tokens: number; active_sessions: number; google_linked: boolean; avatar_updated_at: string | null; job_title: string;
};

export type RequestStatus = 'new' | 'reviewing' | 'accepted' | 'declined' | 'duplicate';

export type FeatureRequest = {
  id: string; project_id: string; key: string; number: number; title: string; description: string; status: RequestStatus;
  area_id: string | null; area_name: string | null; requested_by: string | null; requested_by_name: string | null; requested_by_kind: string | null;
  requested_for: string; card_id: string | null; card_key: string | null; card_title: string | null; card_column: string | null; card_board_key: string | null;
  duplicate_of: string | null; duplicate_key: string | null; duplicate_title: string | null; decision_note: string;
  decided_by_name: string | null; decided_at: string | null; created_at: string; updated_at: string; votes: number; comment_count: number; voted?: boolean;
};
