import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import os from 'os'
import path from 'path'
import fs from 'fs'
import events from 'events'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

// 3번 서바이벌 퀴즈 규격: 150인 이상 동시 접속 시 리스너 초과 경고 방지 및 메모리 보호
events.EventEmitter.defaultMaxListeners = 250

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 프로세스 크래시 방어 쉴드 (3번 프로젝트 동일)
process.on('uncaughtException', (err) => {
  console.error('🛡️ [SERVER CRASH SHIELD] Uncaught Exception 방어됨:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('🛡️ [SERVER CRASH SHIELD] Unhandled Rejection 방어됨:', reason)
})

const app = express()
const port = process.env.PORT || 5000
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RENDER
let publicTunnelUrl = process.env.RENDER_EXTERNAL_URL || ''
let sshProcess = null
let isReconnectingTunnel = false

// Render 및 클라우드 즉시 응답 헬스체크 라우트 (3번 프로젝트 동일)
app.get('/healthz', (req, res) => res.status(200).send('OK'))
app.get('/health', (req, res) => res.status(200).send('OK'))

app.use(cors({ origin: '*' }))
app.use(express.json())

// 1. 프론트엔드 dist 정적 파일 단일 포트 통합 서빙
const clientDistPath = path.resolve(__dirname, 'dist')
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath))
}

const httpServer = http.createServer(app)

// 2. 3번 서바이벌 퀴즈 동일 최적화 Socket.io 설정 (150인 동시 접속 최적화)
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  maxHttpBufferSize: 2e7,
  perMessageDeflate: false,
  allowEIO3: true,
})

// 3번 서바이벌 퀴즈 메인 룸 상수
const SOCKET_ROOM_MAIN = 'room:survival_quiz_main'

