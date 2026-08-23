import { useEffect, useState, useCallback, useRef } from 'react';
import type { IngestStatus, Lead, LeadFilters, LeadStatus, Stats } from './types';
import { fetchLeads, fetchStats, createLead, updateLead, deleteLead, importSample, importCsv, fetchIngestStatus } from './api';
import StatsCards from './components/StatsCards';
import FilterBar from './components/FilterBar';
import LeadsTable from './components/LeadsTable';
import LeadModal from './components/LeadModal';
import IngestionPanel from './components/IngestionPanel';
import './App.css';

const INGEST_POLL_MS = 30000;

export default function App() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [ingestStatus, setIngestStatus] = useState<IngestStatus | null>(null);
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

  const refreshIngestStatus = useCallback(async () => {
    try {
      setIngestStatus(await fetchIngestStatus());
    } catch {
      // ingestion panel is non-critical; leave last known status in place
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refreshIngestStatus();
    const id = setInterval(refreshIngestStatus, INGEST_POLL_MS);
    return () => clearInterval(id);
  }, [refreshIngestStatus]);

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
      const result = await importSample(10);
      refresh();
      if (result.updated > 0) {
        alert(`${result.created} new lead(s), ${result.updated} matched existing leads and were merged (no duplicates).`);
      }
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
      alert(`${result.created} new lead(s), ${result.updated} matched existing leads and were merged (no duplicates).`);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'CSV import failed');
      setLoading(false);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleIngestionRan = () => {
    refresh();
    refreshIngestStatus();
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

      <IngestionPanel status={ingestStatus} onRan={handleIngestionRan} />
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
