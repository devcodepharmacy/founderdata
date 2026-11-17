import { useState } from 'react';
import { api } from '../lib/api';
import { AuthShell, FormError } from '../components/ui/AuthShell';
import { Spinner } from '../components/ui/Spinner';

export function Login({ onLogin, team }: { onLogin: () => void; team: boolean }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [tries, setTries] = useState(0);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/login', { method: 'POST', json: { password, ...(login.trim() ? { login } : {}) } });
      onLogin();
    } catch (err) {
      setError((err as Error).message);
      setTries((t) => t + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell footer="Self-hosted analytics for your websites, apps and revenue.">
      <form onSubmit={submit} noValidate>
        <h1 className="text-display">Welcome back</h1>
        <p className="mt-1.5 text-sm text-stone-500">See which visits brought in revenue, on your sites and apps.</p>
        {team && (
          <>
            <label className="label mt-7" htmlFor="login">
              Name or email
            </label>
            <input id="login" className="input h-10" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" autoFocus />
            <p className="mt-1.5 text-xs text-stone-500">Leave it empty to use the shared owner or viewer password.</p>
          </>
        )}
        <label className={`label ${team ? 'mt-5' : 'mt-7'}`} htmlFor="pw">
          Password
        </label>
        <input
          id="pw"
          type="password"
          className="input h-10"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus={!team}
          autoComplete="current-password"
          aria-invalid={!!error || undefined}
          aria-describedby={error ? 'login-error' : undefined}
        />
        {error && (
          <div id="login-error" key={tries}>
            <FormError>{error}</FormError>
          </div>
        )}
        <button className="btn-dark mt-6 h-10 w-full" disabled={busy || !password}>
          {busy ? (
            <>
              <Spinner /> Signing in
            </>
          ) : (
            'Sign in'
          )}
        </button>
      </form>
    </AuthShell>
  );
}
