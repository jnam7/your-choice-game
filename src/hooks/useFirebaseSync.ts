import { useEffect, useRef } from 'react'
import { useGameStore } from '../store/gameStore'
import { socket } from '../socket'
import { listenFirebaseGame } from '../firebase'
import type { Player } from '../types/game'

export function useFirebaseSync() {
  const store = useGameStore()
  const { syncWithServer, setServerHostUrl } = store
  const lastSyncHashRef = useRef<string>('')

  useEffect(() => {
    // ===== 1. Firebase Realtime Database 실시간 직결 리스너 =====
    const unsubscribeFirebase = listenFirebaseGame({
      onState: (serverState) => {
        if (!serverState) return

        let calculatedTimeLeft = serverState.timeLeft
        if (serverState.phase === 'voting' && serverState.votingDeadline) {
          const remainingSec = Math.max(0, Math.ceil((serverState.votingDeadline - Date.now()) / 1000))
          calculatedTimeLeft = remainingSec
        }

        const hash = `${serverState.phase}_${serverState.roundNumber}_${serverState.votingDeadline}_${Boolean(serverState.currentResult)}_${serverState.isPaused}_${serverState.currentQuestion?.id || ''}`
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
          ...(serverState.votes ? { votes: serverState.votes } : {}),
        })
      },
      onPlayers: (playersList: Player[]) => {
        if (!playersList) return
        // Firebase의 플레이어 목록으로 상태를 즉시 동기화
        syncWithServer({
          players: playersList,
        })
      },
      onVotes: (votesMap: Record<string, 'A' | 'B'>) => {
        if (!votesMap) return
        syncWithServer({
          votes: votesMap,
        })
      },
    })

    // ===== 2. 소켓 통신 보조 채널 (웹소켓 연결 시 실시간 이벤트 처리) =====
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

    socket.on('game:state_sync', handleStateSync)
    socket.on('state:sync', handleStateSync)
    socket.on('game:round_started', handleRoundStarted)
    socket.on('game:force_lobby', handleForceLobby)
    socket.on('game:set_reset', handleForceLobby)
    socket.on('server:tunnel_updated', handleTunnelUpdated)

    // ===== 3. HTTP 백업 폴링 (초기 1회 및 주기적 1.5초 안전장치) =====
    const fetchLatestState = async () => {
      try {
        let res = await fetch('/api/game/state')
        if (!res.ok) {
          res = await fetch('/api/state')
        }
        if (res.ok) {
          const data = await res.json()
          applyState(data)
        }
      } catch (e) {}
    }
    fetchLatestState()
    const pollInterval = setInterval(fetchLatestState, 1500)

    return () => {
      clearInterval(pollInterval)
      unsubscribeFirebase()
      socket.off('game:state_sync', handleStateSync)
      socket.off('state:sync', handleStateSync)
      socket.off('game:round_started', handleRoundStarted)
      socket.off('game:force_lobby', handleForceLobby)
      socket.off('game:set_reset', handleForceLobby)
      socket.off('server:tunnel_updated', handleTunnelUpdated)
    }
  }, [syncWithServer, setServerHostUrl])
}
