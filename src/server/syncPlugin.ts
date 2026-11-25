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
}

interface ServerGameState {
  channelId: string
  phase: string
  roundNumber: number
  ruleMode: 'majority' | 'minority'
  qrMode: 'wifi' | 'tunnel'
  serverHostUrl: string
  currentQuestion: any
  currentResult: any
  isFinals: boolean
  isGameOver: boolean
  soleWinnerId: string | null
  isPaused: boolean
  timeLimit: number
  votingDeadline: number | null
  timeLeft: number
  players: Player[]
  votes: Record<string, 'A' | 'B'>
  chatMessages: Array<{ id: string; nickname: string; message: string; timestamp: number; channelId?: string; roomId?: string; text?: string; isNotice?: boolean }>
}

interface ChannelRoom {
  id: string
  gameState: ServerGameState
  lastNextRoundTriggerTime: number
}

function createInitialGameState(channelId = '1'): ServerGameState {
  return {
    channelId: String(channelId || '1'),
    phase: 'lobby',
    roundNumber: 0,
    ruleMode: 'majority',
    qrMode: 'wifi',
    serverHostUrl: '',
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

    if (Array.isArray(incomingPlayers) && incomingPlayers.length > 0) {
      const statusMap = new Map(incomingPlayers.map((p: any) => [p.id, p.status]))
      for (const p of ch.gameState.players) {
        if (statusMap.has(p.id)) {
          p.status = statusMap.get(p.id)
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
      broadcastState(ch.id)
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
        ch.gameState.phase = 'voting'
        ch.gameState.votingDeadline = Date.now() + limit * 1000
        ch.gameState.timeLeft = limit
      } else {
        ch.gameState.phase = 'question'
        ch.gameState.votingDeadline = null
        ch.gameState.timeLeft = limit
      }
      broadcastState(ch.id)
      const room = getChannelRoom(ch.id)
      const payload = {
        channelId: ch.id,
        roundNumber: 1,
        question: ch.gameState.currentQuestion,
        timeLimit: ch.gameState.timeLimit,
        votingDeadline: ch.gameState.votingDeadline,
      }
      ioInstance?.to(room).emit('game:round_started', payload)
      if (ch.id === '1') ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:round_started', payload)
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
        socket.emit('game:state_sync', ch.gameState)
        socket.emit('state:sync', ch.gameState)
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
          if (callback) callback({ success: true, player, players: ch.gameState.players, channelId: ch.id })
        } catch (e: any) {
          if (callback) callback({ success: false, error: e.message })
        }
      })

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
          broadcastState(ch.id)
          if (callback) callback({ success: true })
        } catch (e: any) {
          if (callback) callback({ success: false, error: e.message })
        }
      })

      socket.on('admin:start_game', (data: any, callback?: any) => {
        const chId = getEventChannelId(data)
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
        if (data?.question) ch.gameState.currentQuestion = data.question
        if (data?.ruleMode) ch.gameState.ruleMode = data.ruleMode
        const limit = Number(data?.timeLimit) || ch.gameState.timeLimit || 15
        ch.gameState.timeLimit = limit
        if (data?.autoStartVoting !== false) {
          ch.gameState.phase = 'voting'
          ch.gameState.votingDeadline = Date.now() + limit * 1000
          ch.gameState.timeLeft = limit
        } else {
          ch.gameState.phase = 'question'
          ch.gameState.votingDeadline = null
          ch.gameState.timeLeft = limit
        }
        broadcastState(ch.id)
        const room = getChannelRoom(ch.id)
        const payload = {
          channelId: ch.id,
          roundNumber: 1,
          question: ch.gameState.currentQuestion,
          timeLimit: ch.gameState.timeLimit,
          votingDeadline: ch.gameState.votingDeadline,
        }
        ioInstance?.to(room).emit('game:round_started', payload)
        if (ch.id === '1') ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:round_started', payload)
        if (callback) callback({ success: true, phase: ch.gameState.phase, channelId: ch.id })
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
        ch.gameState.timeLimit = limit
        ch.gameState.phase = 'voting'
        ch.gameState.votingDeadline = Date.now() + limit * 1000
        ch.gameState.timeLeft = limit
        broadcastState(ch.id)
        const room = getChannelRoom(ch.id)
        const payload = {
          channelId: ch.id,
          roundNumber: ch.gameState.roundNumber,
          question: ch.gameState.currentQuestion,
          timeLimit: ch.gameState.timeLimit,
          votingDeadline: ch.gameState.votingDeadline,
        }
        ioInstance?.to(room).emit('game:round_started', payload)
        if (ch.id === '1') ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:round_started', payload)
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

      const handleQrModeChange = (data: any, callback?: any) => {
        try {
          const chId = getEventChannelId(data)
          const ch = getChannel(chId)
          const rawMode = data?.mode || data?.qrMode || data
          const mode = rawMode === 'EXTERNAL' || rawMode === 'tunnel' || rawMode === 'lte' ? 'tunnel' : 'wifi'
          ch.gameState.qrMode = mode
          broadcastState(ch.id)
          const room = getChannelRoom(ch.id)
          ioInstance?.to(room).emit('game:qr_mode_changed', { mode, channelId: ch.id })
          ioInstance?.to(room).emit('qr:change', { mode, channelId: ch.id })
          if (ch.id === '1') {
            ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:qr_mode_changed', { mode, channelId: ch.id })
            ioInstance?.to(SOCKET_ROOM_MAIN).emit('qr:change', { mode, channelId: ch.id })
          }
          if (callback) callback({ success: true, mode, channelId: ch.id })
        } catch (err) {
          if (callback) callback({ success: false, mode: 'wifi' })
        }
      }
      socket.on('admin:change_qr_mode', handleQrModeChange)
      socket.on('admin:set-qr-mode', handleQrModeChange)
      socket.on('admin:set_qr_mode', handleQrModeChange)
      socket.on('qr:change', handleQrModeChange)
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
