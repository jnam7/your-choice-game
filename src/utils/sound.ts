// ===== Web Audio API 기반 경량 사운드 및 진동 유틸 =====

let audioCtx: AudioContext | null = null
let masterVolumeState = 0.8
let isMutedState = false

const soundInstances: Record<string, HTMLAudioElement> = {}
const activeAudioNodes = new Set<{ stop?: (when?: number) => void; disconnect: () => void }>()

// =========================================================
// 전역 단일 BGM 플레이어 (시스템 전체에 단 1개만 존재 - 돌림노래 현상 원천 차단)
// =========================================================
let globalBgmPlayer: HTMLAudioElement | null = null
let currentPlayingTrack: string = ''

export const getBgmPlayer = (): HTMLAudioElement | null => {
  if (!globalBgmPlayer && typeof window !== 'undefined') {
    globalBgmPlayer = new Audio()
    globalBgmPlayer.preload = 'auto'
    globalBgmPlayer.loop = true
    globalBgmPlayer.src = '/sounds/game_start.mp3'
    globalBgmPlayer.load()
    globalBgmPlayer.muted = isMutedState
    globalBgmPlayer.volume = isMutedState ? 0 : masterVolumeState
  }
  return globalBgmPlayer
}

export const playBGM = (trackUrl: string = '/sounds/game_start.mp3', volume: number = 0.8, startTime: number = 0): void => {
  const player = getBgmPlayer()
  if (!player) return

  const effectiveVol = isMutedState ? 0 : Math.max(0, Math.min(1, volume))

  // 이미 같은 트랙이 재생 중이면 중복 실행 완전 무시 (시간차 겹침 현상 원천 차단)
  if (currentPlayingTrack === trackUrl && !player.paused) {
    player.muted = isMutedState
    player.volume = effectiveVol
    return
  }

  try {
    const currentSrc = player.getAttribute('src') || player.src || ''
    // 음원이 변경된 경우에만 새로 로드하여 불필요한 네트워크 버퍼링 딜레이(3~4초) 원천 제거
    if (!currentSrc.includes(trackUrl)) {
      player.src = trackUrl
      player.load()
    }

    try {
      player.currentTime = startTime
    } catch {}

    player.muted = isMutedState
    player.volume = effectiveVol
    currentPlayingTrack = trackUrl

    const playPromise = player.play()
    if (playPromise !== undefined) {
      playPromise.catch((e) => console.warn('BGM 재생 대기/차단:', e))
    }
  } catch (e) {
    console.error('BGM 재생 에러:', e)
  }
}

export const stopBGM = (): void => {
  if (globalBgmPlayer) {
    try {
      globalBgmPlayer.pause()
      globalBgmPlayer.currentTime = 0
      // removeAttribute('src') 호출 금지: 캐시된 오디오 버퍼를 유지해야 다음 라운드에서 0ms 즉시 재생됨
    } catch {}
    currentPlayingTrack = ''
  }
}

export const setBgmVolume = (volume: number): void => {
  if (globalBgmPlayer) {
    const effectiveVol = isMutedState ? 0 : Math.max(0, Math.min(1, volume))
    globalBgmPlayer.muted = isMutedState
    globalBgmPlayer.volume = effectiveVol
  }
}

// 초기 음소거 설정 로컬스토리지에서 복구 (단, false 기본값 보장)
if (typeof window !== 'undefined') {
  try {
    const saved = localStorage.getItem('lasttwo_sound_muted')
    isMutedState = saved === 'true'
    const savedVol = localStorage.getItem('lasttwo_sound_volume')
    if (savedVol !== null) {
      masterVolumeState = Math.max(0, Math.min(1, Number(savedVol)))
    }
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
  const ctx = getAudioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {})
  }
  // 브라우저 Autoplay Restriction을 원천 해제하기 위한 초경량 무음 버퍼 재생
  try {
    const silentBuffer = ctx.createBuffer(1, 1, 22050)
    const source = ctx.createBufferSource()
    source.buffer = silentBuffer
    source.connect(ctx.destination)
    source.start(0)
  } catch {}
}

