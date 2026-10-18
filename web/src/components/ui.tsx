import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { initials } from '../lib/format';

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="scrim modal-scrim" onClick={onClose} />
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-hd">
          <h2 className="grow">{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-bd">{children}</div>
        {footer && <div className="modal-ft">{footer}</div>}
      </div>
    </>
  );
}

/** Photo when the user has one, otherwise initials (a gear for service accounts). */
export function Avatar({ name, service, userId, photoAt, size }: { name: string; service?: boolean; userId?: string; photoAt?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const style = size ? { width: size, height: size, fontSize: Math.round(size * 0.38) } : undefined;
  if (userId && photoAt && !broken) {
    return <img className={`avatar ${service ? 'svc' : ''}`} style={style} src={`/api/users/${userId}/avatar?v=${Date.parse(photoAt)}`} alt="" title={name} onError={() => setBroken(true)} />;
  }
  return <span className={`avatar ${service ? 'svc' : ''}`} style={style} title={name}>{service ? '⚙' : initials(name)}</span>;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="error-box">{error instanceof Error ? error.message : String(error)}</div>;
}

export function Spinner() {
  return <div className="empty">Loading…</div>;
}

type Toast = { id: number; text: string; kind: 'info' | 'error' };
const ToastCtx = createContext<(text: string, kind?: 'info' | 'error') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setItems((t) => [...t, { id, text, kind }]);
    window.setTimeout(() => setItems((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

export function Confirm({ title, body, confirmLabel = 'Confirm', danger, onConfirm, onClose }: { title: string; body: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => Promise<unknown> | void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal title={title} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            await onConfirm();
            onClose();
          } catch (e) {
            setErr(e);
            setBusy(false);
          }
        }}>{confirmLabel}</button>
      </>
    }>
      <div className="stack-sm">{body}<ErrorBox error={err} /></div>
    </Modal>
  );
}
