# Geofence Attendance

A self-contained, open-source employee clock-in and clock-out system using **Employee ID, password authentication, GPS location, server-side geofencing, configurable office hours, and management CSV reporting**.

The project is intentionally organization-neutral. A company deploying it supplies its own workplace coordinates, geofence radius, office hours, working days, employees, divisions, branding, and production secrets.

It does not require biometric devices, QR kiosks, Bluetooth beacons, NFC, cameras, dedicated GPS hardware, external attendance terminals, or background location tracking.

---

## What the system does

Employees use a browser to record attendance.

- Authentication uses Employee ID and password.
- Location is requested only when an attendance action is performed.
- The backend validates GPS accuracy, freshness, and geofence distance.
- The server generates the official attendance timestamps.
- The system records one attendance record per employee per working date.
- A second clock-in is rejected.
- A normal clock-out records the employee's departure time.
- A later clock-out can replace an earlier clock-out for the same day. This supports cases where an employee clocks out, is called back to work, and later leaves again.
- If an employee forgot to clock in, they may clock out after confirming the action in the application's custom confirmation modal.
- The system calculates actual time recorded in the office.
- The backend compares arrival and departure against configured office hours and produces **Met** or **Not Met** status.
- Authorized management users can export individual, division, or all-staff attendance reports for a selected date range as a simple CSV.

GPS is treated as location evidence, not cryptographic proof of physical presence.

---

## Attendance rules

### First attendance action of the day

If there is no attendance record for the employee on the current working date, the normal action is **Clock In**.

### Duplicate clock-in

A second clock-in on the same date is rejected. The backend enforces this rule.

### Normal clock-out

An employee who has clocked in can clock out. The server records the departure time.

### Updating a clock-out

Clock-out is not a permanently closed state.

Example:

```text
08:00  Clock In
16:00  Clock Out
16:05  Employee is called back to work
16:30  Clock Out again
```

The attendance record becomes:

```text
Clock In:  08:00
Clock Out: 16:30
```

The earlier 16:00 value is replaced for the management attendance record. The employee is not asked to provide a reason.

The system still retains technical attendance evidence for security and troubleshooting.

### Forgotten clock-in

If there is no clock-in for today and the employee selects Clock Out, the application displays a custom confirmation modal:

> You have not clocked in today. Are you sure you want to clock out?

This is an application modal, not a browser `confirm()` dialog.

If confirmed, the system records the clock-out while leaving clock-in empty. It does not invent a clock-in time.

---

## Office hours and attendance status

Every organization can define its own official office hours.

Example configuration:

```env
OFFICE_START_TIME=08:00
OFFICE_END_TIME=17:00
```

These are only examples. A deploying organization might use 07:30–16:30, 09:00–17:00, or another schedule.

The backend determines the attendance status:

**Met** when:

```text
Clock In <= configured office start
AND
Clock Out >= configured office end
```

Otherwise the status is **Not Met**.

Actual time in office is calculated independently:

```text
Clock Out - Clock In
```

Therefore, office hours determine **compliance**, while the actual timestamps determine **time recorded in the office**.

The web application uses a green status indicator for **Met** and a red status indicator for **Not Met**. An incomplete current-day record remains pending until the attendance information is complete.

---

## Workplace geofence configuration

The public repository must not contain an organization's real workplace coordinates.

The deployment environment supplies:

```env
OFFICE_LATITUDE=REPLACE_WITH_WORKPLACE_LATITUDE
OFFICE_LONGITUDE=REPLACE_WITH_WORKPLACE_LONGITUDE
OFFICE_RADIUS_METERS=100
```

The seed file contains a clearly marked configuration section showing where these values are used.

```text
Latitude  = workplace latitude
Longitude = workplace longitude
Radius    = permitted distance in metres
```

The backend performs the geofence calculation using PostGIS. The frontend cannot declare itself inside the workplace.

---

## Working days

Attendance reports should not mark weekends or other non-working days as failed attendance by default.

The public configuration therefore supports working days using ISO weekday numbers:

```env
# Monday=1 ... Sunday=7
WORKING_DAYS=1,2,3,4,5
```

Organizations can change this configuration to match their schedule.

---

## Timezone

Attendance dates, office-hour checks, and reports use the configured organization timezone:

```env
ATTENDANCE_TIMEZONE=UTC
```

Use a valid IANA timezone for the organization, for example `Africa/Accra` or `America/New_York`.

---

## Management CSV reporting

Authorized HR and administrator users can generate a CSV report using:

- Individual staff
- Division
- All staff
- A selected date range

The CSV is deliberately small and management-friendly.

### CSV columns

```text
Date
Staff Name
Employee ID
Division
Clock In
Clock Out
Hours
Status
```

Example:

```text
Date,Staff Name,Employee ID,Division,Clock In,Clock Out,Hours,Status
26/09/2026,John Doe,123456,Finance,07:55,17:10,9h 15m,Met
26/09/2026,Jane Doe,123457,Finance,08:20,17:05,8h 45m,Not Met
```

The CSV does not display GPS coordinates, GPS accuracy, IP addresses, user agents, or the organization's configured office hours. Management already knows the applicable schedule; the backend applies the configuration and outputs the resulting attendance status.

For a selected range, working days without an attendance record are represented with blank attendance times and **Not Met**, so an absent row is not silently mistaken for missing report data.

---

## Security model

### Backend authority

The frontend is an untrusted client. Important decisions are made by the backend.

### Server timestamps

Employees do not submit the official clock-in or clock-out time. The server generates it.

### Passwords

