import React, { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { QRCodeSVG, QRCodeCanvas } from 'qrcode.react'
import { socket } from '../socket'
import { useGameStore } from '../store/gameStore'
import { useCountdown } from '../hooks/useCountdown'
import { useFirebaseSync } from '../hooks/useFirebaseSync'
import { exportGameResultsToExcel } from '../utils/excelExport'
import type { Question } from '../types/game'

// ===== 로고 =====
function Logo() {
  return (
    <div className="flex items-center gap-3">
      <h1 className="font-display text-xl text-gold text-shadow-glow">당신의 선택</h1>
      <span className="text-gold/50 text-xs tracking-widest font-mono">ADMIN DASHBOARD</span>
    </div>
  )
}

// ===== 상태 뱃지 =====
function PhaseBadge({ phase, isFinals, isPaused }: { phase: string; isFinals?: boolean; isPaused?: boolean }) {
  if (isPaused) {
    return (
      <span className="inline-block px-3 py-1 bg-yellow-600 rounded-full text-xs font-bold text-white animate-pulse">
        ⏸️ 일시정지됨
      </span>
    )
  }

  const labels: Record<string, { text: string; color: string }> = {
    lobby: { text: '대기실', color: 'bg-gray-600' },
    question: { text: '문제 출제', color: 'bg-gold/80' },
    voting: { text: '투표 진행 중', color: 'bg-green-600' },
    revealing: { text: '결과 공개 카운트다운', color: 'bg-indigo-600 animate-pulse' },
    result: { text: '결과 발표', color: 'bg-purple-600' },
    elimination: { text: '탈락자 공개', color: 'bg-red-600' },
    gameover: { text: '게임 종료', color: 'bg-gold' },
    finals: { text: '결승 모드', color: 'bg-orange-600' },
  }
  const info = labels[phase] || { text: phase, color: 'bg-gray-600' }

  return (
    <div className="flex items-center gap-2">
      {isFinals && (
        <span className="px-2 py-0.5 bg-orange-600/30 border border-orange-500 rounded-full text-xs font-bold text-orange-400 animate-pulse">
          ⚡ 결승
        </span>
      )}
      <span className={`inline-block px-3 py-1 ${info.color} rounded-full text-xs font-bold text-white shadow-sm`}>
        {info.text}
      </span>
    </div>
  )
}

export default function AdminPage() {
  // 실시간 Firebase 및 상태 복원 동기화
  useFirebaseSync()

  const store = useGameStore()
  const {
    phase, players, roundNumber, currentQuestion, votes,
    currentResult, roundResults, isFinals, isPaused, timeLimit,
    votingDeadline, timeLeft, ruleMode, setRuleMode,
    questionsList, addQuestionItem, updateQuestionItem, deleteQuestionItem, resetQuestionsToDefault,
    addMockPlayers, startGame, startVoting, endVoting, revealResult,
    nextRound, resetGame, clearAllPlayers, pauseGame, resumeGame, forceEndGame,
    setTimeLimit, enterFinals, simulateVotes, soleWinnerId, serverHostUrl, setServerHostUrl,
    qrMode, setQrMode,
  } = store

  const [activeTab, setActiveTab] = useState<'control' | 'questions'>('control')
  const [mockCount, setMockCount] = useState(20)
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null)
  const [isEditingUrl, setIsEditingUrl] = useState(false)
  const [tunnelUrl, setTunnelUrl] = useState('')

  const originUrl = typeof window !== 'undefined' ? `${window.location.origin}/` : 'http://localhost:5000/'
  const hostname = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1'
  const isPrivateIp = /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(hostname)
  const isPublicDomain = !isLocalhost && !isPrivateIp

  const wifiUrl = isPublicDomain
    ? originUrl
    : (!isLocalhost
      ? `${window.location.protocol}//${hostname}${window.location.port ? `:${window.location.port}` : ':5000'}/`
      : 'http://192.168.40.111:5000/')

  const publicUrl = tunnelUrl
    ? (tunnelUrl.endsWith('/') ? tunnelUrl : `${tunnelUrl}/`)
    : (isPublicDomain
      ? originUrl
      : (serverHostUrl && serverHostUrl.startsWith('http')
        ? (serverHostUrl.endsWith('/') ? serverHostUrl : `${serverHostUrl}/`)
        : originUrl))

  const [customUrlInput, setCustomUrlInput] = useState(isPublicDomain ? originUrl : wifiUrl)

  // 서버 정보 및 외부 터널 URL 실시간 연동 (3번 서바이벌 퀴즈 방식)
  useEffect(() => {
    if (typeof window === 'undefined') return

    // 1. 서버 정보 API 조회
    fetch('/api/server-info')
      .then((res) => (res.ok ? res.json() : null))
      .then((info) => {
        if (info?.publicUrl) {
          setTunnelUrl(info.publicUrl)
          setServerHostUrl(info.publicUrl)
          setCustomUrlInput(info.publicUrl)
        }
      })
      .catch(() => {})

    // 2. 소켓 터널 URL 업데이트 이벤트 실시간 수신
    const handleTunnelUpdated = (newUrl: string) => {
      if (newUrl && newUrl.startsWith('http')) {
        setTunnelUrl(newUrl)
        setServerHostUrl(newUrl)
        setCustomUrlInput(newUrl)
      }
    }

    socket.on('server:tunnel_updated', handleTunnelUpdated)
    return () => {
      socket.off('server:tunnel_updated', handleTunnelUpdated)
    }
  }, [setServerHostUrl])

  // 문제 관리 폼 상태
  const [formCategory, setFormCategory] = useState('직장생활')
  const [formOptionA, setFormOptionA] = useState('')
  const [formOptionB, setFormOptionB] = useState('')
  const [formIsFinals, setFormIsFinals] = useState(false)

  const alivePlayers = (phase === 'result' || phase === 'elimination') && currentResult?.survivors
    ? players.filter((p) => currentResult.survivors.includes(p.id))
    : players.filter((p) => p.status === 'alive')
  const eliminatedPlayers = (phase === 'result' || phase === 'elimination') && currentResult?.survivors
    ? players.filter((p) => !currentResult.survivors.includes(p.id))
    : players.filter((p) => p.status === 'eliminated')
  const voteCount = Object.keys(votes).length
  const joinUrl = serverHostUrl || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000')

  // 1. 투표 15초 타이머 (Voting Phase) - votingDeadline 기반 정확한 동기화 및 0초 도달 시 즉시 자동 마감
  const [votingTimeLeft, setVotingTimeLeft] = useState(timeLimit || 15)

  useEffect(() => {
    if (phase !== 'voting' || isPaused) return

    const tick = () => {
      if (votingDeadline) {
        const remaining = Math.max(0, Math.ceil((votingDeadline - Date.now()) / 1000))
        setVotingTimeLeft(remaining)
        if (remaining <= 0) {
          endVoting()
        }
      } else {
        setVotingTimeLeft((prev) => {
          if (prev <= 1) {
            endVoting()
            return 0
          }
          return prev - 1
        })
      }
    }

    tick()
    const timer = setInterval(tick, 250)
    return () => clearInterval(timer)
  }, [phase, isPaused, votingDeadline, endVoting])

  // 2. 3초 결과 서스펜스 카운트다운 (Revealing Phase) - 3초 후 결과 자동 공개
  const [revealingTimeLeft, setRevealingTimeLeft] = useState(3)

  useEffect(() => {
    if (phase !== 'revealing' || isPaused) {
      setRevealingTimeLeft(3)
      return
    }

    setRevealingTimeLeft(3)
    const timer = setInterval(() => {
      setRevealingTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer)
          revealResult()
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [phase, isPaused, revealResult])

  // 3. 결과 공개 후 5초 뒤 자동 다음 라운드 진행 (1~2명 남은 경우 자동 경기 종료 및 우승 발표)
  const [autoAdvance, setAutoAdvance] = useState(true)
  const [resultCountdown, setResultCountdown] = useState(5)

  useEffect(() => {
    if (phase !== 'result' || isPaused || !autoAdvance) {
      setResultCountdown(5)
      return
    }

    // 생존자가 0명인 예외 상황에서만 자동 진행을 멈춤
    if (currentResult && currentResult.survivors.length === 0) {
      return
    }

    setResultCountdown(5)
    const timer = setInterval(() => {
      setResultCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer)
          nextRound()
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [phase, isPaused, autoAdvance, currentResult, nextRound])

  const handleStartVoting = () => {
    startVoting(timeLimit)
  }

  const handleExcelExport = () => {
    exportGameResultsToExcel(players, roundResults)
  }

  const [copied, setCopied] = useState(false)

  const handleDownloadQR = () => {
    const canvas = document.getElementById('admin-qr-canvas') as HTMLCanvasElement
    if (!canvas) return
    const pngUrl = canvas.toDataURL('image/png')
    const downloadLink = document.createElement('a')
    downloadLink.href = pngUrl
    downloadLink.download = 'THE_LAST_TWO_직원접속_QR코드.png'
    document.body.appendChild(downloadLink)
    downloadLink.click()
    document.body.removeChild(downloadLink)
  }

  const handleCopyLink = () => {
    navigator.clipboard.writeText(joinUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const handleSaveQuestion = (e: React.FormEvent) => {
    e.preventDefault()
    if (!formOptionA.trim() || !formOptionB.trim()) return

    if (editingQuestion) {
      updateQuestionItem(editingQuestion.id, {
        category: formCategory,
        optionA: formOptionA.trim(),
        optionB: formOptionB.trim(),
        isFinals: formIsFinals,
      })
      setEditingQuestion(null)
    } else {
      addQuestionItem({
        category: formCategory,
        optionA: formOptionA.trim(),
        optionB: formOptionB.trim(),
        isFinals: formIsFinals,
      })
    }

    setFormOptionA('')
    setFormOptionB('')
    setShowAddModal(false)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-navy-dark via-navy to-navy-light text-white">
      {/* 관리자 헤더 */}
      <header className="border-b border-gold/15 bg-navy-dark/80 backdrop-blur px-6 py-3.5 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-40">
        <Logo />
        <div className="flex items-center gap-3">
          <div className="flex bg-navy rounded-lg p-1 border border-gold/20">
            <button
              onClick={() => setActiveTab('control')}
              className={`px-3 py-1.5 rounded text-xs font-bold transition-all ${
                activeTab === 'control' ? 'bg-gold text-navy-dark shadow' : 'text-gray-400 hover:text-white'
              }`}
            >
              🎮 게임 제어
            </button>
            <button
              onClick={() => setActiveTab('questions')}
              className={`px-3 py-1.5 rounded text-xs font-bold transition-all ${
                activeTab === 'questions' ? 'bg-gold text-navy-dark shadow' : 'text-gray-400 hover:text-white'
              }`}
            >
              📝 문제 관리 ({questionsList.length})
            </button>
          </div>

          <button
            onClick={handleExcelExport}
            className="px-3 py-1.5 bg-green-700 hover:bg-green-600 text-white rounded-lg text-xs font-bold border border-green-500/50 flex items-center gap-1.5 shadow transition-all"
            title="게임 결과 및 참가자 명단을 Excel CSV로 다운로드"
          >
            📊 엑셀 다운로드
          </button>

          <a
            href="/tv"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              e.preventDefault()
              window.open('/tv', '_blank', 'noopener,noreferrer')
            }}
            className="px-3 py-1.5 bg-navy-dark/90 hover:bg-gold hover:text-navy-dark text-gold/90 border border-gold/30 rounded-lg text-xs font-bold flex items-center gap-1.5 shadow transition-all cursor-pointer"
            title="대형 TV 전광판 화면(/tv)을 새 탭/새 창에서 열기"
          >
            🖥️ TV 화면 열기
          </a>

          <button
            onClick={() => {
              if (window.confirm('현재 게임을 초기화하고 다음 게임(세트)을 준비하시겠습니까?\n(접속한 참가자들은 튕기지 않고 유지되며, 전원 생존 상태로 대기실에 남아있습니다)')) {
                resetGame()
              }
            }}
            className="px-3 py-1.5 bg-gold/15 hover:bg-gold/25 text-gold border border-gold/40 rounded-lg text-xs font-bold flex items-center gap-1.5 shadow transition-all"
            title="현재 게임을 리셋하고 새 게임을 시작합니다 (접속자 유지)"
          >
            🔄 새 게임 리셋 (참가자 유지)
          </button>

          <PhaseBadge phase={phase} isFinals={isFinals} isPaused={isPaused} />
          <span className="text-gold text-sm font-bold font-mono bg-gold/10 px-2 py-0.5 rounded border border-gold/20">
            R{roundNumber}
          </span>
        </div>
      </header>

      {activeTab === 'control' ? (
        <main className="p-4 md:p-6 max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* ===== 좌측 2열: 메인 게임 컨트롤 ===== */}
          <div className="lg:col-span-2 space-y-5">
            {/* 통계 지표 카드 */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="총 접속 인원" value={`${players.length}/100`} icon="👥" />
              <StatCard label="생존자 수" value={alivePlayers.length} icon="💚" color="text-green-400" />
              <StatCard label="탈락자 수" value={eliminatedPlayers.length} icon="💀" color="text-red-400" />
              <StatCard
                label={isFinals ? '결승 라운드' : '진행 라운드'}
                value={isFinals ? `결승 R${roundNumber}` : `${roundNumber}/30`}
                icon={isFinals ? '⚡' : '🎯'}
                color="text-gold"
              />
            </div>

            {/* 주요 제어 콘솔 패널 */}
            <div className="glass-card p-6 border border-gold/20 shadow-2xl">
              <div className="flex flex-wrap justify-between items-center gap-2 mb-4 pb-3 border-b border-gold/10">
                <div className="flex items-center gap-2">
                  <h3 className="font-display text-xl text-gold">🎮 게임 진행 제어</h3>
                  {isPaused && (
                    <span className="text-xs bg-yellow-500/20 text-yellow-300 px-2 py-0.5 rounded border border-yellow-500/40">
                      일시정지 중
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  {/* 룰 모드 토글: 다수의 선택 vs 소수의 선택 */}
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="text-gray-400 mr-1 font-bold">생존 룰:</span>
                    <button
                      onClick={() => setRuleMode('majority')}
                      disabled={phase === 'voting'}
                      className={`px-3 py-1 rounded-lg font-bold transition-all flex items-center gap-1 ${
                        ruleMode === 'majority'
                          ? 'bg-gradient-to-r from-amber-500 to-yellow-400 text-navy-dark shadow-md shadow-yellow-500/30'
                          : 'bg-navy border border-gold/20 text-gray-300 hover:text-white'
                      }`}
                    >
                      <span>👥 다수의 선택</span>
                    </button>
                    <button
                      onClick={() => setRuleMode('minority')}
                      disabled={phase === 'voting'}
                      className={`px-3 py-1 rounded-lg font-bold transition-all flex items-center gap-1 ${
                        ruleMode === 'minority'
                          ? 'bg-gradient-to-r from-purple-500 to-indigo-500 text-white shadow-md shadow-purple-500/30'
                          : 'bg-navy border border-gold/20 text-gray-300 hover:text-white'
                      }`}
                    >
                      <span>🎯 소수의 선택</span>
                    </button>
                  </div>

                  {/* 문제 제한 시간 설정 */}
                  <div className="flex items-center gap-1 text-xs">
                    <span className="text-gray-400 mr-1">투표 제한시간:</span>
                    {[10, 15, 20, 30].map((sec) => (
                      <button
                        key={sec}
                        onClick={() => setTimeLimit(sec)}
                        disabled={phase === 'voting'}
                        className={`px-2 py-1 rounded font-bold transition-all ${
                          timeLimit === sec
                            ? 'bg-gold text-navy-dark'
                            : 'bg-navy border border-gold/20 text-gray-300 hover:text-white'
                        }`}
                      >
                        {sec}초
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* 현재 적용 중인 룰 안내 배너 */}
              <div className={`mb-4 px-3 py-2 rounded-lg text-xs flex items-center justify-between border ${
                ruleMode === 'minority'
                  ? 'bg-purple-950/40 border-purple-500/40 text-purple-200'
                  : 'bg-gold/10 border-gold/30 text-gold-light'
              }`}>
                <div className="flex items-center gap-2">
                  <span className="font-bold">
                    {ruleMode === 'minority' ? '🎯 [소수의 선택 룰 적용 중]' : '👥 [다수의 선택 룰 적용 중]'}
                  </span>
                  <span>
                    {ruleMode === 'minority'
                      ? '더 적은 사람이 선택한 쪽이 생존합니다. (0표는 제외하고 투표가 발생한 선택지 중 적은 쪽 승리)'
                      : '더 많은 사람이 선택한 쪽이 생존합니다.'}
                  </span>
                </div>
                <span className="text-[11px] opacity-75 font-mono hidden sm:inline">
                  {ruleMode === 'minority' ? 'MINORITY SURVIVAL' : 'MAJORITY SURVIVAL'}
                </span>
              </div>

              {/* 1. 대기실 페이즈 (LOBBY) */}
              {phase === 'lobby' && (
                <div className="space-y-4">
                  <div className="bg-navy-dark/80 p-4 rounded-xl border border-gold/10">
                    <p className="text-sm text-gray-300 mb-3">
                      참가자들이 QR 코드로 닉네임을 등록하고 접속할 때까지 대기합니다.
                    </p>
                    <div className="flex flex-wrap gap-3 items-center">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400">테스트 더미:</span>
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={mockCount}
                          onChange={(e) => setMockCount(Number(e.target.value))}
                          className="w-20 px-3 py-1.5 bg-navy border border-gold/30 rounded text-center text-white font-bold text-sm"
                        />
                      </div>
                      <button
                        onClick={() => addMockPlayers(mockCount)}
                        className="px-4 py-1.5 bg-navy border border-gold/40 rounded text-gold hover:bg-gold/10 text-xs font-bold transition-colors"
                      >
                        더미 참가자 추가
                      </button>

                      <button
                        onClick={() => {
                          if (window.confirm('접속한 모든 참가자를 퇴장시키고 명단을 완전히 비우시겠습니까?')) {
                            clearAllPlayers()
                          }
                        }}
                        className="px-4 py-1.5 bg-red-950/40 border border-red-500/40 rounded text-red-300 hover:bg-red-900/50 text-xs font-bold transition-colors"
                      >
                        🗑️ 참가자 명단 비우기
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row gap-3">
                    <button
                      onClick={() => startGame(true)}
                      disabled={alivePlayers.length < 1}
                      className="flex-1 py-4 bg-gradient-to-r from-gold-dark via-gold to-gold-light text-navy-dark
                                 font-display text-xl md:text-2xl rounded-xl disabled:opacity-40 disabled:cursor-not-allowed
                                 hover:shadow-lg hover:shadow-gold/30 transition-all font-bold"
                    >
                      🚀 1라운드 시작 & 자동 진행 (15초 투표)
                    </button>
                    <button
                      onClick={() => startGame(false)}
                      disabled={alivePlayers.length < 1}
                      className="py-4 px-6 bg-navy-dark border-2 border-gold/40 text-gold hover:bg-gold/15
                                 font-display text-base md:text-lg rounded-xl disabled:opacity-40 disabled:cursor-not-allowed
                                 transition-all font-bold"
                      title="문제를 먼저 화면에 띄우고 MC가 읽은 후 수동으로 투표를 시작합니다"
                    >
                      📖 문제 먼저 읽기 (MC 모드)
                    </button>
                  </div>
                </div>
              )}

              {/* 2. 문제 출제 페이즈 (QUESTION) */}
              {phase === 'question' && currentQuestion && (
                <div className="space-y-4">
                  <div className="bg-navy-dark p-4 rounded-xl border border-gold/20">
                    <div className="flex justify-between items-center mb-2">
                      <span className="px-2.5 py-0.5 bg-gold/10 border border-gold/30 text-gold rounded-full text-xs font-bold">
                        {currentQuestion.category}
                      </span>
                      {currentQuestion.isFinals && (
                        <span className="px-2.5 py-0.5 bg-orange-600/30 border border-orange-500 text-orange-400 rounded-full text-xs font-bold">
                          결승 전용
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-3 mt-3">
                      <div className="p-4 bg-team-a/15 border border-team-a/40 rounded-xl text-center">
                        <span className="text-team-a-light text-xs font-bold">OPTION A</span>
                        <p className="text-white font-bold text-base md:text-lg mt-1">{currentQuestion.optionA}</p>
                      </div>
                      <div className="p-4 bg-team-b/15 border border-team-b/40 rounded-xl text-center">
                        <span className="text-team-b-light text-xs font-bold">OPTION B</span>
                        <p className="text-white font-bold text-base md:text-lg mt-1">{currentQuestion.optionB}</p>
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={handleStartVoting}
                    className="w-full py-4 bg-gradient-to-r from-green-600 via-green-500 to-emerald-400 text-white
                               font-display text-2xl rounded-xl hover:shadow-lg hover:shadow-green-500/30 transition-all font-bold animate-pulse"
                  >
                    ⏱️ {timeLimit}초 투표 시작하기
                  </button>
                </div>
              )}

              {/* 3. 투표 진행 중 페이즈 (VOTING) */}
              {phase === 'voting' && (
                <div className="space-y-4">
                  <div className="text-center py-2">
                    <div className={`font-display text-7xl ${isPaused ? 'text-yellow-400' : votingTimeLeft <= 5 ? 'text-team-a animate-countdown-urgent' : 'text-gold'}`}>
                      {votingTimeLeft}
                    </div>
                    <p className="text-gray-400 text-sm mt-1">
                      {isPaused ? '⏸️ 투표가 일시정지되었습니다' : `${timeLimit}초 서버 기준 카운트다운 진행 중`}
                    </p>
                  </div>

                  <div className="bg-navy-dark p-4 rounded-xl border border-gold/15">
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-gray-400">실시간 투표 완료 현황</span>
                      <span className="text-gold font-bold">
                        {voteCount} / {alivePlayers.length}명 ({alivePlayers.length > 0 ? Math.round((voteCount / alivePlayers.length) * 100) : 0}%)
                      </span>
                    </div>
                    <div className="h-3.5 bg-gray-800 rounded-full overflow-hidden">
                      <motion.div
                        className="h-full bg-gradient-to-r from-gold-dark to-gold rounded-full"
                        animate={{ width: `${alivePlayers.length > 0 ? (voteCount / alivePlayers.length) * 100 : 0}%` }}
                        transition={{ duration: 0.3 }}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {/* 일시정지 / 재개 버튼 */}
                    {isPaused ? (
                      <button
                        onClick={resumeGame}
                        className="py-3 bg-green-700 hover:bg-green-600 text-white font-bold rounded-xl text-sm border border-green-500 shadow"
                      >
                        ▶️ 투표 재개
                      </button>
                    ) : (
                      <button
                        onClick={pauseGame}
                        className="py-3 bg-yellow-600 hover:bg-yellow-500 text-white font-bold rounded-xl text-sm border border-yellow-400 shadow"
                      >
                        ⏸️ 투표 일시정지
                      </button>
                    )}

                    <button
                      onClick={simulateVotes}
                      disabled={isPaused}
                      className="py-3 bg-navy-lighter border border-gold/30 rounded-xl text-gold hover:bg-gold/15 text-sm font-bold disabled:opacity-50"
                    >
                      🤖 AI 투표 채우기
                    </button>

                    <button
                      onClick={() => endVoting()}
                      className="py-3 bg-red-900/60 border border-red-500/50 rounded-xl text-red-300 hover:bg-red-800 text-sm font-bold"
                    >
                      ⏹️ 즉시 마감
                    </button>
                  </div>
                </div>
              )}

              {/* 4. 결과 공개 3초 카운트다운 페이즈 (REVEALING) */}
              {phase === 'revealing' && (
                <div className="text-center py-6 space-y-3">
                  <span className="text-gold text-sm tracking-widest font-mono">SUSPENSE COUNTDOWN</span>
                  <div className="font-display text-8xl text-indigo-400 animate-bounce">
                    {revealingTimeLeft}
                  </div>
                  <h4 className="font-display text-2xl text-white">결과를 공개하는 중입니다...</h4>
                  <p className="text-gray-400 text-xs">서버에서 다수/소수/동률 및 생존자를 판정하고 있습니다.</p>
                </div>
              )}

              {/* 5. 결과 및 탈락자 확인 페이즈 (RESULT / ELIMINATION) */}
              {(phase === 'result' || phase === 'elimination') && currentResult && (
                <div className="space-y-4">
                  <div className="bg-navy-dark p-5 rounded-xl border border-gold/20">
                    <div className="flex justify-between text-xs text-gray-400 mb-2">
                      <span>ROUND {roundNumber} 투표 결과</span>
                      <span className="text-red-400">미투표 탈락자: {currentResult.nonVoters}명</span>
                    </div>

                    <div className="grid grid-cols-2 gap-4 my-3 text-center">
                      <div className="p-4 bg-team-a/15 border border-team-a/40 rounded-xl">
                        <div className="text-team-a font-display text-5xl">{currentResult.votesA}표</div>
                        <p className="text-white text-sm font-bold mt-2 truncate">{currentResult.question.optionA}</p>
                      </div>
                      <div className="p-4 bg-team-b/15 border border-team-b/40 rounded-xl">
                        <div className="text-team-b font-display text-5xl">{currentResult.votesB}표</div>
                        <p className="text-white text-sm font-bold mt-2 truncate">{currentResult.question.optionB}</p>
                      </div>
                    </div>

                    <div className="text-center pt-3 border-t border-gold/10">
                      <span className={`text-lg font-bold ${
                        currentResult.majority === 'tie' ? 'text-gold' :
                        currentResult.majority === 'A' ? 'text-team-a' : 'text-team-b'
                      }`}>
                        {currentResult.majority === 'tie'
                          ? '⚖️ 동률! 투표 참여자 전원 생존'
                          : currentResult.ruleMode === 'minority'
                            ? `🎯 [${currentResult.majority}] 소수 승리! (소수의 선택)`
                            : `🏆 [${currentResult.majority}] 다수 승리! (다수의 선택)`}
                      </span>
                      <p className="text-gray-400 text-xs mt-1">
                        탈락 {currentResult.eliminated.length}명 ({currentResult.ruleMode === 'minority' ? '다수' : '소수'} + 미투표) │ 잔여 생존자 {currentResult.survivors.length}명
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    {autoAdvance && resultCountdown > 0 && currentResult.survivors.length > 2 && (
                      <div className="text-center py-2.5 px-4 bg-gold/15 border border-gold/40 rounded-xl text-gold font-bold text-sm animate-pulse flex items-center justify-center gap-2">
                        <span>⏱️ {resultCountdown}초 후 다음 라운드가 자동으로 시작됩니다...</span>
                      </div>
                    )}
                    {autoAdvance && resultCountdown > 0 && currentResult.survivors.length <= 2 && currentResult.survivors.length > 0 && (
                      <div className="text-center py-2.5 px-4 bg-yellow-500/20 border border-yellow-400/60 rounded-xl text-yellow-300 font-bold text-sm animate-pulse flex items-center justify-center gap-2">
                        <span>🏆 최후의 {currentResult.survivors.length}인 결정! {resultCountdown}초 후 최종 우승 결과가 발표되고 경기가 종료됩니다...</span>
                      </div>
                    )}
                    <div className="flex gap-3">
                      <button
                        onClick={nextRound}
                        className={`flex-1 py-4 font-display text-xl md:text-2xl rounded-xl hover:shadow-lg transition-all font-bold ${
                          currentResult.survivors.length <= 2 && currentResult.survivors.length > 0
                            ? 'bg-gradient-to-r from-yellow-500 via-amber-400 to-yellow-300 text-navy-dark shadow-amber-500/40 ring-4 ring-yellow-400/40 animate-pulse'
                            : 'bg-gradient-to-r from-gold-dark via-gold to-gold-light text-navy-dark hover:shadow-gold/30'
                        }`}
                      >
                        {currentResult.survivors.length <= 2 && currentResult.survivors.length > 0
                          ? `🏆 즉시 최종 결과 발표 & 경기 종료 (${currentResult.survivors.length}명 우승)`
                          : `➡️ 즉시 다음 라운드 진행 (${currentResult.survivors.length}명 생존)`}
                      </button>
                      <button
                        onClick={() => setAutoAdvance(!autoAdvance)}
                        className={`px-4 py-4 rounded-xl font-bold text-xs md:text-sm border transition-all ${
                          autoAdvance
                            ? 'bg-green-950/50 border-green-500/60 text-green-300'
                            : 'bg-gray-800 border-gray-600 text-gray-400'
                        }`}
                        title="자동 라운드 진행 켜기/끄기"
                      >
                        {autoAdvance ? '⚡ 자동진행: ON' : '⏸️ 자동진행: OFF'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* 6. 게임 종료 페이즈 (GAMEOVER) */}
              {phase === 'gameover' && (
                <div className="text-center py-6 space-y-4">
                  <div className="text-7xl animate-bounce">🏆</div>
                  {alivePlayers.length === 1 ? (
                    <div>
                      <span className="px-3 py-1 bg-gold/20 text-gold border border-gold/40 rounded-full text-xs font-bold">
                        단독 우승 예외 처리
                      </span>
                      <h3 className="font-display text-3xl text-gold mt-2">단독 챔피언 탄생!</h3>
                      <p className="text-gray-400 text-sm">마지막까지 홀로 살아남은 최종 우승자입니다.</p>
                    </div>
                  ) : (
                    <div>
                      <h3 className="font-display text-4xl text-gold">THE LAST TWO</h3>
                      <p className="text-gray-300 text-sm mt-1">최후의 2인이 결정되었습니다!</p>
                    </div>
                  )}

                  <div className="flex gap-4 justify-center my-4">
                    {alivePlayers.map((p) => (
                      <div key={p.id} className="glass-card p-5 border border-gold/40 animate-pulse-glow shadow-xl">
                        <div className="w-14 h-14 mx-auto rounded-full bg-gold text-navy-dark flex items-center justify-center font-display text-2xl mb-2">
                          {p.nickname.charAt(0)}
                        </div>
                        <p className="font-display text-xl text-gold">{p.nickname}</p>
                        <p className="text-xs text-gray-400 mt-1">최종 우승자</p>
                      </div>
                    ))}
                  </div>

                  <div className="flex gap-3 pt-3">
                    <button
                      onClick={handleExcelExport}
                      className="flex-1 py-3 bg-green-700 hover:bg-green-600 text-white font-display text-lg rounded-xl font-bold border border-green-500"
                    >
                      📊 결과 엑셀 다운로드
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm('현재 게임을 마치고 새 게임을 준비하시겠습니까?\n(접속한 참가자들은 유지되며 전원 생존 상태로 대기실에 남아있습니다)')) {
                          resetGame()
                        }
                      }}
                      className="flex-1 py-3 bg-gradient-to-r from-gold-dark to-gold text-navy-dark rounded-xl font-display text-lg font-bold shadow-lg shadow-gold/20"
                    >
                      🔄 다음 게임 준비 (참가자 유지 리셋)
                    </button>
                  </div>
                </div>
              )}

              {/* 하단 보조 제어 도구 모음 */}
              <div className="pt-4 mt-6 border-t border-gold/15 flex flex-wrap gap-2 justify-between items-center text-xs">
                <div className="flex gap-2">
                  {!isFinals && phase !== 'gameover' && phase !== 'lobby' && (
                    <button
                      onClick={enterFinals}
                      className="px-3 py-1.5 bg-orange-950/40 border border-orange-500/50 text-orange-400 hover:bg-orange-900/50 rounded font-bold"
                    >
                      ⚡ 결승 모드로 수동 진입
                    </button>
                  )}
                  {phase !== 'gameover' && phase !== 'lobby' && (
                    <button
                      onClick={forceEndGame}
                      className="px-3 py-1.5 bg-red-950/40 border border-red-500/40 text-red-400 hover:bg-red-900/50 rounded font-bold"
                    >
                      🏁 게임 강제 종료
                    </button>
                  )}
                </div>

                <button
                  onClick={resetGame}
                  className="px-3 py-1.5 text-gray-400 hover:text-red-400 underline"
                >
                  전체 초기화 (Lobby 리셋)
                </button>
              </div>
            </div>

            {/* 라운드 히스토리 테이블 */}
            {roundResults.length > 0 && (
              <div className="glass-card p-4 border border-gold/15">
                <h3 className="font-display text-sm text-gold mb-3 flex items-center justify-between">
                  <span>📋 라운드 누적 히스토리</span>
                  <span className="text-xs text-gray-400">총 {roundResults.length}개 완료</span>
                </h3>
                <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                  {roundResults.map((r, i) => (
                    <div key={i} className="flex items-center justify-between bg-navy-dark/60 rounded-lg px-3 py-2 text-xs border border-gold/10">
                      <span className="text-gray-400 font-bold font-mono">R{i + 1}</span>
                      <span className="text-white truncate mx-3 flex-1 font-medium">
                        {r.question.optionA} vs {r.question.optionB}
                      </span>
                      <span className="text-team-a font-bold">{r.votesA}</span>
                      <span className="text-gray-500 mx-1">:</span>
                      <span className="text-team-b font-bold">{r.votesB}</span>
                      <span className="text-red-400 ml-3 font-mono font-bold">-{r.eliminated.length}명</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ===== 우측 1열: QR 코드 & 실시간 참가자 명단 ===== */}
          <div className="space-y-5">
            {/* 참가자 접속용 QR 코드 */}
            <div className="glass-card p-5 text-center border border-gold/20 shadow-xl">
              <div className="flex justify-between items-center mb-2">
                <h3 className="font-display text-base text-gold">📱 모바일 참가자 접속 QR</h3>
                <button
                  onClick={() => setIsEditingUrl(!isEditingUrl)}
                  className="text-xs text-gold/70 hover:text-gold underline"
                >
                  {isEditingUrl ? '닫기' : '주소 변경'}
                </button>
              </div>

              {/* 주소 선택 프리셋 버튼 */}
              <div className="flex flex-col gap-1.5 mb-3 text-left">
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setQrMode('wifi')
                      setServerHostUrl(wifiUrl)
                      setCustomUrlInput(wifiUrl)
                    }}
                    className={`flex-1 px-2 py-1 rounded text-[11px] font-bold border transition-all ${
                      (qrMode === 'wifi' || (!qrMode && !joinUrl.includes('serveousercontent') && !joinUrl.includes('lhr.life')))
                        ? 'bg-gold text-navy-dark border-gold shadow-md shadow-gold/20'
                        : 'bg-navy border-gold/20 text-gray-300 hover:text-white'
                    }`}
                  >
                    📶 같은 Wi-Fi 접속
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setQrMode('tunnel')
                      const target = tunnelUrl || publicUrl || customUrlInput
                      if (target) {
                        setServerHostUrl(target)
                        setCustomUrlInput(target)
                      }
                    }}
                    className={`flex-1 px-2 py-1 rounded text-[11px] font-bold border transition-all ${
                      (qrMode === 'tunnel' || (!qrMode && isPublicDomain) || (!qrMode && (joinUrl.includes('serveousercontent') || joinUrl.includes('lhr.life'))))
                        ? 'bg-gold text-navy-dark border-gold shadow-md shadow-gold/20'
                        : 'bg-navy border-gold/20 text-gray-300 hover:text-white'
                    }`}
                  >
                    🌍 어디서나(LTE/5G) 🟢
                  </button>
                </div>

                {isEditingUrl && (
                  <div className="mt-1 flex gap-1">
                    <input
                      type="text"
                      value={customUrlInput}
                      onChange={(e) => setCustomUrlInput(e.target.value)}
                      placeholder="접속 주소 직접 입력"
                      className="flex-1 px-2 py-1 bg-navy-dark border border-gold/30 rounded text-xs text-white"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setServerHostUrl(customUrlInput.trim())
                        setIsEditingUrl(false)
                      }}
                      className="px-2.5 py-1 bg-gold text-navy-dark text-xs font-bold rounded"
                    >
                      적용
                    </button>
                  </div>
                )}
              </div>

              <div className="bg-white p-3.5 rounded-2xl inline-block shadow-lg">
                <QRCodeCanvas
                  id="admin-qr-canvas"
                  value={joinUrl}
                  size={170}
                  bgColor="#ffffff"
                  fgColor="#0B1426"
                  level="H"
                  includeMargin={true}
                />
              </div>

              {/* QR 다운로드 및 링크 복사 버튼 */}
              <div className="mt-4 flex flex-col sm:flex-row gap-2 justify-center">
                <button
                  onClick={handleDownloadQR}
                  className="px-3.5 py-2 bg-gradient-to-r from-gold-dark to-gold text-navy-dark rounded-xl text-xs font-bold hover:shadow-lg hover:shadow-gold/30 transition-all flex items-center justify-center gap-1.5 shadow"
                  title="인쇄용 고화질 PNG 이미지로 다운로드"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  QR 이미지 저장
                </button>

                <button
                  onClick={handleCopyLink}
                  className="px-3.5 py-2 bg-navy border border-gold/30 text-gold rounded-xl text-xs font-bold hover:bg-gold/15 transition-all flex items-center justify-center gap-1.5"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  {copied ? '복사 완료!' : '접속 링크 복사'}
                </button>
              </div>

              <p className="text-gray-400 text-xs mt-3 break-all font-mono bg-navy-dark p-2 rounded border border-gold/10">
                {joinUrl}
              </p>
            </div>

            {/* 참가자 실시간 상태 명단 */}
            <div className="glass-card p-5 border border-gold/20 shadow-xl">
              <div className="flex items-center justify-between mb-3 pb-2 border-b border-gold/10">
                <h3 className="font-display text-base text-gold">
                  👥 참가자 목록 ({players.length}/100)
                </h3>
                <div className="flex gap-2 text-xs font-bold">
                  <span className="text-green-400">생존 {alivePlayers.length}</span>
                  <span className="text-red-400">탈락 {eliminatedPlayers.length}</span>
                </div>
              </div>

              <div className="space-y-1.5 max-h-[55vh] overflow-y-auto pr-1">
                <AnimatePresence>
                  {players.map((player) => (
                    <motion.div
                      key={player.id}
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm border transition-colors
                        ${player.status === 'alive'
                          ? 'bg-navy-dark/80 border-gold/15 text-white'
                          : 'bg-red-950/20 border-red-900/30 text-gray-500 opacity-60'
                        }`}
                    >
                      <div className="flex items-center gap-2">
                        <div className={`w-2.5 h-2.5 rounded-full ${
                          player.status === 'alive' ? 'bg-green-400 shadow-sm shadow-green-400' : 'bg-red-500'
                        }`} />
                        <span className={player.status === 'alive' ? 'font-medium' : 'line-through text-gray-500'}>
                          {player.nickname}
                        </span>
                      </div>
                      {player.status === 'alive' && votes[player.id] && (
                        <span className={`text-xs font-bold px-2 py-0.5 rounded font-mono ${
                          votes[player.id] === 'A'
                            ? 'bg-team-a/20 text-team-a-light border border-team-a/40'
                            : 'bg-team-b/20 text-team-b-light border border-team-b/40'
                        }`}>
                          {votes[player.id]}
                        </span>
                      )}
                      {player.status === 'eliminated' && player.eliminatedRound && (
                        <span className="text-[11px] text-gray-500 font-mono">R{player.eliminatedRound} 탈락</span>
                      )}
                    </motion.div>
                  ))}
                </AnimatePresence>
                {players.length === 0 && (
                  <p className="text-center text-gray-500 text-xs py-8">아직 참가자가 없습니다.</p>
                )}
              </div>
            </div>

            {/* 실시간 사내 채팅 모니터링 */}
            <div className="glass-card p-4 border border-gold/20 shadow-xl">
              <div className="flex items-center justify-between mb-2 pb-2 border-b border-gold/10">
                <h3 className="font-display text-sm text-gold flex items-center gap-1.5">
                  <span>💬 실시간 응원톡</span>
                  <span className="text-xs text-gray-400 font-mono">({store.chatMessages.length})</span>
                </h3>
                <button
                  onClick={() => store.clearChatMessages()}
                  className="text-[11px] text-gray-400 hover:text-red-400 underline"
                >
                  채팅 비우기
                </button>
              </div>
              <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1 text-xs">
                {store.chatMessages.map((msg) => (
                  <div key={msg.id} className="bg-navy-dark/80 px-2.5 py-1.5 rounded border border-gold/10">
                    <span className="text-gold font-bold mr-1.5">{msg.nickname}:</span>
                    <span className="text-gray-200">{msg.message}</span>
                  </div>
                ))}
                {store.chatMessages.length === 0 && (
                  <p className="text-gray-500 text-center py-4">등록된 메시지가 없습니다.</p>
                )}
              </div>
            </div>
          </div>
        </main>
      ) : (
        /* ===== 문제 관리 전용 탭 ===== */
        <main className="p-4 md:p-6 max-w-5xl mx-auto space-y-4">
          <div className="flex flex-wrap justify-between items-center bg-navy-dark p-5 rounded-2xl border border-gold/20 gap-3">
            <div>
              <h2 className="font-display text-2xl text-gold">📝 밸런스 게임 문제 풀 관리</h2>
              <p className="text-xs text-gray-400 mt-1">
                기본 30개 문제와 결승 10개 문제를 실시간 추가/수정/삭제합니다.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={resetQuestionsToDefault}
                className="px-3.5 py-2 bg-navy border border-gold/30 rounded-lg text-xs text-gold hover:bg-gold/10 font-bold"
              >
                기본 30문제로 복원
              </button>
              <button
                onClick={() => {
                  setEditingQuestion(null)
                  setFormOptionA('')
                  setFormOptionB('')
                  setFormIsFinals(false)
                  setShowAddModal(true)
                }}
                className="px-4 py-2 bg-gold text-navy-dark rounded-lg text-xs font-bold hover:bg-gold-light shadow"
              >
                + 새 문제 등록
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 max-h-[70vh] overflow-y-auto pr-1">
            {questionsList.map((q, idx) => (
              <div
                key={q.id}
                className={`p-4 rounded-xl border transition-all ${
                  q.isFinals
                    ? 'bg-orange-950/25 border-orange-500/40'
                    : 'bg-navy-dark/90 border-gold/15'
                }`}
              >
                <div className="flex justify-between items-center mb-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-gray-500">#{idx + 1}</span>
                    <span className="px-2 py-0.5 rounded text-xs bg-navy text-gold border border-gold/25 font-bold">
                      {q.category}
                    </span>
                    {q.isFinals && (
                      <span className="px-2 py-0.5 rounded text-[11px] bg-orange-600/30 text-orange-400 border border-orange-500/40 font-bold">
                        결승 전용
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2 text-xs font-bold">
                    <button
                      onClick={() => {
                        setEditingQuestion(q)
                        setFormCategory(q.category)
                        setFormOptionA(q.optionA)
                        setFormOptionB(q.optionB)
                        setFormIsFinals(Boolean(q.isFinals))
                        setShowAddModal(true)
                      }}
                      className="text-blue-400 hover:text-blue-300"
                    >
                      수정
                    </button>
                    <button
                      onClick={() => deleteQuestionItem(q.id)}
                      className="text-red-400 hover:text-red-300"
                    >
                      삭제
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="p-2.5 bg-team-a/10 border border-team-a/30 rounded text-center">
                    <span className="text-[10px] text-team-a-light block font-bold">A (레드)</span>
                    <p className="font-bold text-white text-xs mt-1">{q.optionA}</p>
                  </div>
                  <div className="p-2.5 bg-team-b/10 border border-team-b/30 rounded text-center">
                    <span className="text-[10px] text-team-b-light block font-bold">B (블루)</span>
                    <p className="font-bold text-white text-xs mt-1">{q.optionB}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* 모달 */}
          {showAddModal && (
            <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 z-50">
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-navy-dark border border-gold/40 rounded-2xl p-6 max-w-md w-full shadow-2xl"
              >
                <h3 className="font-display text-2xl text-gold mb-4">
                  {editingQuestion ? '문제 수정' : '새 밸런스 문제 등록'}
                </h3>
                <form onSubmit={handleSaveQuestion} className="space-y-4">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">카테고리</label>
                    <input
                      type="text"
                      value={formCategory}
                      onChange={(e) => setFormCategory(e.target.value)}
                      required
                      className="w-full px-3 py-2 bg-navy border border-gold/30 rounded-lg text-white text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-team-a-light mb-1 font-bold">선택지 A (레드)</label>
                    <input
                      type="text"
                      value={formOptionA}
                      onChange={(e) => setFormOptionA(e.target.value)}
                      required
                      className="w-full px-3 py-2 bg-navy border border-team-a/50 rounded-lg text-white text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-team-b-light mb-1 font-bold">선택지 B (블루)</label>
                    <input
                      type="text"
                      value={formOptionB}
                      onChange={(e) => setFormOptionB(e.target.value)}
                      required
                      className="w-full px-3 py-2 bg-navy border border-team-b/50 rounded-lg text-white text-sm"
                    />
                  </div>
                  <div className="flex items-center gap-2 pt-2">
                    <input
                      type="checkbox"
                      id="finalsCheckbox"
                      checked={formIsFinals}
                      onChange={(e) => setFormIsFinals(e.target.checked)}
                      className="rounded border-gold/40 text-gold focus:ring-gold"
                    />
                    <label htmlFor="finalsCheckbox" className="text-sm text-gray-300">
                      결승 모드 전용 문제로 지정
                    </label>
                  </div>
                  <div className="flex gap-2.5 pt-4">
                    <button
                      type="button"
                      onClick={() => setShowAddModal(false)}
                      className="flex-1 py-2.5 bg-navy-lighter rounded-lg text-gray-400 hover:text-white text-sm font-bold"
                    >
                      취소
                    </button>
                    <button
                      type="submit"
                      className="flex-1 py-2.5 bg-gradient-to-r from-gold-dark to-gold text-navy-dark font-display text-base font-bold rounded-lg shadow"
                    >
                      저장하기
                    </button>
                  </div>
                </form>
              </motion.div>
            </div>
          )}
        </main>
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  icon,
  color = 'text-white',
}: {
  label: string
  value: number | string
  icon: string
  color?: string
}) {
  return (
    <div className="glass-card-dark p-4 text-center border border-gold/15 shadow">
      <div className="text-2xl mb-1">{icon}</div>
      <div className={`font-display text-2xl ${color}`}>{value}</div>
      <div className="text-gray-400 text-xs font-medium mt-0.5">{label}</div>
    </div>
  )
}