// 인메모리 게임 상태
const gameState = {
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

// 3번 서바이벌 퀴즈 규격: 상태 브로드캐스트 (game:state_sync + state:sync 병행 전송)
function broadcastState() {
  io.to(SOCKET_ROOM_MAIN).emit('game:state_sync', gameState)
  io.to(SOCKET_ROOM_MAIN).emit('state:sync', gameState)
  io.emit('game:state_sync', gameState)
  io.emit('state:sync', gameState)
}

function applyAdminSync(updates) {
  if (updates && typeof updates === 'object') {
    const { players: incomingPlayers, ...safeUpdates } = updates
    Object.assign(gameState, safeUpdates)

    if (Array.isArray(incomingPlayers) && incomingPlayers.length > 0) {
      const statusMap = new Map(incomingPlayers.map((p) => [p.id, p.status]))
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

    console.log(`🔄 [STATE SYNC] Phase: ${gameState.phase}, Round: ${gameState.roundNumber}, Result: ${gameState.currentResult ? '있음' : '없음'}`)
    broadcastState()
  }
}

// 3. Socket.io 실시간 이벤트 핸들러 (3번 서바이벌 퀴즈 규격)
io.on('connection', (socket) => {
  // 메인 룸 자동 조인
  socket.join(SOCKET_ROOM_MAIN)

  // 최초 접속 시 현재 상태 즉시 전달 (3번 규격: game:state_sync)
  socket.emit('game:state_sync', gameState)
  socket.emit('state:sync', gameState)

  if (publicTunnelUrl) {
    socket.emit('server:tunnel_updated', publicTunnelUrl)
  }

  // 1. 참가자 등록 (player:join)
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
        console.log(`👤 [PLAYER JOIN] ${nickname} (ID: ${player.id}) - 현재 총 ${gameState.players.length}명`)
      } else {
        if (requestedId) player.id = requestedId
        player.nickname = nickname
        player.status = 'alive'
        player.isAlive = true
        console.log(`🔄 [PLAYER RE-JOIN / UPDATE] ${nickname} (ID: ${player.id}) - 현재 총 ${gameState.players.length}명`)
      }

      broadcastState()
      if (callback) callback({ success: true, player })
    } catch (e) {
      console.error('[player:join Error]', e)
    }
  })

  // 1-1. 참가자 닉네임 수정
  socket.on('player:change_nickname', (data, callback) => {
    try {
      const { id, newNickname } = data || {}
      const trimmed = (newNickname || '').trim()

      if (!trimmed || trimmed.length > 10) {
        if (callback) callback({ success: false, error: '1~10자 이내로 입력해주세요.' })
        return
      }

      const player = gameState.players.find((p) => p.id === id)
      if (player) {
        const oldNick = player.nickname
        player.nickname = trimmed
        console.log(`✏️ [NICKNAME CHANGED] ${oldNick} -> ${trimmed}`)
        for (const msg of gameState.chatMessages) {
          if (msg.nickname === oldNick) msg.nickname = trimmed
        }
        broadcastState()
        if (callback) callback({ success: true, player })
      } else {
        if (callback) callback({ success: false, error: '참가자 정보를 찾을 수 없습니다.' })
      }
    } catch (e) {
      if (callback) callback({ success: false, error: e.message })
    }
  })

  // 2. 참가자 투표 제출 (player:vote 및 3번 호환 player:submit_answer)
  const handleVote = (playerId, choice, callback) => {
    try {
      if (!playerId || (choice !== 'A' && choice !== 'B')) {
        if (callback) callback({ success: false, error: '잘못된 투표 요청입니다.' })
        return
      }

      const player = gameState.players.find((p) => p.id === playerId)
      if (player && (player.status === 'eliminated' || player.isAlive === false)) {
        if (callback) callback({ success: false, error: '이미 탈락한 참가자는 투표할 수 없습니다.' })
        return
      }

      const allowedPhases = ['voting', 'question', 'revealing']
      if (!allowedPhases.includes(gameState.phase)) {
        if (callback) callback({ success: false, error: '투표 진행 중이 아닙니다.' })
        return
      }

      gameState.votes[playerId] = choice
      console.log(`🗳️ [PLAYER VOTE] ${player ? player.nickname : playerId} -> [${choice}] (총 투표: ${Object.keys(gameState.votes).length}표)`)
      broadcastState()
      if (callback) callback({ success: true })
    } catch (e) {
      if (callback) callback({ success: false, error: e.message })
    }
  }

  socket.on('player:vote', (data, callback) => {
    handleVote(data?.playerId, data?.choice, callback)
  })

  socket.on('player:submit_answer', (data, callback) => {
    const choice = data?.choice || (data?.answerIndex === 0 ? 'A' : (data?.answerIndex === 1 ? 'B' : null))
    const pId = data?.playerId || data?.token || socket.id
    handleVote(pId, choice, callback)
  })

  // ==========================================
  // 3. 3번 서바이벌 퀴즈 규격 관리자 핵심 이벤트
  // ==========================================

  // [핵심] 게임 시작: 3번 프로젝트의 admin:start_game
  socket.on('admin:start_game', (data, callback) => {
    try {
      console.log('🚀 [3번 서바이벌 퀴즈 규격] admin:start_game 수신 -> 전 기기 동시 라운드 시작!')
      gameState.roundNumber = 1
      gameState.votes = {}
      gameState.currentResult = null
      gameState.isGameOver = false
      gameState.soleWinnerId = null
      gameState.isPaused = false

      // 전원 생존 복구
      gameState.players.forEach((p) => {
        p.status = 'alive'
        p.isAlive = true
        p.eliminatedRound = undefined
      })

      if (data?.question) {
        gameState.currentQuestion = data.question
      }
      if (data?.ruleMode) {
        gameState.ruleMode = data.ruleMode
      }

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

      io.to(SOCKET_ROOM_MAIN).emit('game:round_started', {
        roundNumber: 1,
        question: gameState.currentQuestion,
        timeLimit: gameState.timeLimit,
        votingDeadline: gameState.votingDeadline,
      })

      if (callback) callback({ success: true, phase: gameState.phase })
    } catch (err) {
      console.error('[admin:start_game Error]:', err)
      if (callback) callback({ success: false, error: err.message })
    }
  })

  // 15초 투표 시작
  socket.on('admin:start_voting', (data, callback) => {
    try {
      const limit = Number(data?.timeLimit) || gameState.timeLimit || 15
      gameState.phase = 'voting'
      gameState.timeLimit = limit
      gameState.votingDeadline = Date.now() + limit * 1000
      gameState.timeLeft = limit
      gameState.isPaused = false
      gameState.votes = {}
      broadcastState()
      if (callback) callback({ success: true })
    } catch (err) {
      if (callback) callback({ success: false })
    }
  })

  // 투표 조기 마감 및 결과 공개 서스펜스 카운트다운
  socket.on('admin:end_voting', (data, callback) => {
    try {
      gameState.phase = 'revealing'
      gameState.timeLeft = 3
      gameState.isPaused = false
      broadcastState()
      if (callback) callback({ success: true })
    } catch (err) {
      if (callback) callback({ success: false })
    }
  })

  // 다음 라운드 진행
  socket.on('admin:next_round', (data, callback) => {
    try {
      gameState.roundNumber += 1
      gameState.votes = {}
      gameState.currentResult = null
      if (data?.question) {
        gameState.currentQuestion = data.question
      }
      const limit = Number(data?.timeLimit) || gameState.timeLimit || 15
      gameState.timeLimit = limit
      gameState.phase = 'voting'
      gameState.votingDeadline = Date.now() + limit * 1000
      gameState.timeLeft = limit
      broadcastState()

      io.to(SOCKET_ROOM_MAIN).emit('game:round_started', {
        roundNumber: gameState.roundNumber,
        question: gameState.currentQuestion,
        timeLimit: gameState.timeLimit,
        votingDeadline: gameState.votingDeadline,
      })
      if (callback) callback({ success: true })
    } catch (err) {
      if (callback) callback({ success: false })
    }
  })

  // 일시정지 및 재개
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

  // 관리자 대기실 복귀 및 게임 리셋 (3번 서바이벌 퀴즈 규격)
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
    io.to(SOCKET_ROOM_MAIN).emit('game:force_lobby')
    io.to(SOCKET_ROOM_MAIN).emit('game:set_reset')
    if (callback) callback({ success: true, count: gameState.players.length })
  })

  socket.on('admin:reset_game_keep_players', (callback) => {
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
    io.to(SOCKET_ROOM_MAIN).emit('game:force_lobby')
    io.to(SOCKET_ROOM_MAIN).emit('game:set_reset')
    if (callback) callback({ success: true, count: gameState.players.length })
  })

  socket.on('admin:move_to_lobby', (callback) => {
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
    io.to(SOCKET_ROOM_MAIN).emit('game:force_lobby')
    io.to(SOCKET_ROOM_MAIN).emit('game:set_reset')
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
    io.to(SOCKET_ROOM_MAIN).emit('game:player_kicked_all')
    io.to(SOCKET_ROOM_MAIN).emit('game:reset')
    if (callback) callback({ success: true })
  })

  // 클라이언트 전체 동기화 수신 (admin:sync)
  socket.on('admin:sync', (updates) => {
    try {
      applyAdminSync(updates)
    } catch (e) {
      console.error('[admin:sync Error]', e)
    }
  })

  // 관리자 더미 참가자 추가
  socket.on('admin:add_mock_players', (data, callback) => {
    try {
      const incoming = Array.isArray(data?.newPlayers) ? data.newPlayers : []
      if (incoming.length > 0) {
        incoming.forEach((p) => { p.isDummy = true; p.isAlive = true; p.status = 'alive' })
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
        const newDummies = []
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
      if (callback) callback({ success: true, total: gameState.players.length })
    } catch (e) {
      if (callback) callback({ success: false, error: e.message })
    }
  })

  // 실시간 사내 응원 채팅 (chat:send)
  socket.on('chat:send', (data) => {
    try {
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
        io.to(SOCKET_ROOM_MAIN).emit('chat:received', msg)
        io.to(SOCKET_ROOM_MAIN).emit('chat:message', msg)
      }
    } catch (e) {
      console.error('[chat:send Error]', e)
    }
  })
})