// 오디오 인스턴스 등록 및 관리
export function registerAudioInstance(name: string, audio: HTMLAudioElement): void {
  soundInstances[name] = audio
  audio.muted = isMutedState
  audio.volume = isMutedState ? 0 : masterVolumeState
}

export function unregisterAudioInstance(name: string): void {
  delete soundInstances[name]
}

export function getAudioInstances(): Record<string, HTMLAudioElement> {
  return soundInstances
}

// 마스터 볼륨 설정 (0.0 ~ 1.0)
export function setMasterVolume(vol: number): void {
  masterVolumeState = Math.max(0, Math.min(1, vol))
  const finalVol = isMutedState ? 0 : masterVolumeState
  if (globalBgmPlayer) {
    globalBgmPlayer.muted = isMutedState
    globalBgmPlayer.volume = finalVol
  }
  Object.values(soundInstances).forEach((audio) => {
    try {
      audio.muted = isMutedState
      audio.volume = finalVol
    } catch {}
  })
  try {
    localStorage.setItem('lasttwo_sound_volume', String(masterVolumeState))
  } catch {}
}

export function getMasterVolume(): number {
  return masterVolumeState
}

// 음소거 제어
export function isSoundMuted(): boolean {
  return isMutedState
}

export function setSoundMuted(muted: boolean): void {
  isMutedState = muted
  const finalVol = muted ? 0 : masterVolumeState
  if (globalBgmPlayer) {
    globalBgmPlayer.muted = muted
    globalBgmPlayer.volume = finalVol
  }
  Object.values(soundInstances).forEach((audio) => {
    try {
      audio.muted = muted
      audio.volume = finalVol
    } catch {}
  })
  try {
    localStorage.setItem('lasttwo_sound_muted', muted ? 'true' : 'false')
  } catch {}
}

export function toggleSoundMute(): boolean {
  setSoundMuted(!isMutedState)
  return isMutedState
}

// 오디오 인스턴스 완전 음소거 및 버퍼 해제 정리 (라운드 시작 시 0.1초 잔향 팝 노이즈 원천 차단)
export const cleanupAndStopAudio = (audio: HTMLAudioElement | null): void => {
  if (!audio) return
  try {
    audio.volume = 0 // 볼륨을 먼저 0으로 음소거
    audio.pause()
    audio.currentTime = 0 // 재생 위치 0초로 리셋
    audio.removeAttribute('src') // 오디오 버퍼 강제 해제
    audio.load()
  } catch (e) {
    console.warn('Audio cleanup warning:', e)
  }
}

// 모든 활성 오디오 노드 및 인스턴스 강제 정지 및 초기화 (사운드 겹침 폭발 및 버퍼 잔향 원천 차단)
export function stopAllSounds(): void {
  // 1) 전역 싱글톤 BGM 정지
  stopBGM()

  // 2) 등록된 모든 HTMLAudioElement 인스턴스 완전 음소거 및 버퍼 정리
  Object.values(soundInstances).forEach((audio) => {
    cleanupAndStopAudio(audio)
  })

  // 3) 현재 활성 상태의 모든 Web Audio Oscillator 노드 즉시 중단 및 연결 해제
  activeAudioNodes.forEach((node) => {
    try {
      if (typeof node.stop === 'function') {
        node.stop(0)
      }
      node.disconnect()
    } catch {}
  })
  activeAudioNodes.clear()
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
  const effectiveVol = isMutedState ? 0 : masterVolumeState
  if (effectiveVol <= 0) return
  const ctx = getAudioContext()
  if (!ctx) return

  const osc = ctx.createOscillator()
  const gain = ctx.createGain()

  osc.type = 'sine'
  const now = ctx.currentTime
  osc.frequency.setValueAtTime(880, now)
  osc.frequency.exponentialRampToValueAtTime(440, now + 0.05)

  gain.gain.setValueAtTime(0.3 * effectiveVol, now)
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05)

  osc.connect(gain)
  gain.connect(ctx.destination)

  activeAudioNodes.add(osc)
  osc.onended = () => activeAudioNodes.delete(osc)

  osc.start(now)
  osc.stop(now + 0.05)
}

