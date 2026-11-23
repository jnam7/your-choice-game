import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import { Server as SocketIOServer } from 'socket.io'
import os from 'os'

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
  } catch {}
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
  chatMessages: Array<{ id: string; nickname: string; message: string; timestamp: number }>
}

const gameState: ServerGameState = {
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

let ioInstance: SocketIOServer | null = null
const SOCKET_ROOM_MAIN = 'room:survival_quiz_main'

function broadcastState() {
  if (!ioInstance) return
  ioInstance.to(SOCKET_ROOM_MAIN).emit('game:state_sync', gameState)
  ioInstance.to(SOCKET_ROOM_MAIN).emit('state:sync', gameState)
  ioInstance.emit('game:state_sync', gameState)
  ioInstance.emit('state:sync', gameState)
}

function broadcastPlayerJoined(player: Player) {
  if (!ioInstance) return
  ioInstance.to(SOCKET_ROOM_MAIN).emit('game:player_joined', { player, players: gameState.players, totalCount: gameState.players.length })
  ioInstance.to(SOCKET_ROOM_MAIN).emit('player:joined', { player, players: gameState.players, totalCount: gameState.players.length })
  ioInstance.to(SOCKET_ROOM_MAIN).emit('players:update', gameState.players)
  ioInstance.emit('game:player_joined', { player, players: gameState.players, totalCount: gameState.players.length })
  ioInstance.emit('player:joined', { player, players: gameState.players, totalCount: gameState.players.length })
  ioInstance.emit('players:update', gameState.players)
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

function applyAdminSync(updates: any) {
  if (updates && typeof updates === 'object') {
    const { players: incomingPlayers, ...safeUpdates } = updates
    Object.assign(gameState, safeUpdates)

    if (Array.isArray(incomingPlayers) && incomingPlayers.length > 0) {
      const statusMap = new Map(incomingPlayers.map((p: any) => [p.id, p.status]))
      for (const p of gameState.players) {
        if (statusMap.has(p.id)) {
          p.status = statusMap.get(p.id)
        }
      }
    }

    if (updates.currentResult?.eliminated && Array.isArray(updates.currentResult.eliminated)) {
      const elimSet = new Set(updates.currentResult.eliminated)
      for (const p of gameState.players) {
        if (elimSet.has(p.id)) {
          p.status = 'eliminated'
          p.eliminatedRound = updates.roundNumber
        }
      }
    }

    if (updates.currentResult) {
      gameState.currentResult = updates.currentResult
    }

    broadcastState()
  }
}

export function syncPlugin(): Plugin {
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url?.split('?')[0] || ''

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.end()
      return
    }

    // 1. 전체 상태 조회 (state 및 game/state)
    if (req.method === 'GET' && (url === '/api/state' || url === '/api/game/state')) {
      sendJson(res, 200, gameState)
      return
    }

    // 1-1. 참가자 목록 조회
    if (req.method === 'GET' && (url === '/api/players' || url === '/api/game/players')) {
      sendJson(res, 200, { success: true, count: gameState.players.length, players: gameState.players })
      return
    }

    // 2. 서버 정보 조회
    if (req.method === 'GET' && url === '/api/server-info') {
      sendJson(res, 200, {
        localIp: getLocalNetworkIp(),
        publicUrl: gameState.serverHostUrl || '',
      })
      return
    }

    // 3. 참가자 참가 (join 및 game/join)
    if (req.method === 'POST' && (url === '/api/join' || url === '/api/game/join')) {
      const body = await parseJsonBody(req)
      const nickname = (body.nickname || '').trim()
      const requestedId = body.id

      if (!nickname) {
        sendJson(res, 400, { success: false, error: '닉네임을 입력해주세요.' })
        return
      }

      let player = gameState.players.find((p) => (requestedId && p.id === requestedId) || p.nickname === nickname)
      if (!player) {
        player = {
          id: requestedId || ('p_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6)),
          nickname,
          status: 'alive',
          isAlive: true,
          joinedAt: Date.now(),
        }
        gameState.players.push(player)
      } else {
        if (requestedId) player.id = requestedId
        player.nickname = nickname
        player.status = 'alive'
        player.isAlive = true
      }

      broadcastState()
      broadcastPlayerJoined(player)
      sendJson(res, 200, { success: true, player, players: gameState.players })
      return
    }

    // 3-1. 참가자 퇴장 (leave 및 game/leave)
    if (req.method === 'POST' && (url === '/api/leave' || url === '/api/game/leave')) {
      const body = await parseJsonBody(req)
      const id = body?.id
      if (id) {
        gameState.players = gameState.players.filter((p) => p.id !== id)
        if (gameState.votes && gameState.votes[id]) {
          delete gameState.votes[id]
        }
        broadcastState()
        ioInstance?.to(SOCKET_ROOM_MAIN).emit('player:left', { id })
        ioInstance?.to(SOCKET_ROOM_MAIN).emit('players:update', gameState.players)
        ioInstance?.emit('players:update', gameState.players)
      }
      sendJson(res, 200, { success: true })
      return
    }

    // 4. 투표 제출 (vote 및 game/vote)
    if (req.method === 'POST' && (url === '/api/vote' || url === '/api/game/vote')) {
      const body = await parseJsonBody(req)
      const { playerId, choice } = body

      if (!playerId || (choice !== 'A' && choice !== 'B')) {
        sendJson(res, 400, { success: false, error: '잘못된 투표 요청입니다.' })
        return
      }

      const player = gameState.players.find((p) => p.id === playerId)
      if (player && (player.status === 'eliminated' || player.isAlive === false)) {
        sendJson(res, 403, { success: false, error: '이미 탈락한 참가자는 투표할 수 없습니다.' })
        return
      }

      gameState.votes[playerId] = choice
      broadcastState()
      sendJson(res, 200, { success: true, votes: gameState.votes })
      return
    }

    // 5. 관리자 게임 시작 (game/start)
    if (req.method === 'POST' && url === '/api/game/start') {
      const body = await parseJsonBody(req)
      gameState.roundNumber = 1
      gameState.votes = {}
      gameState.currentResult = null
      gameState.isGameOver = false
      gameState.soleWinnerId = null
      gameState.isPaused = false
      gameState.players.forEach((p) => {
        p.status = 'alive'
        p.isAlive = true
        p.eliminatedRound = undefined
      })
      if (body.question) gameState.currentQuestion = body.question
      if (body.ruleMode) gameState.ruleMode = body.ruleMode
      const limit = Number(body.timeLimit) || gameState.timeLimit || 15
      gameState.timeLimit = limit
      if (body.autoStartVoting !== false) {
        gameState.phase = 'voting'
        gameState.votingDeadline = Date.now() + limit * 1000
        gameState.timeLeft = limit
      } else {
        gameState.phase = 'question'
        gameState.votingDeadline = null
        gameState.timeLeft = limit
      }

      broadcastState()
      if (ioInstance) {
        ioInstance.to(SOCKET_ROOM_MAIN).emit('game:round_started', {
          roundNumber: 1,
          question: gameState.currentQuestion,
          timeLimit: gameState.timeLimit,
          votingDeadline: gameState.votingDeadline,
        })
      }
      sendJson(res, 200, { success: true, state: gameState })
      return
    }

    // 6. 관리자 상태 동기화 (admin/sync 및 game/sync)
    if (req.method === 'POST' && (url === '/api/admin/sync' || url === '/api/game/sync')) {
      const body = await parseJsonBody(req)
      applyAdminSync(body)
      sendJson(res, 200, { success: true, state: gameState })
      return
    }

    // 7. 게임 리셋 (game/reset)
    if (req.method === 'POST' && url === '/api/game/reset') {
      const body = await parseJsonBody(req)
      const { keepPlayers } = body || {}
      gameState.phase = 'lobby'
      gameState.roundNumber = 0
      gameState.currentQuestion = null
      gameState.currentResult = null
      gameState.isGameOver = false
      gameState.soleWinnerId = null
      gameState.votes = {}
      if (keepPlayers) {
        gameState.players.forEach((p) => {
          p.status = 'alive'
          p.isAlive = true
          p.eliminatedRound = undefined
        })
        broadcastState()
        if (ioInstance) {
          ioInstance.to(SOCKET_ROOM_MAIN).emit('game:force_lobby')
          ioInstance.to(SOCKET_ROOM_MAIN).emit('game:set_reset')
        }
      } else {
        gameState.players = []
        broadcastState()
        if (ioInstance) {
          ioInstance.to(SOCKET_ROOM_MAIN).emit('game:player_kicked_all')
          ioInstance.to(SOCKET_ROOM_MAIN).emit('game:reset')
        }
      }
      sendJson(res, 200, { success: true })
      return
    }

    // 8. 채팅 메시지 전송
    if (req.method === 'POST' && url === '/api/chat') {
      const body = await parseJsonBody(req)
      const { nickname, message } = body
      if (nickname && message) {
        const msg = {
          id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
          nickname,
          message,
          timestamp: Date.now(),
        }
        gameState.chatMessages.push(msg)
        if (gameState.chatMessages.length > 50) {
          gameState.chatMessages.shift()
        }
        if (ioInstance) {
          ioInstance.to(SOCKET_ROOM_MAIN).emit('chat:received', msg)
          ioInstance.to(SOCKET_ROOM_MAIN).emit('chat:message', msg)
        }
        sendJson(res, 200, { success: true, message: msg })
        return
      }
      sendJson(res, 400, { success: false, error: '메시지를 입력해주세요.' })
      return
    }

    next()
  }

  function setupSocketIO(httpServer: any) {
    if (!httpServer || ioInstance) return

    ioInstance = new SocketIOServer(httpServer, {
      cors: { origin: '*', methods: ['GET', 'POST'] },
      pingTimeout: 60000,
      pingInterval: 25000,
      connectTimeout: 45000,
      allowEIO3: true,
    })

    ioInstance.on('connection', (socket) => {
      socket.join(SOCKET_ROOM_MAIN)
      socket.emit('game:state_sync', gameState)
      socket.emit('state:sync', gameState)

      socket.on('player:join', (data, callback) => {
        try {
          const nickname = (data?.nickname || '').trim()
          const requestedId = data?.id || data?.token
          if (!nickname) {
            if (callback) callback({ success: false, error: '닉네임을 입력해주세요.' })
            return
          }
          let player = gameState.players.find((p) => (requestedId && p.id === requestedId) || p.nickname === nickname)
          if (!player) {
            player = {
              id: requestedId || ('p_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6)),
              nickname,
              status: 'alive',
              isAlive: true,
              joinedAt: Date.now(),
            }
            gameState.players.push(player)
          } else {
            if (requestedId) player.id = requestedId
            player.nickname = nickname
            player.status = 'alive'
            player.isAlive = true
          }
          broadcastState()
          broadcastPlayerJoined(player)
          if (callback) callback({ success: true, player, players: gameState.players })
        } catch (e: any) {
          if (callback) callback({ success: false, error: e.message })
        }
      })

      socket.on('player:leave', (data, callback) => {
        try {
          const id = data?.id
          if (id) {
            gameState.players = gameState.players.filter((p) => p.id !== id)
            if (gameState.votes && gameState.votes[id]) {
              delete gameState.votes[id]
            }
            broadcastState()
            ioInstance?.to(SOCKET_ROOM_MAIN).emit('player:left', { id })
            ioInstance?.to(SOCKET_ROOM_MAIN).emit('players:update', gameState.players)
            ioInstance?.emit('players:update', gameState.players)
          }
          if (callback) callback({ success: true })
        } catch (e: any) {
          if (callback) callback({ success: false, error: e.message })
        }
      })

      socket.on('player:vote', (data, callback) => {
        try {
          const { playerId, choice } = data || {}
          if (!playerId || (choice !== 'A' && choice !== 'B')) {
            if (callback) callback({ success: false, error: '잘못된 투표 요청입니다.' })
            return
          }
          gameState.votes[playerId] = choice
          broadcastState()
          if (callback) callback({ success: true })
        } catch (e: any) {
          if (callback) callback({ success: false, error: e.message })
        }
      })

      socket.on('player:leave', (data, callback) => {
        try {
          const id = data?.id
          if (id) {
            gameState.players = gameState.players.filter((p) => p.id !== id)
            if (gameState.votes && gameState.votes[id]) {
              delete gameState.votes[id]
            }
            broadcastState()
            ioInstance?.to(SOCKET_ROOM_MAIN).emit('player:left', { id })
            ioInstance?.to(SOCKET_ROOM_MAIN).emit('players:update', gameState.players)
            ioInstance?.emit('players:update', gameState.players)
          }
          if (callback) callback({ success: true })
        } catch (e: any) {
          if (callback) callback({ success: false, error: e.message })
        }
      })

      socket.on('player:submit_answer', (data, callback) => {
        const choice = data?.choice || (data?.answerIndex === 0 ? 'A' : (data?.answerIndex === 1 ? 'B' : null))
        const pId = data?.playerId || data?.token || socket.id
        if (pId && (choice === 'A' || choice === 'B')) {
          gameState.votes[pId] = choice
          broadcastState()
          if (callback) callback({ success: true })
        }
      })

      socket.on('admin:start_game', (data, callback) => {
        try {
          gameState.roundNumber = 1
          gameState.votes = {}
          gameState.currentResult = null
          gameState.isGameOver = false
          gameState.soleWinnerId = null
          gameState.isPaused = false
          gameState.players.forEach((p) => {
            p.status = 'alive'
            p.isAlive = true
            p.eliminatedRound = undefined
          })
          if (data?.question) gameState.currentQuestion = data.question
          if (data?.ruleMode) gameState.ruleMode = data.ruleMode
          const limit = Number(data?.timeLimit) || gameState.timeLimit || 15
          gameState.timeLimit = limit
          if (data?.autoStartVoting !== false) {
            gameState.phase = 'voting'
            gameState.votingDeadline = Date.now() + limit * 1000
            gameState.timeLeft = limit
          } else {
            gameState.phase = 'question'
            gameState.votingDeadline = null
            gameState.timeLeft = limit
          }
          broadcastState()
          ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:round_started', {
            roundNumber: 1,
            question: gameState.currentQuestion,
            timeLimit: gameState.timeLimit,
            votingDeadline: gameState.votingDeadline,
          })
          if (callback) callback({ success: true, phase: gameState.phase })
        } catch (err: any) {
          if (callback) callback({ success: false, error: err.message })
        }
      })

      socket.on('admin:start_voting', (data, callback) => {
        const limit = Number(data?.timeLimit) || gameState.timeLimit || 15
        gameState.phase = 'voting'
        gameState.timeLimit = limit
        gameState.votingDeadline = Date.now() + limit * 1000
        gameState.timeLeft = limit
        gameState.isPaused = false
        gameState.votes = {}
        broadcastState()
        if (callback) callback({ success: true })
      })

      socket.on('admin:end_voting', (_data, callback) => {
        gameState.phase = 'revealing'
        gameState.timeLeft = 3
        gameState.isPaused = false
        broadcastState()
        if (callback) callback({ success: true })
      })

      socket.on('admin:next_round', (data, callback) => {
        gameState.roundNumber += 1
        gameState.votes = {}
        gameState.currentResult = null
        if (data?.question) gameState.currentQuestion = data.question
        const limit = Number(data?.timeLimit) || gameState.timeLimit || 15
        gameState.timeLimit = limit
        gameState.phase = 'voting'
        gameState.votingDeadline = Date.now() + limit * 1000
        gameState.timeLeft = limit
        broadcastState()
        ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:round_started', {
          roundNumber: gameState.roundNumber,
          question: gameState.currentQuestion,
          timeLimit: gameState.timeLimit,
          votingDeadline: gameState.votingDeadline,
        })
        if (callback) callback({ success: true })
      })

      socket.on('admin:pause_game', () => {
        gameState.isPaused = true
        broadcastState()
      })

      socket.on('admin:resume_game', () => {
        gameState.isPaused = false
        if (gameState.phase === 'voting' && gameState.timeLeft > 0) {
          gameState.votingDeadline = Date.now() + gameState.timeLeft * 1000
        }
        broadcastState()
      })

      socket.on('admin:sync', (updates) => {
        applyAdminSync(updates)
      })

      socket.on('admin:reset_game', (callback) => {
        gameState.phase = 'lobby'
        gameState.roundNumber = 0
        gameState.currentQuestion = null
        gameState.currentResult = null
        gameState.isGameOver = false
        gameState.soleWinnerId = null
        gameState.isPaused = false
        gameState.votes = {}
        gameState.players.forEach((p) => {
          p.status = 'alive'
          p.isAlive = true
          p.eliminatedRound = undefined
        })
        broadcastState()
        ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:force_lobby')
        ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:set_reset')
        if (callback) callback({ success: true })
      })

      socket.on('admin:clear_all_players', (callback) => {
        gameState.phase = 'lobby'
        gameState.roundNumber = 0
        gameState.currentQuestion = null
        gameState.currentResult = null
        gameState.isGameOver = false
        gameState.soleWinnerId = null
        gameState.players = []
        gameState.votes = {}
        broadcastState()
        ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:player_kicked_all')
        ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:reset')
        if (callback) callback({ success: true })
      })

      // 관리자 더미 참가자 추가
      socket.on('admin:add_mock_players', (data, callback) => {
        try {
          const incoming = Array.isArray(data?.newPlayers) ? data.newPlayers : []
          if (incoming.length > 0) {
            incoming.forEach((p: any) => { p.isDummy = true; p.isAlive = true; p.status = 'alive' })
            gameState.players.push(...incoming)
          } else {
            const count = Math.min(100, Math.max(1, Number(data?.count) || 10))
            const existing = gameState.players.length
            const mockNames = [
              '기획팀_김철수', '개발팀_이영희', '디자인_박민수', '마케팅_최지우', '인사팀_정우성',
              '영업1팀_강동원', '재무팀_한지민', '품질관리_송중기', '보안팀_전지현', '총무팀_유재석',
              '해외영업_이정재', '고객지원_박보영', '연구소_신하균', '전략팀_김혜수', '홍보팀_공유',
              'IT지원_손예진', '신사업_조인성', '구매팀_차은우', '데이터팀_아이유', '비서실_원빈'
            ]
            const newDummies: any[] = []
            for (let i = 0; i < count; i++) {
              const idx = existing + i
              const nickname = idx < mockNames.length ? mockNames[idx] : `더미참가자_${idx + 1}`
              newDummies.push({
                id: `mock_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 6)}`,
                nickname,
                status: 'alive',
                isAlive: true,
                joinedAt: Date.now() + i,
                isDummy: true,
              })
            }
            gameState.players.push(...newDummies)
          }

          broadcastState()
          ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:player_joined', { players: gameState.players, totalCount: gameState.players.length })
          if (callback) callback({ success: true, total: gameState.players.length })
        } catch (e: any) {
          if (callback) callback({ success: false, error: e?.message })
        }
      })

      socket.on('chat:send', (data) => {
        const { nickname, message } = data || {}
        if (nickname && message) {
          const msg = {
            id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
            nickname,
            message,
            timestamp: Date.now(),
          }
          gameState.chatMessages.push(msg)
          if (gameState.chatMessages.length > 50) gameState.chatMessages.shift()
          ioInstance?.to(SOCKET_ROOM_MAIN).emit('chat:received', msg)
          ioInstance?.to(SOCKET_ROOM_MAIN).emit('chat:message', msg)
        }
      })

      socket.on('admin:update_server_url', (newUrl) => {
        if (newUrl && typeof newUrl === 'string') {
          gameState.serverHostUrl = newUrl.trim()
          ioInstance?.to(SOCKET_ROOM_MAIN).emit('server:tunnel_updated', newUrl.trim())
          ioInstance?.emit('server:tunnel_updated', newUrl.trim())
        }
      })

      socket.on('admin:change_qr_mode', (data, callback) => {
        try {
          const mode = data?.mode === 'EXTERNAL' || data?.mode === 'tunnel' ? 'tunnel' : 'wifi'
          gameState.qrMode = mode
          ioInstance?.to(SOCKET_ROOM_MAIN).emit('game:qr_mode_changed', { mode })
          ioInstance?.emit('game:qr_mode_changed', { mode })
          if (callback) callback({ success: true, mode })
        } catch (err) {
          if (callback) callback({ success: false, mode: 'wifi' })
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
