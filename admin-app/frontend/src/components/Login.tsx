import { useState } from 'react';
import { verifyCreds, setStoredCreds } from '../auth';

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const ok = await verifyCreds({ user, pass });
      if (!ok) {
        setError('Invalid username or password.');
        return;
      }
      setStoredCreds({ user, pass });
      onSuccess();
    } catch {
      setError('Could not reach the server — try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Estly Admin</h1>
        <p className="subtitle">Sign in to view the lead pipeline.</p>
        <label>
          Username
          <input value={user} onChange={(e) => setUser(e.target.value)} autoFocus autoComplete="username" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button className="btn btn-primary" type="submit" disabled={loading || !user || !pass}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
