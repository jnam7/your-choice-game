import React, { Component, ErrorInfo, ReactNode } from 'react'
import { safeStorage } from '../utils/safeStorage'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[React ErrorBoundary caught error]:', error, errorInfo)
  }

  private handleReset = () => {
    try {
      safeStorage.removeItem('lasttwo_player_id')
      safeStorage.removeItem('lasttwo_player_nickname')
      safeStorage.removeItem('your_choice_game_state')
      safeStorage.removeItem('lasttwo_game_state_v2')
      if (typeof window !== 'undefined') {
        if (window.sessionStorage) window.sessionStorage.clear()
        window.location.href = '/'
      }
    } catch (e) {
      if (typeof window !== 'undefined') {
        window.location.reload()
      }
    }
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6 text-center select-none">
          <div className="w-full max-w-sm bg-slate-900 border border-gold/40 rounded-3xl p-6 shadow-2xl">
            <div className="text-5xl mb-3">⚠️</div>
            <h1 className="font-display text-xl text-gold font-bold mb-2">
              화면을 불러오지 못했습니다
            </h1>
            <p className="text-gray-300 text-xs mb-6 leading-relaxed">
              모바일 접속 중 일시적인 화면 렌더링 오류가 발생했습니다.<br />
              아래 버튼을 눌러 새로고침 및 세션을 초기화해주세요.
            </p>

            <button
              onClick={this.handleReset}
              className="w-full py-3.5 px-4 bg-gradient-to-r from-gold-dark via-gold to-gold-light text-navy-dark font-display font-bold text-base rounded-xl shadow-lg active:scale-95 transition-transform"
            >
              🔄 새로고침 및 다시 접속하기
            </button>

            {this.state.error && (
              <details className="mt-4 text-left">
                <summary className="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300">
                  오류 세부 내용
                </summary>
                <pre className="mt-2 p-2 bg-black/60 rounded text-[9px] text-red-300 font-mono break-all overflow-x-auto max-h-32">
                  {this.state.error.toString()}
                </pre>
              </details>
            )}
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
