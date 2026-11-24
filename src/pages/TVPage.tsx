import { useEffect, useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { QRCodeSVG } from 'qrcode.react'
import { socket } from '../socket'
import { useGameStore } from '../store/gameStore'
import { useCountdown } from '../hooks/useCountdown'
import { useSocketSync } from '../hooks/useSocketSync'
import type { Player } from '../types/game'
import {
  unlockAudioContext,
  isSoundMuted,
  toggleSoundMute,
  playCountdownTick,
  playDrumRoll,
  playResultReveal,
  playGameoverFanfare,
  stopAllSounds,
} from '../utils/sound'

// ===== 관리자 페이지 이동 톱니바퀴 버튼 =====
function AdminGearButton() {
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    window.open('/admin', '_blank', 'noopener,noreferrer')
  }

  return (
    <a
      href="/admin"
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      className="p-2.5 bg-navy-dark/70 hover:bg-gold hover:text-navy-dark border border-gold/30 hover:border-gold rounded-xl text-gold/80 hover:text-navy-dark transition-all duration-300 shadow-xl backdrop-blur group opacity-60 hover:opacity-100 flex items-center justify-center cursor-pointer"
      title="관리자 설정 페이지(/admin)를 새 탭에서 열기"
    >
      <svg
        className="w-5 h-5 transition-transform duration-500 group-hover:rotate-90"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
        />
      </svg>
    </a>
  )
}

