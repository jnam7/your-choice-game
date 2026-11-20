import { useEffect, useRef } from 'react'
import { useGameStore } from '../store/gameStore'
import { socket } from '../socket'

export function useFirebaseSync() {
  const store = useGameStore()
  const { syncWithServer, setServerHostUrl } = store
  const lastSyncHashRef = useRef<string>('')

  useEffect(() => {
    // 1. 소켓 연결 확인 (3번 서바이벌 퀴즈 규격)
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

      // 상태 변경 감지 해시
      const hash = `${serverState.phase}_${serverState.roundNumber}_${serverState.votingDeadline}_${Object.keys(serverState.votes || {}).length}_${serverState.players?.length}_${Boolean(serverState.currentResult)}`
      if (lastSyncHashRef.current === hash && serverState.phase !== 'voting') {
        return
      }
      lastSyncHashRef.current = hash

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
        players: serverState.players || [],
        votes: serverState.votes || {},
      })
    }

    // 2. 3번 서바이벌 퀴즈 규격 이벤트 리스너 (game:state_sync & state:sync)
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

    const handleTunnelUpdated = (newTunnelUrl: string) => {
      if (newTunnelUrl && newTunnelUrl.startsWith('http')) {
        setServerHostUrl(newTunnelUrl)
      }
    }

    // 3번 프로젝트의 핵심 이벤트 등록
    socket.on('game:state_sync', handleStateSync)
    socket.on('state:sync', handleStateSync)
    socket.on('game:round_started', handleRoundStarted)
    socket.on('game:force_lobby', handleForceLobby)
    socket.on('game:set_reset', handleForceLobby)
    socket.on('server:tunnel_updated', handleTunnelUpdated)

    // 3. HTTP Polling Fallback (초기 진입 즉시 1회 Fetch 및 백업)
    const fetchLatestState = async () => {
      try {
        const res = await fetch('/api/game/state')
        if (res.ok) {
          const data = await res.json()
          applyState(data)
        }
      } catch (e) {}
    }
    fetchLatestState()

    const pollInterval = setInterval(() => {
      if (!socket.connected) {
        fetchLatestState()
      }
    }, 1000)

    return () => {
      socket.off('game:state_sync', handleStateSync)
      socket.off('state:sync', handleStateSync)
      socket.off('game:round_started', handleRoundStarted)
      socket.off('game:force_lobby', handleForceLobby)
      socket.off('game:set_reset', handleForceLobby)
      socket.off('server:tunnel_updated', handleTunnelUpdated)
      clearInterval(pollInterval)
    }
  }, [syncWithServer, setServerHostUrl])
}
