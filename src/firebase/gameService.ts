import { doc, onSnapshot, collection } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions, isFirebaseConfigured, isEmulatorEnabled } from './config'
import { signInAnonymouslyUser } from './auth'
import type { Player, Question, RoundResult, GamePhase } from '../types/game'

export interface ServerGameState {
  phase: GamePhase
  roundNumber: number
  currentQuestion: Question | null
  votingDeadline?: number
  votingStartedAt?: number
  isFinals: boolean
  currentResult: RoundResult | null
  usedQuestionIds?: number[]
}

// =========================================================================
// 실시간 리스너 (onSnapshot)
// =========================================================================

// 1. 게임 전역 상태 구독 (/game/current)
export function subscribeGameState(callback: (state: ServerGameState | null) => void) {
  if (!isFirebaseConfigured() && !isEmulatorEnabled()) {
    return () => {}
  }

  const docRef = doc(db, 'game', 'current')
  return onSnapshot(
    docRef,
    (snapshot) => {
      if (snapshot.exists()) {
        callback(snapshot.data() as ServerGameState)
      } else {
        callback(null)
      }
    },
    (error) => {
      console.error('[subscribeGameState Error]', error)
    }
  )
}

// 2. 전체 참가자 목록 실시간 구독 (/players)
export function subscribePlayers(callback: (players: Player[]) => void) {
  if (!isFirebaseConfigured() && !isEmulatorEnabled()) {
    return () => {}
  }

  const colRef = collection(db, 'players')
  return onSnapshot(
    colRef,
    (snapshot) => {
      const players: Player[] = []
      snapshot.forEach((d) => {
        players.push(d.data() as Player)
      })
      callback(players)
    },
    (error) => {
      console.error('[subscribePlayers Error]', error)
    }
  )
}

// 3. 본인의 투표 상태 구독 (/rounds/round_{round}/votes/{uid})
export function subscribeMyVote(
  roundNumber: number,
  uid: string,
  callback: (choice: 'A' | 'B' | null) => void
) {
  if (!isFirebaseConfigured() && !isEmulatorEnabled()) {
    return () => {}
  }
  if (!roundNumber || !uid) return () => {}

  const docRef = doc(db, 'rounds', `round_${roundNumber}`, 'votes', uid)
  return onSnapshot(
    docRef,
    (snapshot) => {
      if (snapshot.exists()) {
        callback(snapshot.data().choice as 'A' | 'B')
      } else {
        callback(null)
      }
    },
    (error) => {
      // 보안 규칙에 의해 타인의 투표 또는 비인가 접근 시 안전하게 무시
      callback(null)
    }
  )
}

// =========================================================================
// Cloud Functions 호출 (클라이언트 -> 서버)
// =========================================================================

// 1. 참가자 참가 (joinGame)
export async function joinGameFirebase(nickname: string): Promise<{ success: boolean; player: Player }> {
  await signInAnonymouslyUser()
  const fn = httpsCallable<{ nickname: string }, { success: boolean; player: Player }>(functions, 'joinGame')
  const result = await fn({ nickname })
  return result.data
}

// 2. 투표 제출 (submitVote)
export async function submitVoteFirebase(choice: 'A' | 'B'): Promise<{ success: boolean; choice: 'A' | 'B' }> {
  const fn = httpsCallable<{ choice: 'A' | 'B' }, { success: boolean; choice: 'A' | 'B' }>(functions, 'submitVote')
  const result = await fn({ choice })
  return result.data
}

// 3. 관리자: 게임 시작 (adminStartGame)
export async function adminStartGameFirebase(secretKey?: string) {
  const fn = httpsCallable<{ secretKey?: string }, { success: boolean }>(functions, 'adminStartGame')
  const result = await fn({ secretKey })
  return result.data
}

// 4. 관리자: 투표 개시 (adminStartVoting - 15초 카운트다운)
export async function adminStartVotingFirebase(secretKey?: string) {
  const fn = httpsCallable<{ secretKey?: string }, { success: boolean; deadline: number }>(functions, 'adminStartVoting')
  const result = await fn({ secretKey })
  return result.data
}

// 5. 관리자: 결과 발표 및 생존/탈락 판정 (adminEvaluateResult)
export async function adminEvaluateResultFirebase(secretKey?: string) {
  const fn = httpsCallable<{ secretKey?: string }, { success: boolean; result: RoundResult; survivorCount: number; isGameOver: boolean }>(
    functions,
    'adminEvaluateResult'
  )
  const result = await fn({ secretKey })
  return result.data
}

// 6. 관리자: 다음 라운드 진행 (adminNextRound)
export async function adminNextRoundFirebase(secretKey?: string) {
  const fn = httpsCallable<{ secretKey?: string }, { success: boolean; roundNumber: number }>(functions, 'adminNextRound')
  const result = await fn({ secretKey })
  return result.data
}

// 7. 관리자: 게임 초기화 (adminResetGame)
export async function adminResetGameFirebase(secretKey?: string) {
  const fn = httpsCallable<{ secretKey?: string }, { success: boolean }>(functions, 'adminResetGame')
  const result = await fn({ secretKey })
  return result.data
}
