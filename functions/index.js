const {setGlobalOptions} = require('firebase-functions/v2');
const {onCall, onRequest, HttpsError} = require('firebase-functions/v2/https');
const {onDocumentWritten} = require('firebase-functions/v2/firestore');
const {defineSecret, defineString} = require('firebase-functions/params');
const admin = require('firebase-admin');
const {google} = require('googleapis');
const crypto = require('node:crypto');

admin.initializeApp();
setGlobalOptions({region: 'us-central1'});
const db = admin.firestore();
const CLIENT_ID = defineSecret('GOOGLE_OAUTH_CLIENT_ID');
const CLIENT_SECRET = defineSecret('GOOGLE_OAUTH_CLIENT_SECRET');
const REDIRECT_URI = defineSecret('GOOGLE_OAUTH_REDIRECT_URI');
const TOKEN_KEY = defineSecret('CALENDAR_TOKEN_ENCRYPTION_KEY');
const APP_URL = defineSecret('TRANSFERLY_APP_URL');
const SYNC_ENABLED = defineString('CALENDAR_SYNC_ENABLED', {default: 'false'});
const SCOPE = ['https://www.googleapis.com/auth/calendar.events', 'openid', 'email'];
const TZ = 'Africa/Nairobi';

function syncEnabled() { return SYNC_ENABLED.value().toLowerCase() === 'true'; }
function oauthClient() { return new google.auth.OAuth2(CLIENT_ID.value(), CLIENT_SECRET.value(), REDIRECT_URI.value()); }
function teamRef(teamId) { return db.collection('teams').doc(teamId); }
function memberRef(teamId, uid) { return teamRef(teamId).collection('members').doc(uid); }
function connectionRef(teamId, uid) { return teamRef(teamId).collection('calendarConnections').doc(uid); }
function stateRef(teamId, stateHash) { return teamRef(teamId).collection('calendarOAuthStates').doc(stateHash); }
function bookingRef(teamId, bookingId) { return teamRef(teamId).collection('bookings').doc(bookingId); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeCode(error) { const status = Number(error?.code || error?.response?.status || 0); if (status === 401 || status === 403) return 'CALENDAR_AUTH_FAILED'; if (status === 404) return 'CALENDAR_EVENT_NOT_FOUND'; if (status === 429) return 'CALENDAR_RATE_LIMITED'; return 'CALENDAR_SYNC_FAILED'; }
function encryptToken(token) { const key = Buffer.from(TOKEN_KEY.value(), 'base64'); if (key.length !== 32) throw new Error('CALENDAR_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key'); const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]); return {version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64')}; }
function decryptToken(value) { const key = Buffer.from(TOKEN_KEY.value(), 'base64'); if (key.length !== 32 || value?.version !== 1) throw new Error('Invalid token encryption configuration'); const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64')); decipher.setAuthTag(Buffer.from(value.tag, 'base64')); return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8'); }
async function assertActiveMember(teamId, uid, email) { const snap = await memberRef(teamId, uid).get(); if (!snap.exists || snap.data().active !== true || String(snap.data().email || '').toLowerCase() !== String(email || '').toLowerCase()) throw new HttpsError('permission-denied', 'An active Transferly staff membership is required.'); }
function requireFeature() { if (!syncEnabled()) throw new HttpsError('failed-precondition', 'Google Calendar integration is disabled until testing is complete.'); }

exports.calendarOAuthStart = onCall({secrets: [CLIENT_ID, CLIENT_SECRET, REDIRECT_URI]}, async request => {
  requireFeature();
  if (!request.auth || request.auth.token.email_verified !== true) throw new HttpsError('unauthenticated', 'Sign in with a verified Google account first.');
  const teamId = 'main';
  await assertActiveMember(teamId, request.auth.uid, request.auth.token.email);
  const rawState = crypto.randomBytes(32).toString('hex');
  const stateHash = hash(rawState);
  await stateRef(teamId, stateHash).set({uid: request.auth.uid, email: request.auth.token.email, status: 'pending', createdAt: admin.firestore.FieldValue.serverTimestamp(), expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60 * 1000)});
  const url = oauthClient().generateAuthUrl({access_type: 'offline', prompt: 'consent', include_granted_scopes: true, scope: SCOPE, state: rawState});
  return {url};
});

