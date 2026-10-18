import { Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import Layout from './components/Layout';
import { Spinner } from './components/ui';
import { useAuth } from './lib/auth';
import Account from './pages/Account';
import AuditPage from './pages/admin/Audit';
import RolesPage from './pages/admin/Roles';
import UserDetail from './pages/admin/UserDetail';
import UsersPage from './pages/admin/Users';
import ChangePassword from './pages/ChangePassword';
import Login from './pages/Login';
import Activity from './pages/project/Activity';
import BoardPage from './pages/project/Board';
import ProjectLayout from './pages/project/ProjectLayout';
import Settings from './pages/project/Settings';
import Requests from './pages/project/Requests';
import Summary from './pages/project/Summary';
import Updates from './pages/project/Updates';
import Projects from './pages/Projects';

/** Signed in while on /login: continue to the page the user was heading to. */
function AfterLogin() {
  const [sp] = useSearchParams();
  const next = sp.get('next');
  return <Navigate to={next && next.startsWith('/') && !next.startsWith('//') ? next : '/'} replace />;
}

export default function App() {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!me) {
    if (loc.pathname !== '/login') return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
    return <Login />;
  }
  if (me.must_change_password) return <ChangePassword forced />;
  return (
    <Routes>
      <Route path="/login" element={<AfterLogin />} />
      <Route element={<Layout />}>
        <Route index element={<Projects />} />
        <Route path="account" element={<Account />} />
        <Route path="settings" element={<Navigate to="/account?tab=preferences" replace />} />
        <Route path="admin/users" element={<UsersPage />} />
        <Route path="admin/users/:id" element={<UserDetail />} />
        <Route path="admin/roles" element={<RolesPage />} />
        <Route path="admin/audit" element={<AuditPage />} />
        <Route path="p/:key" element={<ProjectLayout />}>
          <Route index element={<Summary />} />
          <Route path="b/:board" element={<BoardPage />} />
          <Route path="requests" element={<Requests />} />
          <Route path="updates" element={<Updates />} />
          <Route path="activity" element={<Activity />} />
          <Route path="settings" element={<Settings />} />
        </Route>
        <Route path="*" element={<div className="page"><div className="empty">Page not found</div></div>} />
      </Route>
    </Routes>
  );
}
