import { useEffect, useMemo, useState } from 'react';

const API = import.meta.env.VITE_API_URL ?? '/api';

type Feedback = { message: string; action?: string };
type Employee = { id: string; employeeId: string; name: string; division?: string | null; role: 'EMPLOYEE' | 'HR' | 'ADMIN' };
type Session = { clockInAt: string | null; clockOutAt: string | null } | null;
type AttendanceStatus = {
  state: 'NOT_STARTED' | 'CLOCKED_IN' | 'CLOCKED_OUT' | 'CLOCKED_OUT_WITHOUT_CLOCK_IN';
  clockedIn: boolean;
  session: Session;
  status: 'MET' | 'NOT_MET';
  officeHours: { start: string; end: string };
};
type AuditRow = {
  id: string;
  action: string;
  result: string | null;
  reason: string | null;
  createdAt: string;
  targetEmployee?: { employeeId: string; name: string } | null;
};

type ModalState = 'CLOCK_OUT' | 'CLOCK_OUT_WITHOUT_CLOCK_IN' | 'UPDATE_CLOCK_OUT' | null;

async function getLocation() {
  if (!navigator.geolocation) throw new Error('This browser does not provide location services.');
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
      return { message: 'Location permission was denied.', action: 'Allow location access for this site and try again.' };
    case error.POSITION_UNAVAILABLE:
      return { message: 'Your device could not determine its current location.', action: 'Move to an area with a clearer GPS signal and try again.' };
    case error.TIMEOUT:
      return { message: 'The location request timed out.', action: 'Make sure location services are enabled and try again.' };
    default:
      return { message: 'Unable to obtain your current location.', action: 'Make sure location services are enabled and try again.' };
  }
}

