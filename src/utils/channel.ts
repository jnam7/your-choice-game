export const AVAILABLE_CHANNELS = ['1', '2', '3', '4', '5'] as const
export type ChannelId = typeof AVAILABLE_CHANNELS[number]

/**
 * URL 쿼리 파라미터(?channel=N 또는 ?ch=N)에서 채널 ID를 추출합니다.
 * 없거나 유효하지 않으면 기본값 '1'을 반환하여 100% 하위 호환성을 보장합니다.
 */
export function getChannelIdFromUrl(search?: string): string {
  if (typeof window === 'undefined') return '1'
  try {
    const rawSearch = search !== undefined ? search : window.location.search
    const params = new URLSearchParams(rawSearch)
    const ch = (params.get('channel') || params.get('ch') || params.get('room') || '').trim()
    if (ch && (AVAILABLE_CHANNELS as readonly string[]).includes(ch)) {
      return ch
    }
  } catch (e) {
    // 안전한 기본값 반환
  }
  return '1'
}

/**
 * 주어진 기준 URL에 채널 쿼리 파라미터를 추가/수정하여 반환합니다.
 * TV 화면의 QR 코드가 해당 채널 방으로 참가자를 자동 유입시키도록 만듭니다.
 */
export function buildChannelUrl(baseUrl: string, channelId: string = '1'): string {
  if (!baseUrl) return ''
  const validCh = (AVAILABLE_CHANNELS as readonly string[]).includes(channelId) ? channelId : '1'
  try {
    const url = new URL(baseUrl)
    url.searchParams.set('channel', validCh)
    return url.toString()
  } catch (e) {
    // 상대 경로나 단순 문자열인 경우 처리
    const separator = baseUrl.includes('?') ? '&' : '?'
    // 기존 channel 파라미터가 있다면 정규식으로 치환
    if (/([?&])channel=[^&]*/.test(baseUrl)) {
      return baseUrl.replace(/([?&])channel=[^&]*/, `$1channel=${validCh}`)
    }
    return `${baseUrl}${separator}channel=${validCh}`
  }
}

/**
 * 소켓 룸 명칭을 반환합니다.
 */
export function getChannelRoomName(channelId: string = '1'): string {
  const validCh = (AVAILABLE_CHANNELS as readonly string[]).includes(channelId) ? channelId : '1'
  return `room:channel_${validCh}`
}
