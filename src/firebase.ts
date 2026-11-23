import { initializeApp, getApps, getApp } from 'firebase/app'
import { getDatabase, ref, set, update, onValue, remove, off, DatabaseReference } from 'firebase/database'
import { getFirestore } from 'firebase/firestore'
import { getAuth } from 'firebase/auth'
import type { Player, GameState } from './types/game'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'demo-api-key',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'the-last-two-game.firebaseapp.com',
  databaseURL:
    import.meta.env.VITE_FIREBASE_DATABASE_URL ||
    'https://the-last-two-game-default-rtdb.firebaseio.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'the-last-two-game',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'the-last-two-game.appspot.com',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '123456789',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:123456789:web:demo',
}

export const isFirebaseConfigured = () => {
  return (
    Boolean(import.meta.env.VITE_FIREBASE_API_KEY) &&
    import.meta.env.VITE_FIREBASE_API_KEY !== 'your_api_key_here' &&
    import.meta.env.VITE_FIREBASE_API_KEY !== 'demo-api-key'
  )
}

// 1. Firebase 인스턴스 초기화 (싱글톤)
export const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const db = getFirestore(app)
export const rtdb = getDatabase(app)

// 2. Realtime Database 경로 상수
export const RTDB_PATHS = {
  GAME: 'games/your-choice',
  STATE: 'games/your-choice/state',
  PLAYERS: 'games/your-choice/players',
  VOTES: 'games/your-choice/votes',
} as const

// 3. 브라우저 내부 즉각 동기화 채널 (동일 호스트 탭 간 0ms 동기화)
const syncChannel =
  typeof window !== 'undefined' && 'BroadcastChannel' in window
    ? new BroadcastChannel('your-choice-firebase-sync')
    : null

/**
 * Firebase Realtime DB에 게임 상태 업데이트
 */
export async function writeFirebaseState(stateUpdate: Partial<GameState>) {
  // 로컬 브로드캐스트 채널로 즉시 전송
  if (syncChannel) {
    try {
      syncChannel.postMessage({ type: 'STATE_UPDATE', payload: stateUpdate })
    } catch (e) {}
  }

  try {
    const cleanPayload: Record<string, any> = {}
    const allowedKeys: (keyof GameState)[] = [
      'phase',
      'roundNumber',
      'ruleMode',
      'qrMode',
      'serverHostUrl',
      'currentQuestion',
      'currentResult',
      'isFinals',
      'isGameOver',
      'soleWinnerId',
      'isPaused',
      'timeLimit',
      'votingDeadline',
      'timeLeft',
      'votes',
    ]

    for (const key of allowedKeys) {
      if ((stateUpdate as any)[key] !== undefined) {
        cleanPayload[key] = (stateUpdate as any)[key]
      }
    }

    cleanPayload.updatedAt = Date.now()
    const stateRef = ref(rtdb, RTDB_PATHS.STATE)
    await update(stateRef, cleanPayload)
  } catch (err) {
    // 오프라인 혹은 권한 에러 시 무음 처리
  }
}

/**
 * 참가자 단일 등록/업데이트
 */
export async function writeFirebasePlayer(player: Player) {
  if (syncChannel) {
    try {
      syncChannel.postMessage({ type: 'PLAYER_JOIN', payload: player })
    } catch (e) {}
  }

  try {
    const playerRef = ref(rtdb, `${RTDB_PATHS.PLAYERS}/${player.id}`)
    await set(playerRef, {
      id: player.id,
      nickname: player.nickname,
      status: player.status,
      joinedAt: player.joinedAt || Date.now(),
      eliminatedRound: player.eliminatedRound || null,
      isDummy: Boolean(player.isDummy),
    })
  } catch (err) {
    // 에러 무음 처리
  }
}

/**
 * 참가자 전체 목록 갱신 (더미 참가자 대량 추가 등)
 */
export async function writeAllFirebasePlayers(players: Player[]) {
  if (syncChannel) {
    try {
      syncChannel.postMessage({ type: 'PLAYERS_ALL', payload: players })
    } catch (e) {}
  }

  try {
    const playersObj: Record<string, any> = {}
    for (const p of players) {
      playersObj[p.id] = {
        id: p.id,
        nickname: p.nickname,
        status: p.status,
        joinedAt: p.joinedAt || Date.now(),
        eliminatedRound: p.eliminatedRound || null,
        isDummy: Boolean(p.isDummy),
      }
    }
    const playersRef = ref(rtdb, RTDB_PATHS.PLAYERS)
    await set(playersRef, playersObj)
  } catch (err) {
    // 에러 무음 처리
  }
}

/**
 * 참가자 개별 삭제
 */