// ===== 전체화면 전환 토글 버튼 =====
function FullscreenButton() {
  const [isFullscreen, setIsFullscreen] = useState(false)

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => { })
      setIsFullscreen(true)
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => { })
        setIsFullscreen(false)
      }
    }
  }

  useEffect(() => {
    const handler = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  return (
    <button
      onClick={toggleFullscreen}
      className="p-2.5 bg-navy-dark/70 hover:bg-gold hover:text-navy-dark border border-gold/30 hover:border-gold rounded-xl text-gold/80 hover:text-navy-dark transition-all duration-300 shadow-xl backdrop-blur group opacity-50 hover:opacity-100"
      title="대형 스크린 전체 화면 토글 (F11)"
    >
      {isFullscreen ? (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      ) : (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
        </svg>
      )}
    </button>
  )
}

// ===== TV 헤더 로고 =====
function TVHeader({ roundNumber, category, isFinals, customRuleMode }: { roundNumber?: number; category?: string; isFinals?: boolean; customRuleMode?: 'majority' | 'minority' }) {
  const storeRuleMode = useGameStore((s) => s.ruleMode)
  const currentMode = customRuleMode || storeRuleMode || 'majority'
  const players = useGameStore((s) => s.players)
  const playerList: Player[] = Array.isArray(players) ? players.filter(Boolean) : (players && typeof players === 'object' ? (Object.values(players).filter(Boolean) as Player[]) : [])

  return (
    <header className="relative flex justify-between items-center w-full px-8 py-4 border-b border-gold/15 bg-navy-dark/40 backdrop-blur z-20">
      <div className="flex items-center gap-4">
        <h1 className="font-display text-2xl md:text-3xl text-gold text-shadow-glow">
          당신의 선택
        </h1>
        <span className="font-display text-sm md:text-base text-gold-light tracking-[0.3em] opacity-80">
          YOUR CHOICE
        </span>
      </div>

      {/* 룰 모드 뱃지: 화면 상단 중앙 정렬 */}
      <div className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 hidden sm:flex items-center">
        <div className={`px-5 py-1.5 rounded-full border text-xs md:text-sm font-bold flex items-center gap-2 shadow-xl backdrop-blur ${currentMode === 'minority'
            ? 'bg-purple-950/80 border-purple-400 text-purple-200 shadow-purple-900/50'
            : 'bg-gold/15 border-gold/50 text-gold shadow-gold/25'
          }`}>
          <span className="text-sm">{currentMode === 'minority' ? '🎯 소수의 선택' : '👥 다수의 선택'}</span>
          <span className="opacity-80 text-xs hidden md:inline">
            ({currentMode === 'minority' ? '더 적은 사람이 선택한 쪽 생존' : '더 많은 사람이 선택한 쪽 생존'})
          </span>
        </div>
      </div>

      {/* 우측 상단 인라인 Flex 컨테이너: [ROUND 표시] ➔ [접속자 수] ➔ [관리자 톱니바퀴] ➔ [전체화면 버튼] */}
      <div className="flex flex-row items-center gap-3">
        {isFinals && (
          <span className="px-3 py-1 bg-orange-600/30 border border-orange-500 rounded-full text-orange-400 font-bold text-xs animate-pulse">
            ⚡ FINALS
          </span>
        )}
        {roundNumber !== undefined && roundNumber > 0 && (
          <div className="flex items-center gap-2">
            <span className="font-display text-xl md:text-2xl text-gold font-bold">
              ROUND {roundNumber}
            </span>
            {category && (
              <span className="px-3 py-1 bg-navy-dark border border-gold/30 rounded-full text-gold-light text-xs font-bold">
                {category}
              </span>
            )}
          </div>
        )}

        {/* 접속자 수 배지 */}
        <div className="px-3 py-1.5 bg-navy-dark/80 border border-gold/30 rounded-xl text-xs font-bold text-gold flex items-center gap-1.5 shadow-xl backdrop-blur">
          <span>👥 접속</span>
          <span className="font-mono text-white">{playerList.length}명</span>
        </div>

        {/* 관리자 페이지 바로가기 톱니바퀴 버튼 */}
        <AdminGearButton />

        {/* 전체화면 버튼 */}
        <FullscreenButton />
      </div>
    </header>
  )
}

// ===== 1. TV 로비 (QR & 접속자 카운트) =====
function TVLobby() {
  const players = useGameStore((s) => s.players)
  const playerList: Player[] = Array.isArray(players) ? players.filter(Boolean) : (players && typeof players === 'object' ? (Object.values(players).filter(Boolean) as Player[]) : [])
  const serverHostUrl = useGameStore((s) => s.serverHostUrl)
  const setServerHostUrl = useGameStore((s) => s.setServerHostUrl)
  const qrMode = useGameStore((s) => s.qrMode)
  const setQrMode = useGameStore((s) => s.setQrMode)

  const [tunnelUrl, setTunnelUrl] = useState('')
  const [localIp, setLocalIp] = useState('192.168.40.111')

  // TV 로비 참가자 실시간 카운트/목록 이벤트 직결 수신
  useEffect(() => {
    const handlePlayersUpdate = (data: any) => {
      if (!data) return
      let list: any[] = []
      if (Array.isArray(data)) list = data
      else if (data.players && Array.isArray(data.players)) list = data.players
      else if (data.player) list = [data.player]

      if (list.length > 0) {
        const cur = useGameStore.getState().players
        const map = new Map<string, any>()
        for (const p of cur) map.set(p.id, p)
        for (const p of list) map.set(p.id, p)
        useGameStore.getState().syncWithServer({ players: Array.from(map.values()) })
      }
    }

    const handleQrModeChanged = (data: any) => {
      if (data?.mode) {
        setQrMode(data.mode === 'EXTERNAL' || data.mode === 'tunnel' ? 'tunnel' : 'wifi')
      }
    }

    socket.on('game:player_joined', handlePlayersUpdate)
    socket.on('player:joined', handlePlayersUpdate)
    socket.on('players:update', handlePlayersUpdate)
    socket.on('game:qr_mode_changed', handleQrModeChanged)

    return () => {
      socket.off('game:player_joined', handlePlayersUpdate)
      socket.off('player:joined', handlePlayersUpdate)
      socket.off('players:update', handlePlayersUpdate)
      socket.off('game:qr_mode_changed', handleQrModeChanged)
    }
  }, [setQrMode])

  const originUrl = typeof window !== 'undefined' ? `${window.location.origin}/` : 'http://localhost:5000/'
  const hostname = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1'
  const isPrivateIp = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(hostname)
  const isPublicDomain = !isLocalhost && !isPrivateIp

  // 1. Wi-Fi 접속 URL: 로컬 사설망 IP 기반 (절대 외부 URL과 혼용되지 않음)
  const wifiUrl = !isLocalhost
    ? `${window.location.protocol}//${hostname}${window.location.port ? `:${window.location.port}` : ':5000'}/`
    : `http://${localIp || '192.168.40.111'}:5000/`

  // 2. LTE / 5G 어디서나 접속 URL:
  const isExternalUrl = (url: string) =>
    Boolean(
      url &&
      url.startsWith('http') &&
      !url.includes('localhost') &&
      !url.includes('127.0.0.1') &&
      !/192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\./.test(url)
    )

  const publicLteUrl = isExternalUrl(tunnelUrl)
    ? (tunnelUrl.endsWith('/') ? tunnelUrl : `${tunnelUrl}/`)
    : (isPublicDomain
      ? originUrl
      : (isExternalUrl(serverHostUrl)
        ? (serverHostUrl.endsWith('/') ? serverHostUrl : `${serverHostUrl}/`)
        : ''))

  useEffect(() => {
    if (typeof window === 'undefined') return
    fetch('/api/server-info')
      .then((res) => (res.ok ? res.json() : null))
      .then((info) => {
        if (info?.localIp) setLocalIp(info.localIp)
        if (info?.publicUrl && isExternalUrl(info.publicUrl)) {
          setTunnelUrl(info.publicUrl)
        }
      })
      .catch(() => { })

    const handleTunnelUpdated = (newUrl: string) => {
      if (newUrl && isExternalUrl(newUrl)) {
        setTunnelUrl(newUrl)
      }
    }
    socket.on('server:tunnel_updated', handleTunnelUpdated)
    return () => {
      socket.off('server:tunnel_updated', handleTunnelUpdated)
    }
  }, [])

  // 활성 탭: 'wifi' 또는 'tunnel' (관리자 화면과 양방향 실시간 동기화)
  const activeTab: 'wifi' | 'tunnel' = qrMode === 'tunnel' ? 'tunnel' : 'wifi'

  const handleSelectTab = (tab: 'wifi' | 'tunnel') => {
    setQrMode(tab)
    socket.emit('admin:change_qr_mode', { mode: tab === 'tunnel' ? 'EXTERNAL' : 'WIFI' })
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 md:p-8 relative">
      <div className="particles-bg" />

      {/* 대형 로고 */}
      <motion.div
        initial={{ opacity: 0, y: -40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 1, type: 'spring' }}
        className="text-center mb-6"
      >
        <h1 className="font-display text-5xl md:text-7xl lg:text-8xl text-gold text-shadow-glow tracking-tight">
          당신의 선택
        </h1>
        <p className="font-display text-xl md:text-3xl text-gold-light tracking-[0.35em] mt-2">
          YOUR CHOICE - THE LAST TWO
        </p>
        <p className="text-gray-300 text-sm md:text-base mt-2 font-medium">
          스마트폰 카메라로 화면의 QR 코드를 스캔하여 게임에 참가하세요!
        </p>
      </motion.div>

      {/* 접속 방식 선택 탭 버튼 (오직 1개의 QR만 중앙에 표시) */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="mb-6 flex items-center justify-center gap-3 p-1.5 bg-navy-dark/90 border border-gold/30 rounded-2xl shadow-xl backdrop-blur max-w-lg w-full"
      >
        <button
          onClick={() => handleSelectTab('wifi')}
          className={`flex-1 py-3 px-5 rounded-xl font-bold text-sm md:text-base flex items-center justify-center gap-2 transition-all duration-300 ${activeTab === 'wifi'
              ? 'bg-gradient-to-r from-emerald-600 to-emerald-400 text-white shadow-lg shadow-emerald-500/30 scale-102 font-extrabold'
              : 'text-gray-300 hover:text-white hover:bg-white/5'
            }`}
        >
          <span>📶 같은 Wi-Fi 접속</span>
        </button>

        <button
          onClick={() => handleSelectTab('tunnel')}
          className={`flex-1 py-3 px-5 rounded-xl font-bold text-sm md:text-base flex items-center justify-center gap-2 transition-all duration-300 ${activeTab === 'tunnel'
              ? 'bg-gradient-to-r from-gold-dark via-gold to-gold-light text-navy-dark shadow-lg shadow-gold/30 scale-102 font-extrabold'
              : 'text-gray-300 hover:text-white hover:bg-white/5'
            }`}
        >
          <span>🌍 어디서나(LTE/5G)</span>
          {publicLteUrl ? (
            <span className="flex h-2.5 w-2.5 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500"></span>
            </span>
          ) : (
            <span className="text-[11px] text-yellow-300 font-normal bg-yellow-900/60 px-2 py-0.5 rounded-full border border-yellow-500/40">
              대기중
            </span>
          )}
        </button>
      </motion.div>

      {/* 화면 중앙 단 1개의 대형 QR 코드 카드 */}
      <motion.div
        key={activeTab}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.25 }}
        className={`glass-card p-6 md:p-8 border-2 shadow-2xl flex flex-col items-center max-w-md w-full ${activeTab === 'wifi' ? 'border-emerald-500/40' : 'border-gold/40'
          }`}
      >
        {/* 상단 접속 모드 안내 배지 */}
        <div className="mb-4 px-4 py-1.5 rounded-full bg-navy-dark border text-xs md:text-sm font-bold flex items-center gap-2 shadow-inner">
          {activeTab === 'wifi' ? (
            <>
              <span className="text-emerald-400">📶 사내 Wi-Fi 연결</span>
              <span className="text-gray-400 font-normal hidden sm:inline">| 같은 공유기 연결 필요 (초고속 권장)</span>
            </>
          ) : publicLteUrl ? (
            <>
              <span className="text-gold">🌍 LTE / 5G 외부 접속</span>
              <span className="text-gray-400 font-normal hidden sm:inline">| 모바일 데이터로 어디서나 스캔 가능</span>
            </>
          ) : (
            <>
              <span className="text-yellow-400 animate-pulse">⚠️ 외부 터널 연결 대기 중</span>
              <span className="text-gray-400 font-normal hidden sm:inline">| Wi-Fi 탭 이용 권장</span>
            </>
          )}
        </div>

        {/* QR 코드 본체 (260px 대형 1개) */}
        {activeTab === 'wifi' ? (
          <div className="bg-white p-5 rounded-3xl shadow-2xl">
            <QRCodeSVG
              value={wifiUrl}
              size={260}
              bgColor="#ffffff"
              fgColor="#0B1426"
              level="H"
            />
          </div>
        ) : publicLteUrl ? (
          <div className="bg-white p-5 rounded-3xl shadow-2xl">
            <QRCodeSVG
              value={publicLteUrl}
              size={260}
              bgColor="#ffffff"
              fgColor="#0B1426"
              level="H"
            />
          </div>
        ) : (
          <div className="bg-navy-dark/95 border border-gold/30 p-6 rounded-3xl shadow-2xl w-[260px] h-[260px] flex flex-col items-center justify-center text-center">
            <span className="text-4xl mb-3 animate-spin">🔄</span>
            <p className="text-gold font-bold text-sm mb-1.5">외부 공인 주소 연결 중</p>
            <p className="text-gray-300 text-xs leading-relaxed mb-3">
              같은 공간에 계신 분들은 상단의 <span className="text-emerald-400 font-bold">[📶 같은 Wi-Fi 접속]</span> 탭을 클릭하여 즉시 접속하세요.
            </p>
            <p className="text-[10px] text-gray-500 font-mono">
              (서버 node server.mjs 실행 시 자동 발급)
            </p>
          </div>
        )}

        {/* 하단 접속 안내 및 주소 텍스트 */}
        <div className="mt-5 text-center w-full">
          <p className="text-gray-300 text-xs mb-1.5 font-medium">카메라 스캔 또는 모바일 브라우저 주소창 직접 입력</p>
          <div className="px-4 py-2 bg-navy-dark/95 rounded-xl border border-gold/30 font-mono text-sm md:text-base text-gold font-bold break-all select-all shadow-inner tracking-wide">
            {activeTab === 'wifi' ? wifiUrl : (publicLteUrl || '외부 접속 주소 발급 대기 중...')}
          </div>
        </div>
      </motion.div>

      {/* 실시간 참가 인원 */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.6 }}
        className="mt-8 text-center"
      >
        <div className="flex items-baseline justify-center gap-2">
          <span className="font-display text-7xl md:text-9xl text-gold text-shadow-glow font-bold">
            {playerList.length}
          </span>
          <span className="text-gray-400 text-2xl md:text-3xl font-display">/ 100명</span>
        </div>
        <p className="text-gold-light/80 text-lg md:text-xl font-medium mt-1">
          {playerList.length > 0 ? '현재 접속 대기 중' : '참가자를 기다리는 중입니다...'}
        </p>
      </motion.div>

      {/* 참가자 닉네임 롤링 티커 */}
      {playerList.length > 0 ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8 }}
          className="mt-6 flex flex-wrap gap-2.5 justify-center max-w-4xl px-4"
        >
          {playerList.slice(-25).map((p, i) => (
            <motion.span
              key={p?.id || i}
              initial={{ opacity: 0, scale: 0 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.03 * i }}
              className="px-3.5 py-1.5 bg-navy-dark/80 border border-gold/30 rounded-full text-gold text-sm font-bold shadow"
            >
              👤 {p?.nickname || '참가자'}
            </motion.span>
          ))}
        </motion.div>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.7 }}
          className="mt-6 text-gray-400 text-sm font-medium"
        >
          화면의 QR 코드를 스캔하여 가장 먼저 대기실에 입장해보세요!
        </motion.div>
      )}
    </div>
  )
}

