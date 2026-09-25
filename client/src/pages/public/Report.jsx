import { Link, useParams } from 'react-router-dom';
import { get } from '../../api.js';
import { useLoad } from '../../util.js';
import { ErrorText, Loading } from '../../components/ui.jsx';

export default function Report() {
  const { token } = useParams();
  const { data, error } = useLoad(() => get(`/public/report/${token}`), [token]);
  if (error) return <div className="public narrow"><ErrorText error={error} /></div>;
  if (!data) return <div className="public narrow"><Loading /></div>;
  return (
    <div className="public narrow">
      <section className="card">
        <p className="muted">{data.tutor_name}</p>
        <h1>{data.student}&rsquo;s progress</h1>
        <p className="muted small">{data.period_from} to {data.period_to}</p>
        <p className="report-body">{data.body}</p>
        {data.portal_token && <p className="small"><Link to={`/family/${data.portal_token}`}>Back to your family page</Link></p>}
      </section>
    </div>
  );
}