Passwords are hashed using Argon2id. Raw passwords are never stored.

### Sessions

The application uses short-lived access tokens and rotating refresh tokens. Refresh tokens are stored as hashes.

### Rate limiting

Redis is used for login rate limiting.

### GPS validation

The backend checks:

- GPS accuracy
- Location freshness
- Active workplace configuration
- Calculated distance from the workplace
- Attendance state

### No background tracking

The application does not continuously monitor employee locations. Browser location is requested only when an attendance action requires it.

### Evidence

Technical evidence is retained for accepted and rejected attendance attempts so authorized users can troubleshoot disputes and system failures.

---

## Technology stack

- React
- TypeScript
- Vite
- NestJS
- PostgreSQL
- PostGIS
- Prisma
- Redis
- Nginx
- Docker Compose
- Jest / Supertest

---

## Project structure

```text
geofence-attendance/
├── apps/
│   ├── api/
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   └── seed.ts
│   │   └── src/
│   │       ├── attendance/
│   │       ├── audit/
│   │       ├── auth/
│   │       ├── reports/
│   │       ├── app.module.ts
│   │       ├── main.ts
│   │       ├── prisma.service.ts
│   │       └── redis.service.ts
│   └── web/
│       └── src/
│           ├── App.tsx
│           ├── main.tsx
│           └── styles.css
├── docker/
│   └── postgres/
│       └── init.sql
├── nginx/
│   └── nginx.conf
├── docker-compose.yml
├── .env.example
├── .gitignore
├── LICENSE
├── package.json
└── README.md
```

---

## Configuration

Copy the example configuration:

```bash
cp .env.example .env
```

Then configure at minimum:

```env
DATABASE_URL=
REDIS_URL=
JWT_ACCESS_SECRET=
CORS_ORIGIN=

OFFICE_LATITUDE=
OFFICE_LONGITUDE=
OFFICE_RADIUS_METERS=100

OFFICE_START_TIME=08:00
OFFICE_END_TIME=17:00
ATTENDANCE_TIMEZONE=UTC
WORKING_DAYS=1,2,3,4,5

MAX_GPS_ACCURACY_METERS=100
MAX_LOCATION_AGE_SECONDS=120

SEED_EMPLOYEE_PASSWORD=
SEED_HR_PASSWORD=
```

Never commit `.env`.

---

## Running with Docker

```bash
docker compose up --build
```

The application is exposed through Nginx at:

```text
http://localhost:8080
```

For mobile GPS testing, use HTTPS. Modern mobile browsers generally require a secure context for geolocation.

Stop the application:

```bash
docker compose down
```

Remove the development database volume:

```bash
docker compose down -v
```

The last command destroys the local development database.

---

## Database setup

This project uses Prisma with PostgreSQL/PostGIS.

After changing the Prisma schema in development, synchronize the development database with:

```bash
npx prisma db push --schema apps/api/prisma/schema.prisma
```

Generate the Prisma client when needed:

```bash
npm --workspace apps/api run prisma:generate
```

This project intentionally keeps organization-specific deployment data out of the public source tree.

---

## Development seed

The seed creates fictional demonstration employees. Passwords are supplied through environment variables.

The seed also creates the configured workplace using:

```env
OFFICE_LATITUDE
OFFICE_LONGITUDE
OFFICE_RADIUS_METERS
```

Do not place real employee data or real organization coordinates in the public repository.

---

## API overview

### Authentication

```text
POST /auth/login
POST /auth/refresh
POST /auth/logout
```

### Attendance

```text
GET  /attendance/status
POST /attendance/clock-in
POST /attendance/clock-out
```

### Management report

```text
GET /reports/attendance.csv?from=YYYY-MM-DD&to=YYYY-MM-DD
```

Optional filters:

```text
employeeId=<Employee ID>
division=<Division>
```

The report endpoint is restricted to HR and administrator roles.

### Audit

```text
GET /audit/attendance
```

Audit access is restricted to HR and administrator roles.

---

## Testing expectations

Attendance testing should include at least:

- First clock-in of a day
- Duplicate clock-in
- Normal clock-out
- Clock-out without clock-in
- Confirmation of exceptional clock-out in the frontend
- Updating an existing clock-out
- New-day attendance state
- Poor GPS accuracy
- Stale GPS location
- Outside-geofence rejection
- Server-generated timestamps
- Office-hours Met status
- Office-hours Not Met status
- Actual hours calculation
- Individual CSV report
- Division CSV report
- All-staff CSV report
- Date-range filtering
- Missing attendance on working days
- Non-working days excluded from attendance failure rows
- Unauthorized management report access

---

## Production considerations

Before production deployment:

1. Use strong random JWT secrets.
2. Use HTTPS.
3. Configure the organization's real workplace coordinates privately.
4. Configure the organization's geofence radius privately.
5. Configure official office hours.
6. Configure working days.
7. Configure the organization timezone.
8. Remove or disable demonstration accounts.
9. Use a properly secured PostgreSQL deployment.
10. Configure database backups.
11. Review rate limits and GPS thresholds.
12. Review all authorization rules.

GPS is evidence supplied by a browser/device. It is not a cryptographic guarantee of physical presence.

---

## Public/private separation

This repository is intentionally generic.

A company-specific deployment should use a separate private repository or private deployment configuration for:

- Real employee records
- Real employee IDs
- Real workplace coordinates
- Organization branding
- Organization-specific policies
- Production secrets
- Internal infrastructure

Generic improvements can remain in this public project without exposing private organizational information.

---

## License

This project is released under the MIT License. See `LICENSE`.