// ===== 2. TV 문제 출제 화면 =====
function TVQuestion() {
  const { currentQuestion, roundNumber, isFinals, ruleMode } = useGameStore()
  if (!currentQuestion) return null

  return (
    <div className="min-h-screen flex flex-col justify-between relative pb-12">
      <div className="particles-bg" />
      <TVHeader roundNumber={roundNumber} category={currentQuestion.category} isFinals={isFinals} />

      {/* 메인 문제 카드 */}
      <div className="flex-1 flex flex-col items-center justify-center px-8 max-w-7xl mx-auto w-full">
        {/* 룰 모드 안내 배너 */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className={`mb-4 px-6 py-2 rounded-2xl border text-center font-display shadow-lg ${ruleMode === 'minority'
              ? 'bg-purple-950/70 border-purple-400 text-purple-200'
              : 'bg-gold/15 border-gold/40 text-gold-light'
            }`}
        >
          <span className="text-base md:text-lg font-bold">
            {ruleMode === 'minority'
              ? '🎯 이번 라운드는 [소수의 선택] 룰! 더 적은 사람이 선택한 쪽이 생존합니다!'
              : '👥 이번 라운드는 [다수의 선택] 룰! 더 많은 사람이 선택한 쪽이 생존합니다!'}
          </span>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center mb-8"
        >
          <span className="text-gold text-sm md:text-lg font-bold tracking-widest uppercase">
            BALANCE QUESTION #{currentQuestion.id}
          </span>
          <h2 className="font-display text-4xl md:text-6xl text-white mt-2 text-shadow-white">
            어느 쪽을 선택하시겠습니까?
          </h2>
        </motion.div>

        <div className="w-full grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-6 md:gap-8 items-center">
          {/* A 옵션 (레드) */}
          <motion.div
            initial={{ opacity: 0, x: -120 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ type: 'spring', stiffness: 90, damping: 15 }}
            className="relative h-full"
          >
            <div className="bg-gradient-to-br from-team-a via-team-a-dark to-red-950 rounded-3xl p-8 md:p-12 shadow-2xl border-2 border-red-400/40 animate-pulse-glow-red flex flex-col justify-between min-h-[280px] md:min-h-[340px]">
              <div className="flex justify-between items-center">
                <span className="font-display text-4xl md:text-6xl text-white/40">A</span>
                <span className="px-3 py-1 bg-black/30 rounded-full text-red-200 text-xs font-bold">RED TEAM</span>
              </div>
              <p className="font-display text-2xl md:text-4xl lg:text-5xl text-white text-center leading-tight my-4">
                {currentQuestion.optionA}
              </p>
              <div className="text-right text-white/50 text-xs font-mono">CHOICE A</div>
            </div>
          </motion.div>

          {/* 중앙 VS */}
          <div className="text-center my-4 md:my-0">
            <motion.div
              animate={{ scale: [1, 1.15, 1], rotate: [0, 5, -5, 0] }}
              transition={{ repeat: Infinity, duration: 2.5 }}
              className="font-display text-6xl md:text-8xl text-gold text-shadow-glow"
            >
              VS
            </motion.div>
          </div>

          {/* B 옵션 (블루) */}
          <motion.div
            initial={{ opacity: 0, x: 120 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ type: 'spring', stiffness: 90, damping: 15 }}
            className="relative h-full"
          >
            <div className="bg-gradient-to-br from-team-b via-team-b-dark to-blue-950 rounded-3xl p-8 md:p-12 shadow-2xl border-2 border-blue-400/40 animate-pulse-glow-blue flex flex-col justify-between min-h-[280px] md:min-h-[340px]">
              <div className="flex justify-between items-center">
                <span className="font-display text-4xl md:text-6xl text-white/40">B</span>
                <span className="px-3 py-1 bg-black/30 rounded-full text-blue-200 text-xs font-bold">BLUE TEAM</span>
              </div>
              <p className="font-display text-2xl md:text-4xl lg:text-5xl text-white text-center leading-tight my-4">
                {currentQuestion.optionB}
              </p>
              <div className="text-right text-white/50 text-xs font-mono">CHOICE B</div>
            </div>
          </motion.div>
        </div>

        <motion.p
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ repeat: Infinity, duration: 2 }}
          className="mt-10 text-gold-light text-lg md:text-xl font-bold"
        >
          잠시 후 15초 투표가 시작됩니다...
        </motion.p>
      </div>
    </div>
  )
}

