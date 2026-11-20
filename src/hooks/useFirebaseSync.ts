import { useEffect } from 'react'
import { useGameStore } from '../store/gameStore'
import { socket } from '../socket'

export function useFirebaseSync() {
  const store = useGameStore()
  const { syncWithServer, setServerHostUrl } = store

  useEffect(() => {
    // 1. 소켓 연결 확인
    if (!socket.connected) {
      socket.connect()
    }

    // 2. 실시간 게임 상태 수신 (웹소켓 브로드캐스트)
    const handleStateSync = (serverState: any) => {
      if (serverState) {
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
    }

    // 3. 외부 터널 URL 실시간 갱신 수신
    const handleTunnelUpdated = (newTunnelUrl: string) => {
      if (newTunnelUrl && newTunnelUrl.startsWith('http')) {
        setServerHostUrl(newTunnelUrl)
      }
    }

    socket.on('state:sync', handleStateSync)
    socket.on('server:tunnel_updated', handleTunnelUpdated)

    return () => {
      socket.off('state:sync', handleStateSync)
      socket.off('server:tunnel_updated', handleTunnelUpdated)
    }
  }, [syncWithServer, setServerHostUrl])
}