// 4. 로컬 IP 자동 감지 유틸리티
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

// 5. REST API (웹소켓 차단 방화벽 및 모바일 폴링 대비)
app.get('/api/server-info', (req, res) => {
  res.json({
    localIp: getLocalNetworkIp(),
    clientPort: port,
    serverPort: port,
    publicUrl: publicTunnelUrl || null,
  })
})

app.get('/api/state', (req, res) => {
  res.json(gameState)
})

app.get('/api/game/state', (req, res) => {
  res.json(gameState)
})

app.post('/api/game/start', (req, res) => {
  try {
    const data = req.body || {}
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
    if (data.question) gameState.currentQuestion = data.question
    if (data.ruleMode) gameState.ruleMode = data.ruleMode
    const limit = Number(data.timeLimit) || gameState.timeLimit || 15
    gameState.timeLimit = limit
    if (data.autoStartVoting !== false) {
      gameState.phase = 'voting'
      gameState.votingDeadline = Date.now() + limit * 1000
      gameState.timeLeft = limit
    } else {
      gameState.phase = 'question'
      gameState.votingDeadline = null
      gameState.timeLeft = limit
    }
    broadcastState()
    io.to(SOCKET_ROOM_MAIN).emit('game:round_started', {
      roundNumber: 1,
      question: gameState.currentQuestion,
      timeLimit: gameState.timeLimit,
      votingDeadline: gameState.votingDeadline,
    })
    res.json({ success: true, state: gameState })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post('/api/game/sync', (req, res) => {
  try {
    applyAdminSync(req.body)
    res.json({ success: true, state: gameState })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post('/api/admin/sync', (req, res) => {
  try {
    applyAdminSync(req.body)
    res.json({ success: true, state: gameState })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post('/api/vote', (req, res) => {
  try {
    const { playerId, choice } = req.body || {}
    if (!playerId || (choice !== 'A' && choice !== 'B')) {
      return res.status(400).json({ success: false, error: '잘못된 투표 요청입니다.' })
    }
    const player = gameState.players.find((p) => p.id === playerId)
    if (player && (player.status === 'eliminated' || player.isAlive === false)) {
      return res.status(403).json({ success: false, error: '이미 탈락한 참가자는 투표할 수 없습니다.' })
    }
    gameState.votes[playerId] = choice
    broadcastState()
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post('/api/join', (req, res) => {
  try {
    const nickname = (req.body?.nickname || '').trim()
    const requestedId = req.body?.id
    if (!nickname) {
      return res.status(400).json({ success: false, error: '닉네임을 입력해주세요.' })
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
      console.log(`👤 [HTTP JOIN] ${nickname} (ID: ${player.id}) - 현재 총 ${gameState.players.length}명`)
    } else {
      if (requestedId) player.id = requestedId
      player.nickname = nickname
      player.status = 'alive'
      player.isAlive = true
      console.log(`🔄 [HTTP RE-JOIN] ${nickname} (ID: ${player.id}) - 현재 총 ${gameState.players.length}명`)
    }
    broadcastState()
    res.json({ success: true, player })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post('/api/game/vote', (req, res) => {
  try {
    const { playerId, choice } = req.body || {}
    if (!playerId || (choice !== 'A' && choice !== 'B')) {
      return res.status(400).json({ success: false, error: '잘못된 투표 요청입니다.' })
    }
    const player = gameState.players.find((p) => p.id === playerId)
    if (player && (player.status === 'eliminated' || player.isAlive === false)) {
      return res.status(403).json({ success: false, error: '이미 탈락한 참가자는 투표할 수 없습니다.' })
    }
    gameState.votes[playerId] = choice
    broadcastState()
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post('/api/game/join', (req, res) => {
  try {
    const nickname = (req.body?.nickname || '').trim()
    const requestedId = req.body?.id
    if (!nickname) {
      return res.status(400).json({ success: false, error: '닉네임을 입력해주세요.' })
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
      console.log(`👤 [HTTP JOIN] ${nickname} (ID: ${player.id}) - 현재 총 ${gameState.players.length}명`)
    } else {
      if (requestedId) player.id = requestedId
      player.nickname = nickname
      player.status = 'alive'
      player.isAlive = true
      console.log(`🔄 [HTTP RE-JOIN] ${nickname} (ID: ${player.id}) - 현재 총 ${gameState.players.length}명`)
    }
    broadcastState()
    res.json({ success: true, player })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post('/api/game/reset', (req, res) => {
  try {
    const { keepPlayers } = req.body || {}
    if (keepPlayers) {
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
      io.to(SOCKET_ROOM_MAIN).emit('game:force_lobby')
      io.to(SOCKET_ROOM_MAIN).emit('game:set_reset')
    } else {
      gameState.phase = 'lobby'
      gameState.roundNumber = 0
      gameState.currentQuestion = null
      gameState.currentResult = null
      gameState.isGameOver = false
      gameState.soleWinnerId = null
      gameState.players = []
      gameState.votes = {}
      broadcastState()
      io.to(SOCKET_ROOM_MAIN).emit('game:player_kicked_all')
      io.to(SOCKET_ROOM_MAIN).emit('game:reset')
    }
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// SPA fallback 지원 (Express 5 호환)
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/socket.io') || req.path === '/healthz' || req.path === '/health') {
    return next()
  }
  const indexPath = path.join(clientDistPath, 'index.html')
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath)
  } else {
    next()
  }
})

// 6. 로컬 터널 매니저 (serveo.net 기반 - 로컬 개발 전용)
let reconnectDelay = 5000

function connectTunnel(targetPort) {
  if (isProduction) return
  if (isReconnectingTunnel) return
  isReconnectingTunnel = true

  if (sshProcess) {
    try {
      sshProcess.kill('SIGKILL')
    } catch {}
    sshProcess = null
  }

  console.log('🔄 [로컬 터널 연결 및 복구 시도 중...]')
  try {
    const child = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=NUL',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=120',
      '-o', 'TCPKeepAlive=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-R', `80:127.0.0.1:${targetPort}`,
      'serveo.net',
    ])
    sshProcess = child

    const handleOutput = (data) => {
      const text = data.toString()
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.serveousercontent\.com/)
      if (match) {
        reconnectDelay = 5000
        const newUrl = match[0]
        if (publicTunnelUrl !== newUrl) {
          publicTunnelUrl = newUrl
          console.log(`=======================================================`)
          console.log(`🌍 [외부 공인 접속 주소 (LTE/5G) 정상 연결됨]:`)
          console.log(`👉 ${publicTunnelUrl}`)
          console.log(`=======================================================`)
          try {
            io.to(SOCKET_ROOM_MAIN).emit('server:tunnel_updated', publicTunnelUrl)
          } catch {}
        }
      }
    }

    child.stdout.on('data', handleOutput)
    child.stderr.on('data', handleOutput)

    child.on('error', (err) => {
      console.warn('⚠️ [터널 프로세스 오류]:', err.message)
      scheduleTunnelReconnect(targetPort)
    })

    child.on('close', (code) => {
      scheduleTunnelReconnect(targetPort)
    })

    setTimeout(() => {
      isReconnectingTunnel = false
    }, 10000)
  } catch (err) {
    scheduleTunnelReconnect(targetPort)
  }
}

function scheduleTunnelReconnect(targetPort) {
  if (isProduction) return
  sshProcess = null
  isReconnectingTunnel = false
  setTimeout(() => {
    connectTunnel(targetPort)
  }, reconnectDelay)
  reconnectDelay = Math.min(30000, reconnectDelay + 5000)
}

if (!isProduction) {
  setInterval(() => {
    if (!sshProcess || sshProcess.killed) {
      connectTunnel(Number(port))
    }
  }, 30000)
}

process.on('SIGINT', () => {
  if (sshProcess) {
    try { sshProcess.kill() } catch {}
  }
  process.exit(0)
})

httpServer.listen(Number(port), '0.0.0.0', () => {
  const localIp = getLocalNetworkIp()
  console.log(`=======================================================`)
  console.log(`🚀 [YOUR CHOICE - 당신의 선택 (3번 서바이벌 퀴즈 아키텍처 이식 가동)]`)
  console.log(`🖥️ 대형 TV 화면:    http://localhost:${port}/tv`)
  console.log(`🛠️ 관리자 대시보드:  http://localhost:${port}/admin`)
  console.log(`📱 스마트폰 (사내 Wi-Fi): http://${localIp}:${port}/`)
  if (isProduction) {
    console.log(`☁️ RENDER 클라우드 프로덕션 배포 모드 가동`)
    if (publicTunnelUrl) {
      console.log(`👉 서비스 공인 URL: ${publicTunnelUrl}`)
    }
  } else {
    connectTunnel(Number(port))
  }
  console.log(`=======================================================`)
})
