import { initializeApp } from 'firebase/app'
import { getDatabase, ref, get, set, update, remove, onValue } from 'firebase/database'
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
//
// Every write touches ONLY the session(s) it changes (sessions/<key>). The old
// approach re-wrote the whole `sessions` list from the app's in-memory copy, so
// any stale copy (a second tab, the home-screen app vs. Safari, a phone waking
// up before it re-synced) silently overwrote newer data — lifts saved earlier
// would vanish. Each session remembers its DB key in `_key` (never stored).
//
// Legacy data is a 0-indexed array (keys "0","1",…); new sessions are keyed by
// their id. Both live side by side under `sessions`, so no migration is needed.
const toList = v => Array.isArray(v) ? v.filter(x => x != null) : (v && typeof v === 'object' ? Object.values(v) : [])

function snapToSessions(snap) {
  const out = []
  snap.forEach(child => {
    const v = child.val()
    if (!v || typeof v !== 'object') return
    // RTDB returns a sparse list as an object keyed by index — coerce back to arrays.
    const lifts = toList(v.lifts).filter(l => l && typeof l.exercise === 'string').map(l => ({ ...l, sets: toList(l.sets) }))
    out.push({ ...v, lifts, _key: child.key })
  })
  return out
}

// Strip client-only fields; RTDB also rejects `undefined` values anywhere.
function toStored(session) {
  const { _key, ...rest } = session
  return JSON.parse(JSON.stringify(rest))
}

export const keyOf = s => s._key || String(s.id)

export async function dbRead() {
  return snapToSessions(await get(ref(db(), SESSIONS_PATH)))
}

// Create or replace one session.
export function dbPutSession(session) {
  return set(ref(db(), `${SESSIONS_PATH}/${keyOf(session)}`), toStored(session))
}

export function dbRemoveSession(session) {
  return remove(ref(db(), `${SESSIONS_PATH}/${keyOf(session)}`))
}

// Atomic multi-path patch, paths relative to `sessions` (value null deletes).
export function dbPatch(paths) {
  if (!Object.keys(paths).length) return Promise.resolve()
  return update(ref(db(), SESSIONS_PATH), paths)
}

// onError fires on permission-denied / network failure so the UI can react
// immediately instead of waiting for a fallback timeout.
export function dbSubscribe(cb, onError) {
  const r = ref(db(), SESSIONS_PATH)
  return onValue(r, snap => cb(snapToSessions(snap)), onError)
}
