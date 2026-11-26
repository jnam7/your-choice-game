import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import { Server as SocketIOServer } from 'socket.io'
import os from 'os'
import events from 'events'

events.EventEmitter.defaultMaxListeners = 500

function getLocalNetworkIp() {
  try {
    const interfaces = os.networkInterfaces()
    for (const name of Object.keys(interfaces)) {
      for (const net of interfaces[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address
        }
      }
    }
  } catch { }
  return 'localhost'
}

interface Player {
  id: string
  nickname: string
  status: 'alive' | 'eliminated'
  joinedAt: number
  isDummy?: boolean
  isAlive?: boolean
  eliminatedRound?: number
  socketId?: string
}

interface ServerGameState {
  channelId: string
  phase: string
  roundNumber: number
  ruleMode: 'majority' | 'minority'
  qrMode: 'wifi' | 'tunnel'
  serverHostUrl: string
  bgmVolume?: number
  masterVolume?: number
  isMuted?: boolean
  currentQuestion: any
  currentResult: any
  isFinals: boolean
  isGameOver: boolean
  soleWinnerId: string | null
  isPaused: boolean
  timeLimit: number
  votingDeadline: number | null
  votingEndTime?: number | null
  timeLeft: number
  players: Player[]
  votes: Record<string, 'A' | 'B'>
  chatMessages: Array<{ id: string; nickname: string; message: string; timestamp: number; channelId?: string; roomId?: string; text?: string; isNotice?: boolean }>
}

interface ChannelRoom {
  id: string
  gameState: ServerGameState
  lastNextRoundTriggerTime: number
  votingTimer?: NodeJS.Timeout | null
  revealingTimer?: NodeJS.Timeout | null
}

function createInitialGameState(channelId = '1'): ServerGameState {
  return {
    channelId: String(channelId || '1'),
    phase: 'lobby',
    roundNumber: 0,
    ruleMode: 'majority',
    qrMode: 'wifi',
    serverHostUrl: '',
    bgmVolume: 0.8,
    masterVolume: 0.8,
    isMuted: false,
    currentQuestion: {
      id: 1,
      category: '음식',
      optionA: '평생 치킨만 먹기',
      optionB: '평생 피자만 먹기',
      isFinals: false,
    },
    currentResult: null,
    isFinals: false,
    isGameOver: false,
    soleWinnerId: null,
    isPaused: false,
    timeLimit: 15,
    votingDeadline: null,
    timeLeft: 15,
    players: [],
    votes: {},
    chatMessages: [],
  }
}

const channels = new Map<string, ChannelRoom>()

function getChannel(channelId = '1'): ChannelRoom {
  const id = String(channelId || '1').trim() || '1'
  if (!channels.has(id)) {
    channels.set(id, {
      id,
      gameState: createInitialGameState(id),
      lastNextRoundTriggerTime: 0,
    })
  }
  return channels.get(id)!
}

// 1~5 채널 사전 초기화
;['1', '2', '3', '4', '5'].forEach((id) => getChannel(id))

let ioInstance: SocketIOServer | null = null
const SOCKET_ROOM_MAIN = 'room:survival_quiz_main'

function getChannelRoom(channelId = '1'): string {
  const id = String(channelId || '1').trim() || '1'
  return `room:channel_${id}`
}

function broadcastState(channelId = '1') {
  if (!ioInstance) return
  const ch = getChannel(channelId)
  const room = getChannelRoom(ch.id)
  ioInstance.to(room).emit('game:state_sync', ch.gameState)
  ioInstance.to(room).emit('state:sync', ch.gameState)
  if (ch.id === '1') {
    ioInstance.to(SOCKET_ROOM_MAIN).emit('game:state_sync', ch.gameState)
    ioInstance.to(SOCKET_ROOM_MAIN).emit('state:sync', ch.gameState)
  }
}

// 채널별 투표 쓰로틀링 브로드캐스트 (150ms 단위 배치)
const voteThrottleTimers = new Map<string, NodeJS.Timeout>()

function scheduleThrottledVoteBroadcast(channelId = '1') {
  const ch = getChannel(channelId)
  if (voteThrottleTimers.has(ch.id)) return

  const timer = setTimeout(() => {
    voteThrottleTimers.delete(ch.id)
    if (!ioInstance || ch.gameState.phase !== 'voting') return

    const room = getChannelRoom(ch.id)
    const votePayload = {
      channelId: ch.id,
      votes: ch.gameState.votes,
      voteCount: Object.keys(ch.gameState.votes).length,
    }
    ioInstance.to(room).emit('game:votes_update', votePayload)
    ioInstance.to(room).emit('votes:update', votePayload)
    if (ch.id === '1') {
      ioInstance.to(SOCKET_ROOM_MAIN).emit('game:votes_update', votePayload)
      ioInstance.to(SOCKET_ROOM_MAIN).emit('votes:update', votePayload)
    }
  }, 150)

  voteThrottleTimers.set(ch.id, timer)
}

function clearAllTimers(channelId = '1') {
  const ch = getChannel(channelId)
  if (ch.votingTimer) {
    clearTimeout(ch.votingTimer)
    ch.votingTimer = null
  }
  if (ch.revealingTimer) {
    clearTimeout(ch.revealingTimer)
    ch.revealingTimer = null
  }
  if (voteThrottleTimers.has(ch.id)) {
    clearTimeout(voteThrottleTimers.get(ch.id)!)
    voteThrottleTimers.delete(ch.id)
  }
}

