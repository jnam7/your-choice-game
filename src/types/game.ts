// ===== Game Types =====

export type GamePhase =
  | 'lobby'       // 대기실: 플레이어 접속 대기
  | 'question'    // 문제 공개
  | 'voting'      // 투표 진행 (설정된 시간)
  | 'revealing'   // 결과 공개 3초 전 서스펜스 카운트다운 (3... 2... 1...)
  | 'result'      // 결과 공개 (A/B 표수, 막대 그래프)
  | 'elimination' // 탈락자 연출 (탈락자 명단 표시)
  | 'gameover'    // 최종 2인 또는 1인 우승 → 게임 종료
  | 'finals'      // 결승 모드

export interface Player {
  id: string
  nickname: string
  status: 'alive' | 'eliminated'
  joinedAt: number
  eliminatedRound?: number
  isDummy?: boolean
  isAlive?: boolean
}

export type RuleMode = 'majority' | 'minority'
export type QrMode = 'wifi' | 'tunnel'

export interface Question {
  id: number | string
  category: string
  optionA: string
  optionB: string
  imageUrlA?: string
  imageUrlB?: string
  isFinals?: boolean
  order?: number
}

export interface Vote {
  playerId: string
  choice: 'A' | 'B'
  timestamp: number
}

export interface RoundResult {
  questionId: number | string
  question: Question
  votesA: number
  votesB: number
  totalVoters: number
  nonVoters: number
  majority: 'A' | 'B' | 'tie'
  ruleMode?: RuleMode
  eliminated: string[]  // player IDs
  survivors: string[]   // player IDs
  winnerCount?: number
  soleWinnerId?: string | null
}

export interface ChatMessage {
  id: string
  playerId: string
  nickname: string
  message: string
  text?: string
  timestamp: number
  isNotice?: boolean
  roomId?: string
}

export interface GameState {
  // 게임 상태
  phase: GamePhase
  roundNumber: number
  ruleMode: RuleMode // 'majority' (다수의 선택) | 'minority' (소수의 선택)
  currentQuestion: Question | null
  timeLeft: number
  timeLimit: number // 라운드별 설정 투표 시간 (기본 15초)
  isPaused: boolean  // 일시정지 상태
  isFinals: boolean
  isGameOver?: boolean
  soleWinnerId?: string | null
  votingDeadline?: number

  // 플레이어
  players: Player[]
  
  // 현재 라운드 투표
  votes: Record<string, 'A' | 'B'>  // playerId → choice
  
  // 결과 히스토리
  roundResults: RoundResult[]
  currentResult: RoundResult | null
  usedQuestionIds: (number | string)[]
  
  // 문제 풀 관리
  questionsList: Question[]

  // 실시간 사내 채팅 메시지 목록 (최신순 50개)
  chatMessages: ChatMessage[]

  // 채널(룸) 식별자 ('1' ~ '5', 기본값: '1')
  channelId?: string

  // 모바일 접속 호스트 URL (예: http://192.168.40.207:3001 또는 공용 도메인)
  serverHostUrl: string
  qrMode?: QrMode

  // 현재 플레이어 (직원 화면 용)
  currentPlayerId: string | null
}

export interface GameActions {
  // 플레이어 관리
  addPlayer: (nickname: string, existingId?: string) => string
  setPlayers?: (players: Player[]) => void
  removePlayer: (id: string) => void
  addMockPlayers: (count: number) => void
  changeNickname: (newNickname: string) => void
  
  // 게임 제어 흐름
  startGame: (autoStartVoting?: boolean) => void
  showQuestion: () => void
  startVoting: (customTimeLimit?: number) => void
  startRevealing: () => void
  submitVote: (playerId: string, choice: 'A' | 'B') => void
  vote?: (playerId: string, choice: 'A' | 'B') => void
  simulateDummyVotes: () => void
  clearDummyVotes?: () => void
  pauseGame: () => void
  resumeGame: () => void
  endVoting: () => void
  revealResult: () => void
  nextRound: () => void
  resetGame: () => void
  clearAllPlayers: () => void
  forceEndGame: () => void

  // 채널 설정
  setChannelId: (channelId: string) => void

  // 실시간 채팅
  sendChatMessage: (message: string) => void
  addChatMessage: (msg: ChatMessage) => void
  clearChatMessages: () => void

  // 문제 관리 (추가, 수정, 삭제, 시드)
  setRuleMode: (mode: RuleMode) => void
  setQrMode: (mode: QrMode) => void
  setTimeLimit: (seconds: number) => void
  setServerHostUrl: (url: string) => void
  addQuestionItem: (q: Omit<Question, 'id'>) => void
  updateQuestionItem: (id: number | string, q: Partial<Question>) => void
  deleteQuestionItem: (id: number | string) => void
  resetQuestionsToDefault: () => void

  // 타이머
  decrementTimer: () => void
  setTimeLeft: (time: number) => void
  
  // 플레이어 세션
  setCurrentPlayer: (id: string) => void
  clearCurrentPlayer: () => void

  // 결승 모드
  enterFinals: () => void

  // 유틸리티
  getAlivePlayers: () => Player[]
  getPlayerById: (id: string) => Player | undefined
  hasVoted: (playerId: string) => boolean
  simulateVotes: () => void
  syncWithServer: (serverData: Partial<GameState>) => void
}
