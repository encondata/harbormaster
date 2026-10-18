import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import AuditList from '../components/AuditList';
import { applyTheme, useTheme, type Theme } from '../components/Layout';
import Tokens from '../components/Tokens';
import { Avatar, ErrorBox, Modal, Spinner, useToast } from '../components/ui';
import { useAuth } from '../lib/auth';
import { dateTime, shortDate, timeAgo } from '../lib/format';
import { PasswordForm } from './ChangePassword';

type Profile = {
  id: string; email: string; name: string; kind: string; is_active: boolean; created_at: string; last_login_at: string | null;
  password_changed_at: string | null; avatar_updated_at: string | null; has_password: boolean; google_linked: boolean;
  first_name: string; last_name: string; preferred_name: string; job_title: string; contact_email: string; phone: string;
  address_line1: string; address_line2: string; city: string; region: string; postal_code: string; country: string;
  global_roles: string[]; project_roles: string[];
};
type Details = Pick<Profile, 'first_name' | 'last_name' | 'preferred_name' | 'job_title' | 'contact_email' | 'phone' | 'address_line1' | 'address_line2' | 'city' | 'region' | 'postal_code' | 'country'>;

const TABS = [['profile', 'Profile'], ['preferences', 'Preferences'], ['notifications', 'Notifications'], ['history', 'History']] as const;
export type ProfileTab = (typeof TABS)[number][0];
export const PROFILE_TAB_LABEL: Record<string, string> = Object.fromEntries(TABS);