exports.calendarConnectionStatus = onCall(async request => {
  if (!request.auth || request.auth.token.email_verified !== true) throw new HttpsError('unauthenticated', 'Sign in first.');
  const teamId = 'main';
  await assertActiveMember(teamId, request.auth.uid, request.auth.token.email);
  const snap = await connectionRef(teamId, request.auth.uid).get();
  return {connected: snap.exists && snap.data().connected === true, googleEmail: snap.exists ? (snap.data().googleEmail || null) : null, syncEnabled: syncEnabled()};
});

exports.calendarDisconnect = onCall({secrets: [CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, TOKEN_KEY]}, async request => {
  if (!request.auth || request.auth.token.email_verified !== true) throw new HttpsError('unauthenticated', 'Sign in first.');
  const teamId = 'main';
  await assertActiveMember(teamId, request.auth.uid, request.auth.token.email);
  const connection = connectionRef(teamId, request.auth.uid);
  const snap = await connection.get();
  if (!snap.exists || !snap.data().encryptedRefreshToken) return {disconnected: true};
  const bookings = await teamRef(teamId).collection('bookings').where('assignedStaffUid', '==', request.auth.uid).get();
  for (const doc of bookings.docs) {
    if (doc.data().calendarSync?.eventId) {
      try { await deleteCalendarEvent(teamId, request.auth.uid, doc.id, doc.data().calendarSync.calendarId); }
      catch (error) { console.error('Calendar disconnect cleanup failed', {bookingId: doc.id, code: safeCode(error)}); throw new HttpsError('failed-precondition', 'Some Transferly events could not be removed. Reconnect and retry before disconnecting.'); }
    }
  }
  const refreshToken = decryptToken(snap.data().encryptedRefreshToken);
  try { await oauthClient().revokeToken(refreshToken); } catch (error) { console.error('Google token revocation returned an error', {code: safeCode(error)}); throw new HttpsError('failed-precondition', 'Google did not confirm revocation. Retry disconnect; the saved connection has not been removed.'); }
  await connection.delete();
  const batch = db.batch();
  for (const doc of bookings.docs) {
    batch.update(doc.ref, {calendarSync: {status: 'not_connected', assigneeUid: request.auth.uid, eventId: null, calendarId: null, lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(), lastErrorCode: null}});
  }
  await batch.commit();
  return {disconnected: true};
});

