import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { AuthShell, FormError } from '../components/ui/AuthShell';
import { Skeleton } from '../components/ui/Skeleton';
import { Spinner } from '../components/ui/Spinner';

const MIN = 12;

/** The page an invite link opens: the person sets their own password and is signed in. */
export function Join({ token, onDone }: { token: string; onDone: () => void }) {
  const [invite, setInvite] = useState<{ name: string; role: string } | null>(null);
  const [gone, setGone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [tries, setTries] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ name: string; role: string }>(`/api/auth/invite/${token}`).then(setInvite, (e) => setGone((e as Error).message));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/api/auth/invite/${token}`, { method: 'POST', json: { password } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setTries((t) => t + 1);
    } finally {
      setBusy(false);
    }
  }

  const left = MIN - password.length;
  return (
    <AuthShell>
      <form onSubmit={submit} noValidate>
        {gone ? (
          <>
            <h1 className="text-display">This link no longer works</h1>
            <p className="mt-1.5 text-sm text-stone-500">{gone}</p>
            <p className="mt-4 text-sm text-stone-500">Ask the person who invited you for a new link.</p>
          </>
        ) : !invite ? (
          <div role="status" aria-busy="true">
            <span className="sr-only">Loading your invite</span>
            <Skeleton className="h-8 w-40" />
            <Skeleton className="mt-3 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-3/4" />
            <Skeleton className="mt-8 h-4 w-20" />
            <Skeleton className="mt-2 h-10 w-full rounded-[10px]" />
            <Skeleton className="mt-6 h-10 w-full rounded-[10px]" />
          </div>
        ) : (
          <div className="fd-reveal">
            <h1 className="text-display">Hi {invite.name}</h1>
            <p className="mt-1.5 text-sm text-stone-500">
              Choose a password to join as {invite.role === 'owner' ? 'an owner' : 'a viewer'}. Next time, sign in with your name or email and this password.
            </p>
            <label className="label mt-7" htmlFor="new-pw">
              Password
            </label>
            <input
              id="new-pw"
              type="password"
              className="input h-10"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              autoFocus
              aria-invalid={!!error || undefined}
              aria-describedby="new-pw-hint"
            />
            {/* A bar that fills toward the 12-character minimum. */}
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-stone-100" aria-hidden="true">
              <div
                className={`h-full w-full rounded-full ${left <= 0 ? 'bg-emerald-500' : 'bg-stone-400'}`}
                style={{ transform: `translateX(${Math.min(0, -left / MIN) * 100}%)`, transition: 'transform var(--dur-base) var(--ease-out)' }}
              />
            </div>
            <p id="new-pw-hint" className={`mt-1.5 text-xs ${left <= 0 ? 'text-emerald-700' : 'text-stone-500'}`}>
              {password.length === 0 ? `At least ${MIN} characters.` : left > 0 ? `${left} more ${left === 1 ? 'character' : 'characters'}.` : 'Long enough.'}
            </p>
            {error && (
              <div key={tries}>
                <FormError>{error}</FormError>
              </div>
            )}
            <button className="btn-dark mt-6 h-10 w-full" disabled={busy || password.length < MIN}>
              {busy ? (
                <>
                  <Spinner /> Joining
                </>
              ) : (
                'Join'
              )}
            </button>
          </div>
        )}
      </form>
    </AuthShell>
  );
}
