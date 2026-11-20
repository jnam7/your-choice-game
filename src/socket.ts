import { io } from 'socket.io-client'

const SERVER_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5000'

export const socket = io(SERVER_URL, {
  autoConnect: true,
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
  timeout: 30000,
})
