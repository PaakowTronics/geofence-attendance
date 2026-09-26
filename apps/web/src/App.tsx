import { useEffect, useState } from 'react';

const API = import.meta.env.VITE_API_URL ?? '/api';

type Feedback = {
  message: string;
  action?: string;
};

type Employee = {
  id: string;
  employeeId: string;
  name: string;
  role: 'EMPLOYEE' | 'HR' | 'ADMIN';
};

type AuditRow = {
  id: string;
  action: string;
  result: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  targetEmployee?: {
    employeeId: string;
    name: string;
  } | null;
};

async function getLocation() {
  if (!navigator.geolocation) {
    throw new Error('This browser does not provide location services.');
  }

  return new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15_000,
    });
  });
}

function locationErrorMessage(error: GeolocationPositionError) {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return {
        message: 'Location permission was denied.',
        action: 'Allow location access for this site and try again.',
      };
    case error.POSITION_UNAVAILABLE:
      return {
        message: 'Your device could not determine its current location.',
        action: 'Move to an area with a clearer GPS signal and try again.',
      };
    case error.TIMEOUT:
      return {
        message: 'The location request timed out.',
        action: 'Make sure location services are enabled and try again.',
      };
    default:
      return {
        message: 'Unable to obtain your current location.',
        action: 'Make sure location services are enabled and try again.',
      };
  }
}

