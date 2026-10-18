import AuditList from '../../components/AuditList';
import { ErrorBox } from '../../components/ui';
import { useAuth } from '../../lib/auth';

export default function AuditPage() {
  const { can } = useAuth();
  return (
    <>
      <div className="topbar"><h1>Audit log</h1><span className="faint small">Every sign-in, change and admin action, with who did it and from where.</span></div>
      <div className="page">{can('admin.audit') ? <AuditList endpoint="/api/admin/audit" showProject /> : <ErrorBox error="You do not have access to the audit log." />}</div>
    </>
  );
}