// ===== 3. TV 투표 진행 (15초 초대형 카운트다운) =====
function TVVoting() {
  const currentQuestion = useGameStore((s) => s.currentQuestion)
  const votes = useGameStore((s) => s.votes)
  const players = useGameStore((s) => s.players)
  const playerList: Player[] = Array.isArray(players) ? players.filter(Boolean) : (players && typeof players === 'object' ? (Object.values(players).filter(Boolean) as Player[]) : [])
  const endVoting = useGameStore((s) => s.endVoting)
  const roundNumber = useGameStore((s) => s.roundNumber)
  const isFinals = useGameStore((s) => s.isFinals)
  const timeLimit = useGameStore((s) => s.timeLimit)
  const votingDeadline = useGameStore((s) => s.votingDeadline)
  const ruleMode = useGameStore((s) => s.ruleMode)
  const isPaused = useGameStore((s) => s.isPaused)
  const alivePlayers = playerList.filter((p) => p && p.status === 'alive')
  const voteCount = Object.keys(votes).length

  const [timeLeft, setTimeLeft] = useState(timeLimit || 15)

  useEffect(() => {
    if (isPaused) return

    const tick = () => {
      if (votingDeadline) {
        const remaining = Math.max(0, Math.ceil((votingDeadline - Date.now()) / 1000))
        setTimeLeft(remaining)
      } else {
        setTimeLeft((prev) => (prev > 0 ? prev - 1 : 0))
      }
    }
    tick()
    const timer = setInterval(tick, 250)
    return () => clearInterval(timer)
  }, [votingDeadline, isPaused])

  // 투표 마감 5초 전 매초 카운트다운 틱 효과음 (3초 이하는 긴박한 비프음)
  useEffect(() => {
    if (timeLeft <= 5 && timeLeft > 0) {
      playCountdownTick(timeLeft <= 3)
    }
  }, [timeLeft])

  if (!currentQuestion) return null

  const isUrgent = timeLeft <= 5

  return (
    <div className="min-h-screen flex flex-col justify-between relative pb-8">
      <div className="particles-bg" />
      <TVHeader roundNumber={roundNumber} category={currentQuestion.category} isFinals={isFinals} />

      <div className="flex-1 flex flex-col items-center justify-center px-8 max-w-7xl mx-auto w-full">
        {/* 초대형 타이머 카운트다운 */}
        <motion.div
          key={timeLeft}
          initial={{ scale: 1.2, opacity: 0.8 }}
          animate={{ scale: 1, opacity: 1 }}
          className={`font-display text-shadow-glow leading-none mb-4 select-none ${isUrgent ? 'text-team-a animate-countdown-urgent' : 'text-gold'
            }`}
          style={{ fontSize: 'clamp(7rem, 20vw, 15rem)' }}
        >
          {timeLeft}
        </motion.div>

        {/* 현재 룰 안내 배너 */}
        <div className={`mb-6 px-6 py-2 rounded-full border text-sm md:text-base font-bold shadow-md flex items-center gap-2 ${ruleMode === 'minority'
            ? 'bg-purple-950/70 border-purple-400 text-purple-200'
            : 'bg-gold/15 border-gold/40 text-gold-light'
          }`}>
          <span>{ruleMode === 'minority' ? '🎯 [소수의 선택]' : '👥 [다수의 선택]'}</span>
          <span>{ruleMode === 'minority' ? '더 적은 사람이 선택한 쪽이 생존합니다! (0표 제외)' : '더 많은 사람이 선택한 쪽이 생존합니다!'}</span>
        </div>

        {/* 상단 투표율 게이지 */}
        <div className="w-full max-w-3xl mb-8">
          <div className="flex justify-between items-center text-sm md:text-base font-bold mb-2">
            <span className="text-gray-300">투표 참여 인원</span>
            <span className="text-gold font-mono text-lg">
              {voteCount} / {alivePlayers.length}명 ({alivePlayers.length > 0 ? Math.round((voteCount / alivePlayers.length) * 100) : 0}%)
            </span>
          </div>
          <div className="h-6 bg-navy-dark rounded-full overflow-hidden border border-gold/30 p-1 shadow-inner">
            <motion.div
              className="h-full bg-gradient-to-r from-gold-dark via-gold to-gold-light rounded-full"
              animate={{ width: `${alivePlayers.length > 0 ? (voteCount / alivePlayers.length) * 100 : 0}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
        </div>

        {/* 선택지 리마인더 카드 */}
        <div className="w-full max-w-5xl grid grid-cols-2 gap-6">
          <div className="p-6 rounded-2xl bg-team-a/15 border-2 border-team-a/40 text-center">
            <span className="text-team-a-light text-sm font-bold block mb-1">A (레드)</span>
            <p className="font-display text-xl md:text-3xl text-white leading-snug">
              {currentQuestion.optionA}
            </p>
          </div>
          <div className="p-6 rounded-2xl bg-team-b/15 border-2 border-team-b/40 text-center">
            <span className="text-team-b-light text-sm font-bold block mb-1">B (블루)</span>
            <p className="font-display text-xl md:text-3xl text-white leading-snug">
              {currentQuestion.optionB}
            </p>
          </div>
        </div>

        {isUrgent && (
          <motion.div
            animate={{ opacity: [0.6, 1, 0.6] }}
            transition={{ repeat: Infinity, duration: 0.5 }}
            className="mt-6 text-team-a font-display text-2xl md:text-3xl text-shadow-red"
          >
            ⚠️ 시간이 얼마 남지 않았습니다! 미투표 시 즉시 탈락! ⚠️
          </motion.div>
        )}
      </div>
    </div>
  )
}

// ===== 4. TV 결과 공개 3초 서스펜스 카운트다운 (REVEALING) =====
function TVRevealing() {
  const [timeLeft, setTimeLeft] = useState(3)

  useEffect(() => {
    setTimeLeft(3)
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer)
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  // 서스펜스 카운트다운(3..2..1) 텐션 드럼롤/서스펜스 사운드
  useEffect(() => {
    playDrumRoll()
  }, [timeLeft])

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8 relative overflow-hidden bg-navy-dark">
      <div className="particles-bg" />

      <motion.div
        initial={{ opacity: 0, scale: 0.5 }}
        animate={{ opacity: 1, scale: 1 }}
        className="text-center z-10"
      >
        <span className="font-mono text-xl md:text-2xl text-gold tracking-[0.4em] uppercase block mb-4">
          FINAL VOTING RESULT
        </span>

        <h2 className="font-display text-4xl md:text-6xl text-white mb-6">
          투표가 마감되었습니다!
        </h2>

        {/* 3... 2... 1... 카운트다운 */}
        <motion.div
          key={timeLeft}
          initial={{ scale: 2, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 200 }}
          className="font-display text-gold text-shadow-glow my-8"
          style={{ fontSize: 'clamp(8rem, 25vw, 18rem)' }}
        >
          {timeLeft > 0 ? timeLeft : 'OPEN!'}
        </motion.div>

        <p className="font-display text-2xl md:text-3xl text-gray-300">
          다수와 소수를 집계하는 중입니다...
        </p>
      </motion.div>
    </div>
  )
}

// ===== 5. TV 결과 공개 & 탈락자 연출 (RESULT) =====
function TVResult() {
  const currentResult = useGameStore((s) => s.currentResult)
  const players = useGameStore((s) => s.players)
  const isPaused = useGameStore((s) => s.isPaused)
  const nextRound = useGameStore((s) => s.nextRound)
  const playerList: Player[] = Array.isArray(players) ? players.filter(Boolean) : (players && typeof players === 'object' ? (Object.values(players).filter(Boolean) as Player[]) : [])
  const roundNumber = useGameStore((s) => s.roundNumber)
  const [showBars, setShowBars] = useState(false)
  const [showEliminated, setShowEliminated] = useState(false)

  // 1. 결과 연출 타이머 (막대 0.6초, 탈락자 명단 2.5초)
  useEffect(() => {
    const barTimer = setTimeout(() => setShowBars(true), 600)
    const elimTimer = setTimeout(() => setShowEliminated(true), 2500)
    return () => {
      clearTimeout(barTimer)
      clearTimeout(elimTimer)
    }
  }, [])

  // 2. 결과 화면 5초 노출 보장 후 다음 단계(다음 라운드 또는 최종 우승자) 자동 진행
  useEffect(() => {
    if (isPaused) return

    const advanceTimer = setTimeout(() => {
      // 서버에서 이미 전환되었거나 전환 중일 수 있으므로 nextRound() 호출
      nextRound()
    }, 5000)

    return () => clearTimeout(advanceTimer)
  }, [isPaused, nextRound])

  // 투표 결과 막대 그래프 오픈 시 임팩트 효과음
  useEffect(() => {
    if (showBars) {
      playResultReveal()
    }
  }, [showBars])

  if (!currentResult) return null

  const totalVoters = currentResult.votesA + currentResult.votesB
  const pctA = totalVoters > 0 ? Math.round((currentResult.votesA / totalVoters) * 100) : 0
  const pctB = totalVoters > 0 ? Math.round((currentResult.votesB / totalVoters) * 100) : 0

  const eliminatedPlayers = currentResult?.eliminated && Array.isArray(currentResult.eliminated)
    ? playerList.filter((p) => p && currentResult.eliminated.includes(p.id))
    : []
  const alivePlayers = currentResult?.survivors && Array.isArray(currentResult.survivors)
    ? playerList.filter((p) => p && currentResult.survivors.includes(p.id))
    : playerList.filter((p) => p && p.status === 'alive')

  return (
    <div className="min-h-screen flex flex-col justify-between relative pb-10">
      <div className="particles-bg" />
      <TVHeader roundNumber={roundNumber} category={currentResult.question.category} customRuleMode={currentResult.ruleMode} />

      <div className="flex-1 flex flex-col items-center justify-center px-8 max-w-7xl mx-auto w-full">
        {/* 상단 다수/소수 판정 헤더 배너 */}
        {showBars && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center mb-8"
          >
            {currentResult.majority === 'tie' ? (
              <div className="inline-block px-6 py-2 bg-gold/20 border-2 border-gold rounded-full text-gold font-display text-2xl md:text-3xl animate-bounce">
                ⚖️ {currentResult.votesA} : {currentResult.votesB} 완벽한 동률! 투표자 전원 생존!
              </div>
            ) : (
              <div>
                <div className={`inline-block px-8 py-2.5 rounded-full font-display text-3xl md:text-4xl text-white shadow-2xl ${currentResult.majority === 'A' ? 'bg-team-a border-2 border-red-300 animate-pulse-glow-red' : 'bg-team-b border-2 border-blue-300 animate-pulse-glow-blue'
                  }`}>
                  🏆 [{currentResult.majority === 'A' ? 'A (레드)' : 'B (블루)'}] {currentResult.ruleMode === 'minority' ? '소수 승리!' : '다수 승리!'}
                </div>
                <div className="mt-2 text-gold-light text-base md:text-lg font-bold">
                  {currentResult.ruleMode === 'minority'
                    ? '🎯 [소수의 선택] 더 적은 표를 얻은 쪽이 생존했습니다! (0표 제외)'
                    : '👥 [다수의 선택] 더 많은 표를 얻은 쪽이 생존했습니다!'}
                </div>
              </div>
            )}
          </motion.div>
        )}

        {/* 득표수 대비 비교 카드 */}
        <div className="w-full max-w-5xl grid grid-cols-[1fr_auto_1fr] gap-6 md:gap-8 items-stretch mb-8">
          {/* A 측 */}
          <div className={`rounded-3xl p-6 md:p-8 border-2 transition-all duration-700 flex flex-col justify-between ${currentResult.majority === 'A' || currentResult.majority === 'tie'
            ? 'bg-team-a/25 border-team-a shadow-2xl shadow-team-a/30 scale-105'
            : 'bg-gray-900/40 border-gray-800 opacity-50'
            }`}>
            <div>
              <span className="text-xs font-bold text-team-a-light block mb-1">OPTION A</span>
              <p className="font-display text-xl md:text-3xl text-white leading-snug">
                {currentResult.question.optionA}
              </p>
            </div>
            {showBars && (
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 200 }}
                className="text-center pt-4"
              >
                <div className="font-display text-6xl md:text-8xl text-team-a text-shadow-red font-bold">
                  {currentResult.votesA}
                </div>
                <div className="text-team-a-light font-display text-xl">표 ({pctA}%)</div>
              </motion.div>
            )}
          </div>

          {/* 중앙 대비 아이콘 */}
          <div className="flex items-center justify-center font-display text-3xl text-gold/60">
            VS
          </div>

          {/* B 측 */}
          <div className={`rounded-3xl p-6 md:p-8 border-2 transition-all duration-700 flex flex-col justify-between ${currentResult.majority === 'B' || currentResult.majority === 'tie'
            ? 'bg-team-b/25 border-team-b shadow-2xl shadow-team-b/30 scale-105'
            : 'bg-gray-900/40 border-gray-800 opacity-50'
            }`}>
            <div>
              <span className="text-xs font-bold text-team-b-light block mb-1">OPTION B</span>
              <p className="font-display text-xl md:text-3xl text-white leading-snug">
                {currentResult.question.optionB}
              </p>
            </div>
            {showBars && (
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 200, delay: 0.15 }}
                className="text-center pt-4"
              >
                <div className="font-display text-6xl md:text-8xl text-team-b text-shadow-blue font-bold">
                  {currentResult.votesB}
                </div>
                <div className="text-team-b-light font-display text-xl">표 ({pctB}%)</div>
              </motion.div>
            )}
          </div>
        </div>

        {/* 탈락자 연출 (Dramatic Strobe & Elimination List) */}
        <AnimatePresence>
          {showEliminated && (
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full max-w-4xl text-center"
            >
              <div className="flex justify-center items-center gap-8 mb-4">
                <div className="glass-card px-6 py-3 border border-red-500/40 bg-red-950/20">
                  <span className="text-xs text-red-400 block font-bold">이번 라운드 탈락</span>
                  <span className="font-display text-3xl text-red-400">
                    {eliminatedPlayers.length}명
                  </span>
                  {currentResult.nonVoters > 0 && (
                    <span className="text-[11px] text-gray-400 block mt-0.5">
                      (미투표 {currentResult.nonVoters}명 포함)
                    </span>
                  )}
                </div>

                <div className="glass-card px-8 py-3 border border-green-500/40 bg-green-950/20 shadow-lg">
                  <span className="text-xs text-green-400 block font-bold">남은 생존자</span>
                  <span className="font-display text-4xl text-white font-bold">
                    {alivePlayers.length}명
                  </span>
                </div>
              </div>

              {/* 탈락자 명단 연출 */}
              {eliminatedPlayers.length > 0 && (
                <div className="flex flex-wrap gap-2 justify-center max-h-32 overflow-y-auto px-4 py-2 bg-navy-dark/60 rounded-xl border border-red-500/20">
                  {eliminatedPlayers.map((p, i) => (
                    <motion.span
                      key={p?.id || i}
                      initial={{ scale: 1.3, opacity: 0 }}
                      animate={{ scale: 1, opacity: 0.6 }}
                      transition={{ delay: i * 0.05 }}
                      className="px-3 py-1 bg-red-950/40 border border-red-800/40 rounded-full text-red-300 text-xs line-through font-medium"
                    >
                      💀 {p?.nickname || '탈락자'}
                    </motion.span>
                  ))}
                </div>
              )}

              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: [0.6, 1, 0.6] }}
                transition={{ repeat: Infinity, duration: 1.5 }}
                className="mt-6 text-gold text-lg md:text-xl font-display font-bold"
              >
                {alivePlayers.length <= 2 && alivePlayers.length > 0
                  ? `🏆 최후의 ${alivePlayers.length}인 결정! 잠시 후 최종 우승 결과가 발표되고 경기가 종료됩니다!`
                  : '⏱️ 잠시 후 다음 라운드가 시작됩니다...'}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

// ===== 6. TV 게임 오버 및 최종 우승 연출 (GAMEOVER) =====
function TVGameOver() {
  const players = useGameStore((s) => s.players)
  const playerList: Player[] = Array.isArray(players) ? players.filter(Boolean) : (players && typeof players === 'object' ? (Object.values(players).filter(Boolean) as Player[]) : [])
  const winners = playerList.filter((p) => p && p.status === 'alive')

  // 우승 축하 팡파르 효과음
  useEffect(() => {
    playGameoverFanfare()
  }, [])

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-8 relative overflow-hidden bg-gradient-to-br from-navy-dark via-navy to-navy-dark">
      <div className="particles-bg" />

      {/* 축하 컨페티 효과 (50개 다채로운 색상 파티클) */}
      {Array.from({ length: 50 }).map((_, i) => (
        <div
          key={i}
          className="confetti-piece"
          style={{
            left: `${Math.random() * 100}%`,
            backgroundColor: ['#FFD700', '#EF4444', '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'][i % 7],
            animationDuration: `${2.5 + Math.random() * 4}s`,
            animationDelay: `${Math.random() * 2.5}s`,
            borderRadius: Math.random() > 0.4 ? '50%' : '2px',
            width: `${10 + Math.random() * 14}px`,
            height: `${10 + Math.random() * 14}px`,
          }}
        />
      ))}

      {/* 우승 메인 타이틀 */}
      <motion.div
        initial={{ opacity: 0, scale: 0.4 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', duration: 1.2 }}
        className="text-center z-10 max-w-5xl"
      >
        {winners.length === 0 ? (
          <div>
            <motion.div
              animate={{ scale: [1, 1.15, 1] }}
              transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
              className="text-9xl md:text-[11rem] mb-4 select-none filter drop-shadow-[0_0_40px_rgba(239,68,68,0.6)]"
            >
              💀
            </motion.div>
            <h1 className="font-display text-6xl md:text-8xl lg:text-9xl text-red-400 text-shadow-glow mb-4">
              ALL ELIMINATED
            </h1>
            <p className="font-display text-2xl md:text-4xl text-gray-300 tracking-[0.2em] mb-6">
              모든 생존자가 탈락했습니다! (게임 오버)
            </p>
            <p className="text-gray-400 text-lg max-w-lg mx-auto">
              아쉽게도 최후의 생존자가 남지 않았습니다.<br />
              관리자 페이지에서 재시작하여 새 게임을 준비해주세요.
            </p>
          </div>
        ) : (
          <>
            <motion.div
              animate={{ y: [0, -18, 0], rotate: [0, 5, -5, 0] }}
              transition={{ repeat: Infinity, duration: 2.5, ease: 'easeInOut' }}
              className="text-9xl md:text-[11rem] mb-4 select-none filter drop-shadow-[0_0_40px_rgba(255,215,0,0.6)]"
            >
              🏆
            </motion.div>

            <h1 className="font-display text-6xl md:text-8xl lg:text-9xl text-gold text-shadow-glow mb-3">
              {winners.length === 1 ? 'SOLE CHAMPION' : 'THE LAST TWO'}
            </h1>
            <p className="font-display text-2xl md:text-4xl text-gold-light tracking-[0.3em] mb-12">
              {winners.length === 1 ? '단독 최종 우승자 탄생!' : '최후의 생존자 2인 영광의 우승!'}
            </p>

            {/* 우승자 명단 공개 카드 */}
            <div className="flex flex-wrap gap-8 md:gap-14 justify-center items-center">
              {winners.map((winner, i) => (
                <motion.div
                  key={winner.id}
                  initial={{ y: 80, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.6 + i * 0.3, type: 'spring', bounce: 0.5 }}
                  className="glass-card p-8 md:p-12 border-2 border-gold/50 shadow-[0_0_60px_rgba(255,215,0,0.3)] rounded-3xl text-center min-w-[280px] md:min-w-[340px]"
                >
                  <div className="w-36 h-36 md:w-48 md:h-48 mx-auto mb-6 rounded-full bg-gradient-to-br from-gold via-gold-light to-gold-dark flex items-center justify-center animate-pulse-glow shadow-2xl">
                    <span className="text-6xl md:text-8xl font-display text-navy-dark font-bold">
                      {winner.nickname.charAt(0)}
                    </span>
                  </div>
                  <h2 className="font-display text-4xl md:text-6xl text-gold text-shadow-glow">
                    {winner.nickname}
                  </h2>
                  <p className="text-gold-light/80 text-xl font-bold mt-3">
                    {winners.length === 1 ? '👑 단독 챔피언' : `🎖️ 최종 생존자 #${i + 1}`}
                  </p>
                </motion.div>
              ))}
            </div>
          </>
        )}
      </motion.div>

      {/* 하단 서명 */}
      <div className="absolute bottom-6 text-center text-gold/40 font-display text-sm tracking-widest font-mono">
        당신의 선택 : THE LAST TWO · 2026 연말 페스티벌
      </div>
    </div>
  )
}

