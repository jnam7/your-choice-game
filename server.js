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
const port = process.env.PORT || 4000
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
  bgmVolume: 0.6,
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

// =========================================================
// 서버 주도 상태 전환 관리자 (결과 공개 무한 루프 방지 및 단일 전환 보장)
// =========================================================
let votingTimer = null
let revealingTimer = null
let resultTransitionTimer = null
let usedQuestionIdsServer = new Set()

function clearAllTimers() {
  if (votingTimer) {
    clearTimeout(votingTimer)
    votingTimer = null
  }
  if (revealingTimer) {
    clearTimeout(revealingTimer)
    revealingTimer = null
  }
  if (resultTransitionTimer) {
    clearTimeout(resultTransitionTimer)
    resultTransitionTimer = null
  }
}

// 1. 서버 주도 15초 투표 카운트다운 타이머 시작 (조기 마감 원천 차단: 무조건 15초 유지)
function startServerVoting(limit = 15) {
  clearAllTimers()
  gameState.phase = 'voting'
  gameState.timeLimit = limit
  gameState.votingDeadline = Date.now() + limit * 1000
  gameState.timeLeft = limit
  gameState.isPaused = false
  gameState.votes = {}

  console.log(`⏱️ [SERVER VOTING] 서버 주도 15초 투표 시작 (온전한 ${limit}초 보장, 조기 종료 차단)`)
  broadcastState()
  io.to(SOCKET_ROOM_MAIN).emit('game:round_started', {
    roundNumber: gameState.roundNumber,
    question: gameState.currentQuestion,
    timeLimit: limit,
    votingDeadline: gameState.votingDeadline,
  })

  // 15초가 지나면 오직 서버에 의해 revealing(3초) 단계로 진입
  votingTimer = setTimeout(() => {
    votingTimer = null
    if (gameState.phase !== 'voting' || gameState.isPaused) return

    console.log(`⏰ [SERVER VOTING] 15초 만료 -> 결과 집계 서스펜스(revealing 3초) 단계 진입`)
    startServerRevealing()
  }, limit * 1000)
}

// 2. 서버 주도 3초 서스펜스 타이머 시작
function startServerRevealing() {
  clearAllTimers()
  gameState.phase = 'revealing'
  gameState.timeLeft = 3
  gameState.votingDeadline = null
  gameState.isPaused = false
  broadcastState()

  // 3초 후 결과 공개 및 판정 실행
  revealingTimer = setTimeout(() => {
    revealingTimer = null
    if (gameState.phase !== 'revealing' || gameState.isPaused) return

    console.log(`📊 [SERVER REVEALING] 3초 만료 -> 결과 계산 및 발표(result) 단계 진입`)
    computeAndPublishResult()
  }, 3000)
}

