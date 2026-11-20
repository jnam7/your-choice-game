import { signInAnonymously, onAuthStateChanged, User } from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import { auth, functions, isFirebaseConfigured, isEmulatorEnabled } from './config'

export interface AuthState {
  user: User | null
  isAdmin: boolean
  isLoading: boolean
}

// 1. 익명 로그인 (참가자용)
export async function signInAnonymouslyUser(): Promise<User> {
  if (!isFirebaseConfigured() && !isEmulatorEnabled()) {
    // Firebase 미설정 시 로컬 더미 유저 반환
    const mockUid = localStorage.getItem('lasttwo_mock_uid') || `mock_user_${Math.random().toString(36).substring(2, 8)}`
    localStorage.setItem('lasttwo_mock_uid', mockUid)
    return {
      uid: mockUid,
      isAnonymous: true,
    } as unknown as User
  }

  if (auth.currentUser) {
    return auth.currentUser
  }

  const credential = await signInAnonymously(auth)
  return credential.user
}

// 2. 관리자 인증 (시크릿 키를 통한 관리자 검증)
export async function authenticateAdmin(secretKey: string): Promise<boolean> {
  const user = await signInAnonymouslyUser()
  if (!user) return false

  if (!isFirebaseConfigured() && !isEmulatorEnabled()) {
    // 로컬 모드에서는 기본 시크릿 키 검사
    const defaultSecret = import.meta.env.VITE_ADMIN_SECRET_KEY || 'admin1234'
    const isSuccess = secretKey === defaultSecret
    if (isSuccess) {
      sessionStorage.setItem('lasttwo_admin_auth', 'true')
    }
    return isSuccess
  }

  try {
    const adminLoginFn = httpsCallable<{ secretKey: string }, { success: boolean; admin: boolean }>(
      functions,
      'adminLogin'
    )
    const result = await adminLoginFn({ secretKey })
    if (result.data.success) {
      sessionStorage.setItem('lasttwo_admin_auth', 'true')
      return true
    }
    return false
  } catch (error) {
    console.error('[Admin Auth Error]', error)
    return false
  }
}

// 3. 현재 관리자 인증 상태 확인
export function checkIsAdmin(): boolean {
  return sessionStorage.getItem('lasttwo_admin_auth') === 'true'
}

// 4. 인증 상태 변경 리스너
export function subscribeAuthState(callback: (user: User | null) => void) {
  if (!isFirebaseConfigured() && !isEmulatorEnabled()) {
    const mockUid = localStorage.getItem('lasttwo_mock_uid')
    if (mockUid) {
      callback({ uid: mockUid, isAnonymous: true } as unknown as User)
    } else {
      callback(null)
    }
    return () => {}
  }

  return onAuthStateChanged(auth, (user) => {
    callback(user)
  })
}
