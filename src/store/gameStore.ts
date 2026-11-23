import { create } from 'zustand'
import { socket } from '../socket'
import {
  writeFirebaseState,
  writeFirebasePlayer,
  writeAllFirebasePlayers,
  clearFirebasePlayers,
  submitFirebaseVote,
  clearFirebaseVotes,
} from '../firebase'
import type { GameState, GameActions, GamePhase, Player, RoundResult, Question, ChatMessage, RuleMode, QrMode } from '../types/game'
import {
  questions as defaultQuestions,
  majorityQuestions,
  minorityQuestions,
  mockNicknames,
} from '../data/questions'

function generateId(): string {
  return Math.random().toString(36).substring(2, 10) + Date.now().toString(36)
}

function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

const STORAGE_KEY = 'lasttwo_game_state_v2'

// 더미 참가자 자동 투표 타이머 관리 풀
let dummyVoteTimers: ReturnType<typeof setTimeout>[] = []

export function clearDummyVoteTimers() {
  dummyVoteTimers.forEach((timer) => clearTimeout(timer))
  dummyVoteTimers = []
}

// 로컬스토리지에서 복원
function loadPersistedState(): Partial<GameState> {
  if (typeof window === 'undefined') return {}
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (e) {
    console.error('[loadPersistedState Error]', e)
  }
  return {}
}

function getDefaultHostUrl(): string {
  if (typeof window === 'undefined') return 'http://192.168.40.111:5000'
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return `http://192.168.40.111:${window.location.port || '5000'}`
  }
  return window.location.origin
}

const defaultInitialState: GameState = {
  phase: 'lobby',
  roundNumber: 0,
  ruleMode: 'majority',
  qrMode: 'wifi',
  currentQuestion: null,
  timeLeft: 15,
  timeLimit: 15,
  isPaused: false,
  isFinals: false,
  isGameOver: false,
  soleWinnerId: null,
  votingDeadline: undefined,
  players: [],
  votes: {},
  roundResults: [],
  currentResult: null,
  usedQuestionIds: [],
  questionsList: defaultQuestions,
  chatMessages: [
    {
      id: 'welcome_msg',
      playerId: 'system',
      nickname: '시스템',
      message: '당신의 선택 : THE LAST TWO에 오신 것을 환영합니다! 자유롭게 응원과 대화를 나눠보세요!',
      timestamp: Date.now(),
      isNotice: true,
    },
  ],
  serverHostUrl: getDefaultHostUrl(),
  currentPlayerId: null,
}

const persisted = loadPersistedState()
const initialState: GameState = {
  ...defaultInitialState,
  ...persisted,
  questionsList:
    persisted.questionsList && persisted.questionsList.length >= 100 && persisted.questionsList.some((q) => Number(q.id) >= 101)
      ? persisted.questionsList
      : defaultQuestions,
  chatMessages: persisted.chatMessages && persisted.chatMessages.length > 0 ? persisted.chatMessages : defaultInitialState.chatMessages,
  // 브라우저 탭 세션 아이디 복구
  currentPlayerId:
    (typeof window !== 'undefined' ? localStorage.getItem('lasttwo_player_id') : null) ||
    persisted.currentPlayerId ||
    null,
}

let chatChannel: BroadcastChannel | null = null
if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
  chatChannel = new BroadcastChannel('lasttwo_chat_channel')
  chatChannel.onmessage = (event) => {
    if (event.data?.type === 'NEW_CHAT_MESSAGE') {
      useGameStore.setState((prev) => ({
        chatMessages: [event.data.message, ...prev.chatMessages].slice(0, 50),
      }))
    } else if (event.data?.type === 'CLEAR_CHAT') {
      useGameStore.setState({ chatMessages: [] })
    }
  }
}

