import { create } from 'zustand'
import { socket } from '../socket'
import type { GameState, GameActions, GamePhase, Player, RoundResult, Question, ChatMessage, RuleMode, QrMode } from '../types/game'
import {
  questions as defaultQuestions,
  majorityQuestions,
  minorityQuestions,
  mockNicknames,
} from '../data/questions'
import { getChannelIdFromUrl, getChannelRoomName, AVAILABLE_CHANNELS } from '../utils/channel'
import { stopAllSounds, setMasterVolume as setSoundMasterVolume, setSoundMuted as setGlobalMuted } from '../utils/sound'

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

const getStorageKey = (ch: string = '1') => `lasttwo_game_state_ch_${ch}`
const initialChannelId = getChannelIdFromUrl()

// 더미 참가자 자동 투표 타이머 관리 풀
let dummyVoteTimers: ReturnType<typeof setTimeout>[] = []

export function clearDummyVoteTimers() {
  dummyVoteTimers.forEach((timer) => clearTimeout(timer))
  dummyVoteTimers = []
}

// admin:sync 무한 루프 방지용 마지막 전송 페이로드 캐시
let lastSyncedPayloadStr = ''
// 라운드 광속 스킵 방지용 디바운스 타임스탬프
let lastNextRoundTime = 0

// 로컬스토리지에서 복원
function loadPersistedState(ch: string = initialChannelId): Partial<GameState> {
  if (typeof window === 'undefined') return {}
  try {
    const saved = localStorage.getItem(getStorageKey(ch)) || (ch === '1' ? localStorage.getItem('lasttwo_game_state_v2') : null)
    if (saved) {
      const parsed = JSON.parse(saved)
      if (parsed.phase === 'lobby' || !parsed.phase) {
        parsed.votes = {}
        parsed.currentResult = null
        parsed.currentPlayerId = null
        try {
          localStorage.removeItem(`lasttwo_player_id_ch_${ch}`)
          localStorage.removeItem(`lasttwo_player_nickname_ch_${ch}`)
          if (ch === '1') {
            localStorage.removeItem('lasttwo_player_id')
            localStorage.removeItem('lasttwo_player_nickname')
          }
        } catch { }
      }
      return parsed
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
  channelId: initialChannelId,
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
  votingEndTime: undefined,
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
  masterVolume: 0.8,
  isMuted: false,
}

const persisted = loadPersistedState(initialChannelId)
const initialState: GameState = {
  ...defaultInitialState,
  ...persisted,
  channelId: initialChannelId,
  questionsList:
    persisted.questionsList && persisted.questionsList.length >= 100 && persisted.questionsList.some((q) => Number(q.id) >= 101)
      ? persisted.questionsList
      : defaultQuestions,
  chatMessages: persisted.chatMessages && persisted.chatMessages.length > 0 ? persisted.chatMessages : defaultInitialState.chatMessages,
  // 브라우저 탭 세션 아이디 복구 (대기실/로비일 때는 이전 세션 복원하지 않음)
  currentPlayerId:
    (persisted.phase === 'question' || persisted.phase === 'voting')
      ? ((typeof window !== 'undefined' ? (localStorage.getItem(`lasttwo_player_id_ch_${initialChannelId}`) || localStorage.getItem('lasttwo_player_id')) : null) || persisted.currentPlayerId || null)
      : null,
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
      const channelId = state.channelId || '1'
      const toSave = {
        channelId,
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
      localStorage.setItem(getStorageKey(channelId), JSON.stringify(toSave))
      if (channelId === '1') {
        localStorage.setItem('lasttwo_game_state_v2', JSON.stringify(toSave))
      }

      // 관리자 화면(/admin)에서만 서버 전체 상태 동기화 권한 부여 (참가자 및 TV 화면이 대기실 상태로 서버를 덮어쓰는 버그 원천 차단)
      if (typeof window !== 'undefined' && window.location.pathname.includes('/admin')) {
        const syncPayload = {
          channelId,
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

        // 결과('result', 'revealing') 화면 등 동일한 상태를 서버와 무한 브로드캐스트 핑퐁하는 현상 방어
        const payloadKey = JSON.stringify({
          channelId,
          phase: syncPayload.phase,
          roundNumber: syncPayload.roundNumber,
          questionId: syncPayload.currentQuestion?.id,
          resultId: syncPayload.currentResult?.questionId,
          voteCount: Object.keys(syncPayload.votes || {}).length,
          aliveCount: syncPayload.players.filter((p) => p.status === 'alive').length,
          isPaused: syncPayload.isPaused,
        })

        if (payloadKey !== lastSyncedPayloadStr) {
          lastSyncedPayloadStr = payloadKey
          socket.emit('admin:sync', syncPayload)

          // 관리자 백업 HTTP REST 동기화 병행 (웹소켓 재연결 지연 시 즉각 구제)
          fetch(`/api/game/sync?channel=${channelId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(syncPayload),
          }).catch(() => { })
        }
      }
    } catch (e) {
      // 쿼터 에러 등 방지
    }
  }

  return {
    ...initialState,

    // ===== 채널 설정 =====
    setChannelId: (newChannelId: string) => {
      const validCh = (AVAILABLE_CHANNELS as readonly string[]).includes(newChannelId) ? newChannelId : '1'
      const prevCh = get().channelId || '1'
      if (prevCh === validCh) return

      // 이전 채널 룸 소켓 퇴장
      socket.emit('leave:channel', { channelId: prevCh })

      const chPersisted = loadPersistedState(validCh)
      set((state) => ({
        ...state,
        channelId: validCh,
        ...chPersisted,
        players: chPersisted.players || [],
        votes: chPersisted.votes || {},
        currentResult: chPersisted.currentResult || null,
        chatMessages: chPersisted.chatMessages && chPersisted.chatMessages.length > 0 ? chPersisted.chatMessages : defaultInitialState.chatMessages,
      }))

      const role = typeof window !== 'undefined'
        ? (window.location.pathname.includes('/admin') ? 'admin' : (window.location.pathname.includes('/tv') ? 'tv' : 'player'))
        : 'player'
      socket.emit('join:channel', { channelId: validCh, role })
      socket.emit('join:room', { roomId: getChannelRoomName(validCh) })

      fetch(`/api/game/state?channel=${validCh}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data && data.phase) {
            get().syncWithServer(data)
          }
        })
        .catch(() => {})
    },

    // ===== 실시간 사내 채팅 =====
    sendChatMessage: (messageText: string) => {
      const trimmed = messageText.trim()
      if (!trimmed) return
      const { currentPlayerId, players, channelId: currentCh } = get()
      const channelId = currentCh || '1'
      const player = players.find((p) => p.id === currentPlayerId)
      const nickname = player ? player.nickname : (currentPlayerId ? '참가자' : '관리자')
      const roomId = getChannelRoomName(channelId)

      const newMsg: ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        playerId: currentPlayerId || 'admin',
        nickname,
        message: trimmed,
        text: trimmed,
        timestamp: Date.now(),
        isNotice: !currentPlayerId,
        roomId,
      }

      set((state) => {
        if (state.chatMessages.some((m) => m.id === newMsg.id)) return state
        return {
          chatMessages: [newMsg, ...state.chatMessages].slice(0, 50),
        }
      })

      // 소켓 단일 이벤트 발행: chat:send 1회 전송으로 중복 제거 및 0.1초 즉시 전송
      const payload = {
        id: newMsg.id,
        playerId: newMsg.playerId,
        nickname,
        text: trimmed,
        message: trimmed,
        roomId,
        channelId,
        timestamp: newMsg.timestamp,
        isNotice: newMsg.isNotice,
      }
      socket.emit('chat:send', payload)

      if (chatChannel) {
        try {
          chatChannel.postMessage({ type: 'NEW_CHAT_MESSAGE', message: newMsg })
        } catch (e) { }
      }
    },

    addChatMessage: (msg: ChatMessage) => {
      if (!msg) return
      set((state) => {
        if (state.chatMessages.some((m) => m.id === msg.id)) return state
        return {
          chatMessages: [msg, ...state.chatMessages].slice(0, 50),
        }
      })
    },

    clearChatMessages: () => {
      set({ chatMessages: [] })
      if (chatChannel) {
        try {
          chatChannel.postMessage({ type: 'CLEAR_CHAT' })
        } catch (e) { }
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
      if (get().qrMode === mode) return
      set({ qrMode: mode })
      persist()
    },

    // ===== 룰 모드 설정 (다수의 선택 vs 소수의 선택) =====
    setRuleMode: (mode: RuleMode) => {
      if (get().ruleMode === mode) return
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
      const channelId = get().channelId || '1'

      const newPlayer: Player = { id, nickname, status: 'alive' as const, joinedAt: Date.now() }

      // 플레이어 ID 설정 및 로컬 플레이어 목록 즉시 반영
      const currentPlayers = get().players
      const playerExists = currentPlayers.some((p) => p.id === id)
      set({
        currentPlayerId: id,
        players: playerExists ? currentPlayers : [...currentPlayers, newPlayer],
      })

      if (typeof window !== 'undefined') {
        localStorage.setItem(`lasttwo_player_id_ch_${channelId}`, id)
        localStorage.setItem(`lasttwo_player_nickname_ch_${channelId}`, nickname)
        if (channelId === '1') {
          localStorage.setItem('lasttwo_player_id', id)
          localStorage.setItem('lasttwo_player_nickname', nickname)
        }
      }
      persist()

      // 서버에 클라이언트 ID와 함께 웹소켓 참가자 등록 요청
      socket.emit('player:join', { channelId, id, nickname }, (response: any) => {
        if (response?.player?.id && response.player.id !== id) {
          set({ currentPlayerId: response.player.id })
          localStorage.setItem(`lasttwo_player_id_ch_${channelId}`, response.player.id)
          if (channelId === '1') localStorage.setItem('lasttwo_player_id', response.player.id)
        }
      })

      // 백업 HTTP REST 참가 등록 (웹소켓 연결 지연 시 즉각 백업)
      fetch(`/api/game/join?channel=${channelId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, id, nickname }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.player?.id && data.player.id !== id) {
            set({ currentPlayerId: data.player.id })
            localStorage.setItem(`lasttwo_player_id_ch_${channelId}`, data.player.id)
            if (channelId === '1') localStorage.setItem('lasttwo_player_id', data.player.id)
          }
        })
        .catch(() => { })

      fetch(`/api/join?channel=${channelId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, id, nickname }),
      }).catch(() => { })

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
      const { currentPlayerId, channelId: currentCh } = get()
      if (!currentPlayerId) return
      const channelId = currentCh || '1'

      set((state) => ({
        players: state.players.map((p) => (p.id === currentPlayerId ? { ...p, nickname: trimmed } : p)),
      }))
      localStorage.setItem(`lasttwo_player_nickname_ch_${channelId}`, trimmed)
      if (channelId === '1') localStorage.setItem('lasttwo_player_nickname', trimmed)
      persist()

      socket.emit('player:change_nickname', { channelId, id: currentPlayerId, newNickname: trimmed })
    },

    addMockPlayers: (count: number, targetChannelId?: string) => {
      const channelId = String(targetChannelId || get().channelId || '1').trim() || '1'
      const existing = get().players.length
      const available = mockNicknames.slice(existing, existing + count)
      const extras: string[] = []
      for (let i = available.length; i < count; i++) {
        extras.push(`참가자${existing + i + 1}`)
      }
      const names = [...available, ...extras]

      const newPlayers: Player[] = names.map((nickname, i) => ({
        id: `mock_${channelId}_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 6)}`,
        nickname,
        status: 'alive' as const,
        joinedAt: Date.now() + Math.random() * 1000,
        isDummy: true,
        isAlive: true,
      }))

      const allPlayers = [...get().players, ...newPlayers]
      set({ players: allPlayers })
      persist()

      // 서버에 더미 참가자 즉시 등록 및 전파
      socket.emit('admin:add_mock_players', { channelId, newPlayers, count })
      fetch(`/api/game/mock-players?channel=${channelId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, newPlayers, count }),
      }).catch(() => {})
    },

    // ===== 사운드 마스터 볼륨 및 음소거 제어 =====
    setMasterVolume: (vol: number) => {
      const clamped = Math.max(0, Math.min(1, vol))
      set({ masterVolume: clamped })
      setSoundMasterVolume(clamped)
      persist()
      const channelId = get().channelId || '1'
      socket.emit('admin:set_volume', { channelId, masterVolume: clamped, isMuted: get().isMuted ?? false })
    },

    toggleMute: () => {
      const nextMuted = !get().isMuted
      set({ isMuted: nextMuted })
      setGlobalMuted(nextMuted)
      persist()
      const channelId = get().channelId || '1'
      socket.emit('admin:set_volume', { channelId, masterVolume: get().masterVolume ?? 0.8, isMuted: nextMuted })
    },

    // ===== 게임 제어 흐름 =====
    startGame: (autoStartVoting = true) => {
      // 게임 시작 신호 수신 즉시 모든 잡다한 효과음 강제 정지 및 초기화 (사운드 겹침 폭발 원천 차단)
      stopAllSounds()
      const currentRule = get().ruleMode || 'majority'
      set({
        phase: 'question',
        roundNumber: 1,
        ruleMode: currentRule,
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
      const channelId = state.channelId || '1'
      // 3번 서바이벌 퀴즈 규격: admin:start_game 서버 이벤트 전송
      socket.emit('admin:start_game', {
        channelId,
        autoStartVoting,
        ruleMode: currentRule,
        timeLimit: state.timeLimit || 15,
        question: state.currentQuestion,
      })
      fetch(`/api/game/start?channel=${channelId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId,
          autoStartVoting,
          ruleMode: currentRule,
          timeLimit: state.timeLimit || 15,
          question: state.currentQuestion,
        }),
      }).catch(() => { })

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
        votingEndTime: deadline,
        isPaused: false,
        votes: {},
      })
      persist()

      // 3번 서바이벌 퀴즈 규격 이벤트 전송 (절대 타임스탬프 votingEndTime 포함)
      const channelId = get().channelId || '1'
      socket.emit('admin:start_voting', { channelId, timeLimit: limit, votingDeadline: deadline, votingEndTime: deadline })

      // 생존해 있는 더미 참가자 자동 무작위 투표 시뮬레이션 가동
      get().simulateDummyVotes()
    },

    // 결과 공개 3초 서스펜스 카운트다운
    startRevealing: () => {
      clearDummyVoteTimers()
      set({
        phase: 'revealing',
        timeLeft: 3,
        votingDeadline: undefined,
        votingEndTime: undefined,
        isPaused: false,
      })
      persist()
    },

    submitVote: (playerId: string, choice: 'A' | 'B') => {
      // 1. 탈락자 투표 완전 차단
      const player = get().players.find((p) => p.id === playerId)
      if (player && (player.status === 'eliminated' || player.isAlive === false)) {
        console.warn(`[submitVote 차단] 탈락자 (${player.nickname})는 투표할 수 없습니다.`)
        return
      }

      // 투표 변경 불가 (한 번만 선택 가능)
      if (get().votes[playerId]) return
      if (get().phase !== 'voting' && get().phase !== 'question') return
      if (get().isPaused) return

      const channelId = get().channelId || '1'

      // 웹소켓으로 투표 전송 (3번 서바이벌 퀴즈 호환)
      socket.emit('player:vote', { channelId, playerId, choice }, (res: any) => {
        if (!res?.success) {
          console.warn('[player:vote 서버 응답]', res?.error)
        }
      })

      // 백업 HTTP REST 투표 전송 (소켓 불안정 대비)
      fetch(`/api/game/vote?channel=${channelId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, playerId, choice }),
      }).catch(() => { })

      set((state) => ({
        votes: { ...state.votes, [playerId]: choice },
      }))
      persist()
    },

    // 일시정지 및 재개
    pauseGame: () => {
      clearDummyVoteTimers()
      const { phase, votingDeadline, timeLeft } = get()
      let currentRemaining = timeLeft
      if (phase === 'voting' && votingDeadline) {
        currentRemaining = Math.max(0, Math.ceil((votingDeadline - Date.now()) / 1000))
      }
      set({ isPaused: true, timeLeft: currentRemaining })
      persist()
      const channelId = get().channelId || '1'
      socket.emit('admin:pause', { channelId })
      socket.emit('admin:pause_game', { channelId })
    },

    resumeGame: () => {
      const { timeLeft } = get()
      const newDeadline = Date.now() + (timeLeft || 15) * 1000
      set({ isPaused: false, votingDeadline: newDeadline })
      persist()
      const channelId = get().channelId || '1'
      socket.emit('admin:resume', { channelId })
      socket.emit('admin:resume_game', { channelId })
    },

    endVoting: () => {
      clearDummyVoteTimers()
      const channelId = get().channelId || '1'
      socket.emit('admin:end_voting', { channelId })
      // 투표 마감 -> 결과 공개 3초 카운트다운 진입
      get().startRevealing()
    },

    revealResult: () => {
      const { votes, players, currentQuestion, roundNumber, ruleMode } = get()
      if (!currentQuestion) return

      // 이번 라운드 시작 시점에 생존해 있었던 참가자들 (이번 라운드 이전에 탈락한 인원만 제외)
      // status === 'alive'이거나, 혹시 이미 eliminated 되었더라도 이번 라운드에 탈락 처리된 사람들은 포함
      const eligiblePlayers = players.filter((p) => {
        if (p.eliminatedRound && p.eliminatedRound < roundNumber) return false
        return true
      })
      const eligibleIds = new Set(eligiblePlayers.map((p) => p.id))

      // 1. 이번 라운드에 제출된 모든 유효 투표 집계 (탈락 여부와 무관하게 실제 제출된 선택 데이터 보존)
      // votes 객체에 기록된 모든 투표 중 이번 라운드 참가 가능했던 인원의 투표를 집계
      const validVotes: Record<string, 'A' | 'B'> = {}
      for (const [pId, choice] of Object.entries(votes)) {
        if (eligibleIds.size === 0 || eligibleIds.has(pId)) {
          if (choice === 'A' || choice === 'B') {
            validVotes[pId] = choice
          }
        }
      }

      let votesA = 0
      let votesB = 0
      for (const choice of Object.values(validVotes)) {
        if (choice === 'A') votesA++
        else if (choice === 'B') votesB++
      }

      const voterIds = Object.keys(validVotes)
      const nonVoterIds = eligiblePlayers
        .filter((p) => !voterIds.includes(p.id))
        .map((p) => p.id)

      // 2. 서바이벌 판정 (다수의 선택 vs 소수의 선택)
      const isMinorityMode = (ruleMode === 'minority')
      let majority: 'A' | 'B' | 'tie'
      let eliminatedIds: string[] = []

      if (votesA === votesB) {
        // 동률 시: 실제 투표자 전원 생존, 미투표자만 탈락
        majority = 'tie'
        eliminatedIds = [...nonVoterIds]
      } else if (votesA > votesB) {
        if (isMinorityMode) {
          // [소수의 선택 룰]: B(적은 쪽) 생존, A(많은 쪽) + 미투표자 탈락
          majority = 'B'
          const majorityIds = Object.entries(validVotes)
            .filter(([, c]) => c === 'A')
            .map(([id]) => id)
          eliminatedIds = [...majorityIds, ...nonVoterIds]
        } else {
          // [다수의 선택 룰]: A(많은 쪽) 생존, B(적은 쪽) + 미투표자 탈락
          majority = 'A'
          const minorityIds = Object.entries(validVotes)
            .filter(([, c]) => c === 'B')
            .map(([id]) => id)
          eliminatedIds = [...minorityIds, ...nonVoterIds]
        }
      } else {
        // votesB > votesA
        if (isMinorityMode) {
          // [소수의 선택 룰]: A(적은 쪽) 생존, B(많은 쪽) + 미투표자 탈락
          majority = 'A'
          const majorityIds = Object.entries(validVotes)
            .filter(([, c]) => c === 'B')
            .map(([id]) => id)
          eliminatedIds = [...majorityIds, ...nonVoterIds]
        } else {
          // [다수의 선택 룰]: B(많은 쪽) 생존, A(적은 쪽) + 미투표자 탈락
          majority = 'B'
          const minorityIds = Object.entries(validVotes)
            .filter(([, c]) => c === 'A')
            .map(([id]) => id)
          eliminatedIds = [...minorityIds, ...nonVoterIds]
        }
      }

      let survivorIds = eligiblePlayers
        .filter((p) => !eliminatedIds.includes(p.id))
        .map((p) => p.id)

      // 탈락자 상태 갱신 (기존 상태 보존하며 탈락자만 status = 'eliminated'로 업데이트)
      const updatedPlayers = get().players.map((p) =>
        eliminatedIds.includes(p.id)
          ? { ...p, status: 'eliminated' as const, isAlive: false, eliminatedRound: roundNumber }
          : p
      )

      const alivePlayers = updatedPlayers.filter((p) => p.status === 'alive')

      // 생존자가 2명 이하(0명, 1명, 2명)인 경우 즉시 게임 종료(최종 결과 발표) 처리
      if (alivePlayers.length <= 2) {
        const isGameOver = true
        const soleWinnerId = alivePlayers.length === 1 ? alivePlayers[0].id : null
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
          winnerCount: alivePlayers.length,
          soleWinnerId,
        }

        set((state) => ({
          players: updatedPlayers,
          currentResult: result,
          roundResults: [...state.roundResults, result],
          usedQuestionIds: [...state.usedQuestionIds, currentQuestion.id],
          phase: 'gameover',
          isGameOver: true,
          soleWinnerId,
        }))
        persist()

        const channelId = get().channelId || '1'
        // 서버 및 모든 클라이언트에 최종 게임 오버 이벤트 전송
        socket.emit('admin:game_over', {
          channelId,
          alivePlayers,
          survivors: alivePlayers,
          winnerCount: alivePlayers.length,
          soleWinnerId,
        })
        socket.emit('admin:sync', {
          channelId,
          phase: 'gameover',
          isGameOver: true,
          soleWinnerId,
          currentResult: result,
          roundResults: [...get().roundResults],
          players: updatedPlayers,
          votes: { ...votes },
        })
        return // 다음 라운드로 진행하는 코드 완전 차단
      }

      // 3명 이상 생존 시 결과 공개(result) 단계로 진입
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
        winnerCount: 0,
        soleWinnerId: null,
      }

      const nextPhase: GamePhase = 'result'

      set((state) => ({
        players: updatedPlayers,
        currentResult: result,
        roundResults: [...state.roundResults, result],
        usedQuestionIds: [...state.usedQuestionIds, currentQuestion.id],
        phase: nextPhase,
        isGameOver: false,
        soleWinnerId: null,
      }))
      persist()

      // 결과 화면이 모든 기기(TV, 모바일, 관리자)에 즉시 동일하게 동기화되도록 admin:sync 브로드캐스트
      const channelId = get().channelId || '1'
      socket.emit('admin:sync', {
        channelId,
        phase: nextPhase,
        isGameOver: false,
        soleWinnerId: null,
        currentResult: result,
        roundResults: [...get().roundResults],
        players: updatedPlayers,
        votes: { ...votes },
      })
    },

    nextRound: () => {
      // 2초 내 중복/연속 호출 방어 (광속 스킵 원천 차단)
      const now = Date.now()
      if (now - lastNextRoundTime < 2000) {
        console.warn('⚠️ [nextRound 디바운스] 2초 내 중복 호출이 차단되었습니다.')
        return
      }
      lastNextRoundTime = now

      const { phase, players, timeLimit, channelId: currentCh } = get()
      const channelId = currentCh || '1'
      // 결과 공개('result', 'elimination') 또는 대기실('lobby') 단계에서만 다음 라운드 진행 허용
      if (phase !== 'result' && phase !== 'elimination' && phase !== 'lobby') {
        console.warn(`⚠️ [nextRound 무시] 현재 단계(${phase})에서는 라운드를 건너뛸 수 없습니다.`)
        return
      }

      const alive = players.filter((p) => p.status === 'alive' || p.isAlive === true)

      if (alive.length <= 2) {
        // 생존자가 2명 이하이거나 0명이면 최종 우승자 / 게임오버 화면으로 전환
        const soleWinnerId = alive.length === 1 ? alive[0].id : null
        set({
          phase: 'gameover',
          isGameOver: true,
          soleWinnerId,
        })
        persist()
        socket.emit('admin:sync', { channelId, phase: 'gameover', isGameOver: true, soleWinnerId })
        return
      }

      // 생존자가 3명 이상이면 다음 라운드로 전환
      set((state) => ({
        roundNumber: state.roundNumber + 1,
        votes: {},
        currentResult: null,
      }))
      get().showQuestion()
      const nextQ = get().currentQuestion

      // 3번 서바이벌 퀴즈 규격 이벤트 전송 및 투표 시작
      socket.emit('admin:next_round', { channelId, timeLimit: timeLimit || 15, question: nextQ })
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
      const channelId = get().channelId || '1'
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
        localStorage.setItem(getStorageKey(channelId), JSON.stringify({
          channelId,
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
        if (channelId === '1') {
          localStorage.setItem('lasttwo_game_state_v2', localStorage.getItem(getStorageKey(channelId)) || '')
        }
      } catch (e) { }

      // 서버에 "접속자 유지 리셋" 요청 (소켓 + HTTP)
      socket.emit('admin:reset_game_keep_players', { channelId })
      fetch(`/api/game/reset?channel=${channelId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, keepPlayers: true }),
      }).catch(() => { })
    },

    clearAllPlayers: () => {
      clearDummyVoteTimers()
      const channelId = get().channelId || '1'
      set({ players: [], votes: {}, currentResult: null })
      try {
        localStorage.removeItem(`lasttwo_player_id_ch_${channelId}`)
        localStorage.removeItem(`lasttwo_player_nickname_ch_${channelId}`)
        if (channelId === '1') {
          localStorage.removeItem('lasttwo_player_id')
          localStorage.removeItem('lasttwo_player_nickname')
        }
      } catch (e) {}
      persist()
      socket.emit('admin:clear_all_players', { channelId })
      fetch(`/api/game/reset?channel=${channelId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, keepPlayers: false }),
      }).catch(() => { })
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
      const channelId = get().channelId || '1'
      set({ currentPlayerId: id || null })
      if (typeof window !== 'undefined') {
        if (id) {
          localStorage.setItem(`lasttwo_player_id_ch_${channelId}`, id)
          if (channelId === '1') localStorage.setItem('lasttwo_player_id', id)
        } else {
          localStorage.removeItem(`lasttwo_player_id_ch_${channelId}`)
          if (channelId === '1') localStorage.removeItem('lasttwo_player_id')
        }
      }
      persist()
    },

    clearCurrentPlayer: () => {
      const channelId = get().channelId || '1'
      set({ currentPlayerId: null })
      if (typeof window !== 'undefined') {
        try {
          localStorage.removeItem(`lasttwo_player_id_ch_${channelId}`)
          localStorage.removeItem(`lasttwo_player_nickname_ch_${channelId}`)
          if (channelId === '1') {
            localStorage.removeItem('lasttwo_player_id')
            localStorage.removeItem('lasttwo_player_nickname')
          }
          sessionStorage.removeItem(`lasttwo_player_id_ch_${channelId}`)
          sessionStorage.removeItem(`lasttwo_player_nickname_ch_${channelId}`)
          sessionStorage.removeItem('lasttwo_player_id')
          sessionStorage.removeItem('lasttwo_player_nickname')
        } catch (e) { }
      }
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
      // players 안전 정규화 (null, undefined, 객체 방어)
      if (serverData.players !== undefined) {
        if (!Array.isArray(serverData.players)) {
          serverData.players = serverData.players && typeof serverData.players === 'object'
            ? (Object.values(serverData.players).filter(Boolean) as Player[])
            : []
        } else {
          serverData.players = (serverData.players.filter(Boolean) as Player[])
        }
      }
      // 대기실 복귀/초기화 시 이전 게임 잔여 데이터(투표, 결과 등) 안전 정리
      if (serverData.phase === 'lobby' && (serverData.roundNumber === 0 || !serverData.roundNumber)) {
        serverData.votes = serverData.votes || {}
        serverData.currentResult = null
      }
      // 동일한 ruleMode인 경우 불필요한 재렌더/상태 덮어쓰기 방지
      if (serverData.ruleMode && serverData.ruleMode === get().ruleMode) {
        delete serverData.ruleMode
      }
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
        const ch = state.channelId || '1'
        localStorage.setItem(getStorageKey(ch), JSON.stringify(toSave))
        if (ch === '1') {
          localStorage.setItem('lasttwo_game_state_v2', JSON.stringify(toSave))
        }
      } catch (e) { }
    },
  }
})