// 3. 서버 주도 투표 집계 및 판정
function computeAndPublishResult() {
  clearAllTimers()
  const { votes, players, currentQuestion, roundNumber, ruleMode } = gameState

  const eligiblePlayers = players.filter((p) => {
    if (p.eliminatedRound && p.eliminatedRound < roundNumber) return false
    return true
  })
  const eligibleIds = new Set(eligiblePlayers.map((p) => p.id))

  const validVotes = {}
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

  let majority
  let eliminatedIds = []

  if (ruleMode === 'minority') {
    if (votesA > 0 && votesB > 0) {
      if (votesA === votesB) {
        majority = 'tie'
        eliminatedIds = [...nonVoterIds]
      } else if (votesA < votesB) {
        majority = 'A'
        const minorityLosers = Object.entries(validVotes).filter(([, c]) => c === 'B').map(([id]) => id)
        eliminatedIds = [...minorityLosers, ...nonVoterIds]
      } else {
        majority = 'B'
        const minorityLosers = Object.entries(validVotes).filter(([, c]) => c === 'A').map(([id]) => id)
        eliminatedIds = [...minorityLosers, ...nonVoterIds]
      }
    } else if (votesA > 0 && votesB === 0) {
      majority = 'A'
      eliminatedIds = [...nonVoterIds]
    } else if (votesA === 0 && votesB > 0) {
      majority = 'B'
      eliminatedIds = [...nonVoterIds]
    } else {
      majority = 'tie'
      eliminatedIds = [...nonVoterIds]
    }
  } else {
    // 다수의 선택 모드
    if (votesA === votesB) {
      majority = 'tie'
      eliminatedIds = [...nonVoterIds]
    } else if (votesA > votesB) {
      majority = 'A'
      const minorityIds = Object.entries(validVotes).filter(([, c]) => c === 'B').map(([id]) => id)
      eliminatedIds = [...minorityIds, ...nonVoterIds]
    } else {
      majority = 'B'
      const minorityIds = Object.entries(validVotes).filter(([, c]) => c === 'A').map(([id]) => id)
      eliminatedIds = [...minorityIds, ...nonVoterIds]
    }
  }

  const survivorIds = eligiblePlayers.filter((p) => !eliminatedIds.includes(p.id)).map((p) => p.id)
  const isGameOver = survivorIds.length <= 2
  const soleWinnerId = survivorIds.length === 1 ? survivorIds[0] : null

  const result = {
    questionId: currentQuestion?.id || 1,
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

  // 플레이어 탈락 상태 갱신
  for (const p of gameState.players) {
    if (eliminatedIds.includes(p.id)) {
      p.status = 'eliminated'
      p.isAlive = false
      p.eliminatedRound = roundNumber
    }
  }

  gameState.currentResult = result
  gameState.isGameOver = isGameOver
  gameState.soleWinnerId = soleWinnerId
  // 중요: 생존자가 2명 이하라도 결과 화면(result)을 5초간 온전히 유지하여 시청자와 참가자가 확인하도록 함!
  gameState.phase = 'result'

  console.log(`📢 [SERVER RESULT] 결과 발표: A(${votesA}) vs B(${votesB}), 승리: ${majority}, 남은 생존자: ${survivorIds.length}명`)
  broadcastState()

  // 결과 화면(result) 5초 자동 전환 예약
  scheduleServerResultTransition()
}

// 서버 자체 질문 풀 (src/data/questions.ts와 동일한 데이터)
const serverMajorityQuestions = [
  { id: 1, category: '음식', optionA: '평생 치킨만 먹기', optionB: '평생 피자만 먹기', isFinals: false },
  { id: 2, category: '음식', optionA: '탕수육 소스 부먹', optionB: '탕수육 소스 찍먹', isFinals: false },
  { id: 3, category: '음식', optionA: '평생 탄산음료 없이 살기', optionB: '평생 라면 없이 살기', isFinals: false },
  { id: 4, category: '음식', optionA: '아침 식사 평생 굶기', optionB: '야식 평생 굶기', isFinals: false },
  { id: 5, category: '음식', optionA: '식후 아메리카노 영구 금지', optionB: '식후 달콤한 디저트 영구 금지', isFinals: false },
  { id: 6, category: '음식', optionA: '삼겹살 평생 금지', optionB: '떡볶이 평생 금지', isFinals: false },
  { id: 7, category: '음식', optionA: '평생 소고기만 먹기', optionB: '평생 돼지고기만 먹기', isFinals: false },
  { id: 8, category: '음식', optionA: '무조건 맵고 자극적인 음식만 먹기', optionB: '무조건 싱겁고 담백한 음식만 먹기', isFinals: false },
  { id: 9, category: '음식', optionA: '덜 익은 꼬들꼬들 라면 먹기', optionB: '푹 퍼지고 부드러운 라면 먹기', isFinals: false },
  { id: 10, category: '음식', optionA: '평생 단 음식 금지', optionB: '평생 짠 음식 금지', isFinals: false },
  { id: 11, category: '직장생활', optionA: '월요일 2시간 일찍 출근하기', optionB: '금요일 2시간 늦게 퇴근하기', isFinals: false },
  { id: 12, category: '직장생활', optionA: '월급 300만원 정시 칼퇴근', optionB: '월급 500만원 매일 야근 2시간', isFinals: false },
  { id: 13, category: '직장생활', optionA: '사내 식당 매일 고퀄리티 무료 제공', optionB: '매달 점심 식대 30만원 계좌 입금', isFinals: false },
  { id: 14, category: '직장생활', optionA: '완벽한 능력 상사 + 힘든 업무', optionB: '일 못하는 무능 상사 + 쉬운 업무', isFinals: false },
  { id: 15, category: '직장생활', optionA: '연봉 1,000만원 인상 + 주 6일 출근', optionB: '현재 연봉 그대로 유지 + 주 4일 출근', isFinals: false },
  { id: 16, category: '직장생활', optionA: '일 잘하는데 성격 차가운 동료', optionB: '일 못하는데 한없이 착하고 친절한 동료', isFinals: false },
  { id: 17, category: '직장생활', optionA: '전 사원 앞에서 박수받으며 우수사원 표창', optionB: '아무도 모르게 계좌로 특별 상여금 100만원 입금', isFinals: false },
  { id: 18, category: '직장생활', optionA: '회식 1차에서 고기 먹고 9시 칼귀가', optionB: '회식 3차까지 대표님과 함께 달리기', isFinals: false },
  { id: 19, category: '직장생활', optionA: '매주 월요일 아침 9시 전체 회의', optionB: '매주 금요일 오후 5시 주간 보고 회의', isFinals: false },
  { id: 20, category: '직장생활', optionA: '1년 내내 모든 프로젝트 대성공', optionB: '1년 내내 평화롭게 월급 루팡 성공', isFinals: false },
]

const serverMinorityQuestions = [
  { id: 101, category: '직장/곤란', optionA: '사무실 옆자리 쉼 없는 수다쟁이 동료', optionB: '사무실 옆자리 말 한마디 안 섞는 무반응 동료', isFinals: false },
  { id: 102, category: '직장/곤란', optionA: '점심시간 칼같이 30분만 부여', optionB: '매일 출근 시간 1시간 앞당겨지기', isFinals: false },
  { id: 103, category: '직장/곤란', optionA: '직속 팀장님 바로 앞에서 치명적 엑셀 실수', optionB: '대표님 주재 전사 타운홀 미팅에서 대놓고 졸기', isFinals: false },
  { id: 104, category: '직장/곤란', optionA: '매주 금요일 사내 회식 필참 1년', optionB: '사내 모든 회식 및 부서 친목 영구 금지', isFinals: false },
  { id: 105, category: '직장/곤란', optionA: '직속 상사 결혼식 단독 사회자 맡기', optionB: '직속 상사 부모님 칠순 잔치 단독 축가 부르기', isFinals: false },
]

function getNextServerQuestion(ruleMode) {
  const pool = ruleMode === 'minority' ? serverMinorityQuestions : serverMajorityQuestions
  let available = pool.filter((q) => !usedQuestionIdsServer.has(q.id))
  if (available.length === 0) {
    usedQuestionIdsServer.clear()
    available = [...pool]
  }
  const picked = available[Math.floor(Math.random() * available.length)]
  usedQuestionIdsServer.add(picked.id)
  return picked
}

function clearResultTransition() {
  if (resultTransitionTimer) {
    clearTimeout(resultTransitionTimer)
    resultTransitionTimer = null
  }
}

// 결과 공개 단계 진입 시 서버에서 단 1번만 실행되는 5초 카운트다운 후 다음 단계 자동 진행
function scheduleServerResultTransition() {
  clearResultTransition()
  console.log(`⏱️ [SERVER TRANSITION] 결과 공개 5초 후 서버 주도 상태 전환 예약됨`)

  resultTransitionTimer = setTimeout(() => {
    resultTransitionTimer = null
    // 일시정지 중이거나 이미 결과 단계가 아니면 중단
    if (gameState.phase !== 'result' || gameState.isPaused) {
      return
    }

    // 생존자 계산
    const alivePlayers = gameState.players.filter((p) => p.status === 'alive' || p.isAlive === true)
    console.log(`🏁 [SERVER TRANSITION] 5초 경과 -> 생존자 ${alivePlayers.length}명 판정`)

    // 조건 A: 생존자가 2명 이하이거나 0명인 경우 -> gameover
    if (alivePlayers.length <= 2) {
      gameState.phase = 'gameover'
      gameState.isGameOver = true
      gameState.soleWinnerId = alivePlayers.length === 1 ? alivePlayers[0].id : null
      console.log(`🏆 [SERVER] 게임 종료! (생존자 ${alivePlayers.length}명, 우승자: ${gameState.soleWinnerId || '없음/공동'})`)
      broadcastState()
      io.to(SOCKET_ROOM_MAIN).emit('game:game_over', {
        survivors: alivePlayers,
        winnerCount: alivePlayers.length,
        soleWinnerId: gameState.soleWinnerId,
      })
      return
    }

    // 조건 B: 생존자가 3명 이상인 경우 -> 다음 라운드 voting 카운트다운 시작
    gameState.roundNumber += 1
    gameState.currentQuestion = getNextServerQuestion(gameState.ruleMode)
    const limit = gameState.timeLimit || 15
    console.log(`🚀 [SERVER] 다음 라운드(${gameState.roundNumber}) 시작! (제한시간: ${limit}초)`)

    startServerVoting(limit)
  }, 5000)
}

function broadcastPlayerJoined(player) {
  io.to(SOCKET_ROOM_MAIN).emit('game:player_joined', { player, players: gameState.players, totalCount: gameState.players.length })
  io.to(SOCKET_ROOM_MAIN).emit('player:joined', { player, players: gameState.players, totalCount: gameState.players.length })
  io.to(SOCKET_ROOM_MAIN).emit('players:update', gameState.players)
  io.emit('game:player_joined', { player, players: gameState.players, totalCount: gameState.players.length })
  io.emit('player:joined', { player, players: gameState.players, totalCount: gameState.players.length })
  io.emit('players:update', gameState.players)
}

function applyAdminSync(updates) {
  if (updates && typeof updates === 'object') {
    const oldPhase = gameState.phase
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

    console.log(`🔄 [STATE SYNC] Phase: ${oldPhase} -> ${gameState.phase}, Round: ${gameState.roundNumber}, Result: ${gameState.currentResult ? '있음' : '없음'}`)
    broadcastState()

    // 결과 단계('result')로 진입했거나, 결과가 도착했을 때 서버 주도 5초 전환 예약
    if (gameState.phase === 'result') {
      if (oldPhase !== 'result' || !resultTransitionTimer) {
        scheduleServerResultTransition()
      }
    } else {
      // result 단계가 아니면(예: lobby, voting, gameover) 전환 타이머 취소
      clearResultTransition()
    }
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
      broadcastPlayerJoined(player)
      if (callback) callback({ success: true, player, players: gameState.players })
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

  // 참가자 퇴장 처리 (player:leave)
  socket.on('player:leave', (data, callback) => {
    try {
      const id = data?.id
      if (id) {
        const found = gameState.players.find((p) => p.id === id)
        gameState.players = gameState.players.filter((p) => p.id !== id)
        if (gameState.votes && gameState.votes[id]) {
          delete gameState.votes[id]
        }
        broadcastState()
        io.to(SOCKET_ROOM_MAIN).emit('player:left', { id })
        io.to(SOCKET_ROOM_MAIN).emit('players:update', gameState.players)
        io.emit('players:update', gameState.players)
        console.log(`🚪 [PLAYER LEFT] ${found?.nickname || id} 퇴장 (남은 인원: ${gameState.players.length}명)`)
      }
      if (callback) callback({ success: true })
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
      clearAllTimers()
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
        startServerVoting(limit)
      } else {
        gameState.phase = 'question'
        gameState.votingDeadline = null
        gameState.timeLeft = limit
        broadcastState()
      }

      if (callback) callback({ success: true, phase: gameState.phase })
    } catch (err) {
      console.error('[admin:start_game Error]:', err)
      if (callback) callback({ success: false, error: err.message })
    }
  })

  // 15초 투표 시작 (서버 타이머로 통일)
  socket.on('admin:start_voting', (data, callback) => {
    try {
      const limit = Number(data?.timeLimit) || gameState.timeLimit || 15
      startServerVoting(limit)
      if (callback) callback({ success: true })
    } catch (err) {
      if (callback) callback({ success: false })
    }
  })

  // 투표 마감 -> 서버 3초 서스펜스 단계 진입
  socket.on('admin:end_voting', (data, callback) => {
    try {
      startServerRevealing()
      if (callback) callback({ success: true })
    } catch (err) {
      if (callback) callback({ success: false })
    }
  })

  // 다음 라운드 진행
  socket.on('admin:next_round', (data, callback) => {
    try {
      clearAllTimers()
      const alive = gameState.players.filter((p) => p.status === 'alive' || p.isAlive === true)
      if (alive.length <= 2) {
        gameState.phase = 'gameover'
        gameState.isGameOver = true
        gameState.soleWinnerId = alive.length === 1 ? alive[0].id : null
        broadcastState()
        if (callback) callback({ success: false, reason: '생존자가 2명 이하이므로 게임이 종료되었습니다.' })
        return
      }

      gameState.roundNumber += 1
      gameState.votes = {}
      gameState.currentResult = null
      if (data?.question) {
        gameState.currentQuestion = data.question
      } else {
        gameState.currentQuestion = getNextServerQuestion(gameState.ruleMode)
      }
      const limit = Number(data?.timeLimit) || gameState.timeLimit || 15
      startServerVoting(limit)
      if (callback) callback({ success: true })
    } catch (err) {
      if (callback) callback({ success: false })
    }
  })

  // 일시정지 및 재개
  const handlePause = () => {
    clearAllTimers()
    gameState.isPaused = true
    if (gameState.phase === 'voting' && gameState.votingDeadline) {
      gameState.timeLeft = Math.max(0, Math.ceil((gameState.votingDeadline - Date.now()) / 1000))
    }
    broadcastState()
    io.to(SOCKET_ROOM_MAIN).emit('game:paused', { timeLeft: gameState.timeLeft })
    io.emit('game:paused', { timeLeft: gameState.timeLeft })
    console.log(`⏸️ [GAME PAUSED] 일시정지됨 (남은 시간: ${gameState.timeLeft}초)`)
  }

  const handleResume = () => {
    gameState.isPaused = false
    if (gameState.phase === 'voting' && gameState.timeLeft > 0) {
      gameState.votingDeadline = Date.now() + gameState.timeLeft * 1000
      startServerVoting(gameState.timeLeft)
    } else {
      broadcastState()
      io.to(SOCKET_ROOM_MAIN).emit('game:resumed', {
        timeLeft: gameState.timeLeft,
        votingDeadline: gameState.votingDeadline,
      })
      io.emit('game:resumed', {
        timeLeft: gameState.timeLeft,
        votingDeadline: gameState.votingDeadline,
      })
      if (gameState.phase === 'result') {
        scheduleServerResultTransition()
      }
    }
    console.log(`▶️ [GAME RESUMED] 게임 재개됨 (남은 시간: ${gameState.timeLeft}초)`)
  }

  socket.on('admin:pause_game', handlePause)
  socket.on('admin:pause', handlePause)

  socket.on('admin:resume_game', handleResume)
  socket.on('admin:resume', handleResume)

  // 관리자 대기실 복귀 및 게임 리셋 (3번 서바이벌 퀴즈 규격)
  socket.on('admin:reset_game', (callback) => {
    clearAllTimers()
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
    clearAllTimers()
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
    clearAllTimers()
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

  // 관리자 외부 접속 URL 수동 설정 (admin:update_server_url)
  socket.on('admin:action', (data) => {
    io.to(SOCKET_ROOM_MAIN).emit('game:update', data)
    io.emit('game:update', data)
  })

  // 관리자 TV BGM 마스터 볼륨 설정 (admin:set_volume)
  socket.on('admin:set_volume', (data) => {
    try {
      const vol = typeof data?.volume === 'number' ? Math.max(0, Math.min(1, data.volume)) : 0.6
      gameState.bgmVolume = vol
      io.to(SOCKET_ROOM_MAIN).emit('game:volume_changed', { volume: vol })
      io.emit('game:volume_changed', { volume: vol })
      console.log(`🔊 [BGM VOLUME] TV Master Volume 설정: ${Math.round(vol * 100)}%`)
    } catch (e) {
      console.error('[admin:set_volume Error]', e)
    }
  })

  socket.on('admin:update_server_url', (newUrl) => {
    try {
      if (newUrl && typeof newUrl === 'string') {
        publicTunnelUrl = newUrl.trim()
        gameState.serverHostUrl = publicTunnelUrl
        io.to(SOCKET_ROOM_MAIN).emit('server:tunnel_updated', publicTunnelUrl)
        io.emit('server:tunnel_updated', publicTunnelUrl)
        console.log(`[Admin] Server external URL updated to: ${publicTunnelUrl}`)
      }
    } catch (e) {
      console.error('[admin:update_server_url Error]', e)
    }
  })

  // 관리자 대기실 QR 모드 변경 요청 (admin:change_qr_mode)
  socket.on('admin:change_qr_mode', (data, callback) => {
    try {
      const mode = data?.mode === 'EXTERNAL' || data?.mode === 'tunnel' ? 'tunnel' : 'wifi'
      gameState.qrMode = mode
      broadcastState()
      io.to(SOCKET_ROOM_MAIN).emit('game:qr_mode_changed', { mode })
      io.emit('game:qr_mode_changed', { mode })
      if (callback) callback({ success: true, mode })
    } catch (err) {
      if (callback) callback({ success: false, mode: 'wifi' })
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
  } catch { }
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

app.get('/api/players', (req, res) => {
  res.json({ success: true, count: gameState.players.length, players: gameState.players })
})

app.get('/api/game/players', (req, res) => {
  res.json({ success: true, count: gameState.players.length, players: gameState.players })
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
    broadcastPlayerJoined(player)
    res.json({ success: true, player, players: gameState.players })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post('/api/game/leave', (req, res) => {
  try {
    const { id } = req.body || {}
    if (id) {
      const found = gameState.players.find((p) => p.id === id)
      gameState.players = gameState.players.filter((p) => p.id !== id)
      if (gameState.votes && gameState.votes[id]) {
        delete gameState.votes[id]
      }
      broadcastState()
      io.to(SOCKET_ROOM_MAIN).emit('player:left', { id })
      io.to(SOCKET_ROOM_MAIN).emit('players:update', gameState.players)
      io.emit('players:update', gameState.players)
      console.log(`🚪 [HTTP LEAVE] ${found?.nickname || id} 퇴장 (남은 인원: ${gameState.players.length}명)`)
    }
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})
app.post('/api/leave', (req, res) => {
  try {
    const { id } = req.body || {}
    if (id) {
      gameState.players = gameState.players.filter((p) => p.id !== id)
      if (gameState.votes && gameState.votes[id]) {
        delete gameState.votes[id]
      }
      broadcastState()
      io.to(SOCKET_ROOM_MAIN).emit('player:left', { id })
      io.to(SOCKET_ROOM_MAIN).emit('players:update', gameState.players)
      io.emit('players:update', gameState.players)
    }
    res.json({ success: true })
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
    broadcastPlayerJoined(player)
    res.json({ success: true, player, players: gameState.players })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post('/api/game/leave', (req, res) => {
  try {
    const { id } = req.body || {}
    if (id) {
      const found = gameState.players.find((p) => p.id === id)
      gameState.players = gameState.players.filter((p) => p.id !== id)
      if (gameState.votes && gameState.votes[id]) {
        delete gameState.votes[id]
      }
      broadcastState()
      io.to(SOCKET_ROOM_MAIN).emit('player:left', { id })
      io.to(SOCKET_ROOM_MAIN).emit('players:update', gameState.players)
      io.emit('players:update', gameState.players)
      console.log(`🚪 [HTTP LEAVE] ${found?.nickname || id} 퇴장 (남은 인원: ${gameState.players.length}명)`)
    }
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})
app.post('/api/leave', (req, res) => {
  try {
    const { id } = req.body || {}
    if (id) {
      gameState.players = gameState.players.filter((p) => p.id !== id)
      if (gameState.votes && gameState.votes[id]) {
        delete gameState.votes[id]
      }
      broadcastState()
      io.to(SOCKET_ROOM_MAIN).emit('player:left', { id })
      io.to(SOCKET_ROOM_MAIN).emit('players:update', gameState.players)
      io.emit('players:update', gameState.players)
    }
    res.json({ success: true })
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

let tunnelAttempts = 0

function connectTunnel(targetPort) {
  if (isProduction) return
  if (isReconnectingTunnel) return
  isReconnectingTunnel = true

  if (sshProcess) {
    try {
      sshProcess.kill('SIGKILL')
    } catch { }
    sshProcess = null
  }

  // 1차: localhost.run (LTE_5G_외부접속_터널실행.bat 호환), 2차: serveo.net 교차 시도
  const useLocalhostRun = tunnelAttempts % 2 === 0
  tunnelAttempts++

  const hostTarget = useLocalhostRun ? 'nokey@localhost.run' : 'serveo.net'
  console.log(`🔄 [로컬 터널 연결 시도 중...] (${hostTarget})`)

  try {
    const child = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=120',
      '-o', 'TCPKeepAlive=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-R', `80:127.0.0.1:${targetPort}`,
      hostTarget,
    ])
    sshProcess = child

    const handleOutput = (data) => {
      const text = data.toString()
      // serveo, localhost.run (.lhr.life), pinggy 등 모든 터널 도메인 정규식 매칭
      const match = text.match(/https:\/\/[a-zA-Z0-9-.]+\.(serveo\.net|serveousercontent\.com|lhr\.life|pinggy\.link|loca\.lt|ngrok-free\.app|ngrok\.io)/i)
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
            io.emit('server:tunnel_updated', publicTunnelUrl)
          } catch { }
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
    try { sshProcess.kill() } catch { }
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