const ICON = { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

function Banner({ p, onChanged }: { p: Profile; onChanged: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const roles = [...p.global_roles, ...p.project_roles].map((r) => r.toLowerCase()).filter((r, i, a) => a.indexOf(r) === i);
  const place = [p.city, p.region].filter(Boolean).join(', ');
  const upload = async (f: File) => {
    setErr(null);
    if (f.size > 8 * 1024 * 1024) return setErr(new Error(`That photo is ${(f.size / 1048576).toFixed(1)} MB. Choose one under 8 MB.`));
    setBusy(true);
    const fd = new FormData();
    fd.append('file', f);
    try {
      await api.post('/api/me/avatar', fd);
      onChanged();
      toast('Photo updated');
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card-box profile-banner">
      <div className="profile-band" aria-hidden="true" />
      <div className="profile-head">
        <div className="profile-photo">
          <Avatar name={p.name} userId={p.id} photoAt={p.avatar_updated_at} size={128} />
          <button type="button" className="profile-photo-edit" disabled={busy} onClick={() => fileRef.current?.click()} aria-label="Change photo">
            {busy ? 'Uploading…' : 'Change photo'}
          </button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }} />
        </div>
        <div className="profile-id">
          <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
            <h1 className="profile-name">{p.name}</h1>
            {p.is_active ? <span className="status-pill"><span className="dot" />Active</span> : <span className="badge">Deactivated</span>}
          </div>
          <div className="profile-sub">{[p.job_title, roles.join(', ')].filter(Boolean).join(' · ') || 'Add your job title below'}</div>
          <div className="profile-meta">
            <span><svg {...ICON}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></svg>{p.contact_email || p.email}</span>
            {p.phone && <span><svg {...ICON}><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" /></svg>{p.phone}</span>}
            {place && <span><svg {...ICON}><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></svg>{place}</span>}
            <span>joined {shortDate(p.created_at)}</span>
          </div>
          {p.avatar_updated_at && (
            <button type="button" className="link-btn small" onClick={async () => { await api.del('/api/me/avatar'); onChanged(); toast('Photo removed'); }}>Remove photo</button>
          )}
          <ErrorBox error={err} />
        </div>
      </div>
    </div>
  );
}

const FIELDS: { key: keyof Details; label: string; required?: boolean; wide?: boolean; type?: string; autoComplete?: string; hint?: string }[] = [
  { key: 'first_name', label: 'First name', required: true, autoComplete: 'given-name' },
  { key: 'last_name', label: 'Last name', required: true, autoComplete: 'family-name' },
  { key: 'preferred_name', label: 'Preferred name', hint: 'Shown instead of your first name', autoComplete: 'nickname' },
  { key: 'job_title', label: 'Job title', autoComplete: 'organization-title' },
  { key: 'contact_email', label: 'Contact email', type: 'email', autoComplete: 'email' },
  { key: 'phone', label: 'Phone', type: 'tel', autoComplete: 'tel' },
  { key: 'address_line1', label: 'Address line 1', wide: true, autoComplete: 'address-line1' },
  { key: 'address_line2', label: 'Address line 2', wide: true, autoComplete: 'address-line2' },
  { key: 'city', label: 'City', autoComplete: 'address-level2' },
  { key: 'region', label: 'State / region', autoComplete: 'address-level1' },
  { key: 'postal_code', label: 'Postal code', autoComplete: 'postal-code' },
  { key: 'country', label: 'Country (2-letter)', hint: 'e.g. US', autoComplete: 'country' },
];

function EditDetails({ p, onSaved }: { p: Profile; onSaved: () => void }) {
  const initial = Object.fromEntries(FIELDS.map((f) => [f.key, p[f.key] ?? ''])) as Details;
  const [d, setD] = useState<Details>(initial);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => setD(initial), [p.id, p.name]);
  const dirty = FIELDS.some((f) => d[f.key] !== initial[f.key]);
  return (
    <form className="card-box" onSubmit={async (e) => {
      e.preventDefault();
      setErr(null);
      setBusy(true);
      try {
        await api.patch('/api/me/profile', d);
        onSaved();
        toast('Profile saved');
      } catch (e2) {
        setErr(e2);
      } finally {
        setBusy(false);
      }
    }}>
      <div className="hd"><h2 className="grow">Edit details</h2></div>
      <div className="bd stack">
        <div className="detail-grid">
          {FIELDS.map((f) => (
            <label key={f.key} className={`detail-field ${f.wide ? 'wide' : ''}`}>
              <span className="detail-label">{f.label}{f.required && <span aria-hidden="true"> *</span>}</span>
              <input id={`profile-${f.key}`} className="input detail-input" type={f.type ?? 'text'} autoComplete={f.autoComplete} required={f.required}
                value={d[f.key]} onChange={(e) => setD({ ...d, [f.key]: e.target.value })} placeholder={f.hint} />
            </label>
          ))}
        </div>
        <ErrorBox error={err} />
        <div className="btn-row">
          <button className="btn primary" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save details'}</button>
          {dirty && <button type="button" className="btn ghost" onClick={() => setD(initial)}>Discard changes</button>}
        </div>
      </div>
    </form>
  );
}

function Security({ p }: { p: Profile }) {
  const [changing, setChanging] = useState(false);
  const { refresh } = useAuth();
  return (
    <div className="card-box">
      <div className="hd"><h2 className="grow">Security</h2>{p.has_password && <button className="btn" onClick={() => setChanging(true)}>Change password</button>}</div>
      <div className="bd">
        <dl className="sec-list">
          <dt>Password</dt>
          <dd>{!p.has_password ? 'Not set' : p.password_changed_at ? `Last changed ${shortDate(p.password_changed_at)}` : 'Set by an administrator'}</dd>
          <dt>Google sign-in</dt>
          <dd>{p.google_linked ? <span className="badge ok">Linked</span> : <span className="faint">Not linked. It links the first time you use Sign in with Google.</span>}</dd>
          <dt>Two-factor sign-in</dt>
          <dd><span className="badge">Off</span> <span className="faint small">Not available yet.</span></dd>
          <dt>Last sign-in</dt>
          <dd>{p.last_login_at ? `${dateTime(p.last_login_at)} (${timeAgo(p.last_login_at)})` : '—'}</dd>
        </dl>
      </div>
      {changing && (
        <Modal title="Change password" onClose={() => setChanging(false)}>
          <PasswordForm onDone={() => { setChanging(false); refresh(); }} />
        </Modal>
      )}
    </div>
  );
}

function Preferences() {
  const theme = useTheme();
  return (
    <div className="card-box" style={{ maxWidth: 640 }}>
      <div className="hd"><h2>Appearance</h2></div>
      <div className="bd stack-sm">
        <div className="seg" role="radiogroup" aria-label="Theme" style={{ justifySelf: 'start' }}>
          {([['light', 'Light'], ['dark', 'Dark'], ['system', 'Match my system']] as [Theme, string][]).map(([v, label]) => (
            <button key={v} role="radio" aria-checked={theme === v} className={theme === v ? 'on' : ''} onClick={() => applyTheme(v)}>{label}</button>
          ))}
        </div>
        <div className="faint small">Saved in this browser.</div>
      </div>
    </div>
  );
}

type FeedItem = { id: number; at: string; actor_name: string; via: string; summary: string; project_key: string; project_name: string };
function Notifications() {
  const feed = useQuery({ queryKey: ['feed', 'page'], queryFn: () => api.get<FeedItem[]>('/api/feed?limit=100') });
  return (
    <div className="card-box">
      <div className="hd"><div className="grow"><h2>Notifications</h2><div className="faint small" style={{ marginTop: 2 }}>Changes other people and Claude made on projects you can see. The bell in the header shows the newest.</div></div></div>
      {feed.isLoading ? <Spinner /> : (
        <div className="feed" style={{ maxHeight: 'none' }}>
          {(feed.data ?? []).map((i) => (
            <Link key={i.id} to={`/p/${i.project_key}/activity`} className="feed-item">
              <div className="small"><b>{i.actor_name || 'System'}</b>{i.via !== 'web' && <span className={`via ${i.via}`} style={{ marginLeft: 6 }}>{i.via}</span>} <span className="faint">· {i.project_name} · {timeAgo(i.at)}</span></div>
              <div className="small muted">{i.summary}</div>
            </Link>
          ))}
          {!feed.data?.length && <div className="results-empty">Nothing yet.</div>}
        </div>
      )}
    </div>
  );
}

export default function Account() {
  const [sp, setSp] = useSearchParams();
  const tab = (TABS.some(([k]) => k === sp.get('tab')) ? sp.get('tab') : 'profile') as ProfileTab;
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const q = useQuery({ queryKey: ['profile'], queryFn: () => api.get<Profile>('/api/me/profile') });
  const changed = () => {
    qc.invalidateQueries({ queryKey: ['profile'] });
    refresh();
  };
  if (q.isLoading) return <Spinner />;
  if (!q.data) return <div className="page"><ErrorBox error={q.error} /></div>;
  const p = q.data;
  return (
    <div className="page profile-page">
      <div className="profile-wrap">
        <div className="eyebrow"><span>Account</span></div>
        <Banner p={p} onChanged={changed} />
        <div className="pill-tabs" role="tablist">
          {TABS.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setSp(k === 'profile' ? {} : { tab: k }, { replace: true })}>{label}</button>
          ))}
        </div>
        {tab === 'profile' && (
          <div className="profile-cols">
            <EditDetails p={p} onSaved={changed} />
            <div className="stack">
              <Security p={p} />
              <Tokens base="/api/me/tokens" title="Your API tokens" showSetup />
            </div>
          </div>
        )}
        {tab === 'preferences' && <Preferences />}
        {tab === 'notifications' && <Notifications />}
        {tab === 'history' && <AuditList endpoint="/api/me/history" showProject />}
      </div>
    </div>
  );
}
