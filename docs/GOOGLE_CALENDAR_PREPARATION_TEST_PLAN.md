# Transferly booking assignment and duration validation checklist

**Scope:** First implementation phase for the per-staff Google Calendar integration.
**Status:** Test plan only; do not treat these cases as passed until run against a configured test Firebase project.
**Safety:** Do not use real customer records or production Google calendars.

## Before testing

- Use a dedicated Firebase test project or emulator.
- Configure the verified-staff email allowlist in both the Firebase web config and deployed Firestore rules.
- Deploy the updated Firestore rules to the test project before testing assignment or shared duration settings.
- Sign in with at least two approved test staff accounts and one non-allowlisted test account.
- Keep Calendar API sync disabled. This phase only stores assignment and duration metadata.

## Booking assignment

- [ ] Approved staff can create a booking without an assignee; it displays Unassigned.
- [ ] Active member documents appear in the assignee dropdown.
- [ ] Any approved staff member can assign a booking to another active team member.
- [ ] Editing a booking preserves its assignee unless changed.
- [ ] A user cannot assign a booking to a UID that has no active member document; Firestore rejects the write even if the UI is bypassed.
- [ ] Inactive staff do not appear as available choices.
- [ ] Existing bookings without assignedStaffUid still load and remain editable.
- [ ] Device-only preview remains local and does not claim to sync to Google Calendar.

## Duration configuration

- [ ] Blank booking-specific duration resolves to the selected service type's shared default.
- [ ] A valid booking-specific duration overrides the service-type default.
- [ ] Changing the service type updates the duration helper text.
- [ ] The global fallback is used when a service-type setting is absent or invalid.
- [ ] Values below 5, above 1,440, fractional values, and non-numeric values are rejected.
- [ ] Shared defaults save and load across two approved staff accounts.
- [ ] An unauthorised account cannot read or modify team duration settings.
- [ ] The schedule displays the resolved duration for each booking.

## Privacy flag and sync-state boundary

- [ ] The contact-details flag defaults to unchecked for new bookings.
- [ ] The flag can be saved and edited as a booking field; no Calendar event is created in this phase.
- [ ] A client cannot add or modify server-owned calendarSync metadata using normal Firestore writes.
- [ ] Staff approval/review flow still creates active member documents for newly approved staff.
- [ ] Self-initialisation of a member document works only for an allowlisted verified account whose email matches the authenticated identity.

## Regression checks

- [ ] Create, edit, complete, mark paid/unpaid, and delete a booking.
- [ ] Search and all schedule filters still work.
- [ ] Reminder scheduling still works as before.
- [ ] Mobile layout remains usable in the booking dialog and duration settings panel.
- [ ] Check browser console for errors on sign-in, sign-out, opening/editing bookings, and saving duration settings.

## Google OAuth and Calendar event lifecycle (test project only)

- [ ] With the feature flag false, OAuth start is rejected and no event sync is performed.
- [ ] With the flag true only in a dedicated test project, an approved staff member can start the OAuth flow.
- [ ] OAuth callback rejects missing, expired, replayed, or invalid state.
- [ ] Connecting with a different Google email than the Transferly staff account is rejected.
- [ ] Refresh tokens are encrypted in server-only Firestore documents; the browser cannot read the connection documents.
- [ ] A connected assigned booking creates exactly one event on that assignee's primary calendar.
- [ ] Updating date, time, route, notes or duration updates the same event rather than creating duplicates.
- [ ] Event times use Africa/Nairobi and the resolved booking/service/global duration.
- [ ] Client name and phone are omitted by default; they are included only when the operational-need flag is enabled.
- [ ] Reassignment removes the prior event and creates one on the new assignee's calendar.
- [ ] Marking completed preserves the event and reflects completion; deleting a booking removes its tracked event.
- [ ] Disconnect removes tracked Transferly events before revoking the saved grant; failed cleanup/revocation remains visible and retryable.
- [ ] Expired/revoked tokens and Calendar API failures do not expose tokens or customer data in logs.
- [ ] Feature flag is verified false in production configuration and no production account/calendar was used during testing.

## Release gate

Do not merge this PR or enable production Calendar sync until these checks pass. OAuth connection, secure token storage, Calendar API operations, retries, and event reconciliation are not implemented in this phase.