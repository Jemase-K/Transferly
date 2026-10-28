# Transferly Google Calendar Integration — Per-Staff Design

**Status:** Proposed design; not active in production  
**Target branch:** `design/google-calendar-per-staff`  
**Scope:** Individual staff Google Calendars, staff-authorised OAuth, booking assignment, and reliable event lifecycle sync.

## 1. Decision

Each staff member connects their own Google account to Transferly. A booking is synchronised only to the Google Calendar belonging to its assigned staff member. Transferly's shared Firestore schedule remains the operational source of truth; Google Calendar is a per-assignee projection of that schedule.

Do not use a single shared service-account calendar, impersonate staff, or ask staff for Google passwords.

## 2. Current application facts and gap

- Transferly is a browser-based JavaScript PWA using Firebase Authentication and Cloud Firestore.
- Shared bookings are stored at `teams/{teamId}/bookings/{bookingId}`.
- Existing booking fields include client, type, direction, date, time, pickup/drop-off points, reference, phone, notes and status.
- New bookings currently receive `status: "scheduled"`; there is no staff-assignment field or Calendar integration.
- Existing Google sign-in is used for Transferly access. Firebase Google sign-in alone does **not** grant Google Calendar API access.
- Device-only preview/localStorage bookings cannot be reliably synchronised to a staff member's calendar. Calendar sync must be disabled in preview mode.

## 3. Booking data model

Add these fields to cloud booking documents:

- `assignedStaffUid: string | null` — Firebase Auth UID of the active staff member responsible for the booking. Required before Calendar sync; null means unassigned and not synced.
- `calendarSync.status` — `not_connected | pending | synced | error | skipped`.
- `calendarSync.assigneeUid` — UID whose Google Calendar currently contains the event.
- `calendarSync.eventId` — Google Calendar event ID.
- `calendarSync.calendarId` — target calendar ID (default to the connected user's primary calendar).
- `calendarSync.lastSyncedAt` — server timestamp.
- `calendarSync.lastErrorCode` — safe, non-sensitive diagnostic code only.

The `calendarSync` fields must be written by trusted backend code, not accepted from arbitrary client writes. Prefer a separate server-owned sync-state document or tightly restricted update path so ordinary booking edits cannot spoof sync state.

Existing bookings remain valid after deployment. They will not sync until an authorised staff member is assigned. Do not auto-assign old bookings to the person who happens to open Transferly.

## 4. Staff connection and authorisation

1. An approved Transferly staff member signs in using the existing Firebase Authentication flow.
2. A **Connect Google Calendar** action starts a separate Google OAuth authorisation-code flow with offline access and the minimum Calendar scope required to create, update and delete events (start with `https://www.googleapis.com/auth/calendar.events`).
3. A backend HTTPS function validates the signed-in Firebase identity, verifies the staff member is active in `teams/{teamId}/members/{uid}`, and handles the OAuth callback/code exchange.
4. Store refresh tokens only on the server, encrypted at rest using Cloud KMS (or an equivalent managed encryption design); never place refresh tokens, client secrets, or service credentials in browser JavaScript, the public repository, or ordinary logs.
5. Store connection metadata (Google account email, connected status, selected calendar ID, token expiry metadata) separately from booking documents. A staff member can disconnect and revoke access.
6. Use the authorised staff member's own OAuth grant to operate only on that member's selected calendar. Do not request broad Gmail, contacts, or full-calendar scopes.

OAuth consent screen, authorised redirect URI, Google Calendar API enablement, token encryption keys, and deployment secrets must be configured in the Google Cloud/Firebase project before live sync can work.

## 5. Assignment and permissions

- Add an **Assigned staff member** selector to create/edit booking forms. Populate it only from active, approved team members.
- Assignment is an operational field and must be validated server-side against the active team membership.
- An administrator or staff role permitted by the company's policy may assign/reassign bookings. Staff should not be able to assign a booking to an unapproved UID.
- If a booking has no assignee, retain it in the shared Transferly schedule and show Calendar sync as “Assign staff to sync.”
- If the assignee has not connected Calendar, keep the booking saved and show “Staff member needs to connect Google Calendar.” Do not silently redirect the event to the creator's calendar.
- Reassignment must remove/cancel the event from the former assignee's calendar and create the event on the new assignee's calendar. If the old calendar is disconnected or deletion fails, record a retryable sync error and surface it to an administrator.

## 6. Backend event lifecycle

Use Firebase Cloud Functions (or equivalent trusted backend) to react to booking writes. The browser must never call the Calendar API using a server-held token.

| Transferly change | Calendar action |
|---|---|
| New/updated scheduled booking with assigned, connected staff member | Create event if none exists; otherwise update the existing event |
| Date, time, route, notes, or assignee changes | Update event; on assignee change, remove old event and create new one |
| Booking marked completed | Keep the event and update its description/status, rather than deleting the historical appointment |
| Booking deleted/cancelled | Delete or cancel the matching event |
| Assignee not connected or booking unassigned | Skip sync and expose the reason in Transferly |
| Temporary API/network/token failure | Record retryable error; retry with backoff and provide an admin-visible sync status |

Use the booking ID to derive a stable, valid Google event ID (for example, a lowercase hexadecimal hash) and persist the returned event ID. Make processing idempotent: duplicate Firestore triggers must not create duplicate calendar events. Use bounded retries, a sync lease/transaction or equivalent concurrency guard, and a periodic reconciliation job to repair missed events.

## 7. Calendar event content and time

- Use the `Africa/Nairobi` time zone explicitly for start and end times.
- Current booking data has a start time but no duration. Introduce a configurable default duration (proposed initial default: 60 minutes) and allow it to be changed in settings or per booking before production use.
- Suggested title: `Transferly · Airport transfer · Pickup` (adapt labels to service type/direction).
- Include only operationally necessary details in the event. Avoid including customer phone numbers by default; consider client name, pickup/drop-off, reference and driver notes according to the company's privacy policy.
- Never include payment details or unnecessary personal data in the Calendar event.
- Calendar events should identify that Transferly is the source and include the booking ID in private event metadata where supported.

## 8. Security and Firestore rules

- Keep the existing verified-staff access model; extend rules only as needed for assignment and connection metadata.
- Validate assignment and role permissions in trusted backend code. Firestore rules should prevent clients from writing server-owned sync metadata.
- Keep OAuth client secrets and encryption material in managed secrets/KMS, not in `firebase-config.js` or the repository.
- Limit backend token access to the Calendar sync service; do not return refresh tokens to clients.
- Audit connection, disconnection, assignment/reassignment, sync failures and administrator repair actions without logging tokens or full customer records.
- Provide a disconnect/revoke flow and a way to delete stored token material.
- Confirm privacy notice/consent wording for staff and company policy on client details before enabling production sync.

## 9. UI changes

1. **Account / settings:** Calendar connection state, connected Google account, Connect, Reconnect, Disconnect, and calendar selection (primary calendar as the first default).
2. **Booking form:** Assigned staff member selector.
3. **Booking cards:** Assignee and a small sync state: Synced, Needs assignment, Staff needs to connect, or Sync error.
4. **Admin view:** Filter/report on Calendar connection and failed syncs; provide safe retry.
5. **Preview mode:** Explain that Calendar sync requires cloud sign-in and an assigned staff member.

## 10. Implementation sequence

1. Confirm staff roles and who may assign/reassign bookings; decide the default event duration and which booking details may appear in personal calendars.
2. Enable Google Calendar API and configure OAuth consent/client/redirect URIs in Google Cloud.
3. Add assignment field, active-member selector and Firestore rules/tests.
4. Add backend OAuth callback, encrypted token storage, connection/disconnection endpoints and status UI.
5. Add idempotent Cloud Function sync worker, stable event IDs, reassignment/deletion handling, retries and reconciliation.
6. Add UI status and admin repair tools.
7. Validate using test Google accounts/calendars and synthetic bookings before enabling production staff accounts.

## 11. Acceptance tests

- Unassigned booking does not create an event.
- Assigned booking syncs only to the assignee's authorised calendar, never the creator's calendar by default.
- Staff cannot assign a booking to an unknown/inactive team UID.
- Creating or updating a booking repeatedly results in one event.
- Changing assignee removes the old event and creates one on the new assignee's calendar.
- Completion preserves the event and marks it completed; deletion/cancellation removes or cancels it.
- Disconnected/revoked accounts and expired credentials produce a visible, recoverable sync error.
- Calendar API failure does not lose or block the Firestore booking.
- Events use `Africa/Nairobi` and the configured duration.
- No OAuth secrets or refresh tokens appear in browser payloads, logs, repository history or client-readable documents.
- Device-only preview bookings do not attempt cloud Calendar sync.

## 12. Deployment caveat

This document is a design only. No Google Cloud project settings, OAuth credentials, tokens, live Calendar events, or deployed Cloud Functions are created by adding it to the repository. Implementation and configuration are separate steps, and production sync must remain off until security rules and the acceptance tests pass.
