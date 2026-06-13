import { initializeApp } from 'firebase/app'
import { getDatabase, ref, get, set, onValue } from 'firebase/database'
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth'

// Replaced with real values after `firebase apps:sdkconfig`
const firebaseConfig = {
  apiKey: 'AIzaSyDkAhG4v3DasIaF5QR_EyaWEwBpBjKkb_A',
  authDomain: 'ironlog-f6dd8.firebaseapp.com',
  databaseURL: 'https://ironlog-f6dd8-default-rtdb.firebaseio.com',
  projectId: 'ironlog-f6dd8',
  storageBucket: 'ironlog-f6dd8.firebasestorage.app',
  messagingSenderId: '841189363979',
  appId: '1:841189363979:web:6e58febd62c811eba0520e',
}

const SESSIONS_PATH = 'sessions'

export const isConfigured = () =>
  !!firebaseConfig.databaseURL &&
  !firebaseConfig.databaseURL.startsWith('PASTE_YOUR_')

// One shared app instance for both auth and the database.
let _app = null
function app() {
  if (!isConfigured()) throw new Error('Firebase not configured')
  if (!_app) _app = initializeApp(firebaseConfig)
  return _app
}

let _db = null
function db() {
  if (!_db) _db = getDatabase(app())
  return _db
}

let _auth = null
function auth() {
  if (!_auth) _auth = getAuth(app())
  return _auth
}

// ── Auth ──────────────────────────────────────────────────────────────────
// Calls cb(user|null) immediately with the restored session, then on changes.
export function subscribeAuth(cb) {
  return onAuthStateChanged(auth(), cb)
}

export function signInWithGoogle() {
  return signInWithPopup(auth(), new GoogleAuthProvider())
}

export function signOutUser() {
  return signOut(auth())
}

// ── Data ──────────────────────────────────────────────────────────────────
// These require an authenticated, authorized user once the locked-down
// security rules are deployed — only ever call them after sign-in.
// Firebase RTDB serves a contiguous 0-indexed array as a JS array, but a
// sparse/edited one as an object keyed by index. Coerce both to an array so
// real data is never mistaken for "empty" (which previously triggered a
// destructive SEED overwrite).
function toSessionsArray(val) {
  if (Array.isArray(val)) return val
  if (val && typeof val === 'object') return Object.values(val)
  return []
}

export async function dbRead() {
  const snap = await get(ref(db(), SESSIONS_PATH))
  return toSessionsArray(snap.val())
}

export async function dbWrite(sessions) {
  await set(ref(db(), SESSIONS_PATH), sessions)
}

// onError fires on permission-denied / network failure so the UI can react
// immediately instead of waiting for a fallback timeout.
export function dbSubscribe(cb, onError) {
  const r = ref(db(), SESSIONS_PATH)
  return onValue(r, snap => cb(toSessionsArray(snap.val())), onError)
}
