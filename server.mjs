import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 프로세스 크래시 방어 쉴드
process.on('uncaughtException', (err) => {
  console.error('🛡️ [SERVER CRASH SHIELD] Uncaught Exception 방어됨:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('🛡️ [SERVER CRASH SHIELD] Unhandled Rejection 방어됨:', reason)
})

const app = express()
const port = process.env.PORT || 5000
const isRender = Boolean(process.env.RENDER || process.env.RENDER_EXTERNAL_URL)
let publicTunnelUrl = process.env.RENDER_EXTERNAL_URL || ''
let sshProcess = null
let isReconnectingTunnel = false

app.use(cors({ origin: '*' }))
app.use(express.json())

// 1. 프론트엔드 dist 정적 파일 단일 포트 통합 서빙
const clientDistPath = path.resolve(__dirname, 'dist')
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath))
}

const httpServer = http.createServer(app)

// 2. 150인 동시 접속 최적화 Socket.io 설정
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  perMessageDeflate: false,
  allowEIO3: true,
})

// 인메모리 게임 상태
const gameState = {
  phase: 'lobby',
  roundNumber: 0,
  ruleMode: 'majority',
  qrMode: 'wifi',
  serverHostUrl: '',
  currentQuestion: null,
  currentResult: null,
  isFinals: false,
  isPaused: false,
  timeLimit: 15,
  votingDeadline: null,
  timeLeft: 15,
  players: [],
  votes: {},
  chatMessages: [],
}

function broadcastState() {
  io.emit('state:sync', gameState)
}

function applyAdminSync(updates) {
  if (updates && typeof updates === 'object') {
    const { players: incomingPlayers, ...safeUpdates } = updates
    Object.assign(gameState, safeUpdates)

    // 1. 관리자 store의 각 플레이어 status ('alive' | 'eliminated')를 서버 players에 안전하게 반영
    if (Array.isArray(incomingPlayers) && incomingPlayers.length > 0) {
      const statusMap = new Map(incomingPlayers.map((p) => [p.id, p.status]))
      for (const p of gameState.players) {
        if (statusMap.has(p.id)) {
          p.status = statusMap.get(p.id)
        }
      }
    }

    // 2. 탈락자 명단이 포함되어 있으면 서버 참가자 상태(status: eliminated) 안전하게 반영
    if (updates.currentResult?.eliminated && Array.isArray(updates.currentResult.eliminated)) {
      const elimSet = new Set(updates.currentResult.eliminated)
      for (const p of gameState.players) {
        if (elimSet.has(p.id)) {
          p.status = 'eliminated'
          p.eliminatedRound = updates.roundNumber
        }
      }
    }

    // 라운드 결과 객체 보존
    if (updates.currentResult) {
      gameState.currentResult = updates.currentResult
    }

    console.log(`🔄 [STATE SYNC] Phase: ${gameState.phase}, Round: ${gameState.roundNumber}, Result: ${gameState.currentResult ? '있음' : '없음'}`)
    broadcastState()
  }
}