export function App() {
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [clockedIn, setClockedIn] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [employeeId, setEmployeeId] = useState('');
  const [password, setPassword] = useState('');
  const [auditEmployeeId, setAuditEmployeeId] = useState('');
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);

  async function refreshAccessToken() {
    const response = await fetch(`${API}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      setToken(null);
      setEmployee(null);
      setClockedIn(false);
      return null;
    }

    const data = await response.json();
    setToken(data.accessToken);
    setEmployee(data.employee);
    return data.accessToken as string;
  }

  async function apiFetch(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    let response = await fetch(`${API}${path}`, {
      ...options,
      headers,
      credentials: 'include',
    });

    if (response.status === 401) {
      const refreshed = await refreshAccessToken();

      if (!refreshed) {
        return response;
      }

      headers.set('Authorization', `Bearer ${refreshed}`);
      response = await fetch(`${API}${path}`, {
        ...options,
        headers,
        credentials: 'include',
      });
    }

    return response;
  }

  async function loadStatus(accessToken: string) {
    const response = await fetch(`${API}/attendance/status`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      credentials: 'include',
    });

    if (response.ok) {
      const data = await response.json();
      setClockedIn(Boolean(data.clockedIn));
    }
  }

  useEffect(() => {
    void (async () => {
      const accessToken = await refreshAccessToken();
      if (accessToken) {
        await loadStatus(accessToken);
      }
    })();
  }, []);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setFeedback(null);
    setLoading(true);

    try {
      const response = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ employeeId, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        setFeedback({ message: data.message ?? 'Login failed.' });
        return;
      }

      setToken(data.accessToken);
      setEmployee(data.employee);
      setPassword('');
      setFeedback({ message: 'Signed in successfully.' });
      await loadStatus(data.accessToken);
    } catch {
      setFeedback({
        message: 'The service could not be reached.',
        action: 'Check that the application is running and try again.',
      });
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    await fetch(`${API}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    setToken(null);
    setEmployee(null);
    setClockedIn(false);
    setAuditRows([]);
    setFeedback({ message: 'You have been signed out.' });
  }

  async function clock(type: 'clock-in' | 'clock-out') {
    if (!token) return;

    try {
      setLoading(true);
      setFeedback({ message: 'Getting your current location…' });

      const position = await getLocation();
      const response = await apiFetch(`/attendance/${type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
          locationTimestamp: new Date(position.timestamp).toISOString(),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setFeedback({
          message: data.message ?? 'The attendance request was rejected.',
          action: data.action ?? 'Please try again.',
        });
        return;
      }

      setClockedIn(type === 'clock-in');
      setFeedback({
        message: type === 'clock-in'
          ? 'Clock-in accepted.'
          : 'Clock-out accepted.',
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof (error as { code?: unknown }).code === 'number'
      ) {
        setFeedback(locationErrorMessage(error as GeolocationPositionError));
      } else {
        setFeedback({
          message: error instanceof Error
            ? error.message
            : 'Unable to obtain your location.',
          action: 'Make sure location services are enabled and try again.',
        });
      }
    } finally {
      setLoading(false);
    }
  }

  async function loadAudit() {
    if (!employee || (employee.role !== 'HR' && employee.role !== 'ADMIN')) {
      return;
    }

    const query = auditEmployeeId
      ? `?employeeId=${encodeURIComponent(auditEmployeeId)}`
      : '';

    const response = await apiFetch(`/audit/attendance${query}`);
    const data = await response.json();

    if (response.ok) {
      setAuditRows(data);
    } else {
      setFeedback({
        message: data.message ?? 'Unable to load the attendance audit trail.',
      });
      setAuditRows([]);
    }
  }

  if (!employee || !token) {
    return (
      <main className="shell">
        <section className="card">
          <h1>Secure Timeclock</h1>
          <p>Sign in with your Employee ID to record attendance.</p>

          <form onSubmit={login}>
            <label>
              Employee ID
              <input
                value={employeeId}
                onChange={(event) => setEmployeeId(event.target.value)}
                autoComplete="username"
                required
              />
            </label>

            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                minLength={4}
                required
              />
            </label>

            <button type="submit" disabled={loading}>
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          {feedback && (
            <div className="feedback">
              <strong>What happened</strong>
              <p>{feedback.message}</p>
              {feedback.action && (
                <>
                  <strong>What to do</strong>
                  <p>{feedback.action}</p>
                </>
              )}
            </div>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="card">
        <div className="topbar">
          <div>
            <h1>Good day, {employee.name}</h1>
            <p>Employee ID: {employee.employeeId}</p>
          </div>
          <button className="secondary" onClick={logout}>Sign out</button>
        </div>

        <p>
          When you clock in or out, the app uses your current location.
          Attendance is accepted when you are inside the configured attendance area.
        </p>

        <div className="status">
          Status: <strong>{clockedIn ? 'Clocked in' : 'Not clocked in'}</strong>
        </div>

        {!clockedIn ? (
          <button onClick={() => clock('clock-in')} disabled={loading}>
            {loading ? 'Please wait…' : 'Clock in'}
          </button>
        ) : (
          <button onClick={() => clock('clock-out')} disabled={loading}>
            {loading ? 'Please wait…' : 'Clock out'}
          </button>
        )}

        {feedback && (
          <div className="feedback">
            <strong>What happened</strong>
            <p>{feedback.message}</p>
            {feedback.action && (
              <>
                <strong>What to do</strong>
                <p>{feedback.action}</p>
              </>
            )}
          </div>
        )}

        {(employee.role === 'HR' || employee.role === 'ADMIN') && (
          <section className="audit">
            <h2>Attendance audit trail</h2>
            <p>
              Use this when a staff member asks HR why an attendance attempt
              was accepted or rejected.
            </p>

            <div className="audit-search">
              <input
                placeholder="Employee ID (optional)"
                value={auditEmployeeId}
                onChange={(event) => setAuditEmployeeId(event.target.value)}
              />
              <button onClick={loadAudit} disabled={loading}>View audit</button>
            </div>

            {auditRows.map((row) => (
              <article className="audit-row" key={row.id}>
                <strong>
                  {row.targetEmployee?.employeeId ?? 'Unknown employee'} — {row.action}
                </strong>
                <div>{row.result ?? 'UNKNOWN'}</div>
                <small>{new Date(row.createdAt).toLocaleString()}</small>
                {row.reason && <p>{row.reason}</p>}
              </article>
            ))}
          </section>
        )}
      </section>
    </main>
  );
}
