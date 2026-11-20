import { io } from 'socket.io-client'

// 3번 서바이벌 퀴즈 동일 설정: VITE_SERVER_URL 또는 브라우저 origin 단일 포트 연결
const SERVER_URL =
  (import.meta as any).env?.VITE_SERVER_URL ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5000')

export const socket = io(SERVER_URL, {
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
