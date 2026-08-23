import { useEffect, useState, useCallback, useRef } from 'react';
import type { Lead, LeadFilters, LeadStatus, Stats } from './types';
import { fetchLeads, fetchStats, createLead, updateLead, deleteLead, importSample, importCsv } from './api';
import StatsCards from './components/StatsCards';
import FilterBar from './components/FilterBar';
import LeadsTable from './components/LeadsTable';
import LeadModal from './components/LeadModal';
import './App.css';

export default function App() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [filters, setFilters] = useState<LeadFilters>({});
  const [editingLead, setEditingLead] = useState<Lead | null | 'new'>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [leadsData, statsData] = await Promise.all([fetchLeads(filters), fetchStats()]);
      setLeads(leadsData);
      setStats(statsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load leads');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleStatusChange = async (lead: Lead, status: LeadStatus) => {
    await updateLead(lead.id, { status });
    refresh();
  };

  const handleSave = async (data: Partial<Lead>) => {
    if (editingLead && editingLead !== 'new') {
      await updateLead(editingLead.id, data);
    } else {
      await createLead(data);
    }
    setEditingLead(null);
    refresh();
  };

  const handleDelete = async (lead: Lead) => {
    if (!confirm(`Delete lead at ${lead.address}?`)) return;
    await deleteLead(lead.id);
    setEditingLead(null);
    refresh();
  };

  const handleGenerateSample = async () => {
    setLoading(true);
    try {
      await importSample(10);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate sample leads');
      setLoading(false);
    }
  };

  const handleCsvUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    try {
      const result = await importCsv(file);
      setError(null);
      alert(`Imported ${result.imported} lead(s).`);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'CSV import failed');
      setLoading(false);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="admin-app">
      <header className="admin-header">
        <div>
          <h1>Estly Admin — Lead Pipeline</h1>
          <p className="subtitle">Real estate listing leads &amp; agent outreach</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-ghost" onClick={handleGenerateSample} disabled={loading}>
            Generate Sample Leads
          </button>
          <button className="btn btn-ghost" onClick={() => fileInputRef.current?.click()} disabled={loading}>
            Import CSV
          </button>
          <input ref={fileInputRef} type="file" accept=".csv" hidden onChange={handleCsvUpload} />
          <button className="btn btn-primary" onClick={() => setEditingLead('new')}>
            + Add Lead
          </button>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <StatsCards stats={stats} />
      <FilterBar filters={filters} onChange={setFilters} />

      {loading ? (
        <div className="empty-state">Loading…</div>
      ) : (
        <LeadsTable
          leads={leads}
          onStatusChange={handleStatusChange}
          onEdit={(lead) => setEditingLead(lead)}
          onDelete={handleDelete}
        />
      )}

      {editingLead && (
        <LeadModal
          lead={editingLead === 'new' ? null : editingLead}
          onClose={() => setEditingLead(null)}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