function startServerVoting(channelId = '1', limit = 15) {
  const ch = getChannel(channelId)
  clearAllTimers(ch.id)
  const duration = Number(limit) || 15
  const votingEndTime = Date.now() + duration * 1000

  ch.gameState.phase = 'voting'
  ch.gameState.timeLimit = duration
  ch.gameState.votingDeadline = votingEndTime
  ch.gameState.votingEndTime = votingEndTime
  ch.gameState.timeLeft = duration
  ch.gameState.isPaused = false
  ch.gameState.votes = {}

  console.log(`⏱️ [Vite Plugin CH ${ch.id} VOTING] ${duration}초 투표 시작 (종료 시각: ${votingEndTime})`)
  broadcastState(ch.id)
  if (ioInstance) {
    const room = getChannelRoom(ch.id)
    const payload = {
      channelId: ch.id,
      roundNumber: ch.gameState.roundNumber,
      question: ch.gameState.currentQuestion,
      timeLimit: duration,
      votingDeadline: votingEndTime,
      votingEndTime: votingEndTime,
    }
    ioInstance.to(room).emit('game:round_started', payload)
    ioInstance.to(room).emit('game:voting_started', payload)
    ioInstance.to(room).emit('start_voting', payload)
    if (ch.id === '1') {
      ioInstance.to(SOCKET_ROOM_MAIN).emit('game:round_started', payload)
      ioInstance.to(SOCKET_ROOM_MAIN).emit('game:voting_started', payload)
      ioInstance.to(SOCKET_ROOM_MAIN).emit('start_voting', payload)
    }
  }

  // 절대 타임스탬프 기반 서버 강제 투표 마감
  const delayMs = Math.max(0, votingEndTime - Date.now())
  ch.votingTimer = setTimeout(() => {
    ch.votingTimer = null
    if (ch.gameState.phase !== 'voting' || ch.gameState.isPaused) return
    console.log(`⏰ [Vite Plugin CH ${ch.id}] votingEndTime 도달 -> 서버 강제 투표 마감 및 결과 서스펜스 진입`)
    startServerRevealing(ch.id)
  }, delayMs)
}

function startServerRevealing(channelId = '1') {
  const ch = getChannel(channelId)
  clearAllTimers(ch.id)
  ch.gameState.phase = 'revealing'
  ch.gameState.timeLeft = 3
  ch.gameState.votingDeadline = null
  ch.gameState.votingEndTime = null
  ch.gameState.isPaused = false
  broadcastState(ch.id)

  if (ioInstance) {
    const room = getChannelRoom(ch.id)
    ioInstance.to(room).emit('game:revealing', { channelId: ch.id })
    ioInstance.to(room).emit('revealing', { channelId: ch.id })
    if (ch.id === '1') {
      ioInstance.to(SOCKET_ROOM_MAIN).emit('game:revealing', { channelId: ch.id })
      ioInstance.to(SOCKET_ROOM_MAIN).emit('revealing', { channelId: ch.id })
    }
  }

  ch.revealingTimer = setTimeout(() => {
    ch.revealingTimer = null
    if (ch.gameState.phase !== 'revealing' || ch.gameState.isPaused) return
    computeAndPublishResult(ch.id)
  }, 3000)
}

function computeAndPublishResult(channelId = '1') {
  const ch = getChannel(channelId)
  clearAllTimers(ch.id)
  const { votes, players, currentQuestion, roundNumber, ruleMode } = ch.gameState

  const eligiblePlayers = players.filter((p) => {
    if (p.eliminatedRound && p.eliminatedRound < roundNumber) return false
    return true
  })
  const eligibleIds = new Set(eligiblePlayers.map((p) => p.id))

  const validVotes: Record<string, 'A' | 'B'> = {}
  for (const [pId, choice] of Object.entries(votes || {})) {
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

  let majority: 'A' | 'B' | 'tie'
  let eliminatedIds: string[] = []
  const isMinorityMode = (ruleMode === 'minority')

  if (votesA === votesB) {
    majority = 'tie'
    eliminatedIds = [...nonVoterIds]
  } else if (votesA > votesB) {
    if (isMinorityMode) {
      majority = 'B'
      const majorityIds = Object.entries(validVotes).filter(([, c]) => c === 'A').map(([id]) => id)
      eliminatedIds = [...majorityIds, ...nonVoterIds]
    } else {
      majority = 'A'
      const minorityIds = Object.entries(validVotes).filter(([, c]) => c === 'B').map(([id]) => id)
      eliminatedIds = [...minorityIds, ...nonVoterIds]
    }
  } else {
    if (isMinorityMode) {
      majority = 'A'
      const majorityIds = Object.entries(validVotes).filter(([, c]) => c === 'B').map(([id]) => id)
      eliminatedIds = [...majorityIds, ...nonVoterIds]
    } else {
      majority = 'B'
      const minorityIds = Object.entries(validVotes).filter(([, c]) => c === 'A').map(([id]) => id)
      eliminatedIds = [...minorityIds, ...nonVoterIds]
    }
  }

  const eliminatedSet = new Set(eliminatedIds)
  const survivors: string[] = []
  ch.gameState.players.forEach((p) => {
    if (eligibleIds.has(p.id)) {
      if (eliminatedSet.has(p.id)) {
        p.status = 'eliminated'
        p.isAlive = false
        p.eliminatedRound = roundNumber
      } else {
        p.status = 'alive'
        p.isAlive = true
        survivors.push(p.id)
      }
    }
  })

  const isGameOver = survivors.length <= 2 && roundNumber >= 1
  const soleWinnerId = survivors.length === 1 ? survivors[0] : null

  ch.gameState.currentResult = {
    round: roundNumber,
    questionId: currentQuestion ? currentQuestion.id : 0,
    question: currentQuestion || { id: 0, category: '', optionA: '', optionB: '' },
    votesA,
    votesB,
    majority,
    eliminated: eliminatedIds,
    survivors,
    nonVoters: nonVoterIds.length,
    ruleMode,
  }

  if (isGameOver) {
    ch.gameState.phase = 'gameover'
    ch.gameState.isGameOver = true
    ch.gameState.soleWinnerId = soleWinnerId
    broadcastState(ch.id)
    if (ioInstance) {
      const room = getChannelRoom(ch.id)
      const payload = {
        channelId: ch.id,
        survivors: ch.gameState.players.filter((p) => survivors.includes(p.id)),
        alivePlayers: ch.gameState.players.filter((p) => survivors.includes(p.id)),
        winnerCount: survivors.length,
        soleWinnerId,
      }
      ioInstance.to(room).emit('game:game_over', payload)
      if (ch.id === '1') {
        ioInstance.to(SOCKET_ROOM_MAIN).emit('game:game_over', payload)
      }
    }
    return
  }

  ch.gameState.phase = 'result'
  ch.gameState.isGameOver = false
  ch.gameState.soleWinnerId = null
  ch.gameState.timeLeft = 5

  broadcastState(ch.id)
  if (ioInstance) {
    const room = getChannelRoom(ch.id)
    ioInstance.to(room).emit('game:result_revealed', ch.gameState.currentResult)
    ioInstance.to(room).emit('reveal_result', ch.gameState.currentResult)
    if (ch.id === '1') {
      ioInstance.to(SOCKET_ROOM_MAIN).emit('game:result_revealed', ch.gameState.currentResult)
      ioInstance.to(SOCKET_ROOM_MAIN).emit('reveal_result', ch.gameState.currentResult)
    }
  }
}

function broadcastPlayerJoined(player: Player, channelId = '1') {
  if (!ioInstance) return
  const ch = getChannel(channelId)
  const room = getChannelRoom(ch.id)
  const payload = { channelId: ch.id, player, players: ch.gameState.players, totalCount: ch.gameState.players.length }
  ioInstance.to(room).emit('game:player_joined', payload)
  ioInstance.to(room).emit('player:joined', payload)
  ioInstance.to(room).emit('players:update', ch.gameState.players)
  if (ch.id === '1') {
    ioInstance.to(SOCKET_ROOM_MAIN).emit('game:player_joined', payload)
    ioInstance.to(SOCKET_ROOM_MAIN).emit('player:joined', payload)
    ioInstance.to(SOCKET_ROOM_MAIN).emit('players:update', ch.gameState.players)
  }
}

function parseJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    if ((req as any).body) {
      if (typeof (req as any).body === 'string') {
        try {
          return resolve(JSON.parse((req as any).body))
        } catch {
          return resolve({})
        }
      }
      return resolve((req as any).body)
    }

    let data = ''
    req.setEncoding('utf-8')
    req.on('data', (chunk) => {
      data += chunk
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => {
      resolve({})
    })
  })
}