exports.calendarOAuthCallback = onRequest({secrets: [CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, TOKEN_KEY, APP_URL]}, async (req, res) => {
  if (!syncEnabled()) return res.status(503).send('Transferly Google Calendar integration is disabled until testing is complete.');
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const rawState = typeof req.query.state === 'string' ? req.query.state : '';
  if (!code || !rawState) return res.status(400).send('Missing Google authorisation response. You can close this page and return to Transferly.');
  const teamId = 'main';
  const stateDocument = stateRef(teamId, hash(rawState));
  let state;
  let claimedState = false;
  try {
    await db.runTransaction(async tx => { const snap = await tx.get(stateDocument); if (!snap.exists || snap.data().status !== 'pending' || snap.data().expiresAt.toMillis() < Date.now()) throw new Error('Invalid or expired OAuth state'); state = snap.data(); tx.update(stateDocument, {status: 'processing', processingAt: admin.firestore.FieldValue.serverTimestamp()}); claimedState = true; });
    await assertActiveMember(teamId, state.uid, state.email);
    const client = oauthClient();
    const {tokens} = await client.getToken(code);
    if (!tokens.access_token) throw new Error('Google did not return an access token');
    client.setCredentials(tokens);
    const tokenInfo = await client.getTokenInfo(tokens.access_token);
    const googleEmail = String(tokenInfo.email || '').toLowerCase();
    if (!googleEmail || googleEmail !== String(state.email || '').toLowerCase()) throw new Error('Connect using the same Google account used to sign in to Transferly.');
    const connection = connectionRef(teamId, state.uid);
    const oldSnap = await connection.get();
    const old = oldSnap.exists ? oldSnap.data() : null;
    const refreshToken = tokens.refresh_token || (old?.encryptedRefreshToken ? decryptToken(old.encryptedRefreshToken) : null);
    if (!refreshToken) throw new Error('Google did not return a refresh token; disconnect the existing grant in Google Account settings and reconnect.');
    await connection.set({uid: state.uid, connected: true, googleEmail, calendarId: 'primary', encryptedRefreshToken: encryptToken(refreshToken), connectedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(), tokenExpiryDate: tokens.expiry_date || null}, {merge: true});
    await stateDocument.update({status: 'complete', completedAt: admin.firestore.FieldValue.serverTimestamp()});
    const bookings = await teamRef(teamId).collection('bookings').where('assignedStaffUid', '==', state.uid).get();
    for (const doc of bookings.docs) { try { await syncBooking(teamId, doc.id, null, doc.data()); } catch (error) { console.error('Calendar initial sync failed', {bookingId: doc.id, code: safeCode(error)}); } }
    const destination = new URL(APP_URL.value()); destination.searchParams.set('calendar', 'connected');
    return res.redirect(303, destination.toString());
  } catch (error) {
    console.error('Google Calendar OAuth callback failed', {code: safeCode(error)});
    if (claimedState) { try { await stateDocument.update({status: 'error', failedAt: admin.firestore.FieldValue.serverTimestamp(), errorCode: safeCode(error)}); } catch (_) {} }
    return res.status(400).send('Could not connect Google Calendar. Return to Transferly and try again. No token details are displayed here.');
  }
});

