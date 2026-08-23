import { useState } from 'react';
import type { Lead } from '../types';
import { triggerOutreach } from '../api';

interface Props {
  lead: Lead | null;
  onClose: () => void;
  onSave: (data: Partial<Lead>) => void;
  onDelete: (lead: Lead) => void;
}

const emptyForm: Partial<Lead> = { address: '', status: 'new', source: 'manual' };

export default function LeadModal({ lead, onClose, onSave, onDelete }: Props) {
  const [form, setForm] = useState<Partial<Lead>>(lead ?? emptyForm);
  const [outreachMsg, setOutreachMsg] = useState<string | null>(null);

  const set = (patch: Partial<Lead>) => setForm((f) => ({ ...f, ...patch }));

  const handleOutreach = async () => {
    if (!lead) return;
    try {
      await triggerOutreach(lead.id);
      setOutreachMsg('Sent.');
    } catch (err) {
      setOutreachMsg(err instanceof Error ? err.message : 'Outreach failed.');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{lead ? 'Edit Lead' : 'Add Lead'}</h2>

        <div className="form-grid">
          <label>
            Address*
            <input value={form.address ?? ''} onChange={(e) => set({ address: e.target.value })} />
          </label>
          <label>
            City
            <input value={form.city ?? ''} onChange={(e) => set({ city: e.target.value })} />
          </label>
          <label>
            State
            <input value={form.state ?? ''} onChange={(e) => set({ state: e.target.value })} />
          </label>
          <label>
            Price
            <input
              type="number"
              value={form.price ?? ''}
              onChange={(e) => set({ price: e.target.value ? Number(e.target.value) : null })}
            />
          </label>
          <label>
            Beds
            <input
              type="number"
              value={form.beds ?? ''}
              onChange={(e) => set({ beds: e.target.value ? Number(e.target.value) : null })}
            />
          </label>
          <label>
            Baths
            <input
              type="number"
              value={form.baths ?? ''}
              onChange={(e) => set({ baths: e.target.value ? Number(e.target.value) : null })}
            />
          </label>
          <label>
            Agent Name
            <input value={form.agent_name ?? ''} onChange={(e) => set({ agent_name: e.target.value })} />
          </label>
          <label>
            Agent Email
            <input value={form.agent_email ?? ''} onChange={(e) => set({ agent_email: e.target.value })} />
          </label>
          <label>
            Agent Phone
            <input value={form.agent_phone ?? ''} onChange={(e) => set({ agent_phone: e.target.value })} />
          </label>
          <label>
            Listing URL
            <input value={form.listing_url ?? ''} onChange={(e) => set({ listing_url: e.target.value })} />
          </label>
          <label className="span-2">
            Notes
            <textarea value={form.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} rows={3} />
          </label>
        </div>

        <div className="modal-actions">
          <div>
            {lead && (
              <button className="btn btn-danger" onClick={() => onDelete(lead)}>
                Delete
              </button>
            )}
            {lead && (
              <button className="btn btn-ghost" onClick={handleOutreach}>
                Send Outreach
              </button>
            )}
          </div>
          <div>
            <button className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={!form.address}
              onClick={() => onSave(form)}
            >
              Save
            </button>
          </div>
        </div>
        {outreachMsg && <div className="outreach-msg">{outreachMsg}</div>}
      </div>
    </div>
  );
}
