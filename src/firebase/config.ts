import { initializeApp, getApps, getApp } from 'firebase/app'
import { getAuth, connectAuthEmulator } from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore'
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'

const rawDbUrl = (
  import.meta.env.VITE_FIREBASE_DATABASE_URL ||
  'https://the-last-two-game-default-rtdb.firebaseio.com'
).trim().replace(/\/+$/, '')

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyA_the_last_two_game_key',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'the-last-two-game.firebaseapp.com',
  databaseURL: rawDbUrl,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'the-last-two-game',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'the-last-two-game.appspot.com',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '123456789',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:123456789:web:demo',
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || 'G-DEMO123456',
}

export const isFirebaseConfigured = () => {
  return true
}

export const isEmulatorEnabled = () => {
  return import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true'
}

// 싱글톤 초기화
export const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = getFirestore(app)
export const functions = getFunctions(app)

// 로컬 에뮬레이터 연결 지원
if (isEmulatorEnabled() && typeof window !== 'undefined') {
  try {
    connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true })
    connectFirestoreEmulator(db, 'localhost', 8080)
    connectFunctionsEmulator(functions, 'localhost', 5001)
    console.log('[Firebase] 로컬 에뮬레이터에 연결되었습니다.')
  } catch (e) {
    // 중복 연결 방지
  }
}
