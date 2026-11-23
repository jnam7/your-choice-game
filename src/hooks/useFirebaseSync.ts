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
        if (!playersList || playersList.length === 0) return
        const currentPlayers = useGameStore.getState().players
        const map = new Map<string, Player>()
        for (const p of currentPlayers) map.set(p.id, p)
        for (const p of playersList) map.set(p.id, p)
        syncWithServer({
          players: Array.from(map.values()),
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

      const incomingPlayers: Player[] = Array.isArray(serverState.players) ? serverState.players : []
      const cur = useGameStore.getState().players
      const map = new Map<string, Player>()
      for (const p of cur) map.set(p.id, p)
      for (const p of incomingPlayers) map.set(p.id, p)
      const resolvedPlayers = incomingPlayers.length > 0 ? Array.from(map.values()) : (cur.length > 0 ? cur : [])

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
        players: resolvedPlayers,
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

    const handleConnect = () => {
      fetchLatestState()
    }

    const handlePlayersUpdate = (data: any) => {
      if (!data) return
      let incomingList: Player[] = []
      if (Array.isArray(data)) {
        incomingList = data
      } else if (data.players && Array.isArray(data.players)) {
        incomingList = data.players
      } else if (data.player) {
        incomingList = [data.player]
      }

      if (incomingList.length > 0) {
        const cur = useGameStore.getState().players
        const map = new Map<string, Player>()
        for (const p of cur) map.set(p.id, p)
        for (const p of incomingList) map.set(p.id, p)
        syncWithServer({ players: Array.from(map.values()) })
      }
    }

    socket.on('connect', handleConnect)
    socket.on('game:state_sync', handleStateSync)
    socket.on('state:sync', handleStateSync)
    socket.on('game:player_joined', handlePlayersUpdate)
    socket.on('player:joined', handlePlayersUpdate)
    socket.on('players:update', handlePlayersUpdate)
    socket.on('game:round_started', handleRoundStarted)
    socket.on('game:force_lobby', handleForceLobby)
    socket.on('game:set_reset', handleForceLobby)
    socket.on('server:tunnel_updated', handleTunnelUpdated)

    // ===== 3. HTTP 백업 폴링 (초기 1회 및 주기적 1초 안전장치 + 모바일 화면 복귀 시 즉시 동기화) =====
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
    const pollInterval = setInterval(fetchLatestState, 1000)

    // 모바일 기기 화면 켜짐/포커스/탭 복귀 시 즉각 최신 상태 동기화
    const handleWakeup = () => {
      if (!socket.connected) {
        socket.connect()
      }
      fetchLatestState()
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleWakeup)
      window.addEventListener('pageshow', handleWakeup)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          handleWakeup()
        }
      })
    }

    return () => {
      clearInterval(pollInterval)
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleWakeup)
        window.removeEventListener('pageshow', handleWakeup)
      }
      unsubscribeFirebase()
      socket.off('connect', handleConnect)
      socket.off('game:state_sync', handleStateSync)
      socket.off('state:sync', handleStateSync)
      socket.off('game:player_joined', handlePlayersUpdate)
      socket.off('player:joined', handlePlayersUpdate)
      socket.off('players:update', handlePlayersUpdate)
      socket.off('game:round_started', handleRoundStarted)
      socket.off('game:force_lobby', handleForceLobby)
      socket.off('game:set_reset', handleForceLobby)
      socket.off('server:tunnel_updated', handleTunnelUpdated)
    }
  }, [syncWithServer, setServerHostUrl])
}
