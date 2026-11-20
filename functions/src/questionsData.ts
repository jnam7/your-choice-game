export interface GameQuestion {
  id: string
  category: string
  optionA: string
  optionB: string
  isFinals: boolean
  createdAt?: number
}

// 기본 밸런스 게임 30개 문제
export const DEFAULT_QUESTIONS: Omit<GameQuestion, 'id'>[] = [
  // 음식 (1~5)
  { category: '음식', optionA: '평생 치킨만 먹기', optionB: '평생 피자만 먹기', isFinals: false },
  { category: '음식', optionA: '매운 음식만 먹기', optionB: '싱거운 음식만 먹기', isFinals: false },
  { category: '음식', optionA: '아침을 안 먹기', optionB: '야식을 안 먹기', isFinals: false },
  { category: '음식', optionA: '커피 없는 삶', optionB: '디저트 없는 삶', isFinals: false },
  { category: '음식', optionA: '떡볶이 평생 금지', optionB: '삼겹살 평생 금지', isFinals: false },

  // 직장생활 (6~10)
  { category: '직장생활', optionA: '월요일 2시간 일찍 출근', optionB: '금요일 2시간 늦게 퇴근', isFinals: false },
  { category: '직장생활', optionA: '사무실 옆자리 수다쟁이', optionB: '사무실 옆자리 무반응', isFinals: false },
  { category: '직장생활', optionA: '연봉 500만원 UP + 야근', optionB: '현재 연봉 + 칼퇴', isFinals: false },
  { category: '직장생활', optionA: '점심시간 30분', optionB: '출근시간 1시간 빨라짐', isFinals: false },
  { category: '직장생활', optionA: '완벽한 상사 + 힘든 업무', optionB: '힘든 상사 + 쉬운 업무', isFinals: false },

  // 초능력 (11~15)
  { category: '초능력', optionA: '투명인간 되기', optionB: '하늘을 날기', isFinals: false },
  { category: '초능력', optionA: '과거로 가기', optionB: '미래로 가기', isFinals: false },
  { category: '초능력', optionA: '마음을 읽는 능력', optionB: '5분 후 미래를 보는 능력', isFinals: false },
  { category: '초능력', optionA: '불로불사', optionB: '매일 1억 받기', isFinals: false },
  { category: '초능력', optionA: '동물과 대화', optionB: '모든 외국어 가능', isFinals: false },

  // 생활/여행 (16~20)
  { category: '생활', optionA: '여름만 사는 나라', optionB: '겨울만 사는 나라', isFinals: false },
  { category: '생활', optionA: 'SNS 없는 삶', optionB: '게임 없는 삶', isFinals: false },
  { category: '생활', optionA: '도시에서 혼자 살기', optionB: '시골에서 가족과 살기', isFinals: false },
  { category: '생활', optionA: '엘리베이터 없는 20층', optionB: '1층인데 벌레 많은 집', isFinals: false },
  { category: '생활', optionA: '5년 뒤 기억 삭제', optionB: '5년 전 기억 삭제', isFinals: false },

  // 극한선택 (21~25)
  { category: '극한선택', optionA: '1년 내내 월요일', optionB: '1년 내내 일요일 밤', isFinals: false },
  { category: '극한선택', optionA: '10년 전 나로 돌아가기', optionB: '10년 후 나를 만나기', isFinals: false },
  { category: '극한선택', optionA: '스마트폰 없이 1년', optionB: '에어컨/히터 없이 1년', isFinals: false },
  { category: '극한선택', optionA: '항상 정장만 입기', optionB: '항상 운동복만 입기', isFinals: false },
  { category: '극한선택', optionA: '노래 못하는 가수 되기', optionB: '연기 못하는 배우 되기', isFinals: false },

  // 연말특별 (26~30)
  { category: '연말특별', optionA: '보너스 2배 + 연차 0일', optionB: '보너스 없음 + 연차 2배', isFinals: false },
  { category: '연말특별', optionA: '회식 필참 1년', optionB: '팀회식 영구 금지', isFinals: false },
  { category: '연말특별', optionA: '월급 두 배 + 주 6일', optionB: '현재 월급 + 주 4일', isFinals: false },
  { category: '연말특별', optionA: '내년 모든 프로젝트 성공', optionB: '내년 로또 한 번 당첨', isFinals: false },
  { category: '연말특별', optionA: '사장님과 1일 직무교환', optionB: '신입으로 1일 체험', isFinals: false },
]

// 결승 전용 추가 문제 10개 (더 치열하고 미묘한 심리전 문제)
export const FINALS_QUESTIONS: Omit<GameQuestion, 'id'>[] = [
  { category: '결승-생존', optionA: '상대방 1명 탈락시키기', optionB: '상대방 전원과 승부하기', isFinals: true },
  { category: '결승-심리', optionA: '모두가 A를 고를 것이다', optionB: '모두가 B를 고를 것이다', isFinals: true },
  { category: '결승-가치관', optionA: '명예로운 패배', optionB: '비열한 생존', isFinals: true },
  { category: '결승-직장', optionA: '팀장님 앞에서 실수하기', optionB: '대표님 앞에서 졸기', isFinals: true },
  { category: '결승-행운', optionA: '동전 앞면 던지기', optionB: '동전 뒷면 던지기', isFinals: true },
  { category: '결승-미래', optionA: '내일 아침 10억 입금', optionB: '10년 뒤 100억 입금', isFinals: true },
  { category: '결승-비밀', optionA: '내 모든 검색 기록 공개', optionB: '내 모든 통화 녹음 공개', isFinals: true },
  { category: '결승-인간관계', optionA: '나를 좋아하는 100명', optionB: '내가 좋아하는 1명', isFinals: true },
  { category: '결승-선택', optionA: '빨간색 약 (진실)', optionB: '파란색 약 (행복한 환상)', isFinals: true },
  { category: '결승-운명', optionA: 'THE LAST TWO 우승 상금 기부', optionB: 'THE LAST TWO 우승 상금 전액 수령', isFinals: true },
]
