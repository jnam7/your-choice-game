import { io, Socket } from 'socket.io-client'

// 스마트폰이든 PC든 접속한 도메인 그대로(window.location.origin) 소켓 연결
const SERVER_URL =
  (import.meta as any).env?.VITE_SERVER_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4000')

export const socket: Socket = io(SERVER_URL, {
  autoConnect: true,
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
  timeout: 30000,
})

// 소켓 재연결(Reconnect) 시 채널 자동 재조인 보장 (화면 꺼짐, Wi-Fi 전환, 새로고침 대비)
if (typeof window !== 'undefined') {
  socket.on('connect', () => {
    try {
      const params = new URLSearchParams(window.location.search)
      const ch = params.get('channel') || params.get('ch') || params.get('room') || '1'
      const role = window.location.pathname.includes('/admin')
        ? 'admin'
        : (window.location.pathname.includes('/tv') ? 'tv' : 'player')
      socket.emit('join:channel', { channelId: ch, role })
      socket.emit('join:room', { roomId: `room:channel_${ch}` })
      if (ch === '1') {
        socket.emit('join:room', { roomId: 'room:survival_quiz_main' })
        socket.emit('join', 'room:survival_quiz_main')
      }
      console.log(`🔌 [SOCKET RECONNECTED] Re-joined channel ${ch} (${role})`)
    } catch (e) {}
  })
}

export function isSocketConnected(): boolean {
  return Boolean(socket && socket.connected)
}