export const useGameStore = create<GameState & GameActions>((set, get) => {
  // 상태 변경 시 로컬스토리지 자동 영속화
  const persist = () => {
    try {
      const state = get()
      const toSave = {
        phase: state.phase,
        roundNumber: state.roundNumber,
        ruleMode: state.ruleMode,
        qrMode: state.qrMode,
        currentQuestion: state.currentQuestion,
        timeLeft: state.timeLeft,
        timeLimit: state.timeLimit,
        isPaused: state.isPaused,
        isFinals: state.isFinals,
        isGameOver: state.isGameOver,
        soleWinnerId: state.soleWinnerId,
        votingDeadline: state.votingDeadline,
        players: state.players,
        votes: state.votes,
        roundResults: state.roundResults,
        currentResult: state.currentResult,
        usedQuestionIds: state.usedQuestionIds,
        questionsList: state.questionsList,
        serverHostUrl: state.serverHostUrl,
        chatMessages: state.chatMessages.slice(0, 50),
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave))

      // 관리자 화면(/admin)에서만 서버 전체 상태 동기화 권한 부여 (참가자 및 TV 화면이 대기실 상태로 서버를 덮어쓰는 버그 원천 차단)
      if (typeof window !== 'undefined' && window.location.pathname.includes('/admin')) {
        const syncPayload = {
          phase: state.phase,
          roundNumber: state.roundNumber,
          ruleMode: state.ruleMode,
          qrMode: state.qrMode,
          serverHostUrl: state.serverHostUrl,
          currentQuestion: state.currentQuestion,
          currentResult: state.currentResult,
          isFinals: state.isFinals,
          isGameOver: state.isGameOver,
          soleWinnerId: state.soleWinnerId,
          isPaused: state.isPaused,
          timeLimit: state.timeLimit,
          votingDeadline: state.votingDeadline,
          timeLeft: state.timeLeft,
          votes: state.votes,
          players: state.players.map((p) => ({
            id: p.id,
            status: p.status,
            nickname: p.nickname,
            joinedAt: p.joinedAt || Date.now(),
            isDummy: Boolean(p.isDummy),
          })),
        }
        socket.emit('admin:sync', syncPayload)
        // Firebase Realtime DB에 즉시 직결 반영
        writeFirebaseState(syncPayload).catch(() => {})

        // 관리자 또는 TV 콘솔인 경우 백업 HTTP REST 동기화 병행 (웹소켓 재연결 지연 시 즉각 구제)
        if (window.location.pathname.includes('/admin') || window.location.pathname.includes('/tv')) {
          fetch('/api/game/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(syncPayload),
          }).catch(() => {})
        }
      }
    } catch (e) {
      // 쿼터 에러 등 방지
    }
  }

  return {
    ...initialState,

    // ===== 실시간 사내 채팅 =====
    sendChatMessage: (messageText: string) => {
      const trimmed = messageText.trim()
      if (!trimmed) return
      const { currentPlayerId, players } = get()
      const player = players.find((p) => p.id === currentPlayerId)
      const nickname = player ? player.nickname : (currentPlayerId ? '참가자' : '관리자')

      const newMsg: ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        playerId: currentPlayerId || 'admin',
        nickname,
        message: trimmed,
        timestamp: Date.now(),
        isNotice: !currentPlayerId,
      }

      set((state) => ({
        chatMessages: [newMsg, ...state.chatMessages].slice(0, 50),
      }))

      socket.emit('chat:send', { nickname, message: trimmed })
      persist()
    },

    clearChatMessages: () => {
      set({ chatMessages: [] })
      if (chatChannel) {
        try {
          chatChannel.postMessage({ type: 'CLEAR_CHAT' })
        } catch (e) {}
      }
      persist()
    },

    // ===== 모바일 접속 호스트 URL 설정 =====
    setServerHostUrl: (url: string) => {
      set({ serverHostUrl: url })
      persist()
    },

    // ===== QR 접속 모드 설정 (wifi vs tunnel) =====
    setQrMode: (mode: QrMode) => {
      set({ qrMode: mode })
      persist()
    },

    // ===== 룰 모드 설정 (다수의 선택 vs 소수의 선택) =====
    setRuleMode: (mode: RuleMode) => {
      set({ ruleMode: mode })
      persist()
    },

    // ===== 문제 시간 설정 =====
    setTimeLimit: (seconds: number) => {
      set({ timeLimit: seconds, timeLeft: seconds })
      persist()
    },

    // ===== 문제 풀 관리 (CRUD) =====
    addQuestionItem: (q: Omit<Question, 'id'>) => {
      const newId = `custom_${Date.now()}`
      const newQuestion: Question = {
        ...q,
        id: newId,
      }
      set((state) => ({
        questionsList: [...state.questionsList, newQuestion],
      }))
      persist()
    },

    updateQuestionItem: (id: number | string, updates: Partial<Question>) => {
      set((state) => ({
        questionsList: state.questionsList.map((q) => (q.id === id ? { ...q, ...updates } : q)),
        currentQuestion:
          state.currentQuestion?.id === id
            ? { ...state.currentQuestion, ...updates }
            : state.currentQuestion,
      }))
      persist()
    },

    deleteQuestionItem: (id: number | string) => {
      set((state) => ({
        questionsList: state.questionsList.filter((q) => q.id !== id),
      }))
      persist()
    },

    resetQuestionsToDefault: () => {
      set({ questionsList: defaultQuestions })
      persist()
    },

    // ===== 플레이어 관리 =====
    setPlayers: (players: Player[]) => {
      set({ players })
      persist()
    },

    addPlayer: (nickname: string, existingId?: string) => {
      const existing = get().players.find((p) => p.nickname === nickname)
      const id = existing ? existing.id : (existingId || generateId())

      const newPlayer: Player = { id, nickname, status: 'alive' as const, joinedAt: Date.now() }

      set((state) => {
        const alreadyInList = state.players.some((p) => p.id === id || p.nickname === nickname)
        const updatedList = alreadyInList
          ? state.players.map((p) => (p.nickname === nickname ? { ...p, id, status: 'alive' as const } : p))
          : [...state.players, newPlayer]
        return {
          players: updatedList,
          currentPlayerId: id,
        }
      })

      localStorage.setItem('lasttwo_player_id', id)
      localStorage.setItem('lasttwo_player_nickname', nickname)
      persist()

      // Firebase Realtime DB에 즉시 참가자 등록
      writeFirebasePlayer(newPlayer).catch(() => {})

      // 서버에 클라이언트 ID와 함께 웹소켓 참가자 등록 요청
      socket.emit('player:join', { id, nickname }, (response: any) => {
        if (response?.player?.id && response.player.id !== id) {
          set({ currentPlayerId: response.player.id })
          localStorage.setItem('lasttwo_player_id', response.player.id)
        }
      })

      // 백업 HTTP REST 참가 등록 (웹소켓 연결 지연 시 즉각 백업)
      fetch('/api/game/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, nickname }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.player?.id && data.player.id !== id) {
            set({ currentPlayerId: data.player.id })
            localStorage.setItem('lasttwo_player_id', data.player.id)
          }
        })
        .catch(() => {})

      return id
    },

    removePlayer: (id: string) => {
      set((state) => ({
        players: state.players.filter((p) => p.id !== id),
      }))
      persist()
    },

    changeNickname: (newNickname: string) => {
      const trimmed = newNickname.trim()
      if (!trimmed || trimmed.length > 10) return
      const { currentPlayerId } = get()
      if (!currentPlayerId) return

      set((state) => ({
        players: state.players.map((p) => (p.id === currentPlayerId ? { ...p, nickname: trimmed } : p)),
      }))
      localStorage.setItem('lasttwo_player_nickname', trimmed)
      persist()

      socket.emit('player:change_nickname', { id: currentPlayerId, newNickname: trimmed })
    },

    addMockPlayers: (count: number) => {
      const existing = get().players.length
      const available = mockNicknames.slice(existing, existing + count)
      const extras: string[] = []
      for (let i = available.length; i < count; i++) {
        extras.push(`참가자${existing + i + 1}`)
      }
      const names = [...available, ...extras]

      const newPlayers: Player[] = names.map((nickname, i) => ({
        id: `mock_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 6)}`,
        nickname,
        status: 'alive' as const,
        joinedAt: Date.now() + Math.random() * 1000,
        isDummy: true,
        isAlive: true,
      }))

      const allPlayers = [...get().players, ...newPlayers]
      set({ players: allPlayers })
      persist()

      // Firebase Realtime DB에 전체 플레이어 즉시 직결 반영
      writeAllFirebasePlayers(allPlayers).catch(() => {})

      // 서버에 더미 참가자 즉시 등록 및 전파
      socket.emit('admin:add_mock_players', { newPlayers, count })
    },

    // ===== 게임 제어 흐름 =====
    startGame: (autoStartVoting = true) => {
      set({
        phase: 'question',
        roundNumber: 1,
        roundResults: [],
        currentResult: null,
        usedQuestionIds: [],
        votes: {},
        isPaused: false,
        isFinals: false,
        isGameOver: false,
        soleWinnerId: null,
      })
      get().showQuestion()

      const state = get()
      // 3번 서바이벌 퀴즈 규격: admin:start_game 서버 이벤트 전송
      socket.emit('admin:start_game', {
        autoStartVoting,
        ruleMode: state.ruleMode,
        timeLimit: state.timeLimit || 15,
        question: state.currentQuestion,
      })
      fetch('/api/game/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoStartVoting,
          ruleMode: state.ruleMode,
          timeLimit: state.timeLimit || 15,
          question: state.currentQuestion,
        }),
      }).catch(() => {})

      if (autoStartVoting) {
        get().startVoting()
      } else {
        persist()
      }
    },

    showQuestion: () => {
      const { usedQuestionIds, questionsList, ruleMode } = get()

      // 현재 ruleMode에 따른 대상 질문 풀 (majority: 1~100번 / minority: 101번 이상)
      let targetPool: Question[]
      if (ruleMode === 'minority') {
        const poolFromList = questionsList.filter((q) => Number(q.id) >= 101)
        targetPool = poolFromList.length > 0 ? poolFromList : minorityQuestions
      } else {
        const poolFromList = questionsList.filter((q) => Number(q.id) <= 100)
        targetPool = poolFromList.length > 0 ? poolFromList : majorityQuestions
      }

      // 해당 모드 풀에서 미출제 문제 필터링
      let candidatePool = targetPool.filter((q) => !usedQuestionIds.includes(q.id))
      let updatedUsedQuestionIds = [...usedQuestionIds]

      // 해당 모드의 문제가 전부 소진되면 해당 풀의 usedQuestionIds 기록을 비우고 다시 무작위 순환
      if (candidatePool.length === 0) {
        const poolIdSet = new Set(targetPool.map((q) => q.id))
        updatedUsedQuestionIds = usedQuestionIds.filter((id) => !poolIdSet.has(id))
        candidatePool = [...targetPool]
      }

      const shuffled = shuffleArray(candidatePool)
      const selected = shuffled[0]

      set({
        currentQuestion: selected,
        usedQuestionIds: updatedUsedQuestionIds,
        phase: 'question',
        votes: {},
        currentResult: null,
        isPaused: false,
      })
      persist()
    },

    startVoting: (customTimeLimit?: number) => {
      clearDummyVoteTimers()
      const limit = customTimeLimit || get().timeLimit || 15
      const deadline = Date.now() + limit * 1000

      set({
        phase: 'voting',
        timeLimit: limit,
        timeLeft: limit,
        votingDeadline: deadline,
        isPaused: false,
        votes: {},
      })
      clearFirebaseVotes().catch(() => {})
      persist()

      // 3번 서바이벌 퀴즈 규격 이벤트 전송
      socket.emit('admin:start_voting', { timeLimit: limit })

      // 생존해 있는 더미 참가자 자동 무작위 투표 시뮬레이션 가동
      get().simulateDummyVotes()
    },

    // 결과 공개 3초 서스펜스 카운트다운
    startRevealing: () => {
      clearDummyVoteTimers()
      set({
        phase: 'revealing',
        timeLeft: 3,
        isPaused: false,
      })
      persist()
    },

    submitVote: (playerId: string, choice: 'A' | 'B') => {
      // 1. 탈락자 투표 차단
      const player = get().players.find((p) => p.id === playerId)
      if (player && player.status === 'eliminated') {
        console.warn(`[submitVote 차단] 탈락자 (${player.nickname})는 투표할 수 없습니다.`)
        return
      }

      // 투표 변경 불가 (한 번만 선택 가능)
      if (get().votes[playerId]) return
      if (get().phase !== 'voting' && get().phase !== 'question') return
      if (get().isPaused) return

      // 웹소켓으로 투표 전송 (3번 서바이벌 퀴즈 호환)
      socket.emit('player:vote', { playerId, choice }, (res: any) => {
        if (!res?.success) {
          console.warn('[player:vote 서버 응답]', res?.error)
        }
      })

      // 백업 HTTP REST 투표 전송 (소켓 불안정 대비)
      fetch('/api/game/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId, choice }),
      }).catch(() => {})

      set((state) => ({
        votes: { ...state.votes, [playerId]: choice },
      }))
      submitFirebaseVote(playerId, choice).catch(() => {})
      persist()
    },

    // 일시정지 및 재개
    pauseGame: () => {
      clearDummyVoteTimers()
      set({ isPaused: true })
      persist()
      socket.emit('admin:pause_game')
    },

    resumeGame: () => {
      const { timeLeft } = get()
      const newDeadline = Date.now() + timeLeft * 1000
      set({ isPaused: false, votingDeadline: newDeadline })
      persist()
      socket.emit('admin:resume_game')
    },

    endVoting: () => {
      clearDummyVoteTimers()
      socket.emit('admin:end_voting')
      // 투표 마감 -> 결과 공개 3초 카운트다운 진입
      get().startRevealing()
    },

    revealResult: () => {
      const { votes, players, currentQuestion, roundNumber, ruleMode } = get()
      if (!currentQuestion) return

      const alivePlayers = players.filter((p) => p.status === 'alive')

      // 오직 살아있는(alive) 참가자의 투표만 엄격히 집계 (탈락자 투표 왜곡 원천 차단)
      const aliveVotes: Record<string, 'A' | 'B'> = {}
      for (const p of alivePlayers) {
        if (votes[p.id]) {
          aliveVotes[p.id] = votes[p.id]
        }
      }

      let votesA = 0
      let votesB = 0
      for (const choice of Object.values(aliveVotes)) {
        if (choice === 'A') votesA++
        else if (choice === 'B') votesB++
      }

      const voterIds = Object.keys(aliveVotes)
      const nonVoterIds = alivePlayers
        .filter((p) => !voterIds.includes(p.id))
        .map((p) => p.id)

      // 서바이벌 판정 (다수의 선택 vs 소수의 선택)
      let majority: 'A' | 'B' | 'tie'
      let eliminatedIds: string[] = []

      if (ruleMode === 'minority') {
        // [소수의 선택 모드]
        // 더 적은 표를 얻은 선택지가 승리.
        // 단, 투표수가 0표인 선택지는 제외하고 실제 투표가 발생한 선택지 중 적은 쪽을 승리로 판정.
        if (votesA > 0 && votesB > 0) {
          if (votesA === votesB) {
            majority = 'tie'
            eliminatedIds = [...nonVoterIds]
          } else if (votesA < votesB) {
            majority = 'A' // A 소수 승리
            const minorityLosers = Object.entries(aliveVotes)
              .filter(([, choice]) => choice === 'B')
              .map(([id]) => id)
            eliminatedIds = [...minorityLosers, ...nonVoterIds]
          } else {
            majority = 'B' // B 소수 승리
            const minorityLosers = Object.entries(aliveVotes)
              .filter(([, choice]) => choice === 'A')
              .map(([id]) => id)
            eliminatedIds = [...minorityLosers, ...nonVoterIds]
          }
        } else if (votesA > 0 && votesB === 0) {
          // 0표인 B는 제외, 실제 투표가 발생한 A가 승리
          majority = 'A'
          eliminatedIds = [...nonVoterIds]
        } else if (votesA === 0 && votesB > 0) {
          // 0표인 A는 제외, 실제 투표가 발생한 B가 승리
          majority = 'B'
          eliminatedIds = [...nonVoterIds]
        } else {
          // 둘 다 0표인 경우 동률 처리
          majority = 'tie'
          eliminatedIds = [...nonVoterIds]
        }
      } else {
        // [다수의 선택 모드 (기본)]
        if (votesA === votesB) {
          // 동률 시 실제 투표자 전원 생존! 미투표자만 탈락
          majority = 'tie'
          eliminatedIds = [...nonVoterIds]
        } else if (votesA > votesB) {
          // A 다수 생존, B 소수 + 미투표자 탈락
          majority = 'A'
          const minorityIds = Object.entries(aliveVotes)
            .filter(([, choice]) => choice === 'B')
            .map(([id]) => id)
          eliminatedIds = [...minorityIds, ...nonVoterIds]
        } else {
          // B 다수 생존, A 소수 + 미투표자 탈락
          majority = 'B'
          const minorityIds = Object.entries(aliveVotes)
            .filter(([, choice]) => choice === 'A')
            .map(([id]) => id)
          eliminatedIds = [...minorityIds, ...nonVoterIds]
        }
      }

      let survivorIds = alivePlayers
        .filter((p) => !eliminatedIds.includes(p.id))
        .map((p) => p.id)

      // 예외 처리: 모든 생존자가 동시에 탈락하여 생존자가 0명이 된 경우, 직전 라운드 생존자 전원 부활 재도전
      if (survivorIds.length === 0 && alivePlayers.length > 0) {
        survivorIds = alivePlayers.map((p) => p.id)
        eliminatedIds = []
      }

      let isGameOver = false
      let soleWinnerId: string | null = null

      if (survivorIds.length <= 2 && survivorIds.length > 0) {
        isGameOver = true
        if (survivorIds.length === 1) {
          soleWinnerId = survivorIds[0]
        }
      }

      const result: RoundResult = {
        questionId: currentQuestion.id,
        question: currentQuestion,
        votesA,
        votesB,
        totalVoters: voterIds.length,
        nonVoters: nonVoterIds.length,
        majority,
        ruleMode,
        eliminated: eliminatedIds,
        survivors: survivorIds,
        winnerCount: isGameOver ? survivorIds.length : 0,
        soleWinnerId,
      }

      // 생존자가 2명 이하가 되는 순간 즉시 게임 종료(gameover)로 전환
      const nextPhase: GamePhase = isGameOver ? 'gameover' : 'result'

      set((state) => ({
        players: state.players.map((p) =>
          eliminatedIds.includes(p.id)
            ? { ...p, status: 'eliminated' as const, eliminatedRound: roundNumber }
            : p
        ),
        currentResult: result,
        roundResults: [...state.roundResults, result],
        usedQuestionIds: [...state.usedQuestionIds, currentQuestion.id],
        phase: nextPhase,
        isGameOver,
        soleWinnerId,
      }))
      persist()
    },

    nextRound: () => {
      const { players, timeLimit } = get()
      const alive = players.filter((p) => p.status === 'alive')

      if (alive.length <= 2) {
        set({
          phase: 'gameover',
          isGameOver: true,
          soleWinnerId: alive.length === 1 ? alive[0].id : null,
        })
        persist()
        socket.emit('admin:sync', { phase: 'gameover', isGameOver: true, soleWinnerId: alive.length === 1 ? alive[0].id : null })
        return
      }

      set((state) => ({
        roundNumber: state.roundNumber + 1,
        votes: {},
        currentResult: null,
      }))
      get().showQuestion()
      const nextQ = get().currentQuestion

      // 3번 서바이벌 퀴즈 규격 이벤트 전송
      socket.emit('admin:next_round', { timeLimit: timeLimit || 15, question: nextQ })

      // 다음 라운드 진입 시 즉시 15초 투표 자동 시작
      get().startVoting(timeLimit || 15)
    },

    enterFinals: () => {
      const { timeLimit } = get()
      set({
        isFinals: true,
        phase: 'question',
      })
      set((state) => ({
        roundNumber: state.roundNumber + 1,
        votes: {},
        currentResult: null,
      }))
      get().showQuestion()
      get().startVoting(timeLimit || 15)
    },

    forceEndGame: () => {
      clearDummyVoteTimers()
      const alive = get().players.filter((p) => p.status === 'alive')
      set({
        phase: 'gameover',
        isGameOver: true,
        soleWinnerId: alive.length === 1 ? alive[0].id : null,
      })
      persist()
    },

    resetGame: () => {
      clearDummyVoteTimers()
      // 1. 기존 접속자 전원 유지 & 'alive' 상태로 부활 (탈락 라운드 초기화)
      set((state) => ({
        phase: 'lobby',
        roundNumber: 0,
        currentQuestion: null,
        currentResult: null,
        roundResults: [],
        usedQuestionIds: [],
        votes: {},
        isPaused: false,
        isFinals: false,
        isGameOver: false,
        soleWinnerId: null,
        votingDeadline: undefined,
        timeLeft: state.timeLimit || 15,
        players: state.players.map((p) => ({
          ...p,
          status: 'alive' as const,
          eliminatedRound: undefined,
        })),
      }))

      try {
        const state = get()
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          phase: 'lobby',
          roundNumber: 0,
          currentQuestion: null,
          timeLeft: 15,
          timeLimit: state.timeLimit,
          isPaused: false,
          isFinals: false,
          isGameOver: false,
          soleWinnerId: null,
          votingDeadline: null,
          players: state.players,
          votes: {},
          roundResults: [],
          currentResult: null,
          usedQuestionIds: [],
          questionsList: state.questionsList,
          serverHostUrl: state.serverHostUrl,
          chatMessages: state.chatMessages.slice(0, 50),
        }))
      } catch (e) {}

      // 서버에 "접속자 유지 리셋" 요청 (소켓 + HTTP)
      socket.emit('admin:reset_game_keep_players')
      fetch('/api/game/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepPlayers: true }),
      }).catch(() => {})
    },

    clearAllPlayers: () => {
      clearDummyVoteTimers()
      set({ players: [] })
      persist()
      clearFirebasePlayers().catch(() => {})
      writeFirebaseState({ players: [] }).catch(() => {})
      socket.emit('admin:clear_all_players')
      fetch('/api/game/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepPlayers: false }),
      }).catch(() => {})
    },

    decrementTimer: () => {
      if (get().isPaused) return
      set((state) => ({
        timeLeft: Math.max(0, state.timeLeft - 1),
      }))
    },

    setTimeLeft: (time: number) => {
      set({ timeLeft: time })
    },

    setCurrentPlayer: (id: string) => {
      set({ currentPlayerId: id })
      localStorage.setItem('lasttwo_player_id', id)
      persist()
    },

    getAlivePlayers: () => {
      return get().players.filter((p) => p.status === 'alive')
    },

    getPlayerById: (id: string) => {
      return get().players.find((p) => p.id === id)
    },

    hasVoted: (playerId: string) => {
      return playerId in get().votes
    },

    // 생존 더미 참가자 자동 무작위 투표 시뮬레이션
    simulateDummyVotes: () => {
      clearDummyVoteTimers()
      const { players, currentQuestion, currentPlayerId } = get()
      if (!currentQuestion) return

      // 생존해 있는 더미 참가자 필터링 (isDummy 또는 mock_ prefix 또는 더미 닉네임 패턴)
      const aliveDummies = players.filter((p) => {
        const isAlive = p.status === 'alive' || p.isAlive === true
        const isDummy = Boolean(
          p.isDummy ||
          p.id.startsWith('mock_') ||
          (p.id !== currentPlayerId && (p.nickname.includes('_') || p.nickname.startsWith('참가자') || p.nickname.startsWith('더미')))
        )
        return isAlive && isDummy && p.id !== currentPlayerId
      })

      aliveDummies.forEach((dummy) => {
        // 90% 확률로 투표 참여, 10% 미투표 유지 (실제 참가자 미투표 상황 및 탈락 연출 검증)
        if (Math.random() < 0.9) {
          const choice: 'A' | 'B' = Math.random() < 0.5 ? 'A' : 'B'
          // 0.3초 ~ 2초 사이에 랜덤한 딜레이를 두고 순차적으로 투표
          const delay = Math.floor(Math.random() * 1700) + 300

          const timer = setTimeout(() => {
            // 투표 실행 시점에 여전히 voting 상태이고 살아있는지 확인 후 투표 처리
            const state = get()
            if (state.phase !== 'voting' || state.isPaused) return
            const targetDummy = state.players.find((p) => p.id === dummy.id)
            if (!targetDummy || (targetDummy.status !== 'alive' && !targetDummy.isAlive)) return
            if (state.votes[dummy.id]) return

            get().submitVote(dummy.id, choice)
          }, delay)

          dummyVoteTimers.push(timer)
        }
      })
    },

    clearDummyVotes: () => {
      clearDummyVoteTimers()
    },

    vote: (playerId: string, choice: 'A' | 'B') => {
      get().submitVote(playerId, choice)
    },

    simulateVotes: () => {
      get().simulateDummyVotes()
    },

    syncWithServer: (serverData: Partial<GameState>) => {
      set((state) => ({
        ...state,
        ...serverData,
      }))
      // 무한 루프 방지: 서버에서 동기화받은 상태는 다시 소켓으로 브로드캐스트하지 않고 조용히 로컬 저장
      try {
        const state = get()
        const toSave = {
          phase: state.phase,
          roundNumber: state.roundNumber,
          ruleMode: state.ruleMode,
          qrMode: state.qrMode,
          currentQuestion: state.currentQuestion,
          timeLeft: state.timeLeft,
          timeLimit: state.timeLimit,
          isPaused: state.isPaused,
          isFinals: state.isFinals,
          isGameOver: state.isGameOver,
          soleWinnerId: state.soleWinnerId,
          votingDeadline: state.votingDeadline,
          players: state.players,
          votes: state.votes,
          roundResults: state.roundResults,
          currentResult: state.currentResult,
          usedQuestionIds: state.usedQuestionIds,
          questionsList: state.questionsList,
          serverHostUrl: state.serverHostUrl,
          chatMessages: state.chatMessages.slice(0, 50),
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave))
      } catch (e) {}
    },
  }
})
