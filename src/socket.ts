import { io } from 'socket.io-client'

const SERVER_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5000'

export const socket = io(SERVER_URL, {
  autoConnect: true,
  transports: ['polling', 'websocket'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 2000,
  timeout: 20000,
})

export function isSocketConnected(): boolean {
  return Boolean(socket && socket.connected)
}
