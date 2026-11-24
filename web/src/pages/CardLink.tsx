import { useQuery } from '@tanstack/react-query';
import { Navigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorBox, Spinner } from '../components/ui';

/** Target of the QR code on a printed card: /c/<token> → the card on its board. Sign-in is handled by App. */
export default function CardLink() {
  const { token = '' } = useParams();
  const q = useQuery({
    queryKey: ['card-link-target', token],
    queryFn: () => api.get<{ key: string; project_key: string; board_key: string }>(`/api/card-links/${encodeURIComponent(token)}`),
    retry: false,
  });
  if (q.error) return <div className="page"><ErrorBox error={q.error} /></div>;
  if (!q.data) return <Spinner />;
  const { project_key, board_key, key } = q.data;
  return <Navigate to={`/p/${project_key}/b/${board_key}?card=${encodeURIComponent(key)}`} replace />;
}
