const {initializeTestEnvironment, assertFails, assertSucceeds} = require('@firebase/rules-unit-testing');
const {doc, setDoc, updateDoc, getDoc, Timestamp} = require('firebase/firestore');
const fs = require('node:fs');

const projectId = 'demo-transferly-calendar-rules';
let env;
const allowed = {email: 'admin@example.com', email_verified: true};
const staff = {email: 'staff@example.com', email_verified: true};
const outsider = {email: 'outsider@example.com', email_verified: true};

function booking(extra = {}) {
  return {client: 'Synthetic Test Client', type: 'airport', date: '2026-11-01', time: '10:00', status: 'scheduled', ...extra};
}
function settings(email) {
  return {
    defaultDurationMinutes: 60,
    serviceTypeDurations: {airport: 90, train: 45, rental: 120},
    updatedAt: Timestamp.now(),
    updatedBy: email
  };
}
async function seed(path, data) {
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), path), data);
  });
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId,
    firestore: {rules: fs.readFileSync('firestore.rules', 'utf8')}
  });
  await seed('teams/main/members/admin-uid', {uid: 'admin-uid', email: 'admin@example.com', active: true});
  await seed('teams/main/members/staff-uid', {uid: 'staff-uid', email: 'staff@example.com', active: true});
  await seed('teams/main/members/inactive-uid', {uid: 'inactive-uid', email: 'inactive@example.com', active: false});
});

after(async () => { if (env) await env.cleanup(); });

test('authorised staff can create a booking assigned to an active member', async () => {
  const db = env.authenticatedContext('staff-uid', staff).firestore();
  await assertSucceeds(setDoc(doc(db, 'teams/main/bookings/booking-valid'), booking({assignedStaffUid: 'admin-uid', durationMinutes: 90})));
});

test('authorised staff cannot assign a booking to an inactive or missing member', async () => {
  const db = env.authenticatedContext('staff-uid', staff).firestore();
  await assertFails(setDoc(doc(db, 'teams/main/bookings/booking-inactive'), booking({assignedStaffUid: 'inactive-uid'})));
  await assertFails(setDoc(doc(db, 'teams/main/bookings/booking-missing'), booking({assignedStaffUid: 'missing-uid'})));
});

test('duration validation rejects values outside the permitted range', async () => {
  const db = env.authenticatedContext('staff-uid', staff).firestore();
  await assertFails(setDoc(doc(db, 'teams/main/bookings/booking-too-short'), booking({durationMinutes: 4})));
  await assertFails(setDoc(doc(db, 'teams/main/bookings/booking-too-long'), booking({durationMinutes: 1441})));
  await assertFails(setDoc(doc(db, 'teams/main/bookings/booking-fractional'), booking({durationMinutes: 15.5})));
});

test('client cannot set server-owned calendarSync metadata', async () => {
  const db = env.authenticatedContext('staff-uid', staff).firestore();
  await assertFails(setDoc(doc(db, 'teams/main/bookings/booking-forged-sync'), booking({calendarSync: {status: 'synced', eventId: 'fake'}})));
  await assertSucceeds(setDoc(doc(db, 'teams/main/bookings/booking-sync-source'), booking()));
  await assertFails(updateDoc(doc(db, 'teams/main/bookings/booking-sync-source'), {calendarSync: {status: 'synced', eventId: 'fake'}}));
});

test('unauthorised users cannot read or write bookings or settings', async () => {
  const db = env.authenticatedContext('outsider-uid', outsider).firestore();
  await assertFails(getDoc(doc(db, 'teams/main/bookings/booking-valid')));
  await assertFails(setDoc(doc(db, 'teams/main/bookings/booking-outsider'), booking()));
  await assertFails(setDoc(doc(db, 'teams/main/settings/calendar'), settings('outsider@example.com')));
});

test('authorised staff can save valid shared duration defaults', async () => {
  const db = env.authenticatedContext('staff-uid', staff).firestore();
  await assertSucceeds(setDoc(doc(db, 'teams/main/settings/calendar'), settings('staff@example.com')));
});

test('staff cannot alter existing server-owned calendarSync metadata', async () => {
  await seed('teams/main/bookings/booking-server-sync', booking({calendarSync: {status: 'synced', eventId: 'real-event'}}));
  const db = env.authenticatedContext('staff-uid', staff).firestore();
  await assertFails(updateDoc(doc(db, 'teams/main/bookings/booking-server-sync'), {calendarSync: {status: 'forged', eventId: 'fake'}}));
});
