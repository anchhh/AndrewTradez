import type { Stats } from '../types';

export default function StatsCards({ stats }: { stats: Stats | null }) {
  if (!stats) return null;

  const cards = [
    { label: 'Total Leads', value: stats.total },
    { label: 'New', value: stats.by_status.new ?? 0 },
    { label: 'Contacted', value: stats.by_status.contacted ?? 0 },
    { label: 'Responded', value: stats.by_status.responded ?? 0 },
    { label: 'Converted', value: stats.by_status.converted ?? 0 },
  ];

  return (
    <div className="stats-row">
      {cards.map((c) => (
        <div className="stat-card" key={c.label}>
          <div className="stat-value">{c.value}</div>
          <div className="stat-label">{c.label}</div>
        </div>
      ))}
    </div>
  );
}
