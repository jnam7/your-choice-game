import type { Player, RoundResult } from '../types/game'

/**
 * 게임 결과 및 참가자 명단을 Excel 호환 CSV 파일로 내보냅니다.
 * UTF-8 BOM(\uFEFF)을 포함하여 Microsoft Excel에서 한글 깨짐 없이 정상 열람됩니다.
 */
export function exportGameResultsToExcel(
  players: Player[],
  roundResults: RoundResult[]
) {
  const now = new Date()
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate()
  ).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(
    2,
    '0'
  )}`

  let csvContent = '\uFEFF' // Excel 한글 깨짐 방지 BOM

  // ===== 1. 게임 개요 정보 =====
  csvContent += '=== 당신의 선택 : THE LAST TWO - 게임 결과 리포트 ===\n'
  csvContent += `출력 일시,${now.toLocaleString('ko-KR')}\n`
  csvContent += `총 참가자 수,${players.length}명\n`
  csvContent += `진행 라운드 수,${roundResults.length}라운드\n`
  const alivePlayers = players.filter((p) => p.status === 'alive')
  csvContent += `최종 생존자 수,${alivePlayers.length}명\n`
  csvContent += `최종 우승자,${alivePlayers.map((p) => p.nickname).join(' & ') || '없음'}\n\n`

  // ===== 2. 라운드별 상세 집계 =====
  csvContent += '--- [라운드별 결과 집계] ---\n'
  csvContent += '라운드,카테고리,선택지 A,선택지 B,A 투표수,B 투표수,다수/결과,탈락자 수,미투표 탈락자 수,생존자 수\n'

  roundResults.forEach((r, idx) => {
    const majorityText =
      r.majority === 'tie'
        ? '동률(전원생존)'
        : r.majority === 'A'
          ? 'A(레드) 승리'
          : 'B(블루) 승리'

    const cleanOptionA = `"${r.question.optionA.replace(/"/g, '""')}"`
    const cleanOptionB = `"${r.question.optionB.replace(/"/g, '""')}"`

    csvContent += `${idx + 1},${r.question.category},${cleanOptionA},${cleanOptionB},${r.votesA},${r.votesB},${majorityText},${r.eliminated.length},${r.nonVoters},${r.survivors.length}\n`
  })

  csvContent += '\n'

  // ===== 3. 참가자별 최종 순위 및 성적표 =====
  csvContent += '--- [참가자별 최종 성적 및 순위] ---\n'
  csvContent += '순위,닉네임,최종 상태,탈락 라운드,참가 시각\n'

  // 정렬: 생존자(1순위) -> 탈락 라운드 높은 순 -> 닉네임 순
  const sortedPlayers = [...players].sort((a, b) => {
    if (a.status === 'alive' && b.status !== 'alive') return -1
    if (a.status !== 'alive' && b.status === 'alive') return 1
    if (a.status === 'eliminated' && b.status === 'eliminated') {
      const roundA = a.eliminatedRound || 0
      const roundB = b.eliminatedRound || 0
      if (roundA !== roundB) return roundB - roundA
    }
    return a.nickname.localeCompare(b.nickname)
  })

  sortedPlayers.forEach((p, idx) => {
    let rankText = ''
    if (p.status === 'alive') {
      rankText = alivePlayers.length === 1 ? '1위 (단독 우승)' : '1위 (THE LAST TWO)'
    } else {
      rankText = `${alivePlayers.length + idx + 1 - alivePlayers.length}위`
    }

    const statusText = p.status === 'alive' ? '최종 생존 (우승)' : '탈락'
    const roundText = p.eliminatedRound ? `R${p.eliminatedRound}` : '-'
    const joinTime = new Date(p.joinedAt).toLocaleTimeString('ko-KR')

    csvContent += `${rankText},"${p.nickname.replace(/"/g, '""')}",${statusText},${roundText},${joinTime}\n`
  })

  // 브라우저 파일 다운로드 트리거
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.setAttribute('href', url)
  link.setAttribute('download', `THE_LAST_TWO_결과_${dateStr}.csv`)
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
