// Firebase 완전 비활성화 및 더미 no-op 모듈
// 모든 실시간 통신은 3번 서바이벌 퀴즈의 Socket.io 통신 아키텍처로 완전 복원되었습니다.

export const app = null as any
export const auth = null as any
export const db = null as any
export const rtdb = null as any
export const RTDB_PATHS = {
  GAME: 'your-choice-game',
  STATE: 'your-choice-game/state',
  PLAYERS: 'your-choice-game/players',
  VOTES: 'your-choice-game/votes',
} as const

export const isFirebaseConfigured = () => false
export async function writeFirebaseState(_stateUpdate: any) {}
export async function writeFirebasePlayer(_player: any) {}
export async function writeAllFirebasePlayers(_players: any) {}
export async function removeFirebasePlayer(_playerId: string) {}
export async function clearFirebasePlayers() {}
export async function submitFirebaseVote(_playerId: string, _choice: any) {}
export async function clearFirebaseVotes() {}
export function listenFirebaseGame(_callbacks: any) {
  return () => {}
}