// 3. Socket.io 실시간 이벤트 핸들러
io.on('connection', (socket) => {
  // 최초 접속 시 현재 상태 및 터널 주소 즉시 전송
  socket.emit('state:sync', gameState)
  if (publicTunnelUrl) {
    socket.emit('server:tunnel_updated', publicTunnelUrl)
  }

  // 참가자 참가 (player:join)
  socket.on('player:join', (data, callback) => {
    try {
      const nickname = (data?.nickname || '').trim()
      const requestedId = data?.id

      if (!nickname) {
        if (callback) callback({ success: false, error: '닉네임을 입력해주세요.' })
        return
      }

      let player = gameState.players.find((p) => p.nickname === nickname)
      if (!player) {
        player = {
          id: requestedId || ('p_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6)),
          nickname,
          status: 'alive',
          joinedAt: Date.now(),
        }
        gameState.players.push(player)
        console.log(`👤 [PLAYER JOIN] ${nickname} (ID: ${player.id}) - 현재 총 ${gameState.players.length}명`)
      } else if (requestedId && player.id !== requestedId) {
        player.id = requestedId
        console.log(`🔄 [PLAYER RECONNECT] ${nickname} (ID: ${player.id})`)
      }

      broadcastState()
      if (callback) callback({ success: true, player })
    } catch (e) {
      console.error('[player:join Error]', e)
    }
  })

  // 참가자 닉네임 수정 (player:change_nickname)
  socket.on('player:change_nickname', (data, callback) => {
    try {
      const { id, newNickname } = data || {}
      const trimmed = (newNickname || '').trim()

      if (!trimmed) {
        if (callback) callback({ success: false, error: '닉네임을 입력해주세요.' })
        return
      }
      if (trimmed.length > 10) {
        if (callback) callback({ success: false, error: '10자 이하로 입력해주세요.' })
        return
      }

      const player = gameState.players.find((p) => p.id === id)
      if (player) {
        const oldNick = player.nickname
        player.nickname = trimmed
        console.log(`✏️ [NICKNAME CHANGED] ${oldNick} -> ${trimmed} (ID: ${id})`)

        for (const msg of gameState.chatMessages) {
          if (msg.nickname === oldNick) msg.nickname = trimmed
        }

        broadcastState()
        if (callback) callback({ success: true, player })
      } else {
        if (callback) callback({ success: false, error: '참가자 정보를 찾을 수 없습니다.' })
      }
    } catch (e) {
      console.error('[player:change_nickname Error]', e)
      if (callback) callback({ success: false, error: e.message })
    }
  })

  // 참가자 투표 제출 (player:vote)
  socket.on('player:vote', (data, callback) => {
    try {
      const { playerId, choice } = data || {}
      if (!playerId || (choice !== 'A' && choice !== 'B')) {
        if (callback) callback({ success: false, error: '잘못된 투표 요청입니다.' })
        return
      }

      // 탈락자 투표 원천 차단
      const player = gameState.players.find((p) => p.id === playerId)
      if (player && player.status === 'eliminated') {
        console.warn(`🚫 [VOTE REJECTED] 탈락자 (${player.nickname})의 투표 시도 차단됨`)
        if (callback) callback({ success: false, error: '이미 탈락한 참가자는 투표할 수 없습니다.' })
        return
      }

      // 투표 허용 단계 확인 (voting, question, revealing 버퍼)
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
      console.error('[player:vote Error]', e)
      if (callback) callback({ success: false, error: e.message })
    }
  })

  // 관리자 상태 동기화 (admin:sync)
  socket.on('admin:sync', (updates) => {
    try {
      applyAdminSync(updates)
    } catch (e) {
      console.error('[admin:sync Error]', e)
    }
  })

  // 관리자 더미 참가자 추가 (admin:add_mock_players)
  socket.on('admin:add_mock_players', (data, callback) => {
    try {
      const incoming = Array.isArray(data?.newPlayers) ? data.newPlayers : []
      if (incoming.length > 0) {
        incoming.forEach((p) => { p.isDummy = true })
        gameState.players.push(...incoming)
        console.log(`🤖 [ADD MOCK PLAYERS] 더미 참가자 ${incoming.length}명 추가됨 (현재 총 ${gameState.players.length}명)`)
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
            joinedAt: Date.now() + i,
            isDummy: true,
          })
        }
        gameState.players.push(...newDummies)
        console.log(`🤖 [ADD MOCK PLAYERS] 더미 참가자 ${count}명 추가됨 (현재 총 ${gameState.players.length}명)`)
      }

      broadcastState()
      if (callback) callback({ success: true, total: gameState.players.length })
    } catch (e) {
      console.error('[admin:add_mock_players Error]', e)
      if (callback) callback({ success: false, error: e.message })
    }
  })

  // 관리자 게임 리셋 (접속자 유지 및 전원 생존 부활)
  socket.on('admin:reset_game_keep_players', (callback) => {
    try {
      console.log('🔄 [ADMIN ACTION] 게임 리셋 (참가자 유지 & 전원 생존 부활)')
      gameState.phase = 'lobby'
      gameState.roundNumber = 0
      gameState.currentQuestion = null
      gameState.currentResult = null
      gameState.isFinals = false
      gameState.isPaused = false
      gameState.votingDeadline = null
      gameState.timeLeft = 15
      gameState.votes = {}
      gameState.players = gameState.players.map((p) => ({
        ...p,
        status: 'alive',
        eliminatedRound: undefined,
      }))
      broadcastState()
      io.emit('game:set_reset')
      if (callback) callback({ success: true, count: gameState.players.length })
    } catch (e) {
      console.error('[admin:reset_game_keep_players Error]', e)
      if (callback) callback({ success: false, error: e.message })
    }
  })

  // 관리자 참가자 명단 완전 비우기 (admin:clear_all_players)
  socket.on('admin:clear_all_players', (callback) => {
    try {
      console.log('🗑️ [ADMIN ACTION] 참가자 명단 완전 비우기 실행')
      gameState.players = []
      gameState.votes = {}
      broadcastState()
      io.emit('game:reset')
      if (callback) callback({ success: true })
    } catch (e) {
      console.error('[admin:clear_all_players Error]', e)
      if (callback) callback({ success: false, error: e.message })
    }
  })

  // 관리자 전체 게임 및 참가자 초기화 (admin:reset_all)
  socket.on('admin:reset_all', (callback) => {
    try {
      console.log('🔄 [ADMIN ACTION] 게임 전체 및 참가자 초기화 실행')
      gameState.phase = 'lobby'
      gameState.roundNumber = 0
      gameState.currentQuestion = null
      gameState.currentResult = null
      gameState.isFinals = false
      gameState.isPaused = false
      gameState.votingDeadline = null
      gameState.timeLeft = 15
      gameState.players = []
      gameState.votes = {}
      gameState.chatMessages = []
      broadcastState()
      io.emit('game:reset')
      if (callback) callback({ success: true })
    } catch (e) {
      console.error('[admin:reset_all Error]', e)
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
        io.emit('chat:received', msg)
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

// 5. REST API
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

app.post('/api/game/sync', (req, res) => {
  try {
    applyAdminSync(req.body)
    res.json({ success: true, state: gameState })
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
    if (player && player.status === 'eliminated') {
      return res.status(403).json({ success: false, error: '이미 탈락한 참가자는 투표할 수 없습니다.' })
    }

    const allowedPhases = ['voting', 'question', 'revealing']
    if (!allowedPhases.includes(gameState.phase)) {
      return res.status(400).json({ success: false, error: '투표 진행 중이 아닙니다.' })
    }

    gameState.votes[playerId] = choice
    console.log(`🗳️ [HTTP VOTE] ${player ? player.nickname : playerId} -> [${choice}] (총 투표: ${Object.keys(gameState.votes).length}표)`)
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

    let player = gameState.players.find((p) => p.nickname === nickname)
    if (!player) {
      player = {
        id: requestedId || ('p_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6)),
        nickname,
        status: 'alive',
        joinedAt: Date.now(),
      }
      gameState.players.push(player)
      console.log(`👤 [HTTP JOIN] ${nickname} (ID: ${player.id}) - 현재 총 ${gameState.players.length}명`)
    } else if (requestedId && player.id !== requestedId) {
      player.id = requestedId
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
      gameState.isFinals = false
      gameState.isPaused = false
      gameState.votingDeadline = null
      gameState.timeLeft = 15
      gameState.votes = {}
      gameState.players = gameState.players.map((p) => ({
        ...p,
        status: 'alive',
        eliminatedRound: undefined,
      }))
      broadcastState()
      io.emit('game:set_reset')
    } else {
      gameState.phase = 'lobby'
      gameState.roundNumber = 0
      gameState.currentQuestion = null
      gameState.currentResult = null
      gameState.isFinals = false
      gameState.isPaused = false
      gameState.votingDeadline = null
      gameState.timeLeft = 15
      gameState.players = []
      gameState.votes = {}
      gameState.chatMessages = []
      broadcastState()
      io.emit('game:reset')
    }
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// SPA fallback 지원 (Express 5 호환)
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
    return next()
  }
  const indexPath = path.join(clientDistPath, 'index.html')
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath)
  } else {
    next()
  }
})

// 6. 고가용성 자동 재연결 터널 매니저 (serveo.net 기반 - 로컬 개발 전용)
function connectTunnel(targetPort) {
  if (isRender) {
    console.log(`☁️ [RENDER DEPLOYMENT] 클라우드 환경에서는 자체 배포 도메인을 사용합니다: ${publicTunnelUrl || 'Render Host'}`)
    return
  }
  if (isReconnectingTunnel) return
  isReconnectingTunnel = true

  if (sshProcess) {
    try {
      sshProcess.kill('SIGKILL')
    } catch {}
    sshProcess = null
  }

  console.log('🔄 [터널 연결 및 복구 시도 중...]')
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
        const newUrl = match[0]
        if (publicTunnelUrl !== newUrl) {
          publicTunnelUrl = newUrl
          console.log(`=======================================================`)
          console.log(`🌍 [외부 공인 접속 주소 (LTE/5G) 정상 연결됨]:`)
          console.log(`👉 ${publicTunnelUrl}`)
          console.log(`=======================================================`)
          try {
            io.emit('server:tunnel_updated', publicTunnelUrl)
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
      console.warn(`⚠️ [터널 연결 닫힘 (code: ${code})] 3초 후 자동 재접속합니다...`)
      scheduleTunnelReconnect(targetPort)
    })

    setTimeout(() => {
      isReconnectingTunnel = false
    }, 10000)
  } catch (err) {
    console.error('터널 프로세스 생성 실패:', err.message)
    scheduleTunnelReconnect(targetPort)
  }
}

function scheduleTunnelReconnect(targetPort) {
  if (isRender) return
  sshProcess = null
  isReconnectingTunnel = false
  setTimeout(() => {
    connectTunnel(targetPort)
  }, 3000)
}

// 30초 주기 터널 헬스체크 데몬 (로컬 전용)
if (!isRender) {
  setInterval(() => {
    if (!sshProcess || sshProcess.killed) {
      console.log('🔍 [헬스체크] 터널 프로세스 재기동 필요 감지')
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
  console.log(`🚀 [YOUR CHOICE - 당신의 선택 고성능 웹소켓 서버 가동]`)
  console.log(`🖥️ 대형 TV 화면:    http://localhost:${port}/tv`)
  console.log(`🛠️ 관리자 대시보드:  http://localhost:${port}/admin`)
  console.log(`📱 스마트폰 (사내 Wi-Fi): http://${localIp}:${port}/`)
  if (isRender) {
    console.log(`☁️ RENDER 클라우드 배포 모드 가동 중`)
    if (publicTunnelUrl) {
      console.log(`👉 배포 주소: ${publicTunnelUrl}`)
    }
  } else {
    console.log(`⏳ 외부 접속(LTE/5G)용 자동 복구 HTTPS 터널 시작 중...`)
    connectTunnel(Number(port))
  }
  console.log(`=======================================================`)
})
