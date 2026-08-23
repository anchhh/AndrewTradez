import { useState } from 'react';
import type { FeedResult, IngestStatus } from '../types';
import { runIngestionNow } from '../api';

interface Props {
  status: IngestStatus | null;
  onRan: () => void;
}

const FEED_LABELS: Record<string, string> = {
  sample: 'Sample (demo)',
  zillow: 'Zillow',
  realtor: 'Realtor.com',
  airbnb: 'Airbnb',
};

function FeedRow({ name, result }: { name: string; result?: FeedResult }) {
  const label = FEED_LABELS[name] || name;
  if (!result) {
    return (
      <div className="feed-row">
        <span className="feed-name">{label}</span>
        <span className="feed-pill feed-pill-idle">not yet run</span>
      </div>
    );
  }
  return (
    <div className="feed-row">
      <span className="feed-name">{label}</span>
      {result.status === 'ok' && (
        <span className="feed-pill feed-pill-ok">
          {result.fetched} seen &middot; {result.created} new &middot; {result.updated} merged
        </span>
      )}
      {result.status === 'not_configured' && (
        <span className="feed-pill feed-pill-off" title={result.message}>
          not connected
        </span>
      )}
      {result.status === 'error' && (
        <span className="feed-pill feed-pill-error" title={result.message}>
          error
        </span>
      )}
    </div>
  );
}

export default function IngestionPanel({ status, onRan }: Props) {
  const [running, setRunning] = useState(false);

  const handleRun = async () => {
    setRunning(true);
    try {
      await runIngestionNow();
      onRan();
    } finally {
      setRunning(false);
    }
  };

  const lastRun = status?.last_run;
  const feeds = status?.feeds ?? ['sample', 'zillow', 'realtor', 'airbnb'];

  return (
    <div className="ingest-panel">
      <div className="ingest-header">
        <div>
          <h2>Auto-Ingestion</h2>
          <p className="ingest-sub">
            {lastRun
              ? `Last run ${new Date(lastRun.started_at).toLocaleString()} — auto-runs every 15 min`
              : 'Runs automatically in the background — every 15 min by default'}
          </p>
        </div>
        <button className="btn" onClick={handleRun} disabled={running}>
          {running ? 'Running…' : 'Run Now'}
        </button>
      </div>
      <div className="feed-list">
        {feeds.map((name) => (
          <FeedRow key={name} name={name} result={lastRun?.results.feeds[name]} />
        ))}
      </div>
      {lastRun && (
        <p className="ingest-note">
          No duplicates: repeat or cross-source listings merge into the existing lead
          instead of creating a new one — {lastRun.results.totals.updated} merged this run.
        </p>
      )}
    </div>
  );
}
