import { useEffect, useState, useCallback, useRef } from 'react';
import type { Lead, LeadFilters, LeadStatus, Stats } from './types';
import { fetchLeads, fetchStats, createLead, updateLead, deleteLead, importCsv } from './api';
import { isAuthRequired, getStoredCreds, verifyCreds, clearStoredCreds, AUTH_REQUIRED_EVENT } from './auth';
import StatsCards from './components/StatsCards';
import FilterBar from './components/FilterBar';
import LeadsTable from './components/LeadsTable';
import LeadModal from './components/LeadModal';
import Login from './components/Login';
import './App.css';

type AuthState = 'checking' | 'signed-out' | 'signed-in' | 'not-required';

export default function App() {
  const [authState, setAuthState] = useState<AuthState>('checking');

  const evaluateAuth = useCallback(async () => {
    try {
      if (!(await isAuthRequired())) {
        setAuthState('not-required');
        return;
      }
      const creds = getStoredCreds();
      if (creds && (await verifyCreds(creds))) {
        setAuthState('signed-in');
      } else {
        clearStoredCreds();
        setAuthState('signed-out');
      }
    } catch {
      // Can't reach the server to check -- fall back to whatever the
      // dashboard's own /api calls turn up once it renders.
      setAuthState(getStoredCreds() ? 'signed-in' : 'signed-out');
    }
  }, []);

  useEffect(() => {
    evaluateAuth();
  }, [evaluateAuth]);

  useEffect(() => {
    const onAuthRequired = () => setAuthState('signed-out');
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  }, []);

  if (authState === 'checking') {
    return null;
  }

  if (authState === 'signed-out') {
    return <Login onSuccess={() => setAuthState('signed-in')} />;
  }

  return (
    <Dashboard
      showLogout={authState === 'signed-in'}
      onLogout={() => {
        clearStoredCreds();
        setAuthState('signed-out');
      }}
    />
  );
}

function Dashboard({ showLogout, onLogout }: { showLogout: boolean; onLogout: () => void }) {
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

  return (
    <div className="admin-app">
      <header className="admin-header">
        <div>
          <h1>Estly Admin — Lead Pipeline</h1>
          <p className="subtitle">Real estate listing leads &amp; agent outreach</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-ghost" onClick={() => fileInputRef.current?.click()} disabled={loading}>
            Import CSV
          </button>
          <input ref={fileInputRef} type="file" accept=".csv" hidden onChange={handleCsvUpload} />
          <button className="btn btn-primary" onClick={() => setEditingLead('new')}>
            + Add Lead
          </button>
          {showLogout && (
            <button className="btn btn-ghost" onClick={onLogout}>
              Log out
            </button>
          )}
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
