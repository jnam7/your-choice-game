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

// 3번 서바이벌 퀴즈 규격: 300인 이상 대규모 동시 접속 시 리스너 초과 경고 방지 및 메모리 보호
events.EventEmitter.defaultMaxListeners = 500

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
const port = process.env.PORT || 4000
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RENDER
let publicTunnelUrl = process.env.RENDER_EXTERNAL_URL || ''
let sshProcess = null
let isReconnectingTunnel = false

// Render 및 클라우드 즉시 응답 헬스체크 라우트
app.get('/healthz', (req, res) => res.status(200).send('OK'))
app.get('/health', (req, res) => res.status(200).send('OK'))

app.use(cors({ origin: '*' }))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// 1. 프론트엔드 dist 정적 파일 단일 포트 통합 서빙
const clientDistPath = path.resolve(__dirname, 'dist')
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath))
}

const httpServer = http.createServer(app)

// 2. Socket.io 설정 (최대 300인 동시 접속 최적화)
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  maxHttpBufferSize: 3e7,
  perMessageDeflate: false,
  allowEIO3: true,
})

// 하위 호환성용 메인 룸 상수 (기본 1번 채널에 연결됨)
const SOCKET_ROOM_MAIN = 'room:survival_quiz_main'

// =========================================================
// 5개 채널(룸) 완전 독립 상태 저장소 및 헬퍼
// =========================================================
const channels = new Map()

