import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'

interface Player {
  id: string
  nickname: string
  status: 'alive' | 'eliminated'
  joinedAt: number
}

interface ServerGameState {
  phase: string
  roundNumber: number
  currentQuestion: any
  currentResult: any
  isFinals: boolean
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

    // 1. 전체 상태 조회
    if (req.method === 'GET' && url === '/api/state') {
      sendJson(res, 200, gameState)
      return
    }

    // 2. 참가자 참가 (join)
    if (req.method === 'POST' && url === '/api/join') {
      const body = await parseJsonBody(req)
      const nickname = (body.nickname || '').trim()
      const requestedId = body.id

      if (!nickname) {
        sendJson(res, 400, { success: false, error: '닉네임을 입력해주세요.' })
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
      }

      sendJson(res, 200, { success: true, player })
      return
    }

    // 3. 투표 제출 (vote)
    if (req.method === 'POST' && url === '/api/vote') {
      const body = await parseJsonBody(req)
      const { playerId, choice } = body

      if (playerId && (choice === 'A' || choice === 'B')) {
        gameState.votes[playerId] = choice
      }

      sendJson(res, 200, { success: true, votes: gameState.votes })
      return
    }

    // 4. 관리자 상태 동기화 (admin sync)
    if (req.method === 'POST' && url === '/api/admin/sync') {
      const body = await parseJsonBody(req)
      if (body && typeof body === 'object') {
        // 관리자가 전송한 필드 업데이트
        if (body.phase !== undefined) gameState.phase = body.phase
        if (body.roundNumber !== undefined) gameState.roundNumber = body.roundNumber
        if (body.currentQuestion !== undefined) gameState.currentQuestion = body.currentQuestion
        if (body.currentResult !== undefined) gameState.currentResult = body.currentResult
        if (body.isFinals !== undefined) gameState.isFinals = body.isFinals
        if (body.isPaused !== undefined) gameState.isPaused = body.isPaused
        if (body.timeLimit !== undefined) gameState.timeLimit = body.timeLimit
        if (body.votingDeadline !== undefined) gameState.votingDeadline = body.votingDeadline
        if (body.timeLeft !== undefined) gameState.timeLeft = body.timeLeft
        if (body.players !== undefined && Array.isArray(body.players)) gameState.players = body.players
        if (body.votes !== undefined && typeof body.votes === 'object') gameState.votes = body.votes
      }

      sendJson(res, 200, { success: true, state: gameState })
      return
    }

    // 5. 채팅 메시지 전송
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
        sendJson(res, 200, { success: true, message: msg })
        return
      }
      sendJson(res, 400, { success: false, error: '메시지를 입력해주세요.' })
      return
    }

    next()
  }

  return {
    name: 'game-sync-plugin',
    configureServer(server) {
      server.middlewares.use(handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
  }
}