export async function removeFirebasePlayer(playerId: string) {
  try {
    const playerRef = ref(rtdb, `${RTDB_PATHS.PLAYERS}/${playerId}`)
    await remove(playerRef)
  } catch (err) {}
}

/**
 * 참가자 전체 삭제 (관리자 초기화)
 */
export async function clearFirebasePlayers() {
  if (syncChannel) {
    try {
      syncChannel.postMessage({ type: 'PLAYERS_ALL', payload: [] })
    } catch (e) {}
  }

  try {
    const playersRef = ref(rtdb, RTDB_PATHS.PLAYERS)
    await set(playersRef, null)
  } catch (err) {}
}

/**
 * 투표 제출
 */
export async function submitFirebaseVote(playerId: string, choice: 'A' | 'B') {
  if (syncChannel) {
    try {
      syncChannel.postMessage({ type: 'VOTE_SUBMIT', payload: { playerId, choice } })
    } catch (e) {}
  }

  try {
    const voteRef = ref(rtdb, `${RTDB_PATHS.VOTES}/${playerId}`)
    await set(voteRef, choice)
  } catch (err) {}
}

/**
 * 투표 전체 초기화 (새 라운드 시작 시)
 */
export async function clearFirebaseVotes() {
  try {
    const votesRef = ref(rtdb, RTDB_PATHS.VOTES)
    await set(votesRef, null)
  } catch (err) {}
}

/**
 * Firebase Realtime DB 리스너 구독 (관리자, TV, 참가자 화면 공통)
 */
export function listenFirebaseGame(callbacks: {
  onState?: (state: any) => void
  onPlayers?: (players: Player[]) => void
  onVotes?: (votes: Record<string, 'A' | 'B'>) => void
}) {
  const unsubs: (() => void)[] = []

  // 실제 유효한 Firebase API Key가 설정되어 있을 때만 RTDB 원격 리스너 가동
  if (isFirebaseConfigured()) {
    // 1. Firebase RTDB state 리스너
    try {
      const stateRef = ref(rtdb, RTDB_PATHS.STATE)
      const stateUnsub = onValue(
        stateRef,
        (snapshot) => {
          const val = snapshot.val()
          if (val && callbacks.onState) {
            callbacks.onState(val)
          }
        },
        () => {}
      )
      unsubs.push(() => off(stateRef, 'value', stateUnsub))
    } catch (e) {}

    // 2. Firebase RTDB players 리스너
    try {
      const playersRef = ref(rtdb, RTDB_PATHS.PLAYERS)
      const playersUnsub = onValue(
        playersRef,
        (snapshot) => {
          const val = snapshot.val()
          if (callbacks.onPlayers && val) {
            if (Array.isArray(val)) {
              callbacks.onPlayers(val.filter(Boolean))
            } else if (typeof val === 'object') {
              const list: Player[] = Object.values(val)
              callbacks.onPlayers(list)
            }
          }
        },
        () => {}
      )
      unsubs.push(() => off(playersRef, 'value', playersUnsub))
    } catch (e) {}

    // 3. Firebase RTDB votes 리스너
    try {
      const votesRef = ref(rtdb, RTDB_PATHS.VOTES)
      const votesUnsub = onValue(
        votesRef,
        (snapshot) => {
          const val = snapshot.val()
          if (callbacks.onVotes && val) {
            callbacks.onVotes(val)
          }
        },
        () => {}
      )
      unsubs.push(() => off(votesRef, 'value', votesUnsub))
    } catch (e) {}
  }

  // 4. 로컬 브로드캐스트 채널 수신 (동일 기기/브라우저 초고속 동기화)
  if (syncChannel) {
    const handleChannelMsg = (event: MessageEvent) => {
      const data = event.data
      if (!data) return
      if (data.type === 'STATE_UPDATE' && callbacks.onState) {
        callbacks.onState(data.payload)
      } else if (data.type === 'PLAYER_JOIN' && callbacks.onPlayers && data.payload) {
        // 단일 참가자 입장 브로드캐스트 수신 시 목록 즉각 갱신
        callbacks.onPlayers([data.payload])
      } else if (data.type === 'PLAYERS_ALL' && callbacks.onPlayers) {
        callbacks.onPlayers(data.payload)
      } else if (data.type === 'VOTE_SUBMIT' && callbacks.onVotes && data.payload?.playerId) {
        callbacks.onVotes({ [data.payload.playerId]: data.payload.choice } as any)
      }
    }
    syncChannel.addEventListener('message', handleChannelMsg)
    unsubs.push(() => {
      syncChannel.removeEventListener('message', handleChannelMsg)
    })
  }

  return () => {
    unsubs.forEach((fn) => {
      try {
        fn()
      } catch (e) {}
    })
  }
}
