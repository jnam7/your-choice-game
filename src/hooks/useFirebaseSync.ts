import { useEffect, useRef } from 'react'
import { useGameStore } from '../store/gameStore'
import { socket } from '../socket'

export function useFirebaseSync() {
  const store = useGameStore()
  const { syncWithServer, setServerHostUrl } = store
  const lastSyncHashRef = useRef<string>('')

  useEffect(() => {
    // 1. 소켓 연결 확인
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
        // 이미 반영된 동일 상태면 재처리 생략 (voting 카운트다운 제외)
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

    // 2. 실시간 웹소켓 이벤트 수신
    const handleStateSync = (serverState: any) => {
      applyState(serverState)
    }

    // 3. 외부 터널 URL 실시간 갱신 수신
    const handleTunnelUpdated = (newTunnelUrl: string) => {
      if (newTunnelUrl && newTunnelUrl.startsWith('http')) {
        setServerHostUrl(newTunnelUrl)
      }
    }

    socket.on('state:sync', handleStateSync)
    socket.on('server:tunnel_updated', handleTunnelUpdated)

    // 4. HTTP Polling Fallback (웹소켓 연결 지연이나 모바일 프록시 차단 방어)
    const fetchLatestState = async () => {
      try {
        const res = await fetch('/api/game/state')
        if (res.ok) {
          const data = await res.json()
          applyState(data)
        }
      } catch (e) {
        // 네트워크 일시 오류 무시
      }
    }

    // 마운트 시 즉시 1회 fetch로 초기 상태 즉각 동기화
    fetchLatestState()

    // 1초 주기로 백업 폴링 (소켓 미연결 시 즉시 상태 복구)
    const pollInterval = setInterval(() => {
      if (!socket.connected) {
        fetchLatestState()
      }
    }, 1000)

    return () => {
      socket.off('state:sync', handleStateSync)
      socket.off('server:tunnel_updated', handleTunnelUpdated)
      clearInterval(pollInterval)
    }
  }, [syncWithServer, setServerHostUrl])
}
