# Transferly Google Calendar Integration — Per-Staff Design

**Status:** Proposed design; not active in production  
**Target branch:** `design/google-calendar-per-staff`  
**Pull request:** [#1 — Design per-staff Google Calendar integration](https://github.com/Jemase-K/Transferly/pull/1)  
**Scope:** Individual staff Google Calendars, staff-authorised OAuth, assignment by any authorised staff member, configurable event duration, privacy-conscious event details, and reliable event lifecycle sync.

## 1. Confirmed product decisions

1. **Individual calendars:** Each staff member authorises their own Google account. A booking syncs only to the calendar of the staff member assigned to it.
2. **Assignment permissions:** Any currently authorised Transferly staff member may assign or reassign a booking to an active, approved team member. The backend must validate the acting user's current access and the target assignee's active team membership.
3. **Event duration:** Duration is configurable per booking or by service type. Use a configurable 60-minute fallback when neither a valid booking-specific duration nor a service-type default is set.
4. **Calendar privacy:** Include the client's name and phone number only when operationally necessary. Default to omitting the phone number and avoid putting unnecessary client data in a personal calendar. Provide an explicit, auditable way to indicate that contact details are operationally required.
5. **Safe delivery:** This remains a design-only change until implementation is tested. Do not merge to `main`, enable production sync, or connect real staff calendars as part of this design task.

Transferly's shared Firestore schedule remains the operational source of truth; Google Calendar is a per-assignee projection of that schedule. Do not use a single shared service-account calendar, impersonate staff, or ask staff for Google passwords.

## 2. Current application facts and gap

- Transferly is a browser-based JavaScript PWA using Firebase Authentication and Cloud Firestore.
- Shared bookings are stored at `teams/{teamId}/bookings/{bookingId}`.
- Existing booking fields include client, type, direction, date, time, pickup/drop-off points, reference, phone, notes and status.
- New bookings currently receive `status: "scheduled"`; there is no staff-assignment field, duration field, or Calendar integration.
- Existing Google sign-in is used for Transferly access. Firebase Google sign-in alone does **not** grant Google Calendar API access.
- Device-only preview/localStorage bookings cannot be reliably synchronised to a staff member's calendar. Calendar sync must be disabled in preview mode.

## 3. Booking and sync data model

Add these fields to cloud booking documents:

- `assignedStaffUid: string | null` — Firebase Auth UID of the active staff member responsible for the booking. Required before Calendar sync; null means unassigned and not synced.
- `durationMinutes: integer | null` — optional booking-specific duration. If null, use the configured service-type duration, then the configured global fallback (initially 60 minutes).
- `calendarContactDetailsRequired: boolean` — explicitly records that the booking requires client contact details in the calendar event. Default false; changing it should be auditable and limited to a genuine operational need.
- `calendarSync.status` — `not_connected | pending | synced | error | skipped`.
- `calendarSync.assigneeUid` — UID whose Google Calendar currently contains the event.
- `calendarSync.eventId` — Google Calendar event ID.
- `calendarSync.calendarId` — target calendar ID (default to the connected user's primary calendar).
- `calendarSync.lastSyncedAt` — server timestamp.
- `calendarSync.lastErrorCode` — safe, non-sensitive diagnostic code only.

Store service-type duration defaults and the global fallback in validated configuration. Validate duration as a positive integer within an administratively defined safe range (proposed initial range: 5–1,440 minutes). Reject invalid values rather than silently creating an event with a zero or negative duration. If both a booking-specific duration and a service-type default exist, the booking-specific value takes precedence.

The `calendarSync` fields must be written by trusted backend code, not accepted from arbitrary client writes. Prefer a separate server-owned sync-state document or tightly restricted update path so ordinary booking edits cannot spoof sync state.

Existing bookings remain valid after deployment. They will not sync until an authorised staff member is assigned. Do not auto-assign old bookings to the person who happens to open Transferly.

## 4. Staff connection and authorisation

1. An approved Transferly staff member signs in using the existing Firebase Authentication flow.
2. A **Connect Google Calendar** action starts a separate Google OAuth authorisation-code flow with offline access and the minimum Calendar scope required to create, update and delete events (start with `https://www.googleapis.com/auth/calendar.events`).
3. A backend HTTPS function validates the signed-in Firebase identity, verifies the staff member is active in `teams/{teamId}/members/{uid}`, and handles the OAuth callback/code exchange.
4. Store refresh tokens only on the server, encrypted at rest using Cloud KMS (or an equivalent managed encryption design); never place refresh tokens, client secrets, or service credentials in browser JavaScript, the public repository, or ordinary logs.
5. Store connection metadata (Google account email, connected status, selected calendar ID, token expiry metadata) separately from booking documents. A staff member can disconnect and revoke access.
6. Use the authorised staff member's own OAuth grant to operate only on that member's selected calendar. Do not request broad Gmail, contacts, or full-calendar scopes.

OAuth consent screen, authorised redirect URI, Google Calendar API enablement, token encryption keys, and deployment secrets must be configured in the Google Cloud/Firebase project before live sync can work. OAuth consent is distinct from being authorised to use Transferly.

## 5. Assignment and permissions

- Add an **Assigned staff member** selector to create/edit booking forms. Populate it only from active, approved team members.
- **All currently authorised Transferly staff may assign and reassign bookings.** The backend must validate both (a) the acting user's current active/approved team access and (b) the target assignee's active membership in the same team. Never trust a client-supplied UID or a UI-only check.
- Firestore rules and/or trusted callable/HTTPS functions must enforce assignment permissions and prevent unauthorised users from changing the assignee or server-owned sync metadata. Keep the existing team access boundary and verified-account checks.
- If a booking has no assignee, retain it in the shared Transferly schedule and show Calendar sync as “Assign staff to sync.”
- If the assignee has not connected Calendar, keep the booking saved and show “Staff member needs to connect Google Calendar.” Do not silently redirect the event to the creator's calendar.
- Reassignment must remove/cancel the event from the former assignee's calendar and create the event on the new assignee's calendar. If the old calendar is disconnected or deletion fails, record a retryable sync error and surface it for repair. Do not claim the move succeeded until the new event and old-event cleanup outcomes are recorded.
- Changes to assignment, contact-detail inclusion, and Calendar connection state should be auditable.

## 6. Backend event lifecycle

Use Firebase Cloud Functions (or equivalent trusted backend) to react to booking writes. The browser must never call the Calendar API using a server-held token.

| Transferly change | Calendar action |
|---|---|
| New/updated scheduled booking with assigned, connected staff member | Create event if none exists; otherwise update the existing event |
| Date, time, route, duration, notes, or assignee changes | Update event; on assignee change, remove old event and create new one |
| Booking marked completed | Keep the event and update its description/status, rather than deleting the historical appointment |
| Booking deleted/cancelled | Delete or cancel the matching event |
| Assignee not connected or booking unassigned | Skip sync and expose the reason in Transferly |
| Temporary API/network/token failure | Record retryable error; retry with backoff and provide a visible sync status |

Use the booking ID to derive a stable, valid Google event ID (for example, a lowercase hexadecimal hash) and persist the returned event ID. Make processing idempotent: duplicate Firestore triggers must not create duplicate calendar events. Use bounded retries, a sync lease/transaction or equivalent concurrency guard, and a periodic reconciliation job to repair missed events.

## 7. Calendar event content, privacy and time

- Use the `Africa/Nairobi` time zone explicitly for event start and end times.
- Calculate end time from the resolved duration: booking-specific `durationMinutes`, then service-type default, then global fallback (initially 60 minutes). Persist or expose the resolved duration for troubleshooting so staff understand the time block being created.
- Suggested title: `Transferly · Airport transfer · Pickup` (adapt labels to service type/direction). Avoid putting the client's name or phone number in the event title.
- Default event content should be operationally useful but data-minimising: service type/direction, time, pickup/drop-off, booking reference where appropriate, and concise driver instructions. Do not include payment details or unnecessary personal data.
- **Client name:** include only where it is needed for staff to identify or carry out the booking; otherwise omit it from the event.
- **Client phone number:** omit by default. Include it only when the operational workflow genuinely requires direct contact and the booking's `calendarContactDetailsRequired` flag is explicitly enabled. The UI should explain the choice, and the action should be auditable. Avoid copying the number into logs or sync error messages.
- Consider the visibility of staff members' personal calendars and inform staff what booking data may be synchronised. Follow company privacy policy and applicable data-protection requirements.
- Calendar events should identify Transferly as the source and include the booking ID in private event metadata where supported.

## 8. Security and Firestore rules

- Keep the existing verified-staff access model; extend rules only as needed for assignment and connection metadata.
- Validate assignment and role permissions in trusted backend code. Firestore rules should prevent clients from writing server-owned sync metadata and should validate that only an authorised staff member can make permitted booking changes.
- Keep OAuth client secrets and encryption material in managed secrets/KMS, not in `firebase-config.js` or the repository.
- Limit backend token access to the Calendar sync service; do not return refresh tokens to clients.
- Audit connection, disconnection, assignment/reassignment, contact-detail inclusion, sync failures and administrator repair actions without logging tokens or full customer records.
- Provide a disconnect/revoke flow and a way to delete stored token material.
- Confirm privacy notice/consent wording for staff and company policy on client details before enabling production sync.

## 9. UI changes

1. **Account / settings:** Calendar connection state, connected Google account, Connect, Reconnect, Disconnect, and calendar selection (primary calendar as the first default).
2. **Booking form:** Assigned staff member selector available to every authorised staff member; configurable duration; an optional, clearly explained control to include client contact details only when operationally required.
3. **Service settings:** Configurable default duration for each service type and a global fallback duration (initially 60 minutes). Validate values and show which duration will apply.
4. **Booking cards:** Assignee and a small sync state: Synced, Needs assignment, Staff needs to connect, or Sync error.
5. **Admin/operations view:** Report on Calendar connection and failed syncs; provide safe retry. Assignment itself is available to all authorised staff, not restricted to admins.
6. **Preview mode:** Explain that Calendar sync requires cloud sign-in, a valid assignment, and an authorised Calendar connection.

## 10. Implementation sequence

1. Add assignment, duration and privacy fields; add active-member selection and validation.
2. Confirm Firestore rules and backend validation tests for the decision that all authorised staff may assign/reassign bookings.
3. Enable Google Calendar API and configure Google OAuth consent/client/redirect URIs in Google Cloud.
4. Add backend OAuth callback, encrypted token storage, connection/disconnection endpoints and connection status UI.
5. Add idempotent Cloud Function sync worker, stable event IDs, duration resolution, privacy-aware event construction, reassignment/deletion handling, retries and reconciliation.
6. Add sync status UI, service-duration settings, contact-detail inclusion control and safe repair tools.
7. Validate with test Google accounts/calendars and synthetic bookings before enabling production staff accounts.

## 11. Acceptance tests

- Unassigned booking does not create an event.
- Any authorised staff member can assign/reassign a booking; unauthorised or inactive accounts cannot.
- Backend rejects assignments to unknown/inactive team UIDs even if the client bypasses the UI.
- Assigned booking syncs only to the assignee's authorised calendar, never the creator's calendar by default.
- Creating or updating a booking repeatedly results in one event.
- Changing assignee removes the old event and creates one on the new assignee's calendar; partial failure is visible and retryable.
- A valid per-booking duration overrides the service-type default; the service-type default overrides the global fallback; the initial global fallback is 60 minutes.
- Invalid duration values are rejected and do not create malformed events.
- Client name is omitted when not operationally necessary; phone number is omitted by default and appears only when the explicit operational-need flag is set.
- Contact-detail inclusion changes are audited and do not expose customer data in logs.
- Completion preserves the event and marks it completed; deletion/cancellation removes or cancels it.
- Disconnected/revoked accounts and expired credentials produce a visible, recoverable sync error.
- Calendar API failure does not lose or block the Firestore booking.
- Events use `Africa/Nairobi` and the resolved configured duration.
- No OAuth secrets or refresh tokens appear in browser payloads, logs, repository history or client-readable documents.
- Device-only preview bookings do not attempt cloud Calendar sync.
- Production sync remains disabled until the security and acceptance tests pass.

## 12. Deployment and release gate

This document is a design only. No Google Cloud project settings, OAuth credentials, tokens, live Calendar events, or deployed Cloud Functions are created by this document update. Implementation and configuration are separate steps.

Keep this work on `design/google-calendar-per-staff` and the associated draft pull request. **Do not merge to `main` or enable production Calendar sync until the implementation has passed security review and the acceptance tests above using synthetic bookings and test Google accounts.** Before production release, review Firestore rules, OAuth consent and scopes, token encryption/access, privacy wording, retry/reconciliation behaviour, and a documented rollback/disconnect procedure.