// ===== TV 실시간 채팅 티커 =====
function TVLiveChatTicker() {
  const { chatMessages } = useGameStore()
  const latestMessage = chatMessages[0]
  if (!latestMessage) return null

  return (
    <div className="fixed bottom-3 left-6 z-30 pointer-events-none">
      <motion.div
        key={latestMessage.id}
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="glass-card px-4 py-2 bg-navy-dark/95 border border-gold/40 rounded-xl inline-flex items-center gap-3 shadow-2xl backdrop-blur max-w-lg truncate"
      >
        <span className="text-base">💬</span>
        <span className="text-gold font-bold text-sm shrink-0">{latestMessage.nickname}:</span>
        <span className="text-white text-sm truncate font-medium">{latestMessage.message}</span>
        <span className="text-[10px] text-gold-light/60 font-mono shrink-0">실시간 응원</span>
      </motion.div>
    </div>
  )
}

// ===== TV 송출 메인 페이지 =====
export default function TVPage() {
  // 실시간 웹소켓 상태 동기화 (3번 서바이벌 퀴즈 동일)
  useSocketSync()

  const phase = useGameStore((s) => s.phase)
  const isPaused = useGameStore((s) => s.isPaused)
  const timeLeft = useGameStore((s) => s.timeLeft)
  const players = useGameStore((s) => s.players)
  const playerList: Player[] = Array.isArray(players) ? players.filter(Boolean) : (players && typeof players === 'object' ? (Object.values(players).filter(Boolean) as Player[]) : [])
  const serverHostUrl = useGameStore((s) => s.serverHostUrl)
  const setServerHostUrl = useGameStore((s) => s.setServerHostUrl)
  const qrMode = useGameStore((s) => s.qrMode)

  // BGM 오디오 인스턴스 및 상태 제어
  const bgmRef = useRef<HTMLAudioElement | null>(null)
  const isPlayingRef = useRef<boolean>(false)
  const [bgmEnabled, setBgmEnabled] = useState<boolean>(true)
  const [masterVolume, setMasterVolume] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('tv_bgm_volume')
      return saved !== null ? Number(saved) : 0.6
    }
    return 0.6
  })

  // BGM 오디오 객체 및 타이머 참조
  const fadeIntervalRef = useRef<any>(null)
  const lastTickSecondRef = useRef<number>(-1)

  // 관리자 소켓 이벤트로 마스터 볼륨 실시간 수신
  useEffect(() => {
    const handleVolumeChange = (data: any) => {
      if (typeof data?.volume === 'number') {
        const vol = Math.max(0, Math.min(1, data.volume))
        setMasterVolume(vol)
        if (typeof window !== 'undefined') {
          localStorage.setItem('tv_bgm_volume', String(vol))
        }
      }
    }

    const handleStateSync = (state: any) => {
      if (typeof state?.bgmVolume === 'number') {
        const vol = Math.max(0, Math.min(1, state.bgmVolume))
        setMasterVolume(vol)
      }
    }

    socket.on('game:volume_changed', handleVolumeChange)
    socket.on('game:state_sync', handleStateSync)
    socket.on('state:sync', handleStateSync)

    return () => {
      socket.off('game:volume_changed', handleVolumeChange)
      socket.off('game:state_sync', handleStateSync)
      socket.off('state:sync', handleStateSync)
    }
  }, [])

  // 부드러운 페이드인 헬퍼 함수 (시작 팝 노이즈 방지 & 버퍼 찌꺼기 완벽 차단)
  const fadeInBgm = (targetVolume: number) => {
    const audio = bgmRef.current
    if (!audio) return
    if (fadeIntervalRef.current) {
      clearInterval(fadeIntervalRef.current)
      fadeIntervalRef.current = null
    }

    if (!audio.paused && isPlayingRef.current) {
      // 이미 재생 중이면 볼륨만 목표치로 맞춤
      audio.volume = targetVolume
      return
    }

    // 1) 이전 오디오의 버퍼 찌꺼기 튐을 물리적으로 차단하기 위해 먼저 muted = true로 만들고 0초로 설정
    audio.muted = true
    audio.volume = 0
    audio.currentTime = 0

    const playPromise = audio.play()
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          isPlayingRef.current = true
          // 2) 재생이 정상 궤도에 오른 직후인 약 50ms(0.05초) 뒤에 muted 해제 및 페이드인 시작
          setTimeout(() => {
            if (!bgmRef.current || !isPlayingRef.current) return
            bgmRef.current.muted = false

            let currentStep = 0
            const totalSteps = 10
            const stepInterval = 25 // 25ms * 10 = 250ms 페이드인
            fadeIntervalRef.current = setInterval(() => {
              currentStep++
              if (!bgmRef.current) {
                clearInterval(fadeIntervalRef.current)
                return
              }
              const ratio = Math.min(1, currentStep / totalSteps)
              bgmRef.current.volume = targetVolume * ratio
              if (currentStep >= totalSteps) {
                clearInterval(fadeIntervalRef.current)
                fadeIntervalRef.current = null
              }
            }, stepInterval)
          }, 50)
        })
        .catch((err) => {
          isPlayingRef.current = false
          if (audio) audio.muted = false
          console.warn('[TV BGM 자동재생 대기 - 화면 클릭 시 재생됨]:', err.message)
        })
    }
  }

  // BGM 오디오 객체 단일 인스턴스 초기화
  useEffect(() => {
    const audio = new Audio('/audio/bgm.mp3')
    audio.loop = true
    audio.volume = 0
    bgmRef.current = audio

    audio.onerror = () => {
      // /audio/bgm.mp3 실패 시 /bgm.mp3로 fallback
      if (audio.src.includes('/audio/bgm.mp3')) {
        audio.src = '/bgm.mp3'
        audio.load()
      }
    }

    return () => {
      if (fadeIntervalRef.current) clearInterval(fadeIntervalRef.current)
      audio.pause()
      audio.currentTime = 0
      isPlayingRef.current = false
      bgmRef.current = null
    }
  }, [])

  // 3. 남은 시간 5초 이하 시 BGM 볼륨 20~25% 자동 감쇠 (Audio Ducking) 확실한 적용
  useEffect(() => {
    const audio = bgmRef.current
    if (!audio || phase !== 'voting') return

    const baseVolume = masterVolume

    if (timeLeft <= 5 && timeLeft > 0) {
      // 5초 이하 구간: 기존 볼륨의 20~25% 수준으로 강제 하향
      audio.volume = Math.max(0.05, baseVolume * 0.25)

      // 매 초 초침 효과음 1회 재생
      if (lastTickSecondRef.current !== timeLeft) {
        lastTickSecondRef.current = timeLeft
        playCountdownTick(timeLeft <= 3)
      }
    } else if (timeLeft > 5) {
      if (!fadeIntervalRef.current) {
        audio.volume = baseVolume
      }
      lastTickSecondRef.current = -1
    }
  }, [timeLeft, phase, masterVolume])

  // 2. 게임 페이즈(단계) 및 일시정지에 따른 BGM 재생/일시정지 및 완전 초기화 (잔향 찌꺼기 완벽 차단)
  useEffect(() => {
    const audio = bgmRef.current
    if (!audio) return

    // 일시정지 상태인 경우 BGM 즉시 일시정지
    if (isPaused) {
      if (fadeIntervalRef.current) {
        clearInterval(fadeIntervalRef.current)
        fadeIntervalRef.current = null
      }
      audio.pause()
      isPlayingRef.current = false
      return
    }

    // 투표/질문 단계 (voting, question, playing)
    const isBgmPhase = phase === 'voting' || phase === 'question' || (phase as string) === 'playing'

    if (isBgmPhase) {
      if (bgmEnabled) {
        // 일시정지 후 재개이거나 처음 재생 시
        if (audio.paused || !isPlayingRef.current) {
          fadeInBgm(masterVolume)
        } else {
          audio.volume = masterVolume
        }
      }
    } else {
      // 투표가 종료되거나 다른 단계(revealing, result, elimination, gameover, lobby)로 넘어가면 즉시 완전 정지 및 사운드 클린업
      if (fadeIntervalRef.current) {
        clearInterval(fadeIntervalRef.current)
        fadeIntervalRef.current = null
      }
      audio.pause()
      audio.currentTime = 0
      audio.volume = masterVolume
      isPlayingRef.current = false
      lastTickSecondRef.current = -1
      stopAllSounds()
    }
  }, [phase, isPaused, bgmEnabled, masterVolume])

  // 브라우저 첫 인터랙션 시 오디오 컨텍스트 언락 및 BGM 활성화
  useEffect(() => {
    const handleGesture = () => {
      unlockAudioContext()
      const audio = bgmRef.current
      if (audio) {
        const isBgmPhase = phase === 'voting' || phase === 'question' || (phase as string) === 'playing'
        if (isBgmPhase && audio.paused && bgmEnabled && !isPlayingRef.current) {
          fadeInBgm(masterVolume)
        }
      }
    }
    window.addEventListener('pointerdown', handleGesture)
    window.addEventListener('keydown', handleGesture)
    return () => {
      window.removeEventListener('pointerdown', handleGesture)
      window.removeEventListener('keydown', handleGesture)
    }
  }, [phase, bgmEnabled, masterVolume])

  // 서버 정보 및 외부 터널 URL 실시간 연동 (3번 서바이벌 퀴즈 방식)
  useEffect(() => {
    if (typeof window === 'undefined') return

    const hostname = window.location.hostname
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1'
    const isPrivateIp = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(hostname)
    const isPublicDomain = !isLocalhost && !isPrivateIp

    // Render 등 이미 배포된 퍼블릭 도메인이면 기본 origin을 세팅
    if (isPublicDomain && (!serverHostUrl || serverHostUrl.includes('192.168.') || serverHostUrl.includes('localhost'))) {
      setServerHostUrl(`${window.location.origin}/`)
    }

    fetch('/api/server-info')
      .then((res) => (res.ok ? res.json() : null))
      .then((info) => {
        if (info?.publicUrl && qrMode === 'tunnel') {
          setServerHostUrl(info.publicUrl)
        } else if (!info?.publicUrl && qrMode === 'tunnel' && isPublicDomain) {
          setServerHostUrl(`${window.location.origin}/`)
        }
      })
      .catch(() => { })

    const handleTunnelUpdated = (newUrl: string) => {
      if (newUrl && newUrl.startsWith('http') && qrMode === 'tunnel') {
        setServerHostUrl(newUrl)
      }
    }

    socket.on('server:tunnel_updated', handleTunnelUpdated)
    return () => {
      socket.off('server:tunnel_updated', handleTunnelUpdated)
    }
  }, [setServerHostUrl, qrMode, serverHostUrl])

  return (
    <div className="min-h-screen bg-navy text-white overflow-hidden relative select-none">
      {/* 로비 페이즈가 아닐 때는 TVHeader 내부에 우측 상단 툴바가 배치되며, 로비 페이즈일 때만 플로팅 배치 */}
      {phase === 'lobby' && (
        <div className="fixed top-5 right-5 z-50 flex items-center gap-3">
          <div className="px-3 py-1.5 bg-navy-dark/80 border border-gold/30 rounded-xl text-xs font-bold text-gold flex items-center gap-1.5 shadow-xl backdrop-blur">
            <span>👥 접속</span>
            <span className="font-mono text-white">{playerList.length}명</span>
          </div>
          <AdminGearButton />
          <FullscreenButton />
        </div>
      )}
      <TVLiveChatTicker />
      <div className="scanline-overlay" />

      <AnimatePresence mode="wait">
        {phase === 'lobby' && (
          <motion.div key="lobby" exit={{ opacity: 0 }} transition={{ duration: 0.5 }}>
            <TVLobby />
          </motion.div>
        )}
        {phase === 'question' && (
          <motion.div key="question" exit={{ opacity: 0 }} transition={{ duration: 0.5 }}>
            <TVQuestion />
          </motion.div>
        )}
        {phase === 'voting' && (
          <motion.div key="voting" exit={{ opacity: 0 }} transition={{ duration: 0.5 }}>
            <TVVoting />
          </motion.div>
        )}
        {phase === 'revealing' && (
          <motion.div key="revealing" exit={{ opacity: 0 }} transition={{ duration: 0.5 }}>
            <TVRevealing />
          </motion.div>
        )}
        {(phase === 'result' || phase === 'elimination') && (
          <motion.div key="result" exit={{ opacity: 0 }} transition={{ duration: 0.5 }}>
            <TVResult />
          </motion.div>
        )}
        {phase === 'gameover' && (
          <motion.div key="gameover" exit={{ opacity: 0 }} transition={{ duration: 0.5 }}>
            <TVGameOver />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
