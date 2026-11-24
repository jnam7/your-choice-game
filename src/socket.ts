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

export function isSocketConnected(): boolean {
  return Boolean(socket && socket.connected)
}