function formatTime(value?: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatDuration(clockIn?: string | null, clockOut?: string | null) {
  if (!clockIn || !clockOut) return '—';
  const minutes = Math.max(0, Math.round((new Date(clockOut).getTime() - new Date(clockIn).getTime()) / 60_000));
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function localDateInput(daysFromToday = 0) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + daysFromToday);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function App() {
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [attendance, setAttendance] = useState<AttendanceStatus | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [employeeId, setEmployeeId] = useState('');
  const [password, setPassword] = useState('');
  const [auditEmployeeId, setAuditEmployeeId] = useState('');
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [reportType, setReportType] = useState<'all' | 'division' | 'individual'>('all');
  const [reportDivision, setReportDivision] = useState('');
  const [reportEmployeeId, setReportEmployeeId] = useState('');
  const [reportFrom, setReportFrom] = useState(localDateInput(-6));
  const [reportTo, setReportTo] = useState(localDateInput());
  const [modal, setModal] = useState<ModalState>(null);
  const [loading, setLoading] = useState(false);

  async function refreshAccessToken() {
    const response = await fetch(`${API}/auth/refresh`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    if (!response.ok) {
      setToken(null); setEmployee(null); setAttendance(null); return null;
    }
    const data = await response.json();
    setToken(data.accessToken); setEmployee(data.employee);
    return data.accessToken as string;
  }

  async function apiFetch(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    let response = await fetch(`${API}${path}`, { ...options, headers, credentials: 'include' });
    if (response.status === 401) {
      const refreshed = await refreshAccessToken();
      if (!refreshed) return response;
      headers.set('Authorization', `Bearer ${refreshed}`);
      response = await fetch(`${API}${path}`, { ...options, headers, credentials: 'include' });
    }
    return response;
  }

  async function loadStatus(accessToken: string) {
    const response = await fetch(`${API}/attendance/status`, { headers: { Authorization: `Bearer ${accessToken}` }, credentials: 'include' });
    if (response.ok) setAttendance(await response.json());
  }

  useEffect(() => {
    void (async () => {
      const accessToken = await refreshAccessToken();
      if (accessToken) await loadStatus(accessToken);
    })();
  }, []);

  async function login(event: React.FormEvent) {
    event.preventDefault(); setFeedback(null); setLoading(true);
    try {
      const response = await fetch(`${API}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ employeeId, password }),
      });
      const data = await response.json();
      if (!response.ok) { setFeedback({ message: data.message ?? 'Login failed.' }); return; }
      setToken(data.accessToken); setEmployee(data.employee); setPassword(''); setFeedback({ message: 'Signed in successfully.' });
      await loadStatus(data.accessToken);
    } catch {
      setFeedback({ message: 'The service could not be reached.', action: 'Check that the application is running and try again.' });
    } finally { setLoading(false); }
  }

  async function logout() {
    await fetch(`${API}/auth/logout`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    setToken(null); setEmployee(null); setAttendance(null); setAuditRows([]); setFeedback({ message: 'You have been signed out.' });
  }

  const mainAction = useMemo(() => {
    if (!attendance || attendance.state === 'NOT_STARTED') return 'clock-in' as const;
    return 'clock-out' as const;
  }, [attendance]);

  function requestClockOut() {
    if (!attendance || attendance.state === 'NOT_STARTED') setModal('CLOCK_OUT_WITHOUT_CLOCK_IN');
    else if (attendance.state === 'CLOCKED_OUT') setModal('UPDATE_CLOCK_OUT');
    else setModal('CLOCK_OUT');
  }

  async function performClock(type: 'clock-in' | 'clock-out') {
    if (!token) return;
    try {
      setLoading(true); setFeedback({ message: 'Getting your current location…' });
      const position = await getLocation();
      const response = await apiFetch(`/attendance/${type}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
          locationTimestamp: new Date(position.timestamp).toISOString(),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setFeedback({ message: data.message ?? 'The attendance request was rejected.', action: data.action ?? 'Please try again.' });
        return;
      }
      await loadStatus(token);
      setFeedback({ message: type === 'clock-in' ? 'Clock-in accepted.' : 'Clock-out recorded.' });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'number') {
        setFeedback(locationErrorMessage(error as GeolocationPositionError));
      } else {
        setFeedback({ message: error instanceof Error ? error.message : 'Unable to obtain your location.', action: 'Make sure location services are enabled and try again.' });
      }
    } finally { setLoading(false); setModal(null); }
  }

  async function confirmClockOut() {
    await performClock('clock-out');
  }

  async function loadAudit() {
    if (!employee || (employee.role !== 'HR' && employee.role !== 'ADMIN')) return;
    const query = auditEmployeeId ? `?employeeId=${encodeURIComponent(auditEmployeeId)}` : '';
    const response = await apiFetch(`/audit/attendance${query}`);
    const data = await response.json();
    if (response.ok) setAuditRows(data);
    else { setFeedback({ message: data.message ?? 'Unable to load the attendance audit trail.' }); setAuditRows([]); }
  }

  async function downloadReport() {
    if (!employee || (employee.role !== 'HR' && employee.role !== 'ADMIN')) return;
    if (reportType === 'division' && !reportDivision.trim()) { setFeedback({ message: 'Select a division for the report.' }); return; }
    if (reportType === 'individual' && !reportEmployeeId.trim()) { setFeedback({ message: 'Enter an Employee ID for the report.' }); return; }
    setLoading(true); setFeedback(null);
    try {
      const params = new URLSearchParams({ from: reportFrom, to: reportTo });
      if (reportType === 'division') params.set('division', reportDivision.trim());
      if (reportType === 'individual') params.set('employeeId', reportEmployeeId.trim());
      const response = await apiFetch(`/reports/attendance.csv?${params.toString()}`);
      if (!response.ok) {
        const data = await response.json();
        setFeedback({ message: data.message ?? 'Unable to generate the report.' });
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = 'attendance-report.csv'; link.click();
      URL.revokeObjectURL(url);
      setFeedback({ message: 'Attendance CSV generated successfully.' });
    } catch {
      setFeedback({ message: 'Unable to generate the attendance report.', action: 'Check the date range and try again.' });
    } finally { setLoading(false); }
  }

  if (!employee || !token) {
    return (
      <main className="shell"><section className="card">
        <h1>Secure Timeclock</h1>
        <p>Sign in with your Employee ID to record attendance.</p>
        <form onSubmit={login}>
          <label>Employee ID<input value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} autoComplete="username" required /></label>
          <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" minLength={4} required /></label>
          <button type="submit" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'}</button>
        </form>
        {feedback && <div className="feedback"><strong>What happened</strong><p>{feedback.message}</p>{feedback.action && <><strong>What to do</strong><p>{feedback.action}</p></>}</div>}
      </section></main>
    );
  }

  const session = attendance?.session;
  const hasClockIn = Boolean(session?.clockInAt);
  const hasClockOut = Boolean(session?.clockOutAt);
  const statusClass = attendance?.status === 'MET' ? 'status-badge met' : hasClockOut ? 'status-badge not-met' : 'status-badge pending';

  return (
    <main className="shell">
      <section className="card">
        <div className="topbar">
          <div><h1>Good day, {employee.name}</h1><p>Employee ID: {employee.employeeId}</p></div>
          <button className="secondary" onClick={logout}>Sign out</button>
        </div>

        <div className="attendance-summary">
          <div><span>Clock in</span><strong>{formatTime(session?.clockInAt)}</strong></div>
          <div><span>Clock out</span><strong>{formatTime(session?.clockOutAt)}</strong></div>
          <div><span>Hours</span><strong>{formatDuration(session?.clockInAt, session?.clockOutAt)}</strong></div>
          <div><span>Office-hours status</span><strong className={statusClass}>{attendance?.status === 'MET' ? 'Met' : hasClockOut ? 'Not Met' : 'Pending'}</strong></div>
        </div>

        <p className="muted">Configured office hours: {attendance?.officeHours.start} – {attendance?.officeHours.end}</p>

        {mainAction === 'clock-in' ? (
          <button onClick={() => void performClock('clock-in')} disabled={loading}>{loading ? 'Please wait…' : 'Clock in'}</button>
        ) : (
          <button onClick={requestClockOut} disabled={loading}>{attendance?.state === 'CLOCKED_OUT' ? 'Update clock-out' : loading ? 'Please wait…' : 'Clock out'}</button>
        )}

        {mainAction === 'clock-in' && (
          <button className="secondary full-secondary" onClick={requestClockOut} disabled={loading}>Forgot to clock in? Clock out</button>
        )}

        {feedback && <div className="feedback"><strong>What happened</strong><p>{feedback.message}</p>{feedback.action && <><strong>What to do</strong><p>{feedback.action}</p></>}</div>}

        {(employee.role === 'HR' || employee.role === 'ADMIN') && (
          <section className="management">
            <h2>Management Reports</h2>
            <p>Generate a simple attendance CSV for an employee, division, or all staff.</p>
            <div className="report-grid">
              <label>Report<select value={reportType} onChange={(event) => setReportType(event.target.value as typeof reportType)}><option value="all">All staff</option><option value="division">Division</option><option value="individual">Individual staff</option></select></label>
              {reportType === 'division' && <label>Division<input value={reportDivision} onChange={(event) => setReportDivision(event.target.value)} placeholder="e.g. Finance" /></label>}
              {reportType === 'individual' && <label>Employee ID<input value={reportEmployeeId} onChange={(event) => setReportEmployeeId(event.target.value)} placeholder="Employee ID" /></label>}
              <label>From<input type="date" value={reportFrom} onChange={(event) => setReportFrom(event.target.value)} /></label>
              <label>To<input type="date" value={reportTo} onChange={(event) => setReportTo(event.target.value)} /></label>
            </div>
            <button onClick={() => void downloadReport()} disabled={loading}>Download CSV</button>
          </section>
        )}

        {(employee.role === 'HR' || employee.role === 'ADMIN') && (
          <section className="audit">
            <h2>Attendance audit</h2>
            <p>Technical evidence for troubleshooting attendance decisions.</p>
            <div className="audit-search"><input placeholder="Employee ID (optional)" value={auditEmployeeId} onChange={(event) => setAuditEmployeeId(event.target.value)} /><button onClick={loadAudit} disabled={loading}>View audit</button></div>
            {auditRows.map((row) => <article className="audit-row" key={row.id}><strong>{row.targetEmployee?.employeeId ?? 'Unknown employee'} — {row.action}</strong><div>{row.result ?? 'UNKNOWN'}</div><small>{new Date(row.createdAt).toLocaleString()}</small>{row.reason && <p>{row.reason}</p>}</article>)}
          </section>
        )}
      </section>

      {modal && (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="confirmation-title">
            <h2 id="confirmation-title">
              {modal === 'CLOCK_OUT_WITHOUT_CLOCK_IN' ? 'Clock-out without clock-in' : modal === 'UPDATE_CLOCK_OUT' ? 'Update clock-out' : 'Confirm clock-out'}
            </h2>
            <p>
              {modal === 'CLOCK_OUT_WITHOUT_CLOCK_IN'
                ? 'You have not clocked in today. Are you sure you want to clock out?'
                : modal === 'UPDATE_CLOCK_OUT'
                  ? `Your current clock-out is ${formatTime(session?.clockOutAt)}. The new clock-out will replace it.`
                  : 'Are you sure you want to clock out now?'}
            </p>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setModal(null)} disabled={loading}>Cancel</button>
              <button onClick={() => void confirmClockOut()} disabled={loading}>{loading ? 'Please wait…' : 'Confirm Clock-Out'}</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
