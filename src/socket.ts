// Socket.io 완전 비활성화 및 더미(Mock) 소켓 객체
// Render 정적 호스팅 환경에서는 Socket.io 백엔드 서버가 없으며,
// 모든 실시간 통신은 Firebase Realtime Database 및 BroadcastChannel을 통해 수행됩니다.
// WebSocket 연결 시도(wss://.../socket.io/...)로 인한 지속적인 콘솔 에러를 100% 차단합니다.

class MockSocket {
  public id = 'mock-socket-id'
  public connected = false
  public disconnected = true
  private listeners: Record<string, Function[]> = {}

  public connect(): this {
    return this
  }

  public disconnect(): this {
    return this
  }

  public close(): this {
    return this
  }

  public on(event: string, callback: (...args: any[]) => void): this {
    if (!this.listeners[event]) {
      this.listeners[event] = []
    }
    this.listeners[event].push(callback)
    return this
  }

  public once(event: string, callback: (...args: any[]) => void): this {
    const onceWrapper = (...args: any[]) => {
      this.off(event, onceWrapper)
      callback(...args)
    }
    return this.on(event, onceWrapper)
  }

  public off(event: string, callback?: (...args: any[]) => void): this {
    if (!this.listeners[event]) return this
    if (callback) {
      this.listeners[event] = this.listeners[event].filter((cb) => cb !== callback)
    } else {
      delete this.listeners[event]
    }
    return this
  }

  public emit(event: string, ...args: any[]): this {
    // 콜백 함수가 마지막 인자로 전달된 경우 안전하게 성공 응답 호출
    const lastArg = args[args.length - 1]
    if (typeof lastArg === 'function') {
      try {
        lastArg({ success: true })
      } catch (e) { }
    }
    return this
  }

  public removeListener(event: string, callback: (...args: any[]) => void): this {
    return this.off(event, callback)
  }

  public removeAllListeners(event?: string): this {
    if (event) {
      delete this.listeners[event]
    } else {
      this.listeners = {}
    }
    return this
  }
}

export const socket: any = new MockSocket()

export function isSocketConnected(): boolean {
  return false
}

