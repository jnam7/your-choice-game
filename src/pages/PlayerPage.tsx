import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { socket } from '../socket'
import { writeFirebasePlayer } from '../firebase'
import { useGameStore } from '../store/gameStore'
import { useCountdown } from '../hooks/useCountdown'
import { useFirebaseSync } from '../hooks/useFirebaseSync'
import { LiveChatDrawer } from '../components/LiveChatDrawer'
import {
  unlockAudioContext,
  isSoundMuted,
  toggleSoundMute,
  playClickSound,
  playSurviveSound,
  playEliminatedSound,
  playGameoverFanfare,
  triggerVibration,
} from '../utils/sound'
import type { Player } from '../types/game'

// ===== 사운드 음소거 토글 버튼 =====
function SoundMuteButton({ className = '' }: { className?: string }) {
  const [muted, setMuted] = useState(() => isSoundMuted())

  const handleToggle = () => {
    unlockAudioContext()
    const next = toggleSoundMute()
    setMuted(next)
  }

  return (
    <button
      onClick={handleToggle}
      className={`p-2.5 rounded-xl transition-all duration-300 backdrop-blur shadow-lg flex items-center justify-center border ${
        muted
          ? 'bg-red-950/70 border-red-500/50 text-red-300 hover:bg-red-900/80'
          : 'bg-navy-dark/80 hover:bg-gold hover:text-navy-dark border-gold/30 text-gold'
      } ${className}`}
      title={muted ? '소리 켜기' : '소리 끄기 (음소거)'}
    >
      {muted ? (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
        </svg>
      )}
    </button>
  )
}

// ===== 관리자 페이지 바로가기 버튼 =====
function AdminShortcutButton({ className = '' }: { className?: string }) {
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
      className={`p-2.5 rounded-xl transition-all duration-300 backdrop-blur shadow-lg flex items-center justify-center border bg-navy-dark/80 hover:bg-gold hover:text-navy-dark border-gold/30 text-gold/80 hover:text-navy-dark cursor-pointer group ${className}`}
      title="관리자 페이지(/admin)를 새 탭/새 창에서 열기"
    >
      <svg className="w-4 h-4 transition-transform group-hover:rotate-45" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
      <span className="hidden sm:inline text-xs font-bold ml-1.5">관리자</span>
    </a>
  )
}

// ===== 로고 컴포넌트 =====
function Logo({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const sizes = {
    sm: 'text-lg',
    md: 'text-2xl md:text-3xl',
    lg: 'text-3xl md:text-5xl',
  }
  return (
    <div className="text-center">
      <h1 className={`font-display ${sizes[size]} text-gold text-shadow-glow`}>
        당신의 선택
      </h1>
      <p className={`font-display ${size === 'lg' ? 'text-xl md:text-2xl' : 'text-sm md:text-base'} text-gold-light tracking-[0.3em] mt-1`}>
        YOUR CHOICE - THE LAST TWO
      </p>
    </div>
  )
}

// ===== 닉네임 입력 폼 =====
function NicknameForm({ onJoin }: { onJoin: (player: Player) => void }) {
  const [nickname, setNickname] = useState(() => {
    return typeof window !== 'undefined' ? localStorage.getItem('lasttwo_player_nickname') || '' : ''
  })
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const { addPlayer, players } = useGameStore()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    unlockAudioContext()
    const trimmed = nickname.trim()

    if (!trimmed) {
      setError('닉네임을 입력해주세요')
      return
    }
    if (trimmed.length > 10) {
      setError('10자 이하로 입력해주세요')
      return
    }

    try {
      setIsSubmitting(true)
      const savedId = typeof window !== 'undefined' ? localStorage.getItem('lasttwo_player_id') : null
      const existing = players.find((p) => p.nickname === trimmed)
      const localId = existing ? existing.id : (savedId || ('p_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6)))

      // 1. 로컬 스토리지에 즉시 저장
      if (typeof window !== 'undefined') {
        localStorage.setItem('lasttwo_player_id', localId)
        localStorage.setItem('lasttwo_player_nickname', trimmed)
      }

      // 2. Zustand 스토어에 즉시 등록
      addPlayer(trimmed, localId)

      // 3. 로컬 참가자 객체 생성 후 onJoin 즉시 호출하여 대기실(WaitingRoom) 화면으로 즉시 전환
      const newPlayer: Player = {
        id: localId,
        nickname: trimmed,
        status: 'alive',
        joinedAt: Date.now(),
      }
      onJoin(newPlayer)

      // 4. Firebase Realtime DB에 즉시 등록 (관리자/TV 참석 인원 실시간 연동)
      writeFirebasePlayer(newPlayer).catch(() => {})

      // 5. 백그라운드로 소켓 통신 전송 (네트워크 지연과 무관하게 비동기 동기화)
      socket.emit('player:join', { id: localId, nickname: trimmed }, (res: any) => {
        if (res?.success && res?.player) {
          onJoin(res.player)
        }
      })

      // 5. REST API 백업 전송 (네트워크 지연/차단 시에도 서버 players 및 TV 화면에 100% 반영)
      fetch('/api/game/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: localId, nickname: trimmed }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.player) {
            onJoin(data.player)
          }
        })
        .catch(() => {})

      fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: localId, nickname: trimmed }),
      }).catch(() => {})
    } catch (err) {
      console.error('[NicknameForm handleSubmit error]', err)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="particles-bg" />

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        className="text-center mb-12"
      >
        <Logo size="lg" />
      </motion.div>

      <motion.form
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.6 }}
        onSubmit={handleSubmit}
        className="w-full max-w-sm"
      >
        <div className="glass-card p-8">
          <h2 className="font-display text-xl text-center text-white mb-6">
            닉네임을 입력하세요
          </h2>

          <input
            type="text"
            value={nickname}
            onChange={(e) => { setNickname(e.target.value); setError('') }}
            placeholder="닉네임 (최대 10자)"
            maxLength={10}
            autoFocus
            className="w-full px-4 py-4 bg-navy-dark border-2 border-gold/30 rounded-xl
                       text-white text-center text-xl font-bold placeholder:text-gray-500
                       focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold/20
                       transition-all duration-300"
          />

          {error && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-red-400 text-sm text-center mt-3"
            >
              {error}
            </motion.p>
          )}

          <motion.button
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            type="submit"
            className="w-full mt-6 py-4 bg-gradient-to-r from-gold-dark to-gold
                       text-navy-dark font-display text-xl rounded-xl
                       shadow-lg shadow-gold/20 hover:shadow-gold/40
                       transition-shadow duration-300"
          >
            참가하기
          </motion.button>
        </div>

        <p className="text-center text-gray-500 text-sm mt-4">
          현재 {players.length}명 참가 중
        </p>
      </motion.form>
    </div>
  )
}

// ===== 대기실 =====
function WaitingRoom({
  player,
  onNicknameChange,
  onLeave,
}: {
  player?: Player
  onNicknameChange?: (newNick: string) => void
  onLeave?: () => void
}) {
  const players = useGameStore((s) => s.players)
  const currentPlayerId = useGameStore((s) => s.currentPlayerId)
  const phase = useGameStore((s) => s.phase)
  const changeNickname = useGameStore((s) => s.changeNickname)

  const currentPlayer = players.find((p) => p.id === currentPlayerId) || player
  const [isEditing, setIsEditing] = useState(false)
  const [editInput, setEditInput] = useState(currentPlayer?.nickname || '')
  const [editError, setEditError] = useState('')

  // 대기실 체류 중 서버에 지속적 하트비트 등록 (관리자/TV에 접속 카운트 100% 누락 방지)
  useEffect(() => {
    const localId = currentPlayer?.id || (typeof window !== 'undefined' ? localStorage.getItem('lasttwo_player_id') : null)
    const localNick = currentPlayer?.nickname || (typeof window !== 'undefined' ? localStorage.getItem('lasttwo_player_nickname') : null)
    if (!localId || !localNick) return

    const ensureRegistered = () => {
      socket.emit('player:join', { id: localId, nickname: localNick })
      fetch('/api/game/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: localId, nickname: localNick }),
      }).catch(() => {})
    }

    ensureRegistered()
    const timer = setInterval(ensureRegistered, 3000)
    return () => clearInterval(timer)
  }, [currentPlayer?.id, currentPlayer?.nickname])

  const handleSaveNickname = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = editInput.trim()
    if (!trimmed) {
      setEditError('닉네임을 입력해주세요')
      return
    }
    if (trimmed.length > 10) {
      setEditError('10자 이하로 입력해주세요')
      return
    }
    changeNickname(trimmed)
    onNicknameChange?.(trimmed)
    setIsEditing(false)
    setEditError('')
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="particles-bg" />

      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center mb-8"
      >
        <Logo size="md" />
      </motion.div>

      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="glass-card p-8 w-full max-w-sm text-center"
      >
        <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-gradient-to-br from-gold to-gold-dark
                        flex items-center justify-center animate-pulse-glow">
          <span className="text-3xl font-display text-navy-dark">
            {(editInput || currentPlayer?.nickname || '?').charAt(0)}
          </span>
        </div>

        {isEditing ? (
          <form onSubmit={handleSaveNickname} className="my-2">
            <input
              type="text"
              value={editInput}
              onChange={(e) => { setEditInput(e.target.value); setEditError('') }}
              maxLength={10}
              placeholder="새 닉네임 (최대 10자)"
              className="w-full px-3 py-2 bg-navy-dark border-2 border-gold rounded-xl text-white text-center font-bold focus:outline-none"
              autoFocus
            />
            {editError && <p className="text-red-400 text-xs mt-1">{editError}</p>}
            <div className="flex gap-2 mt-3">
              <button
                type="submit"
                className="flex-1 py-2 bg-gradient-to-r from-gold-dark to-gold text-navy-dark font-display font-bold text-sm rounded-lg"
              >
                저장
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsEditing(false)
                  setEditInput(currentPlayer?.nickname || '')
                  setEditError('')
                }}
                className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 font-bold text-sm rounded-lg"
              >
                취소
              </button>
            </div>
          </form>
        ) : (
          <div>
            <div className="flex items-center justify-center gap-2 mb-1">
              <h2 className="font-display text-2xl text-gold">
                {currentPlayer?.nickname}
              </h2>
              <button
                onClick={() => {
                  setEditInput(currentPlayer?.nickname || '')
                  setIsEditing(true)
                }}
                className="px-2.5 py-1 bg-gold/20 hover:bg-gold/30 border border-gold/40 text-gold text-xs rounded-full font-bold transition-all flex items-center gap-1 active:scale-95"
                title="닉네임 수정하기"
              >
                ✏️ 수정
              </button>
            </div>

            {/* 대기실 상태 및 퇴장/닉네임 변경 버튼 */}
            <div className="flex flex-col items-center gap-3 my-5 w-full">
              <div className="flex items-center justify-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                <p className="text-emerald-400 text-sm font-bold">게임 대기실 입장 완료</p>
              </div>

              <button
                type="button"
                onClick={onLeave}
                className="w-full py-2.5 px-4 bg-red-950/40 hover:bg-red-900/60 border border-red-500/40 hover:border-red-500/80 text-red-300 hover:text-white text-xs md:text-sm rounded-xl font-bold transition-all flex items-center justify-center gap-2 active:scale-95 shadow"
                title="퇴장하고 로컬 세션을 완전히 초기화한 후 닉네임 입력 화면으로 복귀합니다"
              >
                <span>🚪 퇴장하기 / 닉네임 변경</span>
              </button>
            </div>
          </div>
        )}

        <div className="bg-navy-dark rounded-xl p-4 mb-4">
          <p className="text-gold text-sm mb-1">현재 접속 참가자</p>
          <p className="font-display text-4xl text-white">{players.length}명</p>
        </div>

        <motion.div
          animate={{ opacity: [0.5, 1, 0.5] }}
          transition={{ repeat: Infinity, duration: 2 }}
          className="text-gray-400 text-sm"
        >
          {phase === 'lobby' ? '게임 시작을 기다리는 중...' : '곧 게임이 시작됩니다!'}
        </motion.div>
      </motion.div>
    </div>
  )
}

// ===== 카운트다운 타이머 (원형) =====
function CountdownCircle({ timeLeft, total = 15 }: { timeLeft: number; total?: number }) {
  const radius = 50
  const circumference = 2 * Math.PI * radius
  const safeTotal = total > 0 ? total : 15
  const safeTime = Math.max(0, Math.min(safeTotal, timeLeft))
  const progress = (safeTime / safeTotal) * circumference
  const isUrgent = safeTime <= 5

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width="140" height="140" className="countdown-ring">
        {/* 배경 원 */}
        <circle
          cx="70" cy="70" r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.1)"
          strokeWidth="8"
        />
        {/* 진행 원 */}
        <circle
          cx="70" cy="70" r={radius}
          fill="none"
          stroke={isUrgent ? '#EF4444' : '#FFD700'}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - progress}
          className="transition-all duration-300 ease-linear"
        />
      </svg>
      <span className={`absolute font-display text-5xl font-black ${isUrgent ? 'text-team-a animate-pulse' : 'text-gold'
        }`}>
        {safeTime}
      </span>
    </div>
  )
}

// ===== 2. 문제 출제 대기 화면 (MC 안내 중) =====
function QuestionPreviewScreen({ currentPlayer }: { currentPlayer?: Player | null }) {
  const { currentQuestion, roundNumber, isFinals, ruleMode } = useGameStore()

  // 탈락자는 문제 출제 시에도 관전 화면
  if (currentPlayer && currentPlayer.status === 'eliminated') {
    return <EliminatedScreen />
  }

  if (!currentQuestion) return null

  return (
    <div className="min-h-screen flex flex-col justify-between p-6 max-w-md mx-auto">
      <div className="particles-bg" />

      {/* 헤더 */}
      <div className="text-center pt-2">
        <Logo size="sm" />
        <div className="mt-3 inline-flex flex-wrap items-center justify-center gap-2">
          {isFinals && (
            <span className="px-2 py-0.5 bg-orange-600/40 border border-orange-500 rounded-full text-xs font-bold text-orange-300">
              ⚡ 결승
            </span>
          )}
          <span className="px-3 py-1 bg-gold/15 text-gold text-xs rounded-full border border-gold/30 font-bold">
            ROUND {roundNumber} │ {currentQuestion.category}
          </span>
          <span className={`px-2.5 py-1 text-xs rounded-full border font-bold ${
            ruleMode === 'minority'
              ? 'bg-purple-950/60 border-purple-400 text-purple-200'
              : 'bg-gold/20 border-gold/40 text-gold-light'
          }`}>
            {ruleMode === 'minority' ? '🎯 소수의 선택' : '👥 다수의 선택'}
          </span>
        </div>
        <div className="mt-1 text-xs font-medium text-gold-light/80">
          {ruleMode === 'minority' ? '💡 더 적은 사람이 선택한 쪽이 생존합니다!' : '💡 더 많은 사람이 선택한 쪽이 생존합니다!'}
        </div>
        <h2 className="font-display text-2xl text-white mt-2 text-shadow-white">
          문제를 확인하세요!
        </h2>
      </div>

      {/* 문제 카드 미리보기 */}
      <div className="flex flex-col gap-4 my-auto w-full">
        <motion.div
          initial={{ opacity: 0, x: -30 }}
          animate={{ opacity: 1, x: 0 }}
          className="p-5 rounded-2xl bg-gradient-to-r from-team-a-dark to-team-a border-2 border-red-400/50 text-center shadow-xl"
        >
          <span className="text-red-200 text-xs font-bold tracking-wider block mb-1">A 옵션</span>
          <p className="font-display text-xl text-white font-bold">{currentQuestion.optionA}</p>
        </motion.div>

        <div className="text-center font-display text-2xl text-gold text-shadow-glow">VS</div>

        <motion.div
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          className="p-5 rounded-2xl bg-gradient-to-r from-team-b-dark to-team-b border-2 border-blue-400/50 text-center shadow-xl"
        >
          <span className="text-blue-200 text-xs font-bold tracking-wider block mb-1">B 옵션</span>
          <p className="font-display text-xl text-white font-bold">{currentQuestion.optionB}</p>
        </motion.div>
      </div>

      {/* 대기 안내 배너 */}
      <motion.div
        animate={{ opacity: [0.7, 1, 0.7], scale: [0.98, 1, 0.98] }}
        transition={{ repeat: Infinity, duration: 2 }}
        className="glass-card p-4 text-center border-gold/40 mb-4"
      >
        <div className="text-3xl mb-1 animate-bounce">⏳</div>
        <p className="font-bold text-gold text-base">MC가 문제를 안내하고 있습니다</p>
        <p className="text-gray-300 text-xs mt-1">잠시 후 15초 투표 버튼이 활성화됩니다!</p>
      </motion.div>
    </div>
  )
}

// ===== 3. 투표 화면 =====
function VoteScreen({ currentPlayer }: { currentPlayer?: Player | null }) {
  const { currentQuestion, submitVote, currentPlayerId, votes, isPaused, timeLeft, votingDeadline, timeLimit, roundNumber, ruleMode, phase } = useGameStore()
  
  const isEliminated = currentPlayer?.status === 'eliminated'

  const effectiveId = currentPlayer?.id || currentPlayerId || (typeof window !== 'undefined' ? localStorage.getItem('lasttwo_player_id') || '' : '')
  const myVote = (effectiveId && votes[effectiveId]) as 'A' | 'B' | undefined
  const [selected, setSelected] = useState<'A' | 'B' | null>(myVote || null)

  // 2. 새 라운드 시작 또는 문제 변경 시 이전 투표 선택 상태 완벽 초기화 (선택이 안 되거나 굳어버리는 버그 방지)
  useEffect(() => {
    setSelected(myVote || null)
  }, [currentQuestion?.id, roundNumber, myVote])
  
  const total = timeLimit || 15
  const [remaining, setRemaining] = useState<number>(() => {
    if (votingDeadline) {
      return Math.max(0, Math.ceil((votingDeadline - Date.now()) / 1000))
    }
    return timeLeft || total
  })

  // 실시간 15초 카운트다운 (200ms 주기로 계산하여 모바일에서 실시간으로 초가 줄어듦)
  useEffect(() => {
    const calc = () => {
      if (votingDeadline) {
        const sec = Math.max(0, Math.ceil((votingDeadline - Date.now()) / 1000))
        setRemaining(sec)
      } else if (timeLeft !== undefined) {
        setRemaining(timeLeft)
      }
    }
    calc()
    const timer = setInterval(calc, 200)
    return () => clearInterval(timer)
  }, [votingDeadline, timeLeft])

  const handleVote = (choice: 'A' | 'B') => {
    if (isEliminated || selected || myVote || !effectiveId || isPaused || remaining <= 0) return

    playClickSound()
    triggerVibration(50)

    // 즉시 로컬 선택 및 투표 제출
    setSelected(choice)
    submitVote(effectiveId, choice)
  }

  const currentChoice = selected || myVote
  const alreadyVoted = Boolean(currentChoice)

  // 문제 정보가 아직 동기화 중일 때 빈 화면(null) 대신 로딩 UI 제공
  if (!currentQuestion) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center">
        <div className="particles-bg" />
        <div className="glass-card p-6 max-w-sm w-full">
          <div className="text-4xl animate-bounce mb-3">❓</div>
          <h3 className="font-display text-xl text-gold">문제를 준비하는 중...</h3>
          <p className="text-gray-400 text-xs mt-1">잠시 후 라운드 문제가 시작됩니다</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col p-4 max-w-md mx-auto">
      <div className="particles-bg" />

      {/* 상단: 카운트다운 또는 MC 안내 뱃지 */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center pt-2 pb-1"
      >
        {phase === 'question' ? (
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-2xl bg-gold/15 border border-gold/40 text-gold font-bold text-sm shadow-lg mb-2">
            <span className="text-xl animate-pulse">🎙️</span>
            <span>MC가 문제를 안내하고 있습니다</span>
          </div>
        ) : (
          <CountdownCircle timeLeft={remaining} total={total} />
        )}
      </motion.div>

      {/* 탈락자 관전 모드 안내 배너 */}
      {isEliminated && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="mb-2 p-2.5 rounded-xl bg-red-950/80 border border-red-500/50 text-center text-xs text-red-200 font-bold shadow-lg flex items-center justify-center gap-2"
        >
          <span>💀</span>
          <span>관전 모드: 탈락자는 투표할 수 없으며 TV 스크린을 함께 관전합니다</span>
        </motion.div>
      )}

      {/* 카테고리 및 룰 뱃지 */}
      <div className="text-center mb-3 space-y-1.5">
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          <span className="inline-block px-3 py-0.5 bg-gold/20 text-gold text-xs rounded-full border border-gold/30 font-bold">
            {currentQuestion.category}
          </span>
          <span className={`inline-block px-2.5 py-0.5 text-xs rounded-full border font-bold ${
            ruleMode === 'minority'
              ? 'bg-purple-950/60 border-purple-400 text-purple-200'
              : 'bg-gold/20 border-gold/40 text-gold-light'
          }`}>
            {ruleMode === 'minority' ? '🎯 소수의 선택' : '👥 다수의 선택'}
          </span>
        </div>
        <p className="text-xs text-gold-light font-bold">
          {ruleMode === 'minority' ? '⚡ 더 적은 사람이 선택한 쪽이 생존합니다!' : '⚡ 더 많은 사람이 선택한 쪽이 생존합니다!'}
        </p>
      </div>

      {/* 선택 버튼 */}
      <div className="flex-1 flex flex-col gap-4 w-full justify-center">
        {/* A 버튼 */}
        <motion.button
          whileHover={!isEliminated && !alreadyVoted && remaining > 0 ? { scale: 1.02 } : {}}
          whileTap={!isEliminated && !alreadyVoted && remaining > 0 ? { scale: 0.98 } : {}}
          onClick={() => handleVote('A')}
          disabled={isEliminated || alreadyVoted || remaining <= 0}
          className={`relative w-full py-7 px-5 rounded-2xl font-display text-xl md:text-2xl
                      text-white text-center transition-all duration-300
                      ${isEliminated
              ? 'bg-gray-800/60 border-2 border-gray-600/40 opacity-60 cursor-not-allowed'
              : currentChoice === 'A'
                ? 'btn-team-a ring-4 ring-white shadow-2xl shadow-team-a/60 scale-[1.02]'
                : currentChoice === 'B'
                  ? 'bg-gray-800/60 opacity-40 grayscale'
                  : remaining <= 0
                    ? 'bg-gray-850 opacity-40 cursor-not-allowed'
                    : 'btn-team-a hover:shadow-lg'
            }`}
        >
          <span className="absolute top-3 left-4 text-xs font-body opacity-80 font-bold">CHOICE A</span>
          {currentQuestion.optionA}
          {currentChoice === 'A' && (
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              className="absolute top-3 right-4 text-2xl text-yellow-300"
            >
              ✓
            </motion.span>
          )}
        </motion.button>

        {/* VS 디바이더 */}
        <div className="flex items-center justify-center">
          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-gold/30 to-transparent" />
          <span className="mx-4 font-display text-xl text-gold text-shadow-glow">VS</span>
          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-gold/30 to-transparent" />
        </div>

        {/* B 버튼 */}
        <motion.button
          whileHover={!isEliminated && !alreadyVoted && remaining > 0 ? { scale: 1.02 } : {}}
          whileTap={!isEliminated && !alreadyVoted && remaining > 0 ? { scale: 0.98 } : {}}
          onClick={() => handleVote('B')}
          disabled={isEliminated || alreadyVoted || remaining <= 0}
          className={`relative w-full py-7 px-5 rounded-2xl font-display text-xl md:text-2xl
                      text-white text-center transition-all duration-300
                      ${isEliminated
              ? 'bg-gray-800/60 border-2 border-gray-600/40 opacity-60 cursor-not-allowed'
              : currentChoice === 'B'
                ? 'btn-team-b ring-4 ring-white shadow-2xl shadow-team-b/60 scale-[1.02]'
                : currentChoice === 'A'
                  ? 'bg-gray-800/60 opacity-40 grayscale'
                  : remaining <= 0
                    ? 'bg-gray-850 opacity-40 cursor-not-allowed'
                    : 'btn-team-b hover:shadow-lg'
            }`}
        >
          <span className="absolute top-3 left-4 text-xs font-body opacity-80 font-bold">CHOICE B</span>
          {currentQuestion.optionB}
          {currentChoice === 'B' && (
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              className="absolute top-3 right-4 text-2xl text-yellow-300"
            >
              ✓
            </motion.span>
          )}
        </motion.button>
      </div>

      {/* 하단: 투표 상태 */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="text-center py-4 text-sm"
      >
        {isEliminated ? (
          <span className="text-red-400 font-bold flex items-center justify-center gap-1.5">
            💀 [관전 모드] 탈락자는 투표할 수 없습니다 (TV 스크린 관전)
          </span>
        ) : alreadyVoted ? (
          <span className="text-gold font-bold flex items-center justify-center gap-1.5 animate-pulse">
            ✅ [{currentChoice}] 투표 완료! 집계 결과를 기다리고 있습니다
          </span>
        ) : phase === 'question' ? (
          <span className="text-gold-light font-bold">
            💡 지금 바로 미리 선택하거나, TV 화면의 MC 안내를 경청하세요!
          </span>
        ) : (
          <span className="text-gray-300">
            {remaining > 0 ? `⏱️ ${remaining}초 안에 선택하세요! (미투표 시 탈락)` : '투표 마감 중...'}
          </span>
        )}
      </motion.div>
    </div>
  )
}

// ===== 결과 화면 =====
function ResultScreen() {
  const { currentResult, roundResults, currentPlayerId, players, votes, roundNumber } = useGameStore()
  const result = currentResult || (roundResults.length > 0 ? roundResults[roundResults.length - 1] : null)
  const currentPlayer = players.find((p) => p.id === currentPlayerId)

  if (!result) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center">
        <div className="particles-bg" />
        <div className="glass-card p-6 max-w-sm w-full">
          <div className="text-4xl animate-spin mb-3">⏳</div>
          <h3 className="font-display text-xl text-gold">결과 집계 중...</h3>
          <p className="text-gray-400 text-xs mt-1">잠시만 기다려주세요</p>
        </div>
      </div>
    )
  }

  const myVote = (currentPlayerId && votes[currentPlayerId]) as 'A' | 'B' | undefined
  const totalVotes = result.votesA + result.votesB
  const pctA = totalVotes > 0 ? Math.round((result.votesA / totalVotes) * 100) : 0
  const pctB = totalVotes > 0 ? Math.round((result.votesB / totalVotes) * 100) : 0
  const isSurvivor = currentPlayerId ? result.survivors.includes(currentPlayerId) : false

  // 생존 / 탈락 효과음 및 진동 피드백
  useEffect(() => {
    if (isSurvivor) {
      playSurviveSound()
      triggerVibration([100, 50, 100])
    } else {
      playEliminatedSound()
      triggerVibration(400)
    }
  }, [result.questionId, isSurvivor])

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 max-w-md mx-auto">
      <div className="particles-bg" />

      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', duration: 0.5 }}
        className="glass-card p-5 md:p-6 w-full space-y-4"
      >
        {/* 상단 헤더: 라운드 번호 & 카테고리 & 룰 */}
        <div className="text-center">
          <div className="inline-flex flex-wrap items-center justify-center gap-1.5 mb-2">
            <span className="px-3 py-1 bg-gold/15 text-gold text-xs rounded-full border border-gold/30 font-bold">
              ROUND {roundNumber} 결과 발표
            </span>
            <span className={`px-2.5 py-1 text-xs rounded-full border font-bold ${
              result.ruleMode === 'minority'
                ? 'bg-purple-950/60 border-purple-400 text-purple-200'
                : 'bg-gold/20 border-gold/40 text-gold-light'
            }`}>
              {result.ruleMode === 'minority' ? '🎯 소수의 선택 룰' : '👥 다수의 선택 룰'}
            </span>
          </div>
          <h2 className="font-display text-lg text-white font-bold">{result.question.category}</h2>
          <p className="text-xs text-gold-light mt-1 font-bold">
            {result.ruleMode === 'minority'
              ? '⚡ 더 적은 표를 얻은 쪽이 생존했습니다! (0표 제외)'
              : '⚡ 더 많은 표를 얻은 쪽이 생존했습니다!'}
          </p>
        </div>

        {/* 선택지 비교 박스 */}
        <div className="grid grid-cols-2 gap-2 text-center text-sm font-bold">
          {/* A 박스 */}
          <div className={`p-3 rounded-xl border transition-all ${
            result.majority === 'A'
              ? 'bg-team-a/30 border-red-400 text-white shadow-lg ring-2 ring-team-a'
              : result.majority === 'tie'
                ? 'bg-team-a/20 border-yellow-500/50 text-white'
                : 'bg-gray-800/40 border-gray-700 text-gray-400'
          }`}>
            <div className="text-xs text-red-300 mb-1">A ({pctA}%)</div>
            <div className="font-display text-base leading-tight">{result.question.optionA}</div>
            <div className="text-xs mt-1 text-gold">{result.votesA}표</div>
            {result.majority === 'A' && (
              <span className={`inline-block mt-1 px-2 py-0.5 text-white text-[10px] rounded-full font-bold ${
                result.ruleMode === 'minority' ? 'bg-purple-600' : 'bg-red-500'
              }`}>
                {result.ruleMode === 'minority' ? '👑 소수 승리' : '👑 다수 승리'}
              </span>
            )}
          </div>

          {/* B 박스 */}
          <div className={`p-3 rounded-xl border transition-all ${
            result.majority === 'B'
              ? 'bg-team-b/30 border-blue-400 text-white shadow-lg ring-2 ring-team-b'
              : result.majority === 'tie'
                ? 'bg-team-b/20 border-yellow-500/50 text-white'
                : 'bg-gray-800/40 border-gray-700 text-gray-400'
          }`}>
            <div className="text-xs text-blue-300 mb-1">B ({pctB}%)</div>
            <div className="font-display text-base leading-tight">{result.question.optionB}</div>
            <div className="text-xs mt-1 text-gold">{result.votesB}표</div>
            {result.majority === 'B' && (
              <span className={`inline-block mt-1 px-2 py-0.5 text-white text-[10px] rounded-full font-bold ${
                result.ruleMode === 'minority' ? 'bg-purple-600' : 'bg-blue-500'
              }`}>
                {result.ruleMode === 'minority' ? '👑 소수 승리' : '👑 다수 승리'}
              </span>
            )}
          </div>
        </div>

        {/* 득표 비율 바 */}
        <div className="space-y-1">
          <div className="h-6 bg-gray-800 rounded-full overflow-hidden flex shadow-inner">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${pctA}%` }}
              transition={{ duration: 0.8 }}
              className="bg-gradient-to-r from-team-a to-team-a-dark flex items-center justify-center text-[11px] font-bold text-white overflow-hidden"
            >
              {pctA > 10 ? `${pctA}%` : ''}
            </motion.div>
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${pctB}%` }}
              transition={{ duration: 0.8 }}
              className="bg-gradient-to-r from-team-b-dark to-team-b flex items-center justify-center text-[11px] font-bold text-white overflow-hidden"
            >
              {pctB > 10 ? `${pctB}%` : ''}
            </motion.div>
          </div>
          {result.majority === 'tie' && (
            <p className="text-gold text-center text-xs font-bold pt-1">
              ⚖️ 동률! 투표자 전원 생존!
            </p>
          )}
          {result.nonVoters > 0 && (
            <p className="text-gray-400 text-center text-[11px]">
              미투표 탈락: {result.nonVoters}명
            </p>
          )}
        </div>

        {/* 나의 결과 카드 */}
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className={`p-4 rounded-2xl text-center border-2 ${
            isSurvivor
              ? 'bg-gradient-to-br from-green-950/80 to-green-900/40 border-green-500/50 shadow-green-900/30 shadow-lg'
              : 'bg-gradient-to-br from-red-950/80 to-red-900/40 border-red-500/50 shadow-red-900/30 shadow-lg'
          }`}
        >
          <div className="text-4xl mb-1">
            {isSurvivor ? '🎉' : '💀'}
          </div>
          <div className="text-xs text-gray-300 font-bold mb-1">
            내 선택: <span className="text-white font-extrabold">[{myVote ? `CHOICE ${myVote}` : '미투표'}]</span>
          </div>
          <h3 className={`font-display text-2xl font-black ${isSurvivor ? 'text-green-400' : 'text-red-400'}`}>
            {isSurvivor ? '생존 성공!' : '탈락했습니다'}
          </h3>
          <p className="text-xs text-gray-300 mt-2">
            {isSurvivor
              ? `다음 라운드로 진출합니다! (남은 생존자: ${result.survivors.length}명)`
              : result.ruleMode === 'minority'
                ? `소수의 선택에 들지 못했습니다. (탈락자: ${result.eliminated.length}명)`
                : `다수의 선택에 들지 못했습니다. (탈락자: ${result.eliminated.length}명)`}
          </p>
        </motion.div>

        {/* 대기 안내 */}
        <div className="text-center pt-2 text-xs font-bold animate-pulse">
          {result.survivors.length <= 2 && result.survivors.length > 0 ? (
            <span className="text-yellow-300">
              🏆 최후의 {result.survivors.length}인 결정! 잠시 후 최종 우승 결과가 발표되고 경기가 종료됩니다!
            </span>
          ) : (
            <span className="text-gray-400">
              ⏳ MC가 다음 라운드를 준비하고 있습니다...
            </span>
          )}
        </div>
      </motion.div>
    </div>
  )
}

// ===== 탈락 화면 =====
function EliminatedScreen() {
  const { currentPlayerId, players, roundNumber, currentResult, roundResults, phase } = useGameStore()
  const currentPlayer = players.find((p) => p.id === currentPlayerId)
  const alivePlayers = players.filter((p) => p.status === 'alive')
  const lastResult = currentResult || (roundResults.length > 0 ? roundResults[roundResults.length - 1] : null)

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 max-w-md mx-auto">
      <div className="particles-bg" />

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="w-full text-center space-y-4"
      >
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', delay: 0.2 }}
          className="text-7xl mb-2"
        >
          {phase === 'gameover' ? '🏆' : '💀'}
        </motion.div>

        <h2 className="font-display text-3xl text-red-400 mb-1 font-black">
          {phase === 'gameover' ? '경기 종료 (관전)' : '관전 모드 (탈락)'}
        </h2>
        <p className="text-gray-300 text-sm">
          {currentPlayer?.nickname}님은 Round {currentPlayer?.eliminatedRound || roundNumber}에서 탈락하셨습니다
        </p>

        {phase === 'gameover' && alivePlayers.length > 0 && (
          <div className="glass-card p-4 border border-gold/50 bg-gradient-to-br from-gold/15 to-transparent text-center shadow-lg">
            <span className="text-xs text-gold font-bold block mb-1">👑 최종 우승 발표</span>
            <div className="text-xl font-display text-white font-extrabold">
              {alivePlayers.length === 1
                ? `단독 우승자: ${alivePlayers[0].nickname}`
                : `최후의 2인: ${alivePlayers.map((p) => p.nickname).join(', ')}`}
            </div>
            <p className="text-xs text-gray-300 mt-1">모든 라운드가 종료되었습니다! 축하합니다!</p>
          </div>
        )}

        {lastResult && (
          <div className="glass-card p-4 text-xs text-gray-300 space-y-2 border-red-500/30">
            <div className="font-bold text-gold">최근 라운드 결과</div>
            <div className="flex justify-between px-4">
              <span className="text-red-300">A: {lastResult.votesA}표</span>
              <span className="text-blue-300">B: {lastResult.votesB}표</span>
            </div>
            <div className="text-[11px] text-gray-400">
              승리: {lastResult.majority === 'tie' ? '동률' : `${lastResult.majority} 다수`}
            </div>
          </div>
        )}

        <div className="glass-card p-5 max-w-xs mx-auto">
          <p className="text-gold text-xs mb-1 font-bold">{phase === 'gameover' ? '최종 우승자' : '현재 남은 생존자'}</p>
          <p className="font-display text-4xl text-white font-black">{alivePlayers.length}명</p>
          <p className="text-gray-400 text-xs mt-2">
            {phase === 'gameover' ? '스크린/TV 화면에서 우승 축하 연출을 확인하세요!' : '스크린/TV 화면에서 다음 라운드를 관전하세요!'}
          </p>
        </div>
      </motion.div>
    </div>
  )
}

// ===== 우승 화면 =====
function WinnerScreen() {
  const { players } = useGameStore()
  const winners = players.filter((p) => p.status === 'alive')

  // 우승 축하 팡파르 및 진동
  useEffect(() => {
    playGameoverFanfare()
    triggerVibration([150, 80, 150, 80, 300])
  }, [])

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 relative overflow-hidden">
      <div className="particles-bg" />

      {/* 간단한 CSS 파티클 효과 */}
      {Array.from({ length: 20 }).map((_, i) => (
        <div
          key={i}
          className="confetti-piece"
          style={{
            left: `${Math.random() * 100}%`,
            backgroundColor: ['#FFD700', '#EF4444', '#3B82F6', '#10B981', '#F59E0B'][i % 5],
            animationDuration: `${2 + Math.random() * 3}s`,
            animationDelay: `${Math.random() * 2}s`,
            borderRadius: Math.random() > 0.5 ? '50%' : '0',
            width: `${6 + Math.random() * 8}px`,
            height: `${6 + Math.random() * 8}px`,
          }}
        />
      ))}

      <motion.div
        initial={{ opacity: 0, scale: 0.3 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: 'spring', duration: 1 }}
        className="text-center z-10"
      >
        <motion.div
          animate={{ rotate: [0, -5, 5, -5, 0] }}
          transition={{ repeat: Infinity, duration: 2 }}
          className="text-8xl mb-6"
        >
          🏆
        </motion.div>

        <h1 className="font-display text-4xl md:text-5xl text-gold text-shadow-glow mb-4">
          {winners.length === 1 ? '단독 우승을 축하합니다!' : '축하합니다!'}
        </h1>

        <div className="font-display text-2xl text-white mb-8">
          {winners.length === 1 ? '👑 단독 챔피언 탄생' : 'THE LAST TWO'}
        </div>

        <div className="flex gap-6 justify-center">
          {winners.map((winner) => (
            <motion.div
              key={winner.id}
              initial={{ y: 50, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.5, type: 'spring' }}
              className="glass-card p-6 animate-pulse-glow"
            >
              <div className="w-16 h-16 mx-auto mb-3 rounded-full bg-gradient-to-br from-gold to-gold-dark
                              flex items-center justify-center">
                <span className="text-2xl font-display text-navy-dark">
                  {winner.nickname.charAt(0)}
                </span>
              </div>
              <p className="font-display text-xl text-gold">{winner.nickname}</p>
            </motion.div>
          ))}
        </div>
      </motion.div>
    </div>
  )
}

function clearLocalPlayerSession() {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem('lasttwo_player_id')
    localStorage.removeItem('lasttwo_player_nickname')
    sessionStorage.removeItem('lasttwo_player_id')
    sessionStorage.removeItem('lasttwo_player_nickname')
  } catch (e) {}
}

// ===== 메인 직원 페이지 =====
export default function PlayerPage() {
  // 실시간 웹소켓 및 Firebase 상태 동기화
  useFirebaseSync()

  // Zustand selector를 통한 실시간 반응성 보장 (phase 변경 시 즉각 리렌더링)
  const phase = useGameStore((s) => s.phase)
  const currentPlayerId = useGameStore((s) => s.currentPlayerId)
  const setCurrentPlayer = useGameStore((s) => s.setCurrentPlayer)
  const clearCurrentPlayer = useGameStore((s) => s.clearCurrentPlayer)
  const removePlayer = useGameStore((s) => s.removePlayer)
  const players = useGameStore((s) => s.players)

  const savedId = typeof window !== 'undefined' ? localStorage.getItem('lasttwo_player_id') : null
  const savedNickname = typeof window !== 'undefined' ? localStorage.getItem('lasttwo_player_nickname') : null

  // 1. 이번 브라우저 세션에서 사용자가 직접 '참가하기' 버튼을 눌렀는지 여부
  // 대기실(phase === 'lobby')인 경우, localStorage에 이전 데이터가 있더라도 최초 닉네임 입력 화면을 거치도록 하되,
  // 게임이 이미 진행 중(phase !== 'lobby')인 경우 기존 참가자 정보를 자동 복원
  const [hasConfirmedJoin, setHasConfirmedJoin] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return Boolean(savedId && savedNickname && phase !== 'lobby')
  })

  const [myPlayer, setMyPlayer] = useState<Player | null>(() => {
    if (typeof window === 'undefined') return null
    if (savedId && savedNickname && phase !== 'lobby') {
      return { id: savedId, nickname: savedNickname, status: 'alive', joinedAt: Date.now() }
    }
    return null
  })

  // phase가 lobby가 아닐 때 저장된 정보가 있다면 즉시 참가 확정 및 세션 복구
  useEffect(() => {
    if (phase !== 'lobby' && savedId && savedNickname) {
      if (!hasConfirmedJoin) setHasConfirmedJoin(true)
      if (!myPlayer) {
        setMyPlayer({ id: savedId, nickname: savedNickname, status: 'alive', joinedAt: Date.now() })
        setCurrentPlayer(savedId)
      }
    }
  }, [phase, savedId, savedNickname, hasConfirmedJoin, myPlayer, setCurrentPlayer])

  // 퇴장 처리 함수: 로컬스토리지 완전 삭제 및 닉네임 입력 화면으로 복귀
  const handleExitGame = () => {
    const idToLeave = myPlayer?.id || currentPlayerId || (typeof window !== 'undefined' ? localStorage.getItem('lasttwo_player_id') : null)
    if (idToLeave) {
      socket.emit('player:leave', { id: idToLeave })
      fetch('/api/game/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: idToLeave }),
      }).catch(() => {})
      fetch('/api/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: idToLeave }),
      }).catch(() => {})
      removePlayer(idToLeave)
    }

    clearLocalPlayerSession()
    clearCurrentPlayer()
    setMyPlayer(null)
    setHasConfirmedJoin(false)
  }

  // 브라우저 닫기/퇴장 시 대기실 세션 정리
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (phase === 'lobby') {
        const id = myPlayer?.id || (typeof window !== 'undefined' ? localStorage.getItem('lasttwo_player_id') : null)
        if (id) {
          const blob = new Blob([JSON.stringify({ id })], { type: 'application/json' })
          navigator.sendBeacon('/api/game/leave', blob)
        }
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [phase, myPlayer?.id])

  // 게임 세션 유효성 검사 및 리셋 감지
  useEffect(() => {
    const sId = typeof window !== 'undefined' ? localStorage.getItem('lasttwo_player_id') : null

    // 1. 대기실(lobby)인 경우: 이전 라운드 투표/탈락 잔여 데이터 리셋
    if (phase === 'lobby') {
      if (myPlayer && (myPlayer.status === 'eliminated' || myPlayer.eliminatedRound !== undefined)) {
        setMyPlayer((prev) => (prev ? { ...prev, status: 'alive', eliminatedRound: undefined } : null))
      }
      return
    }

    // 2. 게임 진행 중(phase !== 'lobby')인데 저장된 세션이 있는 경우:
    // 서버 players 목록이 이미 로드되었고(players.length > 0), 서버 목록에 내 sId가 전혀 없다면?
    // -> 이전 게임의 유효하지 않은 세션이므로 파기하고 닉네임 입력 화면으로 초기화!
    if (sId && players.length > 0) {
      const isValidPlayer = players.some((p) => p.id === sId)
      if (!isValidPlayer) {
        console.warn('⚠️ [Session Invalid] 현재 진행 중인 게임 세션에 없는 플레이어 ID입니다. 세션을 파기합니다:', sId)
        clearLocalPlayerSession()
        clearCurrentPlayer()
        setMyPlayer(null)
        setHasConfirmedJoin(false)
        return
      }
    }
  }, [phase, players, myPlayer, clearCurrentPlayer])

  // 사용자 최초 터치/클릭 시 Web Audio Context 잠금 해제
  useEffect(() => {
    const handleGesture = () => {
      unlockAudioContext()
      window.removeEventListener('pointerdown', handleGesture)
      window.removeEventListener('keydown', handleGesture)
    }
    window.addEventListener('pointerdown', handleGesture, { once: true })
    window.addEventListener('keydown', handleGesture, { once: true })
    return () => {
      window.removeEventListener('pointerdown', handleGesture)
      window.removeEventListener('keydown', handleGesture)
    }
  }, [])

  // 1. 게임 진행 중 재접속 시 자동 참가/복원 시도 및 관리자 초기화 수신
  useEffect(() => {
    const sId = typeof window !== 'undefined' ? localStorage.getItem('lasttwo_player_id') : null
    const sNick = typeof window !== 'undefined' ? localStorage.getItem('lasttwo_player_nickname') : null

    // 게임이 이미 진행 중(phase !== 'lobby')이고 저장된 세션이 있는 경우에만 백그라운드 재등록
    if (sId && sNick && phase !== 'lobby') {
      socket.emit('player:join', { id: sId, nickname: sNick }, (res: any) => {
        if (res?.success && res?.player) {
          setMyPlayer(res.player)
          setCurrentPlayer(res.player.id)
        }
      })
    }

    const handleSetReset = () => {
      // 다음 세트 시작 대기: 닉네임과 세션 유지, 상태만 alive로 부활
      setMyPlayer((prev) => (prev ? { ...prev, status: 'alive', eliminatedRound: undefined } : null))
    }

    const handleGameReset = () => {
      // 참가자 완전 비우기 / 게임 초기화 시 로컬스토리지 완전 삭제 및 닉네임 입력 폼으로 초기화
      clearLocalPlayerSession()
      clearCurrentPlayer()
      setMyPlayer(null)
      setHasConfirmedJoin(false)
    }

    socket.on('game:set_reset', handleSetReset)
    socket.on('game:force_lobby', handleSetReset)
    socket.on('game:reset', handleGameReset)
    socket.on('game:player_kicked_all', handleGameReset)
    return () => {
      socket.off('game:set_reset', handleSetReset)
      socket.off('game:force_lobby', handleSetReset)
      socket.off('game:reset', handleGameReset)
      socket.off('game:player_kicked_all', handleGameReset)
    }
  }, [setCurrentPlayer, clearCurrentPlayer, phase])

  // 2. 서버 players 목록에서 내 최신 상태(생존/탈락)를 안전하게 반영 (절대 null로 튕기지 않음)
  const foundInList = players.find((p) => p.id === (myPlayer?.id || currentPlayerId || savedId))
  const currentPlayer: Player | null =
    foundInList ||
    myPlayer ||
    (savedId && savedNickname && phase !== 'lobby'
      ? {
          id: savedId,
          nickname: savedNickname,
          status: 'alive',
          joinedAt: Date.now(),
        }
      : null)

  // 대기실 단계이거나 아직 이번 접속에서 '참가하기'를 누르지 않은 경우 (단, 게임 진행 중이면 저장된 정보로 자동 진입)
  if ((phase === 'lobby' && !hasConfirmedJoin) || !currentPlayer) {
    return (
      <NicknameForm
        onJoin={(p) => {
          setMyPlayer(p)
          setCurrentPlayer(p.id)
          setHasConfirmedJoin(true)
          if (typeof window !== 'undefined') {
            localStorage.setItem('lasttwo_player_id', p.id)
            localStorage.setItem('lasttwo_player_nickname', p.nickname)
          }
        }}
      />
    )
  }

  const renderScreen = () => {
    // 1. 게임 종료
    if (phase === 'gameover') {
      if (currentPlayer?.status === 'alive') {
        return <WinnerScreen />
      }
      return <EliminatedScreen />
    }

    // 2. 결과 발표 단계: 생존자/탈락자 모두 이번 라운드 투표 결과를 먼저 확인!
    if (phase === 'result' || phase === 'elimination') {
      return <ResultScreen />
    }

    // 3. 결과 집계 서스펜스 (3초)
    if (phase === 'revealing') {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center">
          <div className="particles-bg" />
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="glass-card p-8 max-w-sm w-full"
          >
            <div className="text-6xl animate-bounce mb-4">⌛</div>
            <h2 className="font-display text-2xl text-gold mb-2">투표 마감!</h2>
            <p className="text-gray-300 text-sm">다수와 소수를 집계하고 있습니다...</p>
            <div className="mt-4 text-xs text-gold/70 font-mono">잠시 후 결과가 공개됩니다</div>
          </motion.div>
        </div>
      )
    }

    // 4. 문제 출제 및 투표 단계 (TV 화면과 분기 조건 일치: question, voting, playing, finals 등)
    // 참가자 상태(생존/탈락)와 상관없이 문제 선택지(A/B) 화면을 즉시 렌더링 (탈락자는 관전 모드로 표시)
    if (
      phase === 'question' ||
      phase === 'voting' ||
      (phase as string) === 'playing' ||
      phase === 'finals'
    ) {
      return <VoteScreen currentPlayer={currentPlayer} />
    }

    // 5. 대기실 (오직 phase === 'lobby' 일 때만 표시)
    if (phase === 'lobby') {
      return (
        <WaitingRoom
          player={myPlayer || undefined}
          onNicknameChange={(newNick) => {
            if (myPlayer) setMyPlayer({ ...myPlayer, nickname: newNick })
          }}
          onLeave={handleExitGame}
        />
      )
    }

    // 6. 기본 폴백: 대기실이 아닌 경우 무조건 문제 선택지 화면으로 폴백하여 대기실 갇힘 원천 방지
    return <VoteScreen currentPlayer={currentPlayer} />
  }

  return (
    <>
      <div className="fixed top-3.5 right-3.5 z-40 flex items-center gap-2">
        <AdminShortcutButton />
        <SoundMuteButton />
      </div>
      {renderScreen()}
      <LiveChatDrawer />
    </>
  )
}