// 2. 카운트다운 째깍째깍 비프음 (마지막 5초 이하)
export function playCountdownTick(isUrgent = false): void {
  const effectiveVol = isMutedState ? 0 : masterVolumeState
  if (effectiveVol <= 0) return
  const ctx = getAudioContext()
  if (!ctx) return

  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  const now = ctx.currentTime

  osc.type = isUrgent ? 'square' : 'sine'
  osc.frequency.setValueAtTime(isUrgent ? 1200 : 800, now)
  osc.frequency.exponentialRampToValueAtTime(isUrgent ? 600 : 400, now + 0.08)

  gain.gain.setValueAtTime((isUrgent ? 0.35 : 0.2) * effectiveVol, now)
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08)

  osc.connect(gain)
  gain.connect(ctx.destination)

  activeAudioNodes.add(osc)
  osc.onended = () => activeAudioNodes.delete(osc)

  osc.start(now)
  osc.stop(now + 0.08)
}

// 3. 결과 공개 3초 서스펜스 긴장감 드럼/톤
export function playDrumRoll(): void {
  const effectiveVol = isMutedState ? 0 : masterVolumeState
  if (effectiveVol <= 0) return
  const ctx = getAudioContext()
  if (!ctx) return

  const now = ctx.currentTime
  for (let i = 0; i < 4; i++) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const t = now + i * 0.22

    osc.type = 'triangle'
    osc.frequency.setValueAtTime(110 + i * 15, t)
    osc.frequency.exponentialRampToValueAtTime(50, t + 0.18)

    gain.gain.setValueAtTime((0.4 + i * 0.08) * effectiveVol, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18)

    osc.connect(gain)
    gain.connect(ctx.destination)

    activeAudioNodes.add(osc)
    osc.onended = () => activeAudioNodes.delete(osc)

    osc.start(t)
    osc.stop(t + 0.18)
  }
}

// 4. 결과 막대그래프 오픈 시 임팩트 사운드
export function playResultReveal(): void {
  const effectiveVol = isMutedState ? 0 : masterVolumeState
  if (effectiveVol <= 0) return
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

    gain.gain.setValueAtTime(0.3 * effectiveVol, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35)

    osc.connect(gain)
    gain.connect(ctx.destination)

    activeAudioNodes.add(osc)
    osc.onended = () => activeAudioNodes.delete(osc)

    osc.start(t)
    osc.stop(t + 0.35)
  })
}

// 5. 생존 시 경쾌하고 높은 승리의 팡파르/차임 톤
export function playSurviveSound(): void {
  const effectiveVol = isMutedState ? 0 : masterVolumeState
  if (effectiveVol <= 0) return
  const ctx = getAudioContext()
  if (!ctx) return

  const now = ctx.currentTime
  const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51] // C5, E5, G5, C6, E6
  notes.forEach((freq, idx) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const t = now + idx * 0.07

    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq, t)

    gain.gain.setValueAtTime(0.35 * effectiveVol, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45)

    osc.connect(gain)
    gain.connect(ctx.destination)

    activeAudioNodes.add(osc)
    osc.onended = () => activeAudioNodes.delete(osc)

    osc.start(t)
    osc.stop(t + 0.45)
  })
}