function sendJson(res: ServerResponse, status: number, data: any) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.end(JSON.stringify(data))
}

function applyAdminSync(updates: any, channelId = '1') {
  const ch = getChannel(channelId)
  if (updates && typeof updates === 'object') {
    const { players: incomingPlayers, channelId: _ch, ...safeUpdates } = updates
    Object.assign(ch.gameState, safeUpdates)

    if (Array.isArray(incomingPlayers)) {
      if (ch.gameState.phase === 'lobby') {
        ch.gameState.players = incomingPlayers
      } else if (incomingPlayers.length > 0) {
        const statusMap = new Map(incomingPlayers.map((p: any) => [p.id, p.status]))
        for (const p of ch.gameState.players) {
          if (statusMap.has(p.id)) {
            p.status = statusMap.get(p.id)
          }
        }
      }
    }

    if (updates.currentResult?.eliminated && Array.isArray(updates.currentResult.eliminated)) {
      const elimSet = new Set(updates.currentResult.eliminated)
      for (const p of ch.gameState.players) {
        if (elimSet.has(p.id)) {
          p.status = 'eliminated'
          p.eliminatedRound = updates.roundNumber
        }
      }
    }

    if (updates.currentResult) {
      ch.gameState.currentResult = updates.currentResult
    }

    broadcastState(ch.id)
  }
}

