import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { ChatWorkspace } from './chat';

type Profile = { id: string; email: string; role: 'customer' | 'admin' };
type Problem = { message: string; fields?: Record<string, string>; retryAfterSeconds?: number };
type SessionState = Profile | null | undefined;

const sessionOptions = { credentials: 'same-origin', cache: 'no-store' } as const;
const networkError = 'The service is temporarily unavailable. Please try again.';

function Brand() {
  return <span className="brand"><span aria-hidden="true" className="brand-mark">LS</span>Legal Support Chat</span>;
}

function AuthForm({ signup, onNavigate, onAuthenticated }: {
  signup: boolean;
  onNavigate: (signup: boolean) => void;
  onAuthenticated: (profile: Profile) => void;
}) {
  const [problem, setProblem] = useState<Problem>();
  const [busy, setBusy] = useState(false);
  const email = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (problem?.fields?.email) email.current?.focus();
    else if (problem?.fields?.password) password.current?.focus();
    else if (problem) feedback.current?.focus();
  }, [problem]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setProblem(undefined);
    const data = new FormData(event.currentTarget);
    const address = String(data.get('email') ?? '').trim();
    const secret = String(data.get('password') ?? '');
    const fields: Record<string, string> = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) fields.email = 'Enter a valid email address.';
    if (!secret.trim()) fields.password = 'Enter your password.';
    else if (signup && new TextEncoder().encode(secret).length > 72) fields.password = 'Use at most 72 UTF-8 bytes.';
    if (Object.keys(fields).length) {
      setProblem({ message: 'Check the highlighted fields.', fields });
      return;
    }

    setBusy(true);
    try {
      const result = await fetch(signup ? '/auth/signup' : '/auth/login', {
        ...sessionOptions,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: address, password: secret }),
      });
      const payload = await result.json();
      if (result.ok) onAuthenticated(payload);
      else setProblem(payload);
    } catch {
      setProblem({ message: networkError });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-layout">
      <aside className="cover">
        <Brand />
        <p>Support for your legal workspace.</p>
      </aside>
      <section className="auth-panel" aria-labelledby="auth-title">
        <form noValidate onSubmit={submit} className="auth-form" aria-busy={busy}>
          <h1 id="auth-title">{signup ? 'Create your account' : 'Log in'}</h1>
          <div className="field">
            <label htmlFor="email">Email address</label>
            <input ref={email} id="email" name="email" type="email" autoComplete="email" required
              aria-invalid={Boolean(problem?.fields?.email)} aria-describedby={problem?.fields?.email ? 'email-error' : undefined} />
            {problem?.fields?.email && <p className="error" id="email-error">{problem.fields.email}</p>}
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input ref={password} id="password" name="password" type="password" required
              autoComplete={signup ? 'new-password' : 'current-password'}
              aria-invalid={Boolean(problem?.fields?.password)}
              aria-describedby={problem?.fields?.password ? 'password-error' : undefined} />
            {problem?.fields?.password && <p className="error" id="password-error">{problem.fields.password}</p>}
          </div>
          {problem && <p ref={feedback} tabIndex={-1} className="error" role="alert">{problem.message}
            {problem.retryAfterSeconds ? ` Try again in ${problem.retryAfterSeconds} seconds.` : ''}
          </p>}
          <button className="primary" type="submit" aria-disabled={busy}>
            {busy ? 'Please wait…' : signup ? 'Create account' : 'Log in'}
          </button>
          <p className="switch">
            {signup ? 'Already have an account? ' : 'New here? '}
            <a href={signup ? '/login' : '/signup'} onClick={event => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              if (!busy) onNavigate(!signup);
            }}>{signup ? 'Log in' : 'Create an account'}</a>
          </p>
        </form>
      </section>
    </main>
  );
}

function App() {
  const [profile, setProfile] = useState<SessionState>(undefined);
  const [path, setPath] = useState(location.pathname);
  const [failure, setFailure] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const viewHeading = useRef<HTMLHeadingElement>(null);

  function navigate(next: string, replace = false) {
    if (location.pathname !== next) {
      if (replace) history.replaceState(null, '', next);
      else history.pushState(null, '', next);
    }
    setPath(next);
  }

  useEffect(() => {
    const restart = () => {
      setProfile(undefined);
      setPath(location.pathname);
      setRefresh(value => value + 1);
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) restart();
    };
    const hidePrivateView = () => { document.documentElement.classList.add('page-hidden'); };
    addEventListener('popstate', restart);
    addEventListener('pageshow', restored);
    addEventListener('pagehide', hidePrivateView);
    return () => {
      removeEventListener('popstate', restart);
      removeEventListener('pageshow', restored);
      removeEventListener('pagehide', hidePrivateView);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    function finish(value: SessionState) {
      if (controller.signal.aborted) return;
      setProfile(value);
    }

    setFailure('');
    void fetch('/auth/me', { ...sessionOptions, signal: controller.signal }).then(async result => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        const account = await result.json();
        if (controller.signal.aborted) return;
        navigate('/app', true);
        finish(account);
      } else if (result.status === 401) {
        if (location.pathname !== '/signup') navigate('/login', true);
        finish(null);
      } else {
        throw new Error(networkError);
      }
    }).catch(() => {
      if (controller.signal.aborted) return;
      setFailure(networkError);
    });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (profile !== undefined || failure) document.documentElement.classList.remove('page-hidden');
  }, [profile, failure]);

  useEffect(() => {
    if (profile) viewHeading.current?.focus();
    else if (profile === null) document.getElementById('email')?.focus();
  }, [profile, path]);

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setFailure('');
    try {
      const result = await fetch('/auth/logout', { ...sessionOptions, method: 'POST' });
      if (!result.ok) throw new Error(networkError);
      setProfile(null);
      navigate('/login', true);
    } catch {
      setFailure('Could not log out. Please try again.');
    } finally {
      setLoggingOut(false);
    }
  }

  if (profile === undefined) {
    return <main className="status-panel">
      <Brand />
      {failure ? <>
        <p className="error" role="alert">{failure}</p>
        <button className="primary" onClick={() => setRefresh(value => value + 1)}>Try again</button>
      </> : <p role="status">Checking your session…</p>}
    </main>;
  }
  if (!profile) {
    return <AuthForm key={path} signup={path === '/signup'} onNavigate={signup => navigate(signup ? '/signup' : '/login')}
      onAuthenticated={account => { setFailure(''); setProfile(account); navigate('/app', true); }} />;
  }
  return (
    <div className="workspace">
      <header className="workspace-bar">
        <Brand />
        <button type="button" className="secondary" aria-disabled={loggingOut} onClick={logout}>
          {loggingOut ? 'Logging out…' : 'Log out'}
        </button>
      </header>
      <div className="workspace-account">
        <h2 tabIndex={-1} ref={viewHeading}>{profile.role === 'admin' ? 'Admin workspace' : 'Support workspace'}</h2>
        <p className="account">Signed in as {profile.email}</p>
        {failure && <p className="error" role="alert">{failure}</p>}
      </div>
      <ChatWorkspace key={profile.id} onSessionExpired={() => { setProfile(null); navigate('/login', true); }} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