// 6. 탈락 시 묵직하고 낮은 '띠로리/쿵' 탈락 톤
export function playEliminatedSound(): void {
  const effectiveVol = isMutedState ? 0 : masterVolumeState
  if (effectiveVol <= 0) return
  const ctx = getAudioContext()
  if (!ctx) return

  const now = ctx.currentTime

  const sadNotes = [349.23, 329.63, 311.13, 277.18]
  sadNotes.forEach((freq, idx) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const t = now + idx * 0.12

    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(freq, t)

    gain.gain.setValueAtTime(0.25 * effectiveVol, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2)

    osc.connect(gain)
    gain.connect(ctx.destination)

    activeAudioNodes.add(osc)
    osc.onended = () => activeAudioNodes.delete(osc)

    osc.start(t)
    osc.stop(t + 0.2)
  })

  const subOsc = ctx.createOscillator()
  const subGain = ctx.createGain()
  const subTime = now + 0.45

  subOsc.type = 'sine'
  subOsc.frequency.setValueAtTime(120, subTime)
  subOsc.frequency.exponentialRampToValueAtTime(35, subTime + 0.6)

  subGain.gain.setValueAtTime(0.5 * effectiveVol, subTime)
  subGain.gain.exponentialRampToValueAtTime(0.001, subTime + 0.6)

  subOsc.connect(subGain)
  subGain.connect(ctx.destination)

  activeAudioNodes.add(subOsc)
  subOsc.onended = () => activeAudioNodes.delete(subOsc)

  subOsc.start(subTime)
  subOsc.stop(subTime + 0.6)
}

// 7. 최종 우승자 발표 축하 그랜드 팡파르
export function playGameoverFanfare(): void {
  const effectiveVol = isMutedState ? 0 : masterVolumeState
  if (effectiveVol <= 0) return
  const ctx = getAudioContext()
  if (!ctx) return

  const now = ctx.currentTime
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

    gain.gain.setValueAtTime(0.4 * effectiveVol, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur)

    osc.connect(gain)
    gain.connect(ctx.destination)

    activeAudioNodes.add(osc)
    osc.onended = () => activeAudioNodes.delete(osc)

    osc.start(t)
    osc.stop(t + dur)
  })
}

// 8. 1라운드 및 매 라운드 시작 팡파르/임팩트 사운드
export function playRoundStartSound(): void {
  const effectiveVol = isMutedState ? 0 : masterVolumeState
  if (effectiveVol <= 0) return
  const ctx = getAudioContext()
  if (!ctx) return

  const now = ctx.currentTime
  const notes = [261.63, 329.63, 392.00, 523.25, 659.25, 783.99, 1046.5]
  notes.forEach((freq, idx) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const t = now + idx * 0.04

    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq, t)

    gain.gain.setValueAtTime(0.35 * effectiveVol, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5)

    osc.connect(gain)
    gain.connect(ctx.destination)

    activeAudioNodes.add(osc)
    osc.onended = () => activeAudioNodes.delete(osc)

    osc.start(t)
    osc.stop(t + 0.5)
  })
}

// 9. 대기실(lobby) 상태에서 게임에 사용되는 모든 오디오 에셋 브라우저 메모리에 사전 프리로드 캐싱
// 절대 play()를 호출하지 않고 순수 load()만 수행하여 소리가 새어 나오지 않도록 방지
export function preloadAudioAssets(): void {
  if (typeof window === 'undefined') return
  try {
    // 1) Web Audio API 컨텍스트 깨우기 및 워밍업
    unlockAudioContext()

    // 2) BGM 파일 백그라운드 프리로드 캐싱 (preload="auto", load()만 호출)
    const preAudio = new Audio()
    preAudio.preload = 'auto'
    preAudio.src = '/sounds/game_start.mp3'
    preAudio.onerror = () => {
      preAudio.src = '/audio/bgm.mp3'
      preAudio.onerror = () => {
        preAudio.src = '/bgm.mp3'
        preAudio.load()
      }
      preAudio.load()
    }
    preAudio.load()
  } catch (err) {
    console.warn('[Audio Preload Notice]:', err)
  }
}
