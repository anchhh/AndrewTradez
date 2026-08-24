import { SOURCES, STATUSES, type LeadFilters } from '../types';

interface Props {
  filters: LeadFilters;
  onChange: (filters: LeadFilters) => void;
}

export default function FilterBar({ filters, onChange }: Props) {
  const set = (patch: Partial<LeadFilters>) => onChange({ ...filters, ...patch });

  return (
    <div className="filter-bar">
      <input
        type="text"
        placeholder="Search address, city, agent..."
        value={filters.search ?? ''}
        onChange={(e) => set({ search: e.target.value })}
        className="filter-search"
      />
      <select value={filters.status ?? ''} onChange={(e) => set({ status: e.target.value })}>
        <option value="">All statuses</option>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <select value={filters.source ?? ''} onChange={(e) => set({ source: e.target.value })}>
        <option value="">All sources</option>
        {SOURCES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <input
        type="number"
        placeholder="Min price"
        value={filters.min_price ?? ''}
        onChange={(e) => set({ min_price: e.target.value })}
        className="filter-price"
      />
      <input
        type="number"
        placeholder="Max price"
        value={filters.max_price ?? ''}
        onChange={(e) => set({ max_price: e.target.value })}
        className="filter-price"
      />
    </div>
  );
}
