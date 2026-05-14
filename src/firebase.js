import { initializeApp } from 'firebase/app'
import { getDatabase, ref, get, set, onValue } from 'firebase/database'

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

let _db = null
function db() {
  if (!isConfigured()) throw new Error('Firebase not configured')
  if (!_db) {
    const app = initializeApp(firebaseConfig)
    _db = getDatabase(app)
  }
  return _db
}

export async function dbRead() {
  const snap = await get(ref(db(), SESSIONS_PATH))
  return snap.exists() ? snap.val() : []
}

export async function dbWrite(sessions) {
  await set(ref(db(), SESSIONS_PATH), sessions)
}

export function dbSubscribe(cb) {
  const r = ref(db(), SESSIONS_PATH)
  return onValue(r, snap => cb(snap.exists() ? snap.val() : []))
}
