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

## Release gate

Do not merge this PR or enable production Calendar sync until these checks pass. OAuth connection, secure token storage, Calendar API operations, retries, and event reconciliation are not implemented in this phase.