export function syncPlugin(): Plugin {
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const [pathOnly, queryString] = (req.url || '').split('?')
    const url = pathOnly || ''

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.end()
      return
    }

    const queryParams = new URLSearchParams(queryString || '')
    const getChId = (body?: any) => {
      const raw = queryParams.get('channel') || queryParams.get('channelId') || queryParams.get('ch') || body?.channelId || body?.channel || '1'
      return String(raw).trim() || '1'
    }

    // 1. 전체 상태 조회 (state 및 game/state)
    if (req.method === 'GET' && (url === '/api/state' || url === '/api/game/state')) {
      const chId = getChId()
      sendJson(res, 200, getChannel(chId).gameState)
      return
    }

    // 1-1. 참가자 목록 조회
    if (req.method === 'GET' && (url === '/api/players' || url === '/api/game/players')) {
      const chId = getChId()
      const ch = getChannel(chId)
      sendJson(res, 200, { success: true, count: ch.gameState.players.length, players: ch.gameState.players, channelId: ch.id })
      return
    }

    // 2. 서버 정보 조회
    if (req.method === 'GET' && url === '/api/server-info') {
      sendJson(res, 200, {
        localIp: getLocalNetworkIp(),
        publicUrl: getChannel('1').gameState.serverHostUrl || '',
      })
      return
    }

    // 3. 참가자 참가 (join 및 game/join)
    if (req.method === 'POST' && (url === '/api/join' || url === '/api/game/join')) {
      const body = await parseJsonBody(req)
      const chId = getChId(body)
      const ch = getChannel(chId)
      const nickname = (body.nickname || '').trim()
      const requestedId = body.id

      if (!nickname) {
        sendJson(res, 400, { success: false, error: '닉네임을 입력해주세요.' })
        return
      }

      let player = ch.gameState.players.find((p) => (requestedId && p.id === requestedId) || p.nickname === nickname)
      const isLobby = ch.gameState.phase === 'lobby'
      if (!player) {
        player = {
          id: requestedId || ('p_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6)),
          nickname,
          status: isLobby ? 'alive' : 'eliminated',
          isAlive: isLobby,
          joinedAt: Date.now(),
        }
        ch.gameState.players.push(player)
      } else {
        if (requestedId) player.id = requestedId
        player.nickname = nickname
        if (isLobby) {
          player.status = 'alive'
          player.isAlive = true
        }
      }

      broadcastState(ch.id)
      broadcastPlayerJoined(player, ch.id)
      sendJson(res, 200, { success: true, player, players: ch.gameState.players, channelId: ch.id })
      return
    }

    // 3-1. 참가자 퇴장 (leave 및 game/leave)
    if (req.method === 'POST' && (url === '/api/leave' || url === '/api/game/leave')) {
      const body = await parseJsonBody(req)
      const chId = getChId(body)
      const ch = getChannel(chId)
      const id = body?.id
      if (id) {
        ch.gameState.players = ch.gameState.players.filter((p) => p.id !== id)
        if (ch.gameState.votes && ch.gameState.votes[id]) {
          delete ch.gameState.votes[id]
        }
        broadcastState(ch.id)
        const room = getChannelRoom(ch.id)
        ioInstance?.to(room).emit('player:left', { id, channelId: ch.id })
        ioInstance?.to(room).emit('players:update', ch.gameState.players)
        if (ch.id === '1') {
          ioInstance?.to(SOCKET_ROOM_MAIN).emit('player:left', { id, channelId: ch.id })
          ioInstance?.to(SOCKET_ROOM_MAIN).emit('players:update', ch.gameState.players)
        }
      }
      sendJson(res, 200, { success: true, channelId: ch.id })
      return
    }

    // 4. 투표 제출 (game/vote 및 vote)
    if (req.method === 'POST' && (url === '/api/game/vote' || url === '/api/vote')) {
      const body = await parseJsonBody(req)
      const chId = getChId(body)
      const ch = getChannel(chId)
      const { playerId, choice } = body || {}

      if (!playerId || (choice !== 'A' && choice !== 'B')) {
        sendJson(res, 400, { success: false, error: '잘못된 투표 요청입니다.' })
        return
      }

      const player = ch.gameState.players.find((p) => p.id === playerId)
      if (player && (player.status === 'eliminated' || player.isAlive === false)) {
        sendJson(res, 403, { success: false, error: '이미 탈락한 참가자는 투표할 수 없습니다.' })
        return
      }

      ch.gameState.votes[playerId] = choice
      scheduleThrottledVoteBroadcast(ch.id)
      sendJson(res, 200, { success: true, channelId: ch.id })
      return
    }

    // 5. 게임 시작
    if (req.method === 'POST' && url === '/api/game/start') {
      const body = await parseJsonBody(req)
      const chId = getChId(body)
      const ch = getChannel(chId)
      ch.gameState.roundNumber = 1
      ch.gameState.votes = {}
      ch.gameState.currentResult = null
      ch.gameState.isGameOver = false
      ch.gameState.soleWinnerId = null
      ch.gameState.isPaused = false
      ch.gameState.players.forEach((p) => {
        p.status = 'alive'
        p.isAlive = true
        p.eliminatedRound = undefined
      })
      if (body.question) ch.gameState.currentQuestion = body.question
      if (body.ruleMode) ch.gameState.ruleMode = body.ruleMode
      const limit = Number(body.timeLimit) || ch.gameState.timeLimit || 15
      ch.gameState.timeLimit = limit
      if (body.autoStartVoting !== false) {
        startServerVoting(ch.id, limit)
      } else {
        ch.gameState.phase = 'question'
        ch.gameState.votingDeadline = null
        ;(ch.gameState as any).votingEndTime = null
        ch.gameState.timeLeft = limit
        broadcastState(ch.id)
        const room = getChannelRoom(ch.id)
        const payload = {
          channelId: ch.id,
          roundNumber: 1,
          question: ch.gameState.currentQuestion,
          timeLimit: ch.gameState.timeLimit,
          votingDeadline: null,
          votingEndTime: null,
        }
        ioInstance?.to(room).emit('game:round_started', payload)
        if (ch.id === '1') ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:round_started', payload)
      }
      sendJson(res, 200, { success: true, state: ch.gameState, channelId: ch.id })
      return
    }

    // 6. 관리자 수동 상태 동기화
    if (req.method === 'POST' && (url === '/api/game/sync' || url === '/api/admin/sync')) {
      const body = await parseJsonBody(req)
      const chId = getChId(body)
      applyAdminSync(body, chId)
      sendJson(res, 200, { success: true, state: getChannel(chId).gameState, channelId: chId })
      return
    }

    // 7. 게임 리셋
    if (req.method === 'POST' && url === '/api/game/reset') {
      const body = await parseJsonBody(req)
      const chId = getChId(body)
      const ch = getChannel(chId)
      const { keepPlayers } = body || {}
      ch.gameState.phase = 'lobby'
      ch.gameState.roundNumber = 0
      ch.gameState.currentQuestion = null
      ch.gameState.currentResult = null
      ch.gameState.isGameOver = false
      ch.gameState.soleWinnerId = null
      ch.gameState.isPaused = false
      ch.gameState.votes = {}
      if (keepPlayers) {
        ch.gameState.players.forEach((p) => {
          p.status = 'alive'
          p.isAlive = true
          p.eliminatedRound = undefined
        })
      } else {
        ch.gameState.players = []
      }
      broadcastState(ch.id)
      const room = getChannelRoom(ch.id)
      ioInstance?.to(room).emit('game:force_lobby', { channelId: ch.id })
      ioInstance?.to(room).emit('game:set_reset', { channelId: ch.id })
      if (ch.id === '1') {
        ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:force_lobby', { channelId: ch.id })
        ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:set_reset', { channelId: ch.id })
      }
      sendJson(res, 200, { success: true, channelId: ch.id })
      return
    }

    next()
  }

  const setupSocketIO = (server: any) => {
    if (ioInstance) return

    ioInstance = new SocketIOServer(server, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
      pingTimeout: 60000,
      pingInterval: 25000,
    })

    ioInstance.on('connection', (socket: any) => {
      socket.data = socket.data || {}
      socket.data.channelId = '1'

      socket.join('room:channel_1')
      socket.join(SOCKET_ROOM_MAIN)

      const getEventChannelId = (data: any) => {
        const raw = data?.channelId || data?.channel || socket.data?.channelId || '1'
        return String(raw).trim() || '1'
      }

      socket.on('join:channel', (data: any, callback?: any) => {
        const targetChannel = getEventChannelId(data)
        for (const r of socket.rooms) {
          if (r.startsWith('room:channel_') && r !== getChannelRoom(targetChannel)) {
            socket.leave(r)
          }
        }
        socket.join(getChannelRoom(targetChannel))
        if (targetChannel === '1') {
          socket.join(SOCKET_ROOM_MAIN)
        }
        socket.data.channelId = targetChannel
        const ch = getChannel(targetChannel)
        // 방 생성 직후 완성된 초기 게임 상태를 담아 즉시 다중 이벤트 응답 (TV 화면 로딩 갇힘 원천 차단)
        socket.emit('sync', ch.gameState)
        socket.emit('game:sync', ch.gameState)
        socket.emit('game:state_sync', ch.gameState)
        socket.emit('state:sync', ch.gameState)
        socket.emit('admin:sync', ch.gameState)
        if (callback) callback({ success: true, channelId: targetChannel, state: ch.gameState })
      })

      socket.on('join:room', (data: any) => {
        const targetRoom = data?.roomId || SOCKET_ROOM_MAIN
        socket.join(targetRoom)
        if (data?.channelId) {
          socket.data.channelId = String(data.channelId).trim() || '1'
        }
      })
      socket.on('join', (data: any) => {
        const targetRoom = typeof data === 'string' ? data : (data?.roomId || SOCKET_ROOM_MAIN)
        socket.join(targetRoom)
      })

      socket.emit('game:state_sync', getChannel('1').gameState)
      socket.emit('state:sync', getChannel('1').gameState)

      // 1-0. 참가자 재접속 세션 복구 (player:reconnect)
      socket.on('player:reconnect', (data: any, callback?: any) => {
        try {
          const chId = getEventChannelId(data)
          const ch = getChannel(chId)
          const playerId = data?.playerId || data?.id
          const nickname = (data?.nickname || '').trim()

          if (!playerId && !nickname) {
            if (callback) callback({ success: false, error: '유효하지 않은 재접속 정보입니다.' })
            return
          }

          const room = getChannelRoom(ch.id)
          socket.join(room)
          if (ch.id === '1') {
            socket.join(SOCKET_ROOM_MAIN)
          }
          socket.data.channelId = ch.id

          let player = ch.gameState.players.find((p: any) => (playerId && p.id === playerId) || (nickname && p.nickname === nickname) as boolean)
          const isLobby = ch.gameState.phase === 'lobby'

          if (player) {
            player.socketId = socket.id
            if (playerId) player.id = playerId
            if (nickname) player.nickname = nickname
            console.log(`🔄 [CH ${ch.id} PLAYER RECONNECT] ${player.nickname} (${player.id}) 최신 소켓 갱신`)
          } else {
            const restoredPlayer: Player = {
              id: playerId || ('p_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6)),
              nickname: nickname || '참가자',
              status: isLobby ? 'alive' : 'eliminated',
              isAlive: isLobby,
              joinedAt: Date.now(),
              socketId: socket.id,
            }
            player = restoredPlayer
            ch.gameState.players.push(restoredPlayer)
            console.log(`➕ [CH ${ch.id} PLAYER RECONNECT RESTORE] ${restoredPlayer.nickname} (${restoredPlayer.id}) 재등록`)
            broadcastPlayerJoined(restoredPlayer, ch.id)
          }

          socket.emit('sync', ch.gameState)
          socket.emit('game:sync', ch.gameState)
          socket.emit('game:state_sync', ch.gameState)
          socket.emit('state:sync', ch.gameState)

          if (callback) {
            callback({
              success: true,
              player,
              players: ch.gameState.players,
              channelId: ch.id,
              gameState: ch.gameState,
            })
          }
        } catch (e: any) {
          console.error('[player:reconnect Error]', e)
          if (callback) callback({ success: false, error: e.message })
        }
      })

      socket.on('player:join', (data: any, callback?: any) => {
        try {
          const chId = getEventChannelId(data)
          const ch = getChannel(chId)
          const nickname = (data?.nickname || '').trim()
          const requestedId = data?.id || data?.token
          if (!nickname) {
            if (callback) callback({ success: false, error: '닉네임을 입력해주세요.' })
            return
          }
          let player = ch.gameState.players.find((p) => (requestedId && p.id === requestedId) || p.nickname === nickname)
          const isLobby = ch.gameState.phase === 'lobby'
          if (!player) {
            player = {
              id: requestedId || ('p_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6)),
              nickname,
              status: isLobby ? 'alive' : 'eliminated',
              isAlive: isLobby,
              joinedAt: Date.now(),
            }
            ch.gameState.players.push(player)
          } else {
            if (requestedId) player.id = requestedId
            player.nickname = nickname
            if (isLobby) {
              player.status = 'alive'
              player.isAlive = true
            }
          }
          broadcastState(ch.id)
          broadcastPlayerJoined(player, ch.id)
          socket.emit('sync', ch.gameState)
          socket.emit('game:sync', ch.gameState)
          if (callback) callback({ success: true, player, players: ch.gameState.players, channelId: ch.id })
        } catch (e: any) {
          if (callback) callback({ success: false, error: e.message })
        }
      })

      // 관리자 더미 참가자 추가
      const handleAddMockPlayers = (data: any, callback?: any) => {
        try {
          const chId = getEventChannelId(data)
          const ch = getChannel(chId)
          const incoming = Array.isArray(data?.newPlayers) ? data.newPlayers : []
          if (incoming.length > 0) {
            incoming.forEach((p: Player) => { p.isDummy = true; p.isAlive = true; p.status = 'alive' })
            ch.gameState.players.push(...incoming)
          } else {
            const count = Math.min(300, Math.max(1, Number(data?.count) || 10))
            const existing = ch.gameState.players.length
            const mockNames = [
              '기획팀_김철수', '개발팀_이영희', '디자인_박민수', '마케팅_최지우', '인사팀_정우성',
              '영업1팀_강동원', '재무팀_한지민', '품질관리_송중기', '보안팀_전지현', '총무팀_유재석',
              '해외영업_이정재', '고객지원_박보영', '연구소_신하균', '전략팀_김혜수', '홍보팀_공유',
              'IT지원_손예진', '신사업_조인성', '구매팀_차은우', '데이터팀_아이유', '비서실_원빈'
            ]
            const newDummies = []
            for (let i = 0; i < count; i++) {
              const idx = existing + i
              const nickname = idx < mockNames.length ? mockNames[idx] : `참가자${idx + 1}`
              newDummies.push({
                id: `mock_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 6)}`,
                nickname,
                status: 'alive' as const,
                isAlive: true,
                joinedAt: Date.now() + i,
                isDummy: true,
              })
            }
            ch.gameState.players.push(...newDummies)
          }

          broadcastState(ch.id)
          const room = getChannelRoom(ch.id)
          ioInstance?.to(room).emit('players:update', ch.gameState.players)
          ioInstance?.to(room).emit('sync', ch.gameState)
          ioInstance?.to(room).emit('game:sync', ch.gameState)
          if (ch.id === '1') {
            ioInstance?.to(SOCKET_ROOM_MAIN).emit('players:update', ch.gameState.players)
            ioInstance?.to(SOCKET_ROOM_MAIN).emit('sync', ch.gameState)
            ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:sync', ch.gameState)
          }
          if (callback) callback({ success: true, total: ch.gameState.players.length, channelId: ch.id })
        } catch (e: any) {
          if (callback) callback({ success: false, error: e.message })
        }
      }

      socket.on('admin:add_mock_players', handleAddMockPlayers)
      socket.on('admin:add-mock-players', handleAddMockPlayers)

      socket.on('player:leave', (data: any, callback?: any) => {
        try {
          const chId = getEventChannelId(data)
          const ch = getChannel(chId)
          const id = data?.id
          if (id) {
            ch.gameState.players = ch.gameState.players.filter((p) => p.id !== id)
            if (ch.gameState.votes && ch.gameState.votes[id]) {
              delete ch.gameState.votes[id]
            }
            broadcastState(ch.id)
            const room = getChannelRoom(ch.id)
            ioInstance?.to(room).emit('player:left', { id, channelId: ch.id })
            ioInstance?.to(room).emit('players:update', ch.gameState.players)
            if (ch.id === '1') {
              ioInstance?.to(SOCKET_ROOM_MAIN).emit('player:left', { id, channelId: ch.id })
              ioInstance?.to(SOCKET_ROOM_MAIN).emit('players:update', ch.gameState.players)
            }
          }
          if (callback) callback({ success: true })
        } catch (e: any) {
          if (callback) callback({ success: false, error: e.message })
        }
      })

      socket.on('player:vote', (data: any, callback?: any) => {
        try {
          const chId = getEventChannelId(data)
          const ch = getChannel(chId)
          const { playerId, choice } = data || {}
          if (!playerId || (choice !== 'A' && choice !== 'B')) {
            if (callback) callback({ success: false, error: '잘못된 투표 요청입니다.' })
            return
          }
          const player = ch.gameState.players.find((p) => p.id === playerId)
          if (player && (player.status === 'eliminated' || player.isAlive === false)) {
            if (callback) callback({ success: false, error: '이미 탈락한 참가자는 투표할 수 없습니다.' })
            return
          }
          ch.gameState.votes[playerId] = choice
          scheduleThrottledVoteBroadcast(ch.id)
          if (callback) callback({ success: true })
        } catch (e: any) {
          if (callback) callback({ success: false, error: e.message })
        }
      })

      socket.on('admin:start_game', (data: any, callback?: any) => {
        const chId = getEventChannelId(data)
        const ch = getChannel(chId)
        clearAllTimers(ch.id)
        ch.gameState.roundNumber = 1
        ch.gameState.votes = {}
        ch.gameState.currentResult = null
        ch.gameState.isGameOver = false
        ch.gameState.soleWinnerId = null
        ch.gameState.isPaused = false
        ch.gameState.players.forEach((p) => {
          p.status = 'alive'
          p.isAlive = true
          p.eliminatedRound = undefined
        })
        if (data?.question) ch.gameState.currentQuestion = data.question
        if (data?.ruleMode) ch.gameState.ruleMode = data.ruleMode
        const limit = Number(data?.timeLimit) || ch.gameState.timeLimit || 15
        ch.gameState.timeLimit = limit
        if (data?.autoStartVoting !== false) {
          startServerVoting(ch.id, limit)
        } else {
          ch.gameState.phase = 'question'
          ch.gameState.votingDeadline = null
          ;(ch.gameState as any).votingEndTime = null
          ch.gameState.timeLeft = limit
          broadcastState(ch.id)
          const room = getChannelRoom(ch.id)
          const payload = {
            channelId: ch.id,
            roundNumber: 1,
            question: ch.gameState.currentQuestion,
            timeLimit: ch.gameState.timeLimit,
            votingDeadline: null,
            votingEndTime: null,
          }
          ioInstance?.to(room).emit('game:round_started', payload)
          if (ch.id === '1') ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:round_started', payload)
        }
        if (callback) callback({ success: true, phase: ch.gameState.phase, channelId: ch.id })
      })

      socket.on('admin:start_voting', (data: any, callback?: any) => {
        try {
          const chId = getEventChannelId(data)
          const ch = getChannel(chId)
          const limit = Number(data?.timeLimit) || ch.gameState.timeLimit || 15
          startServerVoting(ch.id, limit)
          if (callback) callback({ success: true })
        } catch (e: any) {
          if (callback) callback({ success: false, error: e.message })
        }
      })

      socket.on('admin:end_voting', (data: any, callback?: any) => {
        try {
          const chId = getEventChannelId(data)
          startServerRevealing(chId)
          if (callback) callback({ success: true })
        } catch (e: any) {
          if (callback) callback({ success: false, error: e.message })
        }
      })

      socket.on('admin:next_round', (data: any, callback?: any) => {
        const chId = getEventChannelId(data)
        const ch = getChannel(chId)
        const now = Date.now()
        if (now - ch.lastNextRoundTriggerTime < 1500) {
          if (callback) callback({ success: false, reason: '중복 요청 차단' })
          return
        }
        if (ch.gameState.phase !== 'result' && ch.gameState.phase !== 'lobby') {
          if (callback) callback({ success: false, reason: '진행 불가 단계' })
          return
        }
        ch.lastNextRoundTriggerTime = now

        ch.gameState.roundNumber += 1
        ch.gameState.votes = {}
        ch.gameState.currentResult = null
        if (data?.question) ch.gameState.currentQuestion = data.question
        const limit = Number(data?.timeLimit) || ch.gameState.timeLimit || 15
        startServerVoting(ch.id, limit)
        if (callback) callback({ success: true })
      })

      socket.on('admin:game_over', (data: any, callback?: any) => {
        const chId = getEventChannelId(data)
        const ch = getChannel(chId)
        ch.gameState.phase = 'gameover'
        ch.gameState.isGameOver = true
        const alivePlayers = Array.isArray(data?.alivePlayers) ? data.alivePlayers : ch.gameState.players.filter((p) => p.status === 'alive')
        ch.gameState.soleWinnerId = alivePlayers.length === 1 ? alivePlayers[0].id : (data?.soleWinnerId || null)
        broadcastState(ch.id)
        if (ioInstance) {
          const room = getChannelRoom(ch.id)
          const payload = {
            channelId: ch.id,
            survivors: alivePlayers,
            alivePlayers,
            winnerCount: alivePlayers.length,
            soleWinnerId: ch.gameState.soleWinnerId,
          }
          ioInstance.to(room).emit('game:game_over', payload)
          if (ch.id === '1') {
            ioInstance.to(SOCKET_ROOM_MAIN).emit('game:game_over', payload)
          }
        }
        if (callback) callback({ success: true })
      })

      socket.on('admin:pause_game', (data: any) => {
        const chId = getEventChannelId(data)
        const ch = getChannel(chId)
        ch.gameState.isPaused = true
        broadcastState(ch.id)
      })

      socket.on('admin:resume_game', (data: any) => {
        const chId = getEventChannelId(data)
        const ch = getChannel(chId)
        ch.gameState.isPaused = false
        broadcastState(ch.id)
      })

      socket.on('admin:reset_game', (data: any, callback?: any) => {
        const chId = getEventChannelId(data)
        const ch = getChannel(chId)
        ch.gameState.phase = 'lobby'
        ch.gameState.roundNumber = 0
        ch.gameState.currentQuestion = null
        ch.gameState.currentResult = null
        ch.gameState.isGameOver = false
        ch.gameState.soleWinnerId = null
        ch.gameState.isPaused = false
        ch.gameState.votes = {}
        ch.gameState.players.forEach((p) => {
          p.status = 'alive'
          p.isAlive = true
          p.eliminatedRound = undefined
        })
        broadcastState(ch.id)
        const room = getChannelRoom(ch.id)
        ioInstance?.to(room).emit('game:force_lobby', { channelId: ch.id })
        ioInstance?.to(room).emit('game:set_reset', { channelId: ch.id })
        if (ch.id === '1') {
          ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:force_lobby', { channelId: ch.id })
          ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:set_reset', { channelId: ch.id })
        }
        if (callback) callback({ success: true })
      })

      socket.on('admin:clear_all_players', (data: any, callback?: any) => {
        const chId = getEventChannelId(data)
        const ch = getChannel(chId)
        ch.gameState.phase = 'lobby'
        ch.gameState.roundNumber = 0
        ch.gameState.currentQuestion = null
        ch.gameState.currentResult = null
        ch.gameState.isGameOver = false
        ch.gameState.soleWinnerId = null
        ch.gameState.players = []
        ch.gameState.votes = {}
        broadcastState(ch.id)
        const room = getChannelRoom(ch.id)
        ioInstance?.to(room).emit('game:player_kicked_all', { channelId: ch.id })
        ioInstance?.to(room).emit('game:reset', { channelId: ch.id })
        if (ch.id === '1') {
          ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:player_kicked_all', { channelId: ch.id })
          ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:reset', { channelId: ch.id })
        }
        if (callback) callback({ success: true })
      })

      socket.on('admin:sync', (updates: any) => {
        try {
          const chId = getEventChannelId(updates)
          applyAdminSync(updates, chId)
        } catch (e) {
          console.error('[admin:sync Error]', e)
        }
      })

      socket.on('chat:message', (data: any) => {
        try {
          const chId = getEventChannelId(data)
          const ch = getChannel(chId)
          const text = ((data?.text || data?.message || '') + '').trim()
          const nickname = ((data?.nickname || '익명') + '').trim()
          const targetRoom = getChannelRoom(ch.id)

          if (text) {
            const msg = {
              id: data?.id || ('msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6)),
              playerId: data?.playerId || socket.id,
              nickname: nickname || '참가자',
              text,
              message: text,
              timestamp: data?.timestamp || Date.now(),
              isNotice: Boolean(data?.isNotice),
              channelId: ch.id,
              roomId: targetRoom,
            }
            ch.gameState.chatMessages.push(msg)
            if (ch.gameState.chatMessages.length > 50) ch.gameState.chatMessages.shift()
            ioInstance?.to(targetRoom).emit('chat:message', msg)
            if (ch.id === '1') ioInstance?.to(SOCKET_ROOM_MAIN).emit('chat:message', msg)
          }
        } catch (e) {
          console.error('[chat error]', e)
        }
      })

      socket.on('chat:send', (data: any) => {
        socket.emit('chat:message', data)
      })

      const handleRuleModeChange = (data: any, callback?: any) => {
        try {
          const chId = getEventChannelId(data)
          const ch = getChannel(chId)
          const mode = data?.ruleMode || data?.mode || (data === 'minority' ? 'minority' : 'majority')
          ch.gameState.ruleMode = mode === 'minority' ? 'minority' : 'majority'
          broadcastState(ch.id)
          const room = getChannelRoom(ch.id)
          ioInstance?.to(room).emit('game:rule_mode_changed', { ruleMode: ch.gameState.ruleMode, channelId: ch.id })
          if (ch.id === '1') {
            ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:rule_mode_changed', { ruleMode: ch.gameState.ruleMode, channelId: ch.id })
          }
          if (callback) callback({ success: true, ruleMode: ch.gameState.ruleMode, channelId: ch.id })
        } catch (err: any) {
          if (callback) callback({ success: false, error: err.message })
        }
      }

      socket.on('admin:set_rule_mode', handleRuleModeChange)
      socket.on('admin:set-rule-mode', handleRuleModeChange)

      const handleQrModeChange = (data: any, callback?: any) => {
        try {
          const chId = getEventChannelId(data)
          const ch = getChannel(chId)
          const rawMode = data?.qrMode || data?.mode || data
          const mode = rawMode === 'EXTERNAL' || rawMode === 'tunnel' || rawMode === 'lte' || rawMode === 'external' ? 'tunnel' : 'wifi'
          ch.gameState.qrMode = mode
          const room = getChannelRoom(ch.id)
          ioInstance?.to(room).emit('qr_mode_updated', { qrMode: mode, mode, channelId: ch.id })
          ioInstance?.to(room).emit('game:qr_mode_changed', { qrMode: mode, mode, channelId: ch.id })
          ioInstance?.to(room).emit('qr:change', { qrMode: mode, mode, channelId: ch.id })
          if (ch.id === '1') {
            ioInstance?.to(SOCKET_ROOM_MAIN).emit('qr_mode_updated', { qrMode: mode, mode, channelId: ch.id })
            ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:qr_mode_changed', { qrMode: mode, mode, channelId: ch.id })
            ioInstance?.to(SOCKET_ROOM_MAIN).emit('qr:change', { qrMode: mode, mode, channelId: ch.id })
          }
          if (callback) callback({ success: true, mode, qrMode: mode, channelId: ch.id })
        } catch (err) {
          if (callback) callback({ success: false, mode: 'wifi' })
        }
      }
      socket.on('admin:change_qr_mode', handleQrModeChange)
      socket.on('admin:set-qr-mode', handleQrModeChange)
      socket.on('admin:set_qr_mode', handleQrModeChange)
      socket.on('qr:change', handleQrModeChange)

      // 마스터 볼륨 및 음소거 설정
      socket.on('admin:set_volume', (data: any) => {
        try {
          const chId = getEventChannelId(data)
          const ch = getChannel(chId)
          const rawVol = typeof data?.masterVolume === 'number' ? data.masterVolume : (typeof data?.volume === 'number' ? data.volume : 0.8)
          const vol = Math.max(0, Math.min(1, rawVol))
          const isMuted = typeof data?.isMuted === 'boolean' ? data.isMuted : false
          ch.gameState.masterVolume = vol
          ch.gameState.bgmVolume = vol
          ch.gameState.isMuted = isMuted
          const room = getChannelRoom(ch.id)
          const payload = { volume: vol, masterVolume: vol, isMuted, channelId: ch.id }
          ioInstance?.to(room).emit('volume_updated', payload)
          ioInstance?.to(room).emit('admin:volume_updated', payload)
          ioInstance?.to(room).emit('game:volume_changed', payload)
          if (ch.id === '1') {
            ioInstance?.to(SOCKET_ROOM_MAIN).emit('volume_updated', payload)
            ioInstance?.to(SOCKET_ROOM_MAIN).emit('admin:volume_updated', payload)
            ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:volume_changed', payload)
          }
        } catch (e) {
          console.error('[syncPlugin admin:set_volume Error]', e)
        }
      })
    })
  }

  return {
    name: 'game-sync-plugin',
    configureServer(server) {
      server.middlewares.use(handler)
      if (server.httpServer) {
        setupSocketIO(server.httpServer)
      }
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
      if (server.httpServer) {
        setupSocketIO(server.httpServer)
      }
    },
  }
}
