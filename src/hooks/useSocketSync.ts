import { useEffect, useRef } from 'react'
import { useGameStore } from '../store/gameStore'
import { socket } from '../socket'
import type { Player } from '../types/game'

export function useSocketSync() {
  const store = useGameStore()
  const { syncWithServer, setServerHostUrl } = store
  const lastSyncHashRef = useRef<string>('')

  useEffect(() => {
    if (!socket.connected) {
      socket.connect()
    }

    const applyState = (serverState: any) => {
      if (!serverState) return

      let calculatedTimeLeft = serverState.timeLeft
      if (serverState.phase === 'voting' && serverState.votingDeadline) {
        const remainingSec = Math.max(0, Math.ceil((serverState.votingDeadline - Date.now()) / 1000))
        calculatedTimeLeft = remainingSec
      }

      const hash = `${serverState.phase}_${serverState.roundNumber}_${serverState.votingDeadline}_${Boolean(serverState.currentResult)}_${serverState.isPaused}_${serverState.currentQuestion?.id || ''}`
      if (lastSyncHashRef.current === hash && serverState.phase !== 'voting') {
        // 중복 동기화 방지
      } else {
        lastSyncHashRef.current = hash
      }

      const incomingPlayers: Player[] = Array.isArray(serverState.players)
        ? serverState.players.filter(Boolean)
        : (serverState.players && typeof serverState.players === 'object'
          ? (Object.values(serverState.players).filter(Boolean) as Player[])
          : (serverState.players === null ? [] : useGameStore.getState().players))

      const mySavedId = typeof window !== 'undefined' ? localStorage.getItem('lasttwo_player_id') : null
      const mySavedNick = typeof window !== 'undefined' ? localStorage.getItem('lasttwo_player_nickname') : null

      // 게임 진행 중(question 또는 voting)에만 튕김 방지용 자동 재등록 허용
      const isGamePlaying = serverState.phase === 'question' || serverState.phase === 'voting'
      if (isGamePlaying && mySavedId && mySavedNick) {
        const inServer = incomingPlayers.some((p) => p.id === mySavedId || p.nickname === mySavedNick)
        if (!inServer) {
          socket.emit('player:join', { id: mySavedId, nickname: mySavedNick })
          fetch('/api/game/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: mySavedId, nickname: mySavedNick }),
          }).catch(() => {})
        }
      }

      syncWithServer({
        phase: serverState.phase,
        roundNumber: serverState.roundNumber,
        ruleMode: serverState.ruleMode || 'majority',
        qrMode: serverState.qrMode || 'wifi',
        ...(serverState.serverHostUrl ? { serverHostUrl: serverState.serverHostUrl } : {}),
        currentQuestion: serverState.currentQuestion,
        currentResult: serverState.currentResult,
        isFinals: Boolean(serverState.isFinals),
        isGameOver: Boolean(serverState.isGameOver),
        soleWinnerId: serverState.soleWinnerId || null,
        isPaused: Boolean(serverState.isPaused),
        timeLimit: serverState.timeLimit || 15,
        votingDeadline: serverState.votingDeadline,
        timeLeft: calculatedTimeLeft,
        players: incomingPlayers,
        votes: serverState.votes || {},
      })
    }

    const handleStateSync = (serverState: any) => {
      applyState(serverState)
    }

    const handleRoundStarted = (data: any) => {
      if (data) {
        syncWithServer({
          phase: 'voting',
          roundNumber: data.roundNumber || 1,
          currentQuestion: data.question,
          timeLimit: data.timeLimit || 15,
          votingDeadline: data.votingDeadline,
          timeLeft: data.timeLimit || 15,
        })
      }
    }

    const handleForceLobby = () => {
      syncWithServer({
        phase: 'lobby',
        roundNumber: 0,
        currentQuestion: null,
        currentResult: null,
        votes: {},
      })
    }

    const handlePaused = (data: any) => {
      syncWithServer({
        isPaused: true,
        ...(typeof data?.timeLeft === 'number' ? { timeLeft: data.timeLeft } : {}),
      })
    }

    const handleResumed = (data: any) => {
      syncWithServer({
        isPaused: false,
        ...(typeof data?.timeLeft === 'number' ? { timeLeft: data.timeLeft } : {}),
        ...(data?.votingDeadline ? { votingDeadline: data.votingDeadline } : {}),
      })
    }

    const handleTunnelUpdated = (newTunnelUrl: string) => {
      if (newTunnelUrl && newTunnelUrl.startsWith('http')) {
        setServerHostUrl(newTunnelUrl)
      }
    }

    const handlePlayersUpdate = (data: any) => {
      if (!data) return
      let incomingList: Player[] = []
      if (Array.isArray(data)) {
        incomingList = data.filter(Boolean)
      } else if (Array.isArray(data.players)) {
        incomingList = data.players.filter(Boolean)
      } else if (data.player) {
        const current = useGameStore.getState().players
        const exists = current.some((p) => p.id === data.player.id)
        incomingList = exists
          ? current.map((p) => (p.id === data.player.id ? data.player : p))
          : [...current, data.player]
      }
      if (incomingList.length > 0 || Array.isArray(data) || Array.isArray(data.players)) {
        syncWithServer({ players: incomingList })
      }
    }

    const fetchLatestState = () => {
      fetch('/api/game/state')
        .then((res) => {
          if (!res.ok) throw new Error('State fetch failed')
          return res.json()
        })
        .then((data) => {
          if (data && data.phase) {
            applyState(data)
          }
        })
        .catch(() => {})
    }

    const handleConnect = () => {
      socket.emit('join:room', { roomId: 'room:survival_quiz_main' })
      socket.emit('join', 'room:survival_quiz_main')
      fetchLatestState()
    }

    const handleIncomingChatMessage = (rawMsg: any) => {
      if (!rawMsg) return
      const text = ((rawMsg.text || rawMsg.message || '') + '').trim()
      if (!text) return

      const formatted = {
        id: rawMsg.id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        playerId: rawMsg.playerId || 'participant',
        nickname: rawMsg.nickname || '참가자',
        message: text,
        text: text,
        timestamp: rawMsg.timestamp || Date.now(),
        isNotice: Boolean(rawMsg.isNotice),
        roomId: rawMsg.roomId || 'room:survival_quiz_main',
      }
      useGameStore.getState().addChatMessage(formatted)
    }

    socket.on('connect', handleConnect)
    socket.on('chat:message', handleIncomingChatMessage)
    socket.on('chat:received', handleIncomingChatMessage)
    socket.on('game:state_sync', handleStateSync)
    socket.on('state:sync', handleStateSync)
    socket.on('admin:sync', handleStateSync)
    socket.on('game:player_joined', handlePlayersUpdate)
    socket.on('player:joined', handlePlayersUpdate)
    socket.on('players:update', handlePlayersUpdate)
    socket.on('game:round_started', handleRoundStarted)
    socket.on('game:force_lobby', handleForceLobby)
    socket.on('game:set_reset', handleForceLobby)
    socket.on('game:paused', handlePaused)
    socket.on('game:resumed', handleResumed)
    socket.on('server:tunnel_updated', handleTunnelUpdated)

    // 마운트 시 즉시 최신 상태 가져오기
    fetchLatestState()

    // 소켓이 아직 연결되지 않았을 경우를 대비한 짧은 주기 폴링 백업
    const pollInterval = setInterval(() => {
      if (!socket.connected) {
        fetchLatestState()
      }
    }, 3000)

    return () => {
      clearInterval(pollInterval)
      socket.off('connect', handleConnect)
      socket.off('chat:message', handleIncomingChatMessage)
      socket.off('chat:received', handleIncomingChatMessage)
      socket.off('game:state_sync', handleStateSync)
      socket.off('state:sync', handleStateSync)
      socket.off('admin:sync', handleStateSync)
      socket.off('game:player_joined', handlePlayersUpdate)
      socket.off('player:joined', handlePlayersUpdate)
      socket.off('players:update', handlePlayersUpdate)
      socket.off('game:round_started', handleRoundStarted)
      socket.off('game:force_lobby', handleForceLobby)
      socket.off('game:set_reset', handleForceLobby)
      socket.off('game:paused', handlePaused)
      socket.off('game:resumed', handleResumed)
      socket.off('server:tunnel_updated', handleTunnelUpdated)
    }
  }, [syncWithServer, setServerHostUrl])
}
