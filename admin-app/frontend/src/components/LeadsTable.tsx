import type { Lead, LeadStatus } from '../types';
import { STATUSES } from '../types';

interface Props {
  leads: Lead[];
  onStatusChange: (lead: Lead, status: LeadStatus) => void;
  onEdit: (lead: Lead) => void;
  onDelete: (lead: Lead) => void;
}

function formatPrice(price: number | null) {
  if (price == null) return '—';
  return `$${price.toLocaleString()}`;
}

export default function LeadsTable({ leads, onStatusChange, onEdit, onDelete }: Props) {
  if (leads.length === 0) {
    return <div className="empty-state">No leads match these filters yet.</div>;
  }

  return (
    <div className="table-wrap">
      <table className="leads-table">
        <thead>
          <tr>
            <th>Address</th>
            <th>Price</th>
            <th>Beds/Baths</th>
            <th>Agent</th>
            <th>Source</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => (
            <tr key={lead.id}>
              <td>
                <button className="link-btn" onClick={() => onEdit(lead)}>
                  {lead.address}
                </button>
                <div className="subtext">
                  {[lead.city, lead.state].filter(Boolean).join(', ')}
                </div>
              </td>
              <td>{formatPrice(lead.price)}</td>
              <td>
                {lead.beds ?? '—'} bd / {lead.baths ?? '—'} ba
              </td>
              <td>
                <div>{lead.agent_name ?? '—'}</div>
                <div className="subtext">{lead.agent_email ?? ''}</div>
              </td>
              <td>
                {(lead.sources.length ? lead.sources : [lead.source]).map((s) => (
                  <span className="badge" key={s}>{s}</span>
                ))}
                {lead.times_seen > 1 && (
                  <div className="subtext" title={`Last seen ${new Date(lead.last_seen_at).toLocaleString()}`}>
                    seen {lead.times_seen}&times;
                  </div>
                )}
              </td>
              <td>
                <select
                  className={`status-select status-${lead.status}`}
                  value={lead.status}
                  onChange={(e) => onStatusChange(lead, e.target.value as LeadStatus)}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <a
                  className="link-btn"
                  href={`/studio/create?lead_id=${lead.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Create Video
                </a>
                <button className="icon-btn" title="Delete" onClick={() => onDelete(lead)}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
