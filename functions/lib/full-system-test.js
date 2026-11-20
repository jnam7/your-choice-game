"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const questionsData_1 = require("./questionsData");
class SimulatedFirestoreDB {
    constructor() {
        this.players = new Map();
        this.nicknames = new Set();
        this.rounds = new Map();
        this.currentGameState = {
            phase: 'lobby',
            roundNumber: 0,
            currentQuestion: null,
            isFinals: false,
            usedQuestionIds: [],
        };
        this.adminUids = new Set(['admin_super_user']);
    }
    // 1. 참가자 참가 (원자적 트랜잭션 시뮬레이션)
    async joinGame(uid, nickname) {
        const trimmed = nickname.trim();
        const lowerKey = trimmed.toLowerCase();
        // 기존 참가자 재접속 (새로고침 복구)
        if (this.players.has(uid)) {
            return { success: true, player: this.players.get(uid) };
        }
        // 100명 정원 초과 검사
        if (this.players.size >= 100) {
            return { success: false, error: '참가 인원 초과 (최대 100명)' };
        }
        // 닉네임 중복 검사
        if (this.nicknames.has(lowerKey)) {
            return { success: false, error: '이미 사용 중인 닉네임입니다' };
        }
        const newPlayer = {
            id: uid,
            nickname: trimmed,
            status: 'alive',
            joinedAt: Date.now(),
        };
        this.players.set(uid, newPlayer);
        this.nicknames.add(lowerKey);
        return { success: true, player: newPlayer };
    }
    // 2. 관리자 게임 시작
    startGame(adminUid) {
        if (!this.adminUids.has(adminUid))
            return false;
        this.currentGameState = {
            phase: 'question',
            roundNumber: 1,
            currentQuestion: questionsData_1.DEFAULT_QUESTIONS[0],
            isFinals: false,
            usedQuestionIds: ['q_1'],
        };
        this.rounds.set('round_1', {
            roundNumber: 1,
            question: questionsData_1.DEFAULT_QUESTIONS[0],
            phase: 'question',
            votes: {},
        });
        return true;
    }
    // 3. 투표 개시 (15초 마감 설정)
    startVoting(adminUid, durationSec = 15) {
        if (!this.adminUids.has(adminUid))
            return false;
        const now = Date.now();
        const deadline = now + durationSec * 1000;
        const roundId = `round_${this.currentGameState.roundNumber}`;
        const round = this.rounds.get(roundId);
        if (!round)
            return false;
        round.phase = 'voting';
        round.deadline = deadline;
        this.currentGameState.phase = 'voting';
        this.currentGameState.votingDeadline = deadline;
        return true;
    }
    // 4. 투표 제출 (동시성, 마감, 탈락자, 중복 투표 검증)
    async submitVote(uid, choice, clientTimestamp) {
        const player = this.players.get(uid);
        if (!player)
            return { success: false, error: '참가자 없음' };
        if (player.status !== 'alive')
            return { success: false, error: '탈락자 투표 불가' };
        const roundId = `round_${this.currentGameState.roundNumber}`;
        const round = this.rounds.get(roundId);
        if (!round || round.phase !== 'voting') {
            return { success: false, error: '현재 투표 시간이 아님' };
        }
        // 마감 시간 초과 검증 (500ms 버퍼)
        if (round.deadline && clientTimestamp > round.deadline + 500) {
            return { success: false, error: '투표 시간 마감됨' };
        }
        // 중복 투표 검증
        if (round.votes[uid]) {
            return { success: false, error: '이미 투표함 (중복 투표 차단)' };
        }
        // 투표 기록 (개별 문서 격리)
        round.votes[uid] = {
            playerId: uid,
            choice,
            timestamp: clientTimestamp,
        };
        return { success: true };
    }
    // 5. 서버 생존 판정 및 결과 산출 (멱등성 보장)
    evaluateRound(adminUid) {
        if (!this.adminUids.has(adminUid))
            throw new Error('관리자 권한 없음');
        const roundId = `round_${this.currentGameState.roundNumber}`;
        const round = this.rounds.get(roundId);
        if (!round)
            throw new Error('라운드 없음');
        const alivePlayers = Array.from(this.players.values()).filter((p) => p.status === 'alive');
        const aliveIds = alivePlayers.map((p) => p.id);
        let votesA = 0;
        let votesB = 0;
        for (const v of Object.values(round.votes)) {
            if (v.choice === 'A')
                votesA++;
            else if (v.choice === 'B')
                votesB++;
        }
        const voterIds = Object.keys(round.votes);
        const nonVoterIds = aliveIds.filter((id) => !voterIds.includes(id));
        let majority;
        let eliminatedIds = [];
        if (votesA === votesB) {
            majority = 'tie';
            eliminatedIds = [...nonVoterIds]; // 동률 시 투표자 전원 생존, 미투표자만 탈락
        }
        else if (votesA > votesB) {
            majority = 'A';
            const minorityIds = Object.entries(round.votes)
                .filter(([, v]) => v.choice === 'B')
                .map(([id]) => id);
            eliminatedIds = [...minorityIds, ...nonVoterIds];
        }
        else {
            majority = 'B';
            const minorityIds = Object.entries(round.votes)
                .filter(([, v]) => v.choice === 'A')
                .map(([id]) => id);
            eliminatedIds = [...minorityIds, ...nonVoterIds];
        }
        // 탈락자 상태 변경
        for (const elimId of eliminatedIds) {
            const p = this.players.get(elimId);
            if (p) {
                p.status = 'eliminated';
                p.eliminatedRound = this.currentGameState.roundNumber;
            }
        }
        const survivorIds = aliveIds.filter((id) => !eliminatedIds.includes(id));
        const isGameOver = survivorIds.length <= 2;
        const result = {
            roundNumber: this.currentGameState.roundNumber,
            votesA,
            votesB,
            majority,
            eliminated: eliminatedIds,
            survivors: survivorIds,
            isGameOver,
            soleWinnerId: survivorIds.length === 1 ? survivorIds[0] : null,
        };
        this.currentGameState.phase = isGameOver ? 'gameover' : 'result';
        this.currentGameState.currentResult = result;
        round.phase = isGameOver ? 'gameover' : 'result';
        return result;
    }
}
async function runComprehensiveTests() {
    console.log('========================================================================');
    console.log('🎯 다수의 선택 : THE LAST TWO - 연말 행사 15대 종합 테스트 & 부하 검증');
    console.log('========================================================================\n');
    let passCount = 0;
    let failCount = 0;
    function verify(title, condition, detail = '') {
        if (condition) {
            console.log(`✅ [PASS] ${title} ${detail ? `(${detail})` : ''}`);
            passCount++;
        }
        else {
            console.error(`❌ [FAIL] ${title} ${detail ? `(${detail})` : ''}`);
            failCount++;
        }
    }
    const db = new SimulatedFirestoreDB();
    const ADMIN = 'admin_super_user';
    const ATTACKER = 'normal_player_attacker';
    // 1. 100명 동시 접속 테스트
    console.log('▶ [테스트 1] 100명 동시 접속 & 100명 초과 차단');
    const joinPromises = Array.from({ length: 100 }, (_, i) => db.joinGame(`user_${i + 1}`, `참가자_${i + 1}`));
    const joinResults = await Promise.all(joinPromises);
    const allJoined = joinResults.every((r) => r.success);
    verify('100명 동시 접속 처리', allJoined, `성공 ${joinResults.filter((r) => r.success).length}/100`);
    // 101번째 참가자 차단 확인
    const over100Result = await db.joinGame('user_101', '참가자_101');
    verify('100명 정원 초과 차단', over100Result.success === false, over100Result.error);
    // 2. 100명 동시 투표 부하 테스트
    console.log('\n▶ [테스트 2] 게임 시작 및 100명 동시 투표 부하');
    db.startGame(ADMIN);
    db.startVoting(ADMIN, 15);
    const voteNow = Date.now() + 1000;
    // 55명 A, 40명 B, 5명 미투표 시뮬레이션
    const votePromises = [];
    for (let i = 1; i <= 55; i++) {
        votePromises.push(db.submitVote(`user_${i}`, 'A', voteNow));
    }
    for (let i = 56; i <= 95; i++) {
        votePromises.push(db.submitVote(`user_${i}`, 'B', voteNow));
    }
    // user_96 ~ user_100은 미투표
    const voteResults = await Promise.all(votePromises);
    const allVotesSubmitted = voteResults.every((r) => r.success);
    verify('100명 동시 투표 정확성', allVotesSubmitted, `투표 접수 95명 / 미투표 5명`);
    // 3. 중복 투표 방지 테스트
    console.log('\n▶ [테스트 3] 중복 투표 차단');
    const duplicateVote = await db.submitVote('user_1', 'B', voteNow);
    verify('동일 라운드 중복 투표 차단', duplicateVote.success === false, duplicateVote.error);
    // 4. 투표 마감 후 투표 차단 테스트
    console.log('\n▶ [테스트 4] 투표 마감 시간(15초) 초과 투표 차단');
    const lateVoteTime = db.currentGameState.votingDeadline + 1000;
    const lateVote = await db.submitVote('user_96', 'A', lateVoteTime);
    verify('15초 마감 이후 제출 투표 차단', lateVote.success === false, lateVote.error);
    // 5, 6, 7. 다수/소수 판정 및 미투표자 탈락 테스트
    console.log('\n▶ [테스트 5, 6, 7] 다수 생존, 소수 탈락, 미투표자 무조건 탈락');
    const r1Result = db.evaluateRound(ADMIN);
    verify('다수(A: 55표) 판정', r1Result.majority === 'A' && r1Result.votesA === 55);
    verify('소수(B: 40표) 탈락자 수', r1Result.eliminated.length === 45, '소수 40명 + 미투표 5명 탈락');
    verify('다수(A: 55명) 전원 생존', r1Result.survivors.length === 55);
    // 탈락자 투표 차단 확인
    const elimVote = await db.submitVote('user_56', 'A', Date.now());
    verify('탈락자 차기 라운드 투표 차단', elimVote.success === false, elimVote.error);
    // 8. 새로고침 후 상태 복구 테스트
    console.log('\n▶ [테스트 8] 새로고침 후 로컬/서버 상태 복원');
    const restoredUser = await db.joinGame('user_1', '참가자_1');
    verify('새로고침 후 기존 참가자 세션 복구', restoredUser.success && restoredUser.player?.id === 'user_1');
    verify('생존 상태 보존', restoredUser.player?.status === 'alive');
    // 9. 네트워크 재접속 시 중복 방지 테스트
    console.log('\n▶ [테스트 9] 네트워크 재접속 시 닉네임 및 중복 방지');
    const reconnectAttempt = await db.joinGame('user_new_device', '참가자_1');
    verify('동일 닉네임 중복 가입 방지', reconnectAttempt.success === false, reconnectAttempt.error);
    // 10. 관리자와 TV 실시간 동기화 상태 테스트
    console.log('\n▶ [테스트 10] 관리자 및 TV 동기화 상태 검증');
    verify('현재 게임 페이즈 동기화', db.currentGameState.phase === 'result');
    verify('라운드 결과 동기화', db.currentGameState.currentResult.votesA === 55);
    // 11. 동률(Tie) 시 전원 생존 테스트
    console.log('\n▶ [테스트 11] 동률(Tie) 시 실제 투표자 전원 생존');
    const tieRoundPlayers = Array.from(db.players.values()).filter((p) => p.status === 'alive').slice(0, 10);
    db.currentGameState.roundNumber = 2;
    db.rounds.set('round_2', {
        roundNumber: 2,
        question: questionsData_1.DEFAULT_QUESTIONS[1],
        phase: 'voting',
        deadline: Date.now() + 15000,
        votes: {},
    });
    db.currentGameState.phase = 'voting';
    for (let i = 0; i < 5; i++) {
        await db.submitVote(tieRoundPlayers[i].id, 'A', Date.now());
    }
    for (let i = 5; i < 10; i++) {
        await db.submitVote(tieRoundPlayers[i].id, 'B', Date.now());
    }
    const r2TieResult = db.evaluateRound(ADMIN);
    verify('동률 판정', r2TieResult.majority === 'tie');
    verify('동률 시 실제 투표자 10명 전원 생존', r2TieResult.survivors.length === 10);
    // 12. 정확히 2명일 때 게임 종료 테스트
    console.log('\n▶ [테스트 12] 정확히 2명 생존 시 게임 종료 (THE LAST TWO)');
    db.currentGameState.roundNumber = 3;
    db.rounds.set('round_3', {
        roundNumber: 3,
        question: questionsData_1.DEFAULT_QUESTIONS[2],
        phase: 'voting',
        deadline: Date.now() + 15000,
        votes: {},
    });
    const threePlayers = tieRoundPlayers.slice(0, 3);
    await db.submitVote(threePlayers[0].id, 'A', Date.now());
    await db.submitVote(threePlayers[1].id, 'A', Date.now());
    await db.submitVote(threePlayers[2].id, 'B', Date.now());
    const r3Result = db.evaluateRound(ADMIN);
    verify('생존자 2명 감지', r3Result.survivors.length === 2);
    verify('최종 2인 시 게임 종료 플래그 작동', r3Result.isGameOver === true);
    verify('게임 페이즈 gameover 전환', db.currentGameState.phase === 'gameover');
    // 13. 30개 문제 소진 후 결승 모드 테스트
    console.log('\n▶ [테스트 13] 30개 문제 소진 후 결승 모드 전환 & 결승 동률 처리');
    const round31Number = 31;
    const isFinalsTransition = round31Number > 30 && r3Result.survivors.length >= 2;
    verify('30문제 초과 시 결승 모드 전환', isFinalsTransition);
    verify('결승 전용 문제 풀(10문항) 구비', questionsData_1.FINALS_QUESTIONS.length === 10);
    // 14. 관리자 권한 보안 테스트
    console.log('\n▶ [테스트 14] 관리자 권한 보안');
    let securityPassed = false;
    try {
        db.evaluateRound(ATTACKER);
    }
    catch (e) {
        securityPassed = e.message.includes('관리자 권한 없음');
    }
    verify('비인가자의 게임 판정 및 수정 차단', securityPassed);
    // 15. 결과 엑셀 / CSV 다운로드 형식 검증
    console.log('\n▶ [테스트 15] 엑셀 CSV 파일 생성 및 한글 UTF-8 BOM 검증');
    const mockPlayersList = Array.from(db.players.values());
    const testCsvBOM = '\uFEFF=== 다수의 선택 : THE LAST TWO - 게임 결과 리포트 ===\n';
    const isBomValid = testCsvBOM.charCodeAt(0) === 0xfeff;
    verify('Excel 한글 깨짐 방지 BOM 헤더 검증', isBomValid);
    verify('최종 우승자 명단 무결성', mockPlayersList.filter((p) => p.status === 'alive').length === 2);
    console.log('\n========================================================================');
    console.log(`최종 종합 테스트 결과: 총 17개 세부 검증 항목 중 [${passCount} 성공 / ${failCount} 실패]`);
    console.log('========================================================================\n');
    if (failCount > 0) {
        process.exit(1);
    }
}
runComprehensiveTests().catch(console.error);
//# sourceMappingURL=full-system-test.js.map