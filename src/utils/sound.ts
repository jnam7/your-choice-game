// ===== Web Audio API 기반 경량 사운드 및 진동 유틸 =====

let audioCtx: AudioContext | null = null
let isMutedState = false

// 초기 음소거 설정 로컬스토리지에서 복구 (단, false 기본값 보장)
if (typeof window !== 'undefined') {
  try {
    const saved = localStorage.getItem('lasttwo_sound_muted')
    isMutedState = saved === 'true'
  } catch {}
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
    if (AudioContextClass) {
      audioCtx = new AudioContextClass()
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {})
  }
  return audioCtx
}

// 모바일 및 TV 브라우저 오디오 잠금 해제 (사용자 인터랙션 또는 자동 해제 시 호출)
export function unlockAudioContext(): void {
  isMutedState = false
  const ctx = getAudioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {})
  }
}

// 음소거 제어
export function isSoundMuted(): boolean {
  return isMutedState
}

export function setSoundMuted(muted: boolean): void {
  isMutedState = muted
  try {
    localStorage.setItem('lasttwo_sound_muted', muted ? 'true' : 'false')
  } catch {}
}

export function toggleSoundMute(): boolean {
  setSoundMuted(!isMutedState)
  return isMutedState
}

// 모든 활성 오디오 노드 및 컨텍스트 정리
export function stopAllSounds(): void {
  // 효과음 노드는 개별 duration 후 자동 stop되므로 AudioContext를 suspend하지 않고 정상 유지
}

// 모바일 진동 헬퍼 (미지원 브라우저 및 에러 방어)
export function triggerVibration(pattern: number | number[]): void {
  try {
    if (typeof window !== 'undefined' && 'vibrate' in navigator && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern)
    }
  } catch {}
}

// 1. 버튼 / 선택지 터치 시 경쾌하고 짧은 '틱' 소리
export function playClickSound(): void {
  if (isMutedState) return
  const ctx = getAudioContext()
  if (!ctx) return

  const osc = ctx.createOscillator()
  const gain = ctx.createGain()

  osc.type = 'sine'
  const now = ctx.currentTime
  osc.frequency.setValueAtTime(880, now)
  osc.frequency.exponentialRampToValueAtTime(440, now + 0.05)

  gain.gain.setValueAtTime(0.3, now)
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05)

  osc.connect(gain)
  gain.connect(ctx.destination)

  osc.start(now)
  osc.stop(now + 0.05)
}

// 2. 카운트다운 째깍째깍 비프음 (마지막 5초 이하)
export function playCountdownTick(isUrgent = false): void {
  if (isMutedState) return
  const ctx = getAudioContext()
  if (!ctx) return

  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  const now = ctx.currentTime

  osc.type = isUrgent ? 'square' : 'sine'
  osc.frequency.setValueAtTime(isUrgent ? 1200 : 800, now)
  osc.frequency.exponentialRampToValueAtTime(isUrgent ? 600 : 400, now + 0.08)

  gain.gain.setValueAtTime(isUrgent ? 0.35 : 0.2, now)
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08)

  osc.connect(gain)
  gain.connect(ctx.destination)

  osc.start(now)
  osc.stop(now + 0.08)
}

// 3. 결과 공개 3초 서스펜스 긴장감 드럼/톤
export function playDrumRoll(): void {
  if (isMutedState) return
  const ctx = getAudioContext()
  if (!ctx) return

  // 서스펜스 저음 펄스 3타
  const now = ctx.currentTime
  for (let i = 0; i < 4; i++) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const t = now + i * 0.22

    osc.type = 'triangle'
    osc.frequency.setValueAtTime(110 + i * 15, t)
    osc.frequency.exponentialRampToValueAtTime(50, t + 0.18)

    gain.gain.setValueAtTime(0.4 + i * 0.08, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18)

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.start(t)
    osc.stop(t + 0.18)
  }
}

// 4. 결과 막대그래프 오픈 시 임팩트 사운드
export function playResultReveal(): void {
  if (isMutedState) return
  const ctx = getAudioContext()
  if (!ctx) return

  const now = ctx.currentTime
  const notes = [523.25, 659.25, 783.99, 1046.5] // C5, E5, G5, C6
  notes.forEach((freq, idx) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const t = now + idx * 0.06

    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, t)

    gain.gain.setValueAtTime(0.3, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35)

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.start(t)
    osc.stop(t + 0.35)
  })
}

// 5. 생존 시 경쾌하고 높은 승리의 팡파르/차임 톤
export function playSurviveSound(): void {
  if (isMutedState) return
  const ctx = getAudioContext()
  if (!ctx) return

  const now = ctx.currentTime
  // 도-미-솔-도 (화려하고 맑은 화음)
  const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51] // C5, E5, G5, C6, E6
  notes.forEach((freq, idx) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const t = now + idx * 0.07

    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq, t)

    gain.gain.setValueAtTime(0.35, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45)

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.start(t)
    osc.stop(t + 0.45)
  })
}

// 6. 탈락 시 묵직하고 낮은 '띠로리/쿵' 탈락 톤
export function playEliminatedSound(): void {
  if (isMutedState) return
  const ctx = getAudioContext()
  if (!ctx) return

  const now = ctx.currentTime

  // 1) 비극적인 하강 음계 (F4 -> E4 -> Eb4 -> D4)
  const sadNotes = [349.23, 329.63, 311.13, 277.18]
  sadNotes.forEach((freq, idx) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const t = now + idx * 0.12

    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(freq, t)

    gain.gain.setValueAtTime(0.25, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2)

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.start(t)
    osc.stop(t + 0.2)
  })

  // 2) 묵직한 서브 베이스 쿵 톤
  const subOsc = ctx.createOscillator()
  const subGain = ctx.createGain()
  const subTime = now + 0.45

  subOsc.type = 'sine'
  subOsc.frequency.setValueAtTime(120, subTime)
  subOsc.frequency.exponentialRampToValueAtTime(35, subTime + 0.6)

  subGain.gain.setValueAtTime(0.5, subTime)
  subGain.gain.exponentialRampToValueAtTime(0.001, subTime + 0.6)

  subOsc.connect(subGain)
  subGain.connect(ctx.destination)

  subOsc.start(subTime)
  subOsc.stop(subTime + 0.6)
}

// 7. 최종 우승자 발표 축하 그랜드 팡파르
export function playGameoverFanfare(): void {
  if (isMutedState) return
  const ctx = getAudioContext()
  if (!ctx) return

  const now = ctx.currentTime
  // 팡-파-레-! (C4, G4, C5, E5, G5, C6)
  const fanfare = [
    { freq: 523.25, time: 0, dur: 0.18 },
    { freq: 523.25, time: 0.2, dur: 0.18 },
    { freq: 523.25, time: 0.4, dur: 0.18 },
    { freq: 659.25, time: 0.6, dur: 0.35 },
    { freq: 783.99, time: 0.95, dur: 0.25 },
    { freq: 1046.5, time: 1.25, dur: 0.9 },
  ]

  fanfare.forEach(({ freq, time, dur }) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const t = now + time

    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq, t)

    gain.gain.setValueAtTime(0.4, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur)

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.start(t)
    osc.stop(t + dur)
  })
}

// 8. 1라운드 및 매 라운드 시작 팡파르/임팩트 사운드 (0초 즉각 재생)
export function playRoundStartSound(): void {
  if (isMutedState) return
  const ctx = getAudioContext()
  if (!ctx) return

  const now = ctx.currentTime
  // 웅장하고 선명한 라운드 개시 신호음 (도-미-솔-도 화음 + 브라스 임팩트)
  const notes = [261.63, 329.63, 392.00, 523.25, 659.25, 783.99, 1046.5]
  notes.forEach((freq, idx) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const t = now + idx * 0.04

    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq, t)

    gain.gain.setValueAtTime(0.35, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5)

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.start(t)
    osc.stop(t + 0.5)
  })
}

// 9. 대기실(lobby) 상태에서 게임에 사용되는 모든 오디오 에셋(BGM, 효과음 컨텍스트) 브라우저 메모리에 사전 프리로드 캐싱
export function preloadAudioAssets(): void {
  if (typeof window === 'undefined') return
  try {
    // 1) Web Audio API 컨텍스트 깨우기 및 워밍업
    const ctx = getAudioContext()
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {})
    }

    // 2) BGM 오디오 파일 백그라운드 프리로드 캐싱 (preload="auto")
    const preAudio = new Audio()
    preAudio.preload = 'auto'
    preAudio.src = '/audio/bgm.mp3'
    preAudio.onerror = () => {
      preAudio.src = '/bgm.mp3'
      preAudio.load()
    }
    preAudio.load()
  } catch (err) {
    console.warn('[Audio Preload Notice]:', err)
  }
}