function resolveDuration(booking, settings) {
  const value = booking.durationMinutes ?? settings?.serviceTypeDurations?.[booking.type] ?? settings?.defaultDurationMinutes ?? 60;
  if (!Number.isInteger(value) || value < 5 || value > 1440) throw new Error('Invalid event duration');
  return value;
}
function wallTime(date, time, durationMinutes) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^\d{2}:\d{2}$/.test(String(time))) throw new Error('Invalid booking date or time');
  const start = new Date(`${date}T${time}:00Z`);
  if (Number.isNaN(start.getTime())) throw new Error('Invalid booking date or time');
  const end = new Date(start.getTime() + durationMinutes * 60000);
  return {start: `${date}T${time}:00`, end: `${end.toISOString().slice(0, 19)}`};
}
function eventId(teamId, bookingId) { return hash(`${teamId}:${bookingId}`); }
function eventPayload(booking, settings, bookingId) {
  const duration = resolveDuration(booking, settings);
  const times = wallTime(booking.date, booking.time, duration);
  const service = ({airport: 'Airport transfer', train: 'Train station transfer', rental: 'Car rental'})[booking.type] || 'Transferly booking';
  const direction = ({pickup: 'Pickup', dropoff: 'Drop-off', handover: 'Handover', collection: 'Collection'})[booking.direction] || 'Service';
  const lines = [`Service: ${service}`, `Direction: ${direction}`, `Pickup: ${booking.pickupPoint || booking.location || 'Not set'}`, `Drop-off: ${booking.dropoffPoint || booking.location || 'Not set'}`, `Booking reference: ${booking.reference || bookingId}`, `Duration: ${duration} minutes`];
  if (booking.calendarContactDetailsRequired === true) { if (booking.client) lines.push(`Client: ${booking.client}`); if (booking.phone) lines.push(`Client phone: ${booking.phone}`); }
  if (booking.notes) lines.push(`Driver notes: ${booking.notes}`);
  if (booking.status === 'completed') lines.push('Transferly status: completed');
  return {id: eventId('main', bookingId), summary: `Transferly · ${service} · ${direction}`, description: lines.join('\n'), start: {dateTime: times.start, timeZone: TZ}, end: {dateTime: times.end, timeZone: TZ}, extendedProperties: {private: {transferlyBookingId: bookingId, source: 'Transferly'}}};
}
async function calendarFor(teamId, uid) {
  const snap = await connectionRef(teamId, uid).get();
  if (!snap.exists || snap.data().connected !== true || !snap.data().encryptedRefreshToken) throw new Error('Calendar account is not connected');
  const client = oauthClient(); client.setCredentials({refresh_token: decryptToken(snap.data().encryptedRefreshToken)});
  return {api: google.calendar({version: 'v3', auth: client}), calendarId: snap.data().calendarId || 'primary'};
}
async function deleteCalendarEvent(teamId, uid, bookingId, calendarId) {
  if (!uid) return;
  const {api, calendarId: connectedCalendarId} = await calendarFor(teamId, uid);
  try { await api.events.delete({calendarId: calendarId || connectedCalendarId, eventId: eventId(teamId, bookingId)}); }
  catch (error) { if (Number(error?.code || error?.response?.status) !== 404) throw error; }
}
async function syncBooking(teamId, bookingId, before, after) {
  const beforeUid = before?.assignedStaffUid || before?.calendarSync?.assigneeUid || null;
  const afterUid = after?.assignedStaffUid || null;
  if (beforeUid && (before?.calendarSync?.eventId || before?.calendarSync?.status === 'error') && (!after || beforeUid !== afterUid)) await deleteCalendarEvent(teamId, beforeUid, bookingId, before?.calendarSync?.calendarId);
  if (!after) return;
  const ref = bookingRef(teamId, bookingId);
  if (!afterUid) { await ref.update({calendarSync: {status: 'skipped', assigneeUid: null, eventId: null, calendarId: null, lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(), lastErrorCode: null}}); return; }
  const connection = await connectionRef(teamId, afterUid).get();
  if (!connection.exists || connection.data().connected !== true) { await ref.update({calendarSync: {status: 'not_connected', assigneeUid: afterUid, eventId: null, calendarId: null, lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(), lastErrorCode: 'STAFF_CALENDAR_NOT_CONNECTED'}}); return; }
  const settingsSnap = await teamRef(teamId).collection('settings').doc('calendar').get();
  const payload = eventPayload(after, settingsSnap.exists ? settingsSnap.data() : null, bookingId);
  const {api, calendarId} = await calendarFor(teamId, afterUid);
  try { await api.events.patch({calendarId, eventId: payload.id, requestBody: payload}); }
  catch (error) { if (Number(error?.code || error?.response?.status) !== 404) throw error; await api.events.insert({calendarId, requestBody: payload}); }
  await ref.update({calendarSync: {status: 'synced', assigneeUid: afterUid, eventId: payload.id, calendarId, lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(), lastErrorCode: null}});
}

exports.calendarSyncOnBookingWrite = onDocumentWritten({document: 'teams/{teamId}/bookings/{bookingId}', retry: true, secrets: [CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, TOKEN_KEY]}, async event => {
  if (!syncEnabled()) return;
  const before = event.data?.before?.exists ? event.data.before.data() : null;
  const after = event.data?.after?.exists ? event.data.after.data() : null;
  const fields = ['assignedStaffUid', 'type', 'direction', 'date', 'time', 'durationMinutes', 'pickupPoint', 'dropoffPoint', 'location', 'reference', 'notes', 'client', 'phone', 'calendarContactDetailsRequired', 'status'];
  if (before && after && fields.every(field => JSON.stringify(before[field] ?? null) === JSON.stringify(after[field] ?? null))) return;
  try { await syncBooking(event.params.teamId, event.params.bookingId, before, after); }
  catch (error) {
    console.error('Calendar event sync failed', {bookingId: event.params.bookingId, code: safeCode(error)});
    if (after) { try { await bookingRef(event.params.teamId, event.params.bookingId).update({calendarSync: {status: 'error', assigneeUid: after.assignedStaffUid || null, eventId: null, calendarId: null, lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(), lastErrorCode: safeCode(error)}}); } catch (_) {} }
    throw error;
  }
});