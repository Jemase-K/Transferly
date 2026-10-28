# Transferly

Transferly is a simple, mobile-first staff schedule for client airport pickups and drop-offs, train-station transfers, and rental-car handovers and returns. Staff can add and update bookings, mark journeys complete, and set reminders.

Transferly is owned by **Jemase Travellers & Hire**. The app displays this ownership notice, and the repository's MIT license preserves the copyright notice while allowing use, modification, and redistribution under its terms.

The app runs as a browser-based progressive web app and can be installed from Chrome on Android. With Firebase configured, approved staff share one live Firestore schedule across devices. Without Firebase configuration, the app runs in device-only preview mode.

## Features

- Schedule airport, train-station, and rental-car bookings.
- Record pickup and drop-off points, service price and currency, and who is responsible for payment.
- Track payments due after service, paid in advance, or paid after service, and update payment status from the schedule.
- Record client, date, time, reference, phone, notes, status, and reminder offset.
- Search and filter by today, upcoming, and completed bookings.
- Synchronize approved staff bookings in real time through Firebase Authentication and Cloud Firestore.
- Install on Android from the hosted HTTPS page.
- Enable device notifications for reminders while the app/browser is running. Mobile operating systems may pause background browser work, so reminders are not guaranteed after the app is fully closed.
- Keep shared schedule details hidden until an approved team account signs in; Firestore rules enforce access to synced booking data.

## Run a preview

Serve this folder through a local web server and open its address in a browser. The app will use local browser storage until Firebase is configured. Local-only bookings do not automatically migrate into the shared Firebase schedule.

## Set up Firebase for shared staff use

1. Create a Firebase project and register a **Web app** in that project.
2. In Firebase Authentication, enable **Google** sign-in.
3. Create the Cloud Firestore database.
4. Copy `firebase-config.example.js` to `firebase-config.js`, then replace the placeholder Firebase settings with the values for your web app. Keep `teamId` set to `main` on every device.
5. Configure the administrator and initial team email addresses in `firebase-config.js` and `firestore.rules`. Keep the administrator email the same in both places.
6. Install the Firebase CLI, sign in, and from this folder select your Firebase project with `firebase use --add`.
7. Deploy the site and rules with `firebase deploy`.
8. Open the hosted HTTPS address on each Android phone and sign in with an allowlisted Google account. Use Chrome's menu to install or add Transferly to the home screen.

Only verified Google accounts listed in both `firebase-config.js` and `firestore.rules` can access the shared schedule. Keep the lists aligned and keep the admin email configured in both places. This fixed allowlist replaces the in-app request-and-approval queue. Do not replace it with a rule that allows every signed-in user: bookings can contain client contact details.

Firebase's no-cost quotas and plan terms can change. Check the current Firebase pricing and Authentication documentation for your expected usage. Publishing this source code does not make hosting, maps, SMS, email, or other external services free.

## Configuration and privacy

`firebase-config.js` is intentionally excluded from version control. Firebase web configuration identifies the project and is visible to app users by design; it is not an authorization secret. Firestore Security Rules enforce access to booking data. Never add service-account keys, private credentials, real client records, or production exports to this repository.

Keep the staff email allowlist limited to company accounts. Device-only preview data is stored in that browser's local storage and is not shared between users or devices.

## License

Transferly is released under the MIT License. See [LICENSE](LICENSE).