function createInitialGameState(channelId = '1') {
  return {
    channelId: String(channelId || '1'),
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
}

function getChannel(channelId = '1') {
  const id = String(channelId || '1').trim() || '1'
  if (!channels.has(id)) {
    channels.set(id, {
      id,
      gameState: createInitialGameState(id),
      votingTimer: null,
      revealingTimer: null,
      resultTransitionTimer: null,
      usedQuestionIdsServer: new Set(),
      lastServerNextRoundTime: 0,
    })
  }
  return channels.get(id)
}

// 1~5번 채널 사전 초기화
;['1', '2', '3', '4', '5'].forEach((id) => getChannel(id))

// 기본 채널 1의 gameState 참조 (레거시 코드 호환용)
const gameState = getChannel('1').gameState

function getChannelRoom(channelId = '1') {
  const id = String(channelId || '1').trim() || '1'
  return `room:channel_${id}`
}

function broadcastState(channelId = '1') {
  const ch = getChannel(channelId)
  const room = getChannelRoom(ch.id)
  io.to(room).emit('game:state_sync', ch.gameState)
  io.to(room).emit('state:sync', ch.gameState)
  if (ch.id === '1') {
    io.to(SOCKET_ROOM_MAIN).emit('game:state_sync', ch.gameState)
    io.to(SOCKET_ROOM_MAIN).emit('state:sync', ch.gameState)
  }
}

// 채널별 투표 쓰로틀링 브로드캐스트 (150ms 단위 배치)
const voteThrottleTimers = new Map()

function scheduleThrottledVoteBroadcast(channelId = '1') {
  const ch = getChannel(channelId)
  if (voteThrottleTimers.has(ch.id)) return

  const timer = setTimeout(() => {
    voteThrottleTimers.delete(ch.id)
    if (ch.gameState.phase !== 'voting') return

    const room = getChannelRoom(ch.id)
    const votePayload = {
      channelId: ch.id,
      votes: ch.gameState.votes,
      voteCount: Object.keys(ch.gameState.votes).length,
    }
    io.to(room).emit('game:votes_update', votePayload)
    io.to(room).emit('votes:update', votePayload)
    if (ch.id === '1') {
      io.to(SOCKET_ROOM_MAIN).emit('game:votes_update', votePayload)
      io.to(SOCKET_ROOM_MAIN).emit('votes:update', votePayload)
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
  if (ch.resultTransitionTimer) {
    clearTimeout(ch.resultTransitionTimer)
    ch.resultTransitionTimer = null
  }
  if (voteThrottleTimers.has(ch.id)) {
    clearTimeout(voteThrottleTimers.get(ch.id))
    voteThrottleTimers.delete(ch.id)
  }
}

// 1. 서버 주도 투표 타이머 시작 (절대 타임스탬프 기반)
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

  console.log(`⏱️ [CH ${ch.id} VOTING] ${duration}초 투표 시작 (종료 시각: ${votingEndTime})`)
  broadcastState(ch.id)
  const room = getChannelRoom(ch.id)
  const payload = {
    channelId: ch.id,
    roundNumber: ch.gameState.roundNumber,
    question: ch.gameState.currentQuestion,
    timeLimit: duration,
    votingDeadline: votingEndTime,
    votingEndTime: votingEndTime,
  }
  io.to(room).emit('game:round_started', payload)
  io.to(room).emit('game:voting_started', payload)
  io.to(room).emit('start_voting', payload)
  if (ch.id === '1') {
    io.to(SOCKET_ROOM_MAIN).emit('game:round_started', payload)
    io.to(SOCKET_ROOM_MAIN).emit('game:voting_started', payload)
    io.to(SOCKET_ROOM_MAIN).emit('start_voting', payload)
  }

  // votingEndTime 도달 시 클라이언트 응답 여부와 상관없이 무조건 서버가 강제로 투표 마감
  const delayMs = Math.max(0, votingEndTime - Date.now())
  ch.votingTimer = setTimeout(() => {
    ch.votingTimer = null
    if (ch.gameState.phase !== 'voting' || ch.gameState.isPaused) return
    console.log(`⏰ [CH ${ch.id} VOTING] votingEndTime 도달 -> 서버 강제 투표 마감 및 결과 서스펜스 진입`)
    startServerRevealing(ch.id)
  }, delayMs)
}

// 2. 서버 주도 3초 서스펜스 타이머 시작
function startServerRevealing(channelId = '1') {
  const ch = getChannel(channelId)
  clearAllTimers(ch.id)
  ch.gameState.phase = 'revealing'
  ch.gameState.timeLeft = 3
  ch.gameState.votingDeadline = null
  ch.gameState.votingEndTime = null
  ch.gameState.isPaused = false
  broadcastState(ch.id)

  const room = getChannelRoom(ch.id)
  io.to(room).emit('game:revealing', { channelId: ch.id })
  io.to(room).emit('revealing', { channelId: ch.id })
  if (ch.id === '1') {
    io.to(SOCKET_ROOM_MAIN).emit('game:revealing', { channelId: ch.id })
    io.to(SOCKET_ROOM_MAIN).emit('revealing', { channelId: ch.id })
  }

  ch.revealingTimer = setTimeout(() => {
    ch.revealingTimer = null
    if (ch.gameState.phase !== 'revealing' || ch.gameState.isPaused) return
    console.log(`📊 [CH ${ch.id} REVEALING] 3초 만료 -> 결과 계산 및 발표 단계 진입`)
    computeAndPublishResult(ch.id)
  }, 3000)
}

// 3. 서버 주도 투표 집계 및 판정
function computeAndPublishResult(channelId = '1') {
  const ch = getChannel(channelId)
  clearAllTimers(ch.id)
  const { votes, players, currentQuestion, roundNumber, ruleMode } = ch.gameState

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
    // votesB > votesA
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

  const survivorIds = eligiblePlayers.filter((p) => !eliminatedIds.includes(p.id)).map((p) => p.id)
  const isGameOver = survivorIds.length <= 2
  const soleWinnerId = survivorIds.length === 1 ? survivorIds[0] : null

  const result = {
    channelId: ch.id,
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
  for (const p of ch.gameState.players) {
    if (eliminatedIds.includes(p.id)) {
      p.status = 'eliminated'
      p.isAlive = false
      p.eliminatedRound = roundNumber
    }
  }

  ch.gameState.currentResult = result
  ch.gameState.isGameOver = isGameOver
  ch.gameState.soleWinnerId = soleWinnerId
  ch.gameState.phase = 'result'

  console.log(`📢 [CH ${ch.id} RESULT] A(${votesA}) vs B(${votesB}), 승리: ${majority}, 남은 생존자: ${survivorIds.length}명`)
  broadcastState(ch.id)
  scheduleServerResultTransition(ch.id)
}

// 서버 질문 풀
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

function getNextServerQuestion(channelId = '1', ruleMode) {
  const ch = getChannel(channelId)
  const pool = ruleMode === 'minority' ? serverMinorityQuestions : serverMajorityQuestions
  let available = pool.filter((q) => !ch.usedQuestionIdsServer.has(q.id))
  if (available.length === 0) {
    ch.usedQuestionIdsServer.clear()
    available = [...pool]
  }
  const picked = available[Math.floor(Math.random() * available.length)]
  ch.usedQuestionIdsServer.add(picked.id)
  return picked
}

function scheduleServerResultTransition(channelId = '1') {
  const ch = getChannel(channelId)
  if (ch.resultTransitionTimer) {
    clearTimeout(ch.resultTransitionTimer)
    ch.resultTransitionTimer = null
  }
  console.log(`⏱️ [CH ${ch.id} TRANSITION] 결과 공개 5초 후 전환 예약됨`)

  ch.resultTransitionTimer = setTimeout(() => {
    ch.resultTransitionTimer = null
    if (ch.gameState.phase !== 'result' || ch.gameState.isPaused) {
      return
    }

    const alivePlayers = ch.gameState.players.filter((p) => p.status === 'alive' || p.isAlive === true)
    console.log(`🏁 [CH ${ch.id} TRANSITION] 5초 경과 -> 생존자 ${alivePlayers.length}명 판정`)

    if (alivePlayers.length <= 2) {
      ch.gameState.phase = 'gameover'
      ch.gameState.isGameOver = true
      ch.gameState.soleWinnerId = alivePlayers.length === 1 ? alivePlayers[0].id : null
      console.log(`🏆 [CH ${ch.id}] 게임 종료! (생존자 ${alivePlayers.length}명, 우승자: ${ch.gameState.soleWinnerId || '없음/공동'})`)
      broadcastState(ch.id)
      const room = getChannelRoom(ch.id)
      const payload = {
        channelId: ch.id,
        survivors: alivePlayers,
        winnerCount: alivePlayers.length,
        soleWinnerId: ch.gameState.soleWinnerId,
      }
      io.to(room).emit('game:game_over', payload)
      if (ch.id === '1') {
        io.to(SOCKET_ROOM_MAIN).emit('game:game_over', payload)
      }
      return
    }

    ch.gameState.roundNumber += 1
    ch.gameState.currentQuestion = getNextServerQuestion(ch.id, ch.gameState.ruleMode)
    const limit = ch.gameState.timeLimit || 15
    console.log(`🚀 [CH ${ch.id}] 다음 라운드(${ch.gameState.roundNumber}) 시작! (제한시간: ${limit}초)`)
    startServerVoting(ch.id, limit)
  }, 5000)
}

function broadcastPlayerJoined(player, channelId = '1') {
  const ch = getChannel(channelId)
  const room = getChannelRoom(ch.id)
  const payload = { channelId: ch.id, player, players: ch.gameState.players, totalCount: ch.gameState.players.length }
  io.to(room).emit('game:player_joined', payload)
  io.to(room).emit('player:joined', payload)
  io.to(room).emit('players:update', ch.gameState.players)
  if (ch.id === '1') {
    io.to(SOCKET_ROOM_MAIN).emit('game:player_joined', payload)
    io.to(SOCKET_ROOM_MAIN).emit('player:joined', payload)
    io.to(SOCKET_ROOM_MAIN).emit('players:update', ch.gameState.players)
  }
}

function applyAdminSync(updates, channelId = '1') {
  const ch = getChannel(channelId)
  if (updates && typeof updates === 'object') {
    const oldPhase = ch.gameState.phase
    const { players: incomingPlayers, channelId: _ch, ...safeUpdates } = updates
    Object.assign(ch.gameState, safeUpdates)

    if (Array.isArray(incomingPlayers)) {
      if (ch.gameState.phase === 'lobby') {
        // 대기실에서는 클라이언트가 보낸 최신 플레이어 목록(더미 추가 등)을 전체 반영
        ch.gameState.players = incomingPlayers
      } else if (incomingPlayers.length > 0) {
        const statusMap = new Map(incomingPlayers.map((p) => [p.id, p.status]))
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

    console.log(`🔄 [CH ${ch.id} SYNC] Phase: ${oldPhase} -> ${ch.gameState.phase}, Round: ${ch.gameState.roundNumber}`)
    broadcastState(ch.id)

    if (ch.gameState.phase === 'result') {
      if (oldPhase !== 'result' || !ch.resultTransitionTimer) {
        scheduleServerResultTransition(ch.id)
      }
    } else {
      if (ch.resultTransitionTimer) {
        clearTimeout(ch.resultTransitionTimer)
        ch.resultTransitionTimer = null
      }
    }
  }
}

// =========================================================
// Socket.io 실시간 이벤트 핸들러 (채널 격리 지원)
// =========================================================
io.on('connection', (socket) => {
  socket.data = socket.data || {}
  socket.data.channelId = '1'

  // 기본 채널 1 및 메인 룸 자동 조인 (하위 호환 100% 보장)
  socket.join('room:channel_1')
  socket.join(SOCKET_ROOM_MAIN)

  const getEventChannelId = (data) => {
    const raw = data?.channelId || data?.channel || socket.data?.channelId || '1'
    return String(raw).trim() || '1'
  }

  // 채널 조인 핸들러
  socket.on('join:channel', (data, callback) => {
    const targetChannel = getEventChannelId(data)
    for (const r of socket.rooms) {
      if (r.startsWith('room:channel_') && r !== getChannelRoom(targetChannel)) {
        socket.leave(r)
      }
    }
    if (targetChannel !== '1') {
      socket.leave(SOCKET_ROOM_MAIN)
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
    socket.emit('players:update', { channelId: targetChannel, players: ch.gameState.players })
    socket.emit('qr_mode_updated', { qrMode: ch.gameState.qrMode, mode: ch.gameState.qrMode, channelId: targetChannel })
    socket.emit('game:qr_mode_changed', { qrMode: ch.gameState.qrMode, mode: ch.gameState.qrMode, channelId: targetChannel })
    console.log(`📡 [SOCKET JOIN:CHANNEL] Socket ${socket.id} -> 채널 ${targetChannel} (${data?.role || 'user'})`)
    if (callback) callback({ success: true, channelId: targetChannel, state: ch.gameState })
  })

  // 채널 퇴장 핸들러
  socket.on('leave:channel', (data) => {
    try {
      const targetChannel = String(data?.channelId || data || '').trim()
      if (targetChannel) {
        socket.leave(getChannelRoom(targetChannel))
        if (targetChannel === '1') {
          socket.leave(SOCKET_ROOM_MAIN)
        }
        console.log(`🚪 [SOCKET LEAVE:CHANNEL] Socket ${socket.id} <- 채널 ${targetChannel}`)
      }
    } catch (e) {
      console.error('[leave:channel error]', e)
    }
  })

  // 룸 조인 이벤트 수신 (join:room 및 join 호환)
  socket.on('join:room', (data) => {
    const targetRoom = data?.roomId || SOCKET_ROOM_MAIN
    if (targetRoom === SOCKET_ROOM_MAIN && socket.data?.channelId && socket.data.channelId !== '1') {
      return
    }
    socket.join(targetRoom)
    if (data?.channelId) {
      socket.data.channelId = String(data.channelId).trim() || '1'
    }
  })
  socket.on('join', (data) => {
    const targetRoom = typeof data === 'string' ? data : (data?.roomId || SOCKET_ROOM_MAIN)
    if (targetRoom === SOCKET_ROOM_MAIN && socket.data?.channelId && socket.data.channelId !== '1') {
      return
    }
    socket.join(targetRoom)
  })

  // 최초 접속 시 현재 상태 즉시 전달
  socket.emit('game:state_sync', getChannel('1').gameState)
  socket.emit('state:sync', getChannel('1').gameState)

  if (publicTunnelUrl) {
    socket.emit('server:tunnel_updated', publicTunnelUrl)
  }

  // 1-0. 참가자 재접속 세션 복구 (player:reconnect)
  socket.on('player:reconnect', (data, callback) => {
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

      let player = ch.gameState.players.find((p) => (playerId && p.id === playerId) || (nickname && p.nickname === nickname))
      const isLobby = ch.gameState.phase === 'lobby'

      if (player) {
        player.socketId = socket.id
        if (playerId) player.id = playerId
        if (nickname) player.nickname = nickname
        console.log(`🔄 [CH ${ch.id} PLAYER RECONNECT] ${player.nickname} (${player.id}) 최신 소켓 갱신`)
      } else {
        player = {
          id: playerId || ('p_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6)),
          nickname: nickname || '참가자',
          status: isLobby ? 'alive' : 'eliminated',
          isAlive: isLobby,
          joinedAt: Date.now(),
          socketId: socket.id,
        }
        ch.gameState.players.push(player)
        console.log(`➕ [CH ${ch.id} PLAYER RECONNECT RESTORE] ${player.nickname} (${player.id}) 재등록`)
        broadcastPlayerJoined(player, ch.id)
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
    } catch (e) {
      console.error('[player:reconnect Error]', e)
      if (callback) callback({ success: false, error: e.message })
    }
  })

  // 1. 참가자 등록 (player:join)
  socket.on('player:join', (data, callback) => {
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
        console.log(`👤 [CH ${ch.id} PLAYER JOIN] ${nickname} (ID: ${player.id}) - 현재 총 ${ch.gameState.players.length}명`)
      } else {
        if (requestedId) player.id = requestedId
        player.nickname = nickname
        if (isLobby) {
          player.status = 'alive'
          player.isAlive = true
        }
        console.log(`🔄 [CH ${ch.id} PLAYER RE-JOIN] ${nickname} (ID: ${player.id}) - 현재 총 ${ch.gameState.players.length}명`)
      }

      if (player) {
        player.socketId = socket.id
      }
      broadcastState(ch.id)
      broadcastPlayerJoined(player, ch.id)
      socket.emit('sync', ch.gameState)
      socket.emit('game:sync', ch.gameState)
      if (callback) callback({ success: true, player, players: ch.gameState.players, channelId: ch.id })
    } catch (e) {
      console.error('[player:join Error]', e)
    }
  })

  // 1-1. 참가자 닉네임 수정
  socket.on('player:change_nickname', (data, callback) => {
    try {
      const chId = getEventChannelId(data)
      const ch = getChannel(chId)
      const { id, newNickname } = data || {}
      const trimmed = (newNickname || '').trim()

      if (!trimmed || trimmed.length > 10) {
        if (callback) callback({ success: false, error: '1~10자 이내로 입력해주세요.' })
        return
      }

      const player = ch.gameState.players.find((p) => p.id === id)
      if (player) {
        const oldNick = player.nickname
        player.nickname = trimmed
        console.log(`✏️ [CH ${ch.id} NICKNAME CHANGED] ${oldNick} -> ${trimmed}`)
        for (const msg of ch.gameState.chatMessages) {
          if (msg.nickname === oldNick) msg.nickname = trimmed
        }
        broadcastState(ch.id)
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
      const chId = getEventChannelId(data)
      const ch = getChannel(chId)
      const id = data?.id
      if (id) {
        const found = ch.gameState.players.find((p) => p.id === id)
        ch.gameState.players = ch.gameState.players.filter((p) => p.id !== id)
        if (ch.gameState.votes && ch.gameState.votes[id]) {
          delete ch.gameState.votes[id]
        }
        broadcastState(ch.id)
        const room = getChannelRoom(ch.id)
        io.to(room).emit('player:left', { id, channelId: ch.id })
        io.to(room).emit('players:update', ch.gameState.players)
        if (ch.id === '1') {
          io.to(SOCKET_ROOM_MAIN).emit('player:left', { id, channelId: ch.id })
          io.to(SOCKET_ROOM_MAIN).emit('players:update', ch.gameState.players)
        }
        console.log(`🚪 [CH ${ch.id} PLAYER LEFT] ${found?.nickname || id} 퇴장`)
      }
      if (callback) callback({ success: true })
    } catch (e) {
      if (callback) callback({ success: false, error: e.message })
    }
  })

  // 2. 참가자 투표 제출
  const handleVote = (playerId, choice, data, callback) => {
    try {
      const chId = getEventChannelId(data)
      const ch = getChannel(chId)
      if (!playerId || (choice !== 'A' && choice !== 'B')) {
        if (callback) callback({ success: false, error: '잘못된 투표 요청입니다.' })
        return
      }

      const player = ch.gameState.players.find((p) => p.id === playerId)
      if (player && (player.status === 'eliminated' || player.isAlive === false)) {
        if (callback) callback({ success: false, error: '이미 탈락한 참가자는 투표할 수 없습니다.' })
        return
      }

      const allowedPhases = ['voting', 'question', 'revealing']
      if (!allowedPhases.includes(ch.gameState.phase)) {
        if (callback) callback({ success: false, error: '투표 진행 중이 아닙니다.' })
        return
      }

      ch.gameState.votes[playerId] = choice
      // 투표 폭주 시 전체 동기화 브로드캐스트 대신 150ms 쓰로틀링 배치 전송
      scheduleThrottledVoteBroadcast(ch.id)
      if (callback) callback({ success: true })
    } catch (e) {
      if (callback) callback({ success: false, error: e.message })
    }
  }

  socket.on('player:vote', (data, callback) => {
    handleVote(data?.playerId, data?.choice, data, callback)
  })

  socket.on('player:submit_answer', (data, callback) => {
    const choice = data?.choice || (data?.answerIndex === 0 ? 'A' : (data?.answerIndex === 1 ? 'B' : null))
    const pId = data?.playerId || data?.token || socket.id
    handleVote(pId, choice, data, callback)
  })

  // 3. 관리자 제어 이벤트
  socket.on('admin:start_game', (data, callback) => {
    try {
      const chId = getEventChannelId(data)
      const ch = getChannel(chId)
      console.log(`🚀 [CH ${ch.id}] admin:start_game 수신 -> 라운드 시작!`)
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
        ch.gameState.timeLeft = limit
        broadcastState(ch.id)
      }

      if (callback) callback({ success: true, phase: ch.gameState.phase, channelId: ch.id })
    } catch (err) {
      console.error('[admin:start_game Error]:', err)
      if (callback) callback({ success: false, error: err.message })
    }
  })

  socket.on('admin:start_voting', (data, callback) => {
    try {
      const chId = getEventChannelId(data)
      const ch = getChannel(chId)
      const limit = Number(data?.timeLimit) || ch.gameState.timeLimit || 15
      startServerVoting(ch.id, limit)
      if (callback) callback({ success: true })
    } catch (err) {
      if (callback) callback({ success: false })
    }
  })

  socket.on('admin:end_voting', (data, callback) => {
    try {
      const chId = getEventChannelId(data)
      startServerRevealing(chId)
      if (callback) callback({ success: true })
    } catch (err) {
      if (callback) callback({ success: false })
    }
  })

  socket.on('admin:next_round', (data, callback) => {
    try {
      const chId = getEventChannelId(data)
      const ch = getChannel(chId)
      const now = Date.now()
      if (now - ch.lastServerNextRoundTime < 1500) {
        console.warn(`⚠️ [CH ${ch.id} admin:next_round] 1.5초 내 중복 요청 차단`)
        if (callback) callback({ success: false, reason: '중복 요청 차단' })
        return
      }
      if (ch.gameState.phase !== 'result' && ch.gameState.phase !== 'lobby') {
        console.warn(`⚠️ [CH ${ch.id} admin:next_round] 현재 단계(${ch.gameState.phase})에서는 진행할 수 없습니다.`)
        if (callback) callback({ success: false, reason: '진행 불가 단계' })
        return
      }
      ch.lastServerNextRoundTime = now

      clearAllTimers(ch.id)
      const alive = ch.gameState.players.filter((p) => p.status === 'alive' || p.isAlive === true)
      if (alive.length <= 2) {
        ch.gameState.phase = 'gameover'
        ch.gameState.isGameOver = true
        ch.gameState.soleWinnerId = alive.length === 1 ? alive[0].id : null
        broadcastState(ch.id)
        if (callback) callback({ success: false, reason: '생존자가 2명 이하이므로 게임이 종료되었습니다.' })
        return
      }

      ch.gameState.roundNumber += 1
      ch.gameState.votes = {}
      ch.gameState.currentResult = null
      if (data?.question) {
        ch.gameState.currentQuestion = data.question
      } else {
        ch.gameState.currentQuestion = getNextServerQuestion(ch.id, ch.gameState.ruleMode)
      }
      const limit = Number(data?.timeLimit) || ch.gameState.timeLimit || 15
      startServerVoting(ch.id, limit)
      if (callback) callback({ success: true })
    } catch (err) {
      if (callback) callback({ success: false })
    }
  })

  const handlePause = (data) => {
    const chId = getEventChannelId(data)
    const ch = getChannel(chId)
    clearAllTimers(ch.id)
    ch.gameState.isPaused = true
    if (ch.gameState.phase === 'voting' && ch.gameState.votingDeadline) {
      ch.gameState.timeLeft = Math.max(0, Math.ceil((ch.gameState.votingDeadline - Date.now()) / 1000))
    }
    broadcastState(ch.id)
    const room = getChannelRoom(ch.id)
    io.to(room).emit('game:paused', { timeLeft: ch.gameState.timeLeft, channelId: ch.id })
    if (ch.id === '1') io.to(SOCKET_ROOM_MAIN).emit('game:paused', { timeLeft: ch.gameState.timeLeft, channelId: ch.id })
    console.log(`⏸️ [CH ${ch.id} PAUSED] 일시정지 (남은: ${ch.gameState.timeLeft}초)`)
  }

  const handleResume = (data) => {
    const chId = getEventChannelId(data)
    const ch = getChannel(chId)
    ch.gameState.isPaused = false
    if (ch.gameState.phase === 'voting' && ch.gameState.timeLeft > 0) {
      ch.gameState.votingDeadline = Date.now() + ch.gameState.timeLeft * 1000
      startServerVoting(ch.id, ch.gameState.timeLeft)
    } else {
      broadcastState(ch.id)
      const room = getChannelRoom(ch.id)
      const payload = { timeLeft: ch.gameState.timeLeft, votingDeadline: ch.gameState.votingDeadline, channelId: ch.id }
      io.to(room).emit('game:resumed', payload)
      if (ch.id === '1') io.to(SOCKET_ROOM_MAIN).emit('game:resumed', payload)
      if (ch.gameState.phase === 'result') {
        scheduleServerResultTransition(ch.id)
      }
    }
    console.log(`▶️ [CH ${ch.id} RESUMED] 게임 재개 (남은: ${ch.gameState.timeLeft}초)`)
  }

  socket.on('admin:pause_game', handlePause)
  socket.on('admin:pause', handlePause)
  socket.on('admin:resume_game', handleResume)
  socket.on('admin:resume', handleResume)

  socket.on('admin:reset_game', (data, callback) => {
    const chId = getEventChannelId(data)
    const ch = getChannel(chId)
    clearAllTimers(ch.id)
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
    io.to(room).emit('sync', ch.gameState)
    io.to(room).emit('game:sync', ch.gameState)
    io.to(room).emit('players:update', { channelId: ch.id, players: ch.gameState.players })
    io.to(room).emit('game:force_lobby', { channelId: ch.id })
    io.to(room).emit('game:set_reset', { channelId: ch.id })
    if (ch.id === '1') {
      io.to(SOCKET_ROOM_MAIN).emit('sync', ch.gameState)
      io.to(SOCKET_ROOM_MAIN).emit('game:sync', ch.gameState)
      io.to(SOCKET_ROOM_MAIN).emit('players:update', { channelId: ch.id, players: ch.gameState.players })
      io.to(SOCKET_ROOM_MAIN).emit('game:force_lobby', { channelId: ch.id })
      io.to(SOCKET_ROOM_MAIN).emit('game:set_reset', { channelId: ch.id })
    }
    if (callback) callback({ success: true, count: ch.gameState.players.length })
  })

  socket.on('admin:reset_game_keep_players', (data, callback) => {
    const chId = getEventChannelId(data)
    const ch = getChannel(chId)
    clearAllTimers(ch.id)
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
    io.to(room).emit('sync', ch.gameState)
    io.to(room).emit('game:sync', ch.gameState)
    io.to(room).emit('players:update', { channelId: ch.id, players: ch.gameState.players })
    io.to(room).emit('game:force_lobby', { channelId: ch.id })
    io.to(room).emit('game:set_reset', { channelId: ch.id })
    if (ch.id === '1') {
      io.to(SOCKET_ROOM_MAIN).emit('sync', ch.gameState)
      io.to(SOCKET_ROOM_MAIN).emit('game:sync', ch.gameState)
      io.to(SOCKET_ROOM_MAIN).emit('players:update', { channelId: ch.id, players: ch.gameState.players })
      io.to(SOCKET_ROOM_MAIN).emit('game:force_lobby', { channelId: ch.id })
      io.to(SOCKET_ROOM_MAIN).emit('game:set_reset', { channelId: ch.id })
    }
    if (callback) callback({ success: true, count: ch.gameState.players.length })
  })

  socket.on('admin:move_to_lobby', (data, callback) => {
    const chId = getEventChannelId(data)
    const ch = getChannel(chId)
    clearAllTimers(ch.id)
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
    io.to(room).emit('sync', ch.gameState)
    io.to(room).emit('game:sync', ch.gameState)
    io.to(room).emit('players:update', { channelId: ch.id, players: ch.gameState.players })
    io.to(room).emit('game:force_lobby', { channelId: ch.id })
    io.to(room).emit('game:set_reset', { channelId: ch.id })
    if (ch.id === '1') {
      io.to(SOCKET_ROOM_MAIN).emit('sync', ch.gameState)
      io.to(SOCKET_ROOM_MAIN).emit('game:sync', ch.gameState)
      io.to(SOCKET_ROOM_MAIN).emit('players:update', { channelId: ch.id, players: ch.gameState.players })
      io.to(SOCKET_ROOM_MAIN).emit('game:force_lobby', { channelId: ch.id })
      io.to(SOCKET_ROOM_MAIN).emit('game:set_reset', { channelId: ch.id })
    }
    if (callback) callback({ success: true })
  })

  socket.on('admin:clear_all_players', (data, callback) => {
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
    io.to(room).emit('sync', ch.gameState)
    io.to(room).emit('game:sync', ch.gameState)
    io.to(room).emit('players:update', { channelId: ch.id, players: [] })
    io.to(room).emit('game:player_kicked_all', { channelId: ch.id })
    io.to(room).emit('game:reset', { channelId: ch.id })
    if (ch.id === '1') {
      io.to(SOCKET_ROOM_MAIN).emit('sync', ch.gameState)
      io.to(SOCKET_ROOM_MAIN).emit('game:sync', ch.gameState)
      io.to(SOCKET_ROOM_MAIN).emit('players:update', { channelId: ch.id, players: [] })
      io.to(SOCKET_ROOM_MAIN).emit('game:player_kicked_all', { channelId: ch.id })
      io.to(SOCKET_ROOM_MAIN).emit('game:reset', { channelId: ch.id })
    }
    if (callback) callback({ success: true })
  })

  // 클라이언트 전체 동기화 수신 (admin:sync)
  socket.on('admin:sync', (updates) => {
    try {
      const chId = getEventChannelId(updates)
      applyAdminSync(updates, chId)
    } catch (e) {
      console.error('[admin:sync Error]', e)
    }
  })

  // 관리자 더미 참가자 추가
  const handleAddMockPlayers = (data, callback) => {
    try {
      const chId = getEventChannelId(data)
      const ch = getChannel(chId)
      const incoming = Array.isArray(data?.newPlayers) ? data.newPlayers : []
      if (incoming.length > 0) {
        const existingIds = new Set(ch.gameState.players.map((p) => p.id))
        const toAdd = incoming.filter((p) => p && !existingIds.has(p.id))
        toAdd.forEach((p) => { p.isDummy = true; p.isAlive = true; p.status = 'alive' })
        ch.gameState.players.push(...toAdd)
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
            id: `mock_${ch.id}_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 6)}`,
            nickname,
            status: 'alive',
            isAlive: true,
            joinedAt: Date.now() + i,
            isDummy: true,
          })
        }
        ch.gameState.players.push(...newDummies)
      }

      broadcastState(ch.id)
      const room = getChannelRoom(ch.id)
      io.to(room).emit('players:update', { channelId: ch.id, players: ch.gameState.players })
      io.to(room).emit('sync', ch.gameState)
      io.to(room).emit('game:sync', ch.gameState)
      if (ch.id === '1') {
        io.to(SOCKET_ROOM_MAIN).emit('players:update', { channelId: ch.id, players: ch.gameState.players })
        io.to(SOCKET_ROOM_MAIN).emit('sync', ch.gameState)
        io.to(SOCKET_ROOM_MAIN).emit('game:sync', ch.gameState)
      }
      if (callback) callback({ success: true, total: ch.gameState.players.length, channelId: ch.id })
    } catch (e) {
      if (callback) callback({ success: false, error: e.message })
    }
  }

  socket.on('admin:add_mock_players', handleAddMockPlayers)
  socket.on('admin:add-mock-players', handleAddMockPlayers)

  // 실시간 사내 응원 채팅 (해당 채널 룸으로만 격리 전송)
  const handleIncomingChatMessage = (data) => {
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

        io.to(targetRoom).emit('chat:message', msg)
        if (ch.id === '1') {
          io.to(SOCKET_ROOM_MAIN).emit('chat:message', msg)
        }
      }
    } catch (e) {
      console.error('[chat error]', e)
    }
  }

  socket.on('chat:message', handleIncomingChatMessage)
  socket.on('chat:send', handleIncomingChatMessage)

  socket.on('admin:action', (data) => {
    const chId = getEventChannelId(data)
    io.to(getChannelRoom(chId)).emit('game:update', data)
  })

  // 관리자 TV BGM 마스터 볼륨 설정
  socket.on('admin:set_volume', (data) => {
    try {
      const chId = getEventChannelId(data)
      const ch = getChannel(chId)
      const vol = typeof data?.volume === 'number' ? Math.max(0, Math.min(1, data.volume)) : 0.6
      ch.gameState.bgmVolume = vol
      const room = getChannelRoom(ch.id)
      io.to(room).emit('game:volume_changed', { volume: vol, channelId: ch.id })
      if (ch.id === '1') io.to(SOCKET_ROOM_MAIN).emit('game:volume_changed', { volume: vol, channelId: ch.id })
      console.log(`🔊 [CH ${ch.id} BGM] Volume: ${Math.round(vol * 100)}%`)
    } catch (e) {
      console.error('[admin:set_volume Error]', e)
    }
  })

  socket.on('admin:update_server_url', (newUrl) => {
    try {
      if (newUrl && typeof newUrl === 'string') {
        publicTunnelUrl = newUrl.trim()
        for (const ch of channels.values()) {
          ch.gameState.serverHostUrl = publicTunnelUrl
        }
        io.emit('server:tunnel_updated', publicTunnelUrl)
        console.log(`[Admin] Server external URL updated to: ${publicTunnelUrl}`)
      }
    } catch (e) {
      console.error('[admin:update_server_url Error]', e)
    }
  })

  // 관리자 룰 모드 변경 요청
  const handleRuleModeChange = (data, callback) => {
    try {
      const chId = getEventChannelId(data)
      const ch = getChannel(chId)
      const mode = data?.ruleMode || data?.mode || (data === 'minority' ? 'minority' : 'majority')
      ch.gameState.ruleMode = mode === 'minority' ? 'minority' : 'majority'
      const room = getChannelRoom(ch.id)
      io.to(room).emit('rule_mode_updated', { ruleMode: ch.gameState.ruleMode, channelId: ch.id })
      io.to(room).emit('game:rule_mode_changed', { ruleMode: ch.gameState.ruleMode, channelId: ch.id })
      if (ch.id === '1') {
        io.to(SOCKET_ROOM_MAIN).emit('rule_mode_updated', { ruleMode: ch.gameState.ruleMode, channelId: ch.id })
        io.to(SOCKET_ROOM_MAIN).emit('game:rule_mode_changed', { ruleMode: ch.gameState.ruleMode, channelId: ch.id })
      }
      console.log(`🎯 [CH ${ch.id} RULE MODE] -> ${ch.gameState.ruleMode}`)
      if (callback) callback({ success: true, ruleMode: ch.gameState.ruleMode, channelId: ch.id })
    } catch (err) {
      if (callback) callback({ success: false, error: err.message })
    }
  }

  socket.on('admin:set_rule_mode', handleRuleModeChange)
  socket.on('admin:set-rule-mode', handleRuleModeChange)

  // 관리자 대기실 QR 모드 변경 요청
  const handleQrModeChange = (data, callback) => {
    try {
      const chId = getEventChannelId(data)
      const ch = getChannel(chId)
      const rawMode = data?.qrMode || data?.mode || data
      const mode = rawMode === 'EXTERNAL' || rawMode === 'tunnel' || rawMode === 'lte' || rawMode === 'external' ? 'tunnel' : 'wifi'
      ch.gameState.qrMode = mode
      const room = getChannelRoom(ch.id)
      io.to(room).emit('qr_mode_updated', { qrMode: mode, mode, channelId: ch.id })
      io.to(room).emit('game:qr_mode_changed', { qrMode: mode, mode, channelId: ch.id })
      io.to(room).emit('qr:change', { qrMode: mode, mode, channelId: ch.id })
      if (ch.id === '1') {
        io.to(SOCKET_ROOM_MAIN).emit('qr_mode_updated', { qrMode: mode, mode, channelId: ch.id })
        io.to(SOCKET_ROOM_MAIN).emit('game:qr_mode_changed', { qrMode: mode, mode, channelId: ch.id })
        io.to(SOCKET_ROOM_MAIN).emit('qr:change', { qrMode: mode, mode, channelId: ch.id })
      }
      console.log(`📡 [CH ${ch.id} QR MODE] -> ${mode}`)
      if (callback) callback({ success: true, mode, qrMode: mode, channelId: ch.id })
    } catch (err) {
      if (callback) callback({ success: false, mode: 'wifi' })
    }
  }

  socket.on('admin:change_qr_mode', handleQrModeChange)
  socket.on('admin:set-qr-mode', handleQrModeChange)
  socket.on('admin:set_qr_mode', handleQrModeChange)
  socket.on('qr:change', handleQrModeChange)
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

// 5. REST API (채널 쿼리/바디 매핑)
app.get('/api/server-info', (req, res) => {
  res.json({
    localIp: getLocalNetworkIp(),
    clientPort: port,
    serverPort: port,
    publicUrl: publicTunnelUrl || null,
  })
})

const getReqChannelId = (req) => {
  const ch = req.query?.channel || req.query?.channelId || req.query?.ch || req.body?.channelId || req.body?.channel || '1'
  return String(ch).trim() || '1'
}

app.get('/api/state', (req, res) => {
  const chId = getReqChannelId(req)
  res.json(getChannel(chId).gameState)
})

app.get('/api/game/state', (req, res) => {
  const chId = getReqChannelId(req)
  res.json(getChannel(chId).gameState)
})

app.get('/api/players', (req, res) => {
  const chId = getReqChannelId(req)
  const ch = getChannel(chId)
  res.json({ success: true, count: ch.gameState.players.length, players: ch.gameState.players, channelId: ch.id })
})

app.get('/api/game/players', (req, res) => {
  const chId = getReqChannelId(req)
  const ch = getChannel(chId)
  res.json({ success: true, count: ch.gameState.players.length, players: ch.gameState.players, channelId: ch.id })
})

app.post('/api/game/start', (req, res) => {
  try {
    const data = req.body || {}
    const chId = getReqChannelId(req)
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
    if (data.question) ch.gameState.currentQuestion = data.question
    if (data.ruleMode) ch.gameState.ruleMode = data.ruleMode
    const limit = Number(data.timeLimit) || ch.gameState.timeLimit || 15
    ch.gameState.timeLimit = limit
    if (data.autoStartVoting !== false) {
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
    io.to(room).emit('game:round_started', payload)
    if (ch.id === '1') io.to(SOCKET_ROOM_MAIN).emit('game:round_started', payload)
    res.json({ success: true, state: ch.gameState, channelId: ch.id })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post('/api/game/sync', (req, res) => {
  try {
    const chId = getReqChannelId(req)
    applyAdminSync(req.body, chId)
    res.json({ success: true, state: getChannel(chId).gameState, channelId: chId })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post('/api/admin/sync', (req, res) => {
  try {
    const chId = getReqChannelId(req)
    applyAdminSync(req.body, chId)
    res.json({ success: true, state: getChannel(chId).gameState, channelId: chId })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post('/api/game/rule-mode', (req, res) => {
  try {
    const chId = getReqChannelId(req)
    const ch = getChannel(chId)
    const mode = req.body?.ruleMode || req.body?.mode || 'majority'
    ch.gameState.ruleMode = mode === 'minority' ? 'minority' : 'majority'
    const room = getChannelRoom(ch.id)
    io.to(room).emit('rule_mode_updated', { ruleMode: ch.gameState.ruleMode, channelId: ch.id })
    io.to(room).emit('game:rule_mode_changed', { ruleMode: ch.gameState.ruleMode, channelId: ch.id })
    if (ch.id === '1') {
      io.to(SOCKET_ROOM_MAIN).emit('rule_mode_updated', { ruleMode: ch.gameState.ruleMode, channelId: ch.id })
      io.to(SOCKET_ROOM_MAIN).emit('game:rule_mode_changed', { ruleMode: ch.gameState.ruleMode, channelId: ch.id })
    }
    res.json({ success: true, ruleMode: ch.gameState.ruleMode, channelId: ch.id })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post('/api/game/qr-mode', (req, res) => {
  try {
    const chId = getReqChannelId(req)
    const ch = getChannel(chId)
    const rawMode = req.body?.qrMode || req.body?.mode
    const mode = rawMode === 'EXTERNAL' || rawMode === 'tunnel' || rawMode === 'lte' || rawMode === 'external' ? 'tunnel' : 'wifi'
    ch.gameState.qrMode = mode
    const room = getChannelRoom(ch.id)
    io.to(room).emit('qr_mode_updated', { qrMode: mode, mode, channelId: ch.id })
    io.to(room).emit('game:qr_mode_changed', { qrMode: mode, mode, channelId: ch.id })
    io.to(room).emit('qr:change', { qrMode: mode, mode, channelId: ch.id })
    if (ch.id === '1') {
      io.to(SOCKET_ROOM_MAIN).emit('qr_mode_updated', { qrMode: mode, mode, channelId: ch.id })
      io.to(SOCKET_ROOM_MAIN).emit('game:qr_mode_changed', { qrMode: mode, mode, channelId: ch.id })
      io.to(SOCKET_ROOM_MAIN).emit('qr:change', { qrMode: mode, mode, channelId: ch.id })
    }
    res.json({ success: true, qrMode: mode, mode, channelId: ch.id })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

app.post('/api/game/mock-players', (req, res) => {
  try {
    const chId = getReqChannelId(req)
    const ch = getChannel(chId)
    const incoming = Array.isArray(req.body?.newPlayers) ? req.body.newPlayers : []
    if (incoming.length > 0) {
      const existingIds = new Set(ch.gameState.players.map((p) => p.id))
      const toAdd = incoming.filter((p) => p && !existingIds.has(p.id))
      toAdd.forEach((p) => { p.isDummy = true; p.isAlive = true; p.status = 'alive' })
      ch.gameState.players.push(...toAdd)
    }
    broadcastState(ch.id)
    const room = getChannelRoom(ch.id)
    io.to(room).emit('players:update', { channelId: ch.id, players: ch.gameState.players })
    io.to(room).emit('sync', ch.gameState)
    io.to(room).emit('game:sync', ch.gameState)
    if (ch.id === '1') {
      io.to(SOCKET_ROOM_MAIN).emit('players:update', { channelId: ch.id, players: ch.gameState.players })
      io.to(SOCKET_ROOM_MAIN).emit('sync', ch.gameState)
      io.to(SOCKET_ROOM_MAIN).emit('game:sync', ch.gameState)
    }
    res.json({ success: true, total: ch.gameState.players.length, channelId: ch.id })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

const handleHttpVote = (req, res) => {
  try {
    const { playerId, choice } = req.body || {}
    const chId = getReqChannelId(req)
    const ch = getChannel(chId)
    if (!playerId || (choice !== 'A' && choice !== 'B')) {
      return res.status(400).json({ success: false, error: '잘못된 투표 요청입니다.' })
    }
    const player = ch.gameState.players.find((p) => p.id === playerId)
    if (player && (player.status === 'eliminated' || player.isAlive === false)) {
      return res.status(403).json({ success: false, error: '이미 탈락한 참가자는 투표할 수 없습니다.' })
    }
    ch.gameState.votes[playerId] = choice
    scheduleThrottledVoteBroadcast(ch.id)
    res.json({ success: true, channelId: ch.id })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
}
app.post('/api/vote', handleHttpVote)
app.post('/api/game/vote', handleHttpVote)

const handleHttpJoin = (req, res) => {
  try {
    const chId = getReqChannelId(req)
    const ch = getChannel(chId)
    const nickname = (req.body?.nickname || '').trim()
    const requestedId = req.body?.id
    if (!nickname) {
      return res.status(400).json({ success: false, error: '닉네임을 입력해주세요.' })
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
      console.log(`👤 [CH ${ch.id} HTTP JOIN] ${nickname} (ID: ${player.id}) - 현재 총 ${ch.gameState.players.length}명`)
    } else {
      if (requestedId) player.id = requestedId
      player.nickname = nickname
      if (isLobby) {
        player.status = 'alive'
        player.isAlive = true
      }
      console.log(`🔄 [CH ${ch.id} HTTP RE-JOIN] ${nickname} (ID: ${player.id}) - 현재 총 ${ch.gameState.players.length}명`)
    }
    broadcastState(ch.id)
    broadcastPlayerJoined(player, ch.id)
    res.json({ success: true, player, players: ch.gameState.players, channelId: ch.id })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
}
app.post('/api/join', handleHttpJoin)
app.post('/api/game/join', handleHttpJoin)

const handleHttpLeave = (req, res) => {
  try {
    const chId = getReqChannelId(req)
    const ch = getChannel(chId)
    const { id } = req.body || {}
    if (id) {
      const found = ch.gameState.players.find((p) => p.id === id)
      ch.gameState.players = ch.gameState.players.filter((p) => p.id !== id)
      if (ch.gameState.votes && ch.gameState.votes[id]) {
        delete ch.gameState.votes[id]
      }
      broadcastState(ch.id)
      const room = getChannelRoom(ch.id)
      io.to(room).emit('player:left', { id, channelId: ch.id })
      io.to(room).emit('players:update', ch.gameState.players)
      if (ch.id === '1') {
        io.to(SOCKET_ROOM_MAIN).emit('player:left', { id, channelId: ch.id })
        io.to(SOCKET_ROOM_MAIN).emit('players:update', ch.gameState.players)
      }
      console.log(`🚪 [CH ${ch.id} HTTP LEAVE] ${found?.nickname || id} 퇴장`)
    }
    res.json({ success: true, channelId: ch.id })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
}
app.post('/api/leave', handleHttpLeave)
app.post('/api/game/leave', handleHttpLeave)

app.post('/api/game/reset', (req, res) => {
  try {
    const chId = getReqChannelId(req)
    const ch = getChannel(chId)
    const { keepPlayers } = req.body || {}
    clearAllTimers(ch.id)
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
    io.to(room).emit('sync', ch.gameState)
    io.to(room).emit('game:sync', ch.gameState)
    io.to(room).emit('players:update', { channelId: ch.id, players: ch.gameState.players })
    io.to(room).emit('game:force_lobby', { channelId: ch.id })
    io.to(room).emit('game:set_reset', { channelId: ch.id })
    if (ch.id === '1') {
      io.to(SOCKET_ROOM_MAIN).emit('sync', ch.gameState)
      io.to(SOCKET_ROOM_MAIN).emit('game:sync', ch.gameState)
      io.to(SOCKET_ROOM_MAIN).emit('players:update', { channelId: ch.id, players: ch.gameState.players })
      io.to(SOCKET_ROOM_MAIN).emit('game:force_lobby', { channelId: ch.id })
      io.to(SOCKET_ROOM_MAIN).emit('game:set_reset', { channelId: ch.id })
    }
    res.json({ success: true, channelId: ch.id })
  } catch (e) {
    res.status(500).json({ success: false, error: e.message })
  }
})

// 6. SPA 라우팅 폴백 (Express 5 path-to-regexp 완벽 호환)
app.use((req, res, next) => {
  if (req.method !== 'GET') return next()
  const indexHtml = path.join(clientDistPath, 'index.html')
  if (fs.existsSync(indexHtml)) {
    res.sendFile(indexHtml)
  } else {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Your Choice Game Server</title></head>
        <body style="background:#0b1426;color:#e2c974;font-family:sans-serif;padding:40px;text-align:center;">
          <h1>당신의 선택 (The Last Two) 게임 서버</h1>
          <p>서버가 포트 ${port}에서 정상 실행 중입니다.</p>
          <p>프론트엔드 빌드(npm run build) 후 새로고침하세요.</p>
        </body>
      </html>
    `)
  }
})

// 7. 터널 및 포트 리스닝
function startLocalTunnel() {
  if (isProduction || sshProcess || isReconnectingTunnel) return
  isReconnectingTunnel = true

  console.log(`🌐 [AUTO TUNNEL] 스마트폰 외부 접속 터널을 연결합니다...`)
  try {
    sshProcess = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-R', `80:localhost:${port}`,
      'nokey@localhost.run'
    ])

    sshProcess.stdout.on('data', (data) => {
      const output = data.toString()
      const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.lhr\.life/)
      if (match && match[0]) {
        const detectedUrl = match[0]
        if (detectedUrl !== publicTunnelUrl) {
          publicTunnelUrl = detectedUrl
          for (const ch of channels.values()) {
            ch.gameState.serverHostUrl = publicTunnelUrl
          }
          console.log(`✨ [TUNNEL SUCCESS] 외부 접속 주소 발급: ${publicTunnelUrl}`)
          io.emit('server:tunnel_updated', publicTunnelUrl)
        }
      }
    })

    sshProcess.stderr.on('data', (data) => {
      const output = data.toString()
      const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.lhr\.life/)
      if (match && match[0]) {
        const detectedUrl = match[0]
        if (detectedUrl !== publicTunnelUrl) {
          publicTunnelUrl = detectedUrl
          for (const ch of channels.values()) {
            ch.gameState.serverHostUrl = publicTunnelUrl
          }
          console.log(`✨ [TUNNEL SUCCESS] 외부 접속 주소 발급: ${publicTunnelUrl}`)
          io.emit('server:tunnel_updated', publicTunnelUrl)
        }
      }
    })

    sshProcess.on('close', () => {
      sshProcess = null
      isReconnectingTunnel = false
      setTimeout(() => {
        if (!sshProcess) startLocalTunnel()
      }, 5000)
    })

    sshProcess.on('error', () => {
      sshProcess = null
      isReconnectingTunnel = false
    })
  } catch (err) {
    sshProcess = null
    isReconnectingTunnel = false
  }
}

httpServer.listen(port, '0.0.0.0', () => {
  const localIp = getLocalNetworkIp()
  console.log('====================================================')
  console.log(`🎮 [YOUR CHOICE] 서바이벌 퀴즈 5개 채널 서버 가동 완료`)
  console.log(`📡 포트: ${port}`)
  console.log(`📶 사내 Wi-Fi: http://${localIp}:${port}`)
  if (publicTunnelUrl) {
    console.log(`🌍 외부 URL: ${publicTunnelUrl}`)
  }
  console.log(`📺 채널: 1채널 ~ 5채널 완전 독립 운영 지원`)
  console.log('====================================================')

  if (!isProduction && !publicTunnelUrl) {
    startLocalTunnel()
  }
})
