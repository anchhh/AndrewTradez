import type { Lead, LeadFilters, Stats } from './types';
import { authHeader, clearStoredCreds, AUTH_REQUIRED_EVENT } from './auth';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: {
      ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...authHeader(),
    },
    ...options,
  });
  if (res.status === 401) {
    clearStoredCreds();
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    throw new Error('Session expired — please sign in again.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export function fetchLeads(filters: LeadFilters): Promise<Lead[]> {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const qs = params.toString();
  return request<Lead[]>(`/api/leads${qs ? `?${qs}` : ''}`);
}

export function fetchStats(): Promise<Stats> {
  return request<Stats>('/api/leads/stats');
}

export function createLead(data: Partial<Lead>): Promise<Lead> {
  return request<Lead>('/api/leads', { method: 'POST', body: JSON.stringify(data) });
}

export function updateLead(id: number, data: Partial<Lead>): Promise<Lead> {
  return request<Lead>(`/api/leads/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export function deleteLead(id: number): Promise<void> {
  return request<void>(`/api/leads/${id}`, { method: 'DELETE' });
}

export function importCsv(file: File): Promise<{ imported: number; created: number; updated: number }> {
  const form = new FormData();
  form.append('file', file);
  return request('/api/leads/import/csv', { method: 'POST', body: form });
}

export function triggerOutreach(id: number, channel = 'email'): Promise<unknown> {
  return request(`/api/leads/${id}/outreach`, {
    method: 'POST',
    body: JSON.stringify({ channel }),
  });
}
