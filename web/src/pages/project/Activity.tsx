import AuditList from '../../components/AuditList';
import { useProjectCtx } from './ProjectLayout';

export default function Activity() {
  const { project } = useProjectCtx();
  return (
    <div className="page">
      <AuditList endpoint={`/api/projects/${project.key}/audit`} projectKey={project.key} />
    </div>
  );
}
