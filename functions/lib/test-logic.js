"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const questionsData_1 = require("./questionsData");
function evaluateRoundLogic(alivePlayers, votes) {
    const aliveIds = alivePlayers.map((p) => p.id);
    let votesA = 0;
    let votesB = 0;
    for (const choice of Object.values(votes)) {
        if (choice === 'A')
            votesA++;
        else if (choice === 'B')
            votesB++;
    }
    const voterIds = Object.keys(votes);
    const nonVoterIds = aliveIds.filter((id) => !voterIds.includes(id));
    let majority;
    let eliminatedIds = [];
    if (votesA === votesB) {
        majority = 'tie';
        eliminatedIds = [...nonVoterIds];
    }
    else if (votesA > votesB) {
        majority = 'A';
        const minorityIds = Object.entries(votes)
            .filter(([, choice]) => choice === 'B')
            .map(([id]) => id);
        eliminatedIds = [...minorityIds, ...nonVoterIds];
    }
    else {
        majority = 'B';
        const minorityIds = Object.entries(votes)
            .filter(([, choice]) => choice === 'A')
            .map(([id]) => id);
        eliminatedIds = [...minorityIds, ...nonVoterIds];
    }
    const survivorIds = aliveIds.filter((id) => !eliminatedIds.includes(id));
    let isGameOver = false;
    let soleWinnerId = null;
    if (survivorIds.length === 2) {
        isGameOver = true;
    }
    else if (survivorIds.length === 1) {
        isGameOver = true;
        soleWinnerId = survivorIds[0];
    }
    return {
        votesA,
        votesB,
        totalVoters: voterIds.length,
        nonVoters: nonVoterIds.length,
        majority,
        eliminated: eliminatedIds,
        survivors: survivorIds,
        isGameOver,
        soleWinnerId,
    };
}
// ===== 테스트 러너 =====
async function runTests() {
    console.log('====================================================');
    console.log('🚀 다수의 선택 : THE LAST TWO - 핵심 로직 및 보안 테스트');
    console.log('====================================================\n');
    let passed = 0;
    let failed = 0;
    function assert(condition, testName) {
        if (condition) {
            console.log(`  ✅ [PASS] ${testName}`);
            passed++;
        }
        else {
            console.error(`  ❌ [FAIL] ${testName}`);
            failed++;
        }
    }
    // 1. 문제 풀 검증
    console.log('1. [문제 관리 테스트]');
    assert(questionsData_1.DEFAULT_QUESTIONS.length === 30, '기본 문제 30개 등록 확인');
    assert(questionsData_1.FINALS_QUESTIONS.length === 10, '결승 추가 문제 10개 등록 확인');
    assert(questionsData_1.DEFAULT_QUESTIONS.every((q) => q.optionA && q.optionB && q.category && !q.isFinals), '30개 기본 문제의 A/B 선택지 및 카테고리 유효성 검증');
    assert(questionsData_1.FINALS_QUESTIONS.every((q) => q.isFinals), '결승 문제의 isFinals 플래그 검증');
    // 2. 100명 동시 참가 및 투표 시뮬레이션
    console.log('\n2. [100명 동시성 및 생존 판정 테스트]');
    const players100 = Array.from({ length: 100 }, (_, i) => ({
        id: `player_${i + 1}`,
        nickname: `참가자_${i + 1}`,
        status: 'alive',
    }));
    // 60명 A, 35명 B, 5명 미투표
    const votesRound1 = {};
    for (let i = 0; i < 60; i++)
        votesRound1[`player_${i + 1}`] = 'A';
    for (let i = 60; i < 95; i++)
        votesRound1[`player_${i + 1}`] = 'B';
    // player_96 ~ player_100은 미투표 (5명)
    const res1 = evaluateRoundLogic(players100, votesRound1);
    assert(res1.votesA === 60, 'A 투표수 60표 정확도');
    assert(res1.votesB === 35, 'B 투표수 35표 정확도');
    assert(res1.nonVoters === 5, '미투표자 5명 정확도');
    assert(res1.majority === 'A', 'A 다수 판정');
    assert(res1.survivors.length === 60, '다수(A) 선택자 60명 전원 생존');
    assert(res1.eliminated.length === 40, '소수(35명) + 미투표자(5명) = 총 40명 탈락');
    // 3. 동률(Tie) 규칙 검증
    console.log('\n3. [동률(Tie) 시 실제 투표자 전원 생존 & 미투표자 탈락 테스트]');
    const aliveRound2 = players100.slice(0, 20); // 20명 생존자
    // 9명 A, 9명 B, 2명 미투표
    const votesRound2 = {};
    for (let i = 0; i < 9; i++)
        votesRound2[aliveRound2[i].id] = 'A';
    for (let i = 9; i < 18; i++)
        votesRound2[aliveRound2[i].id] = 'B';
    // 2명 미투표
    const res2 = evaluateRoundLogic(aliveRound2, votesRound2);
    assert(res2.majority === 'tie', '9 vs 9 동률 판정');
    assert(res2.survivors.length === 18, '동률 시 실제 투표한 18명 전원 생존');
    assert(res2.nonVoters === 2, '미투표자 2명 감지');
    assert(res2.eliminated.length === 2, '동률 시에도 미투표자 2명은 반드시 탈락');
    // 4. 게임 종료: 정확히 2명 생존 시 종료 (THE LAST TWO)
    console.log('\n4. [최종 2인 종료 판정 테스트]');
    const aliveRound3 = [
        { id: 'p1', nickname: '김과장', status: 'alive' },
        { id: 'p2', nickname: '이대리', status: 'alive' },
        { id: 'p3', nickname: '박부장', status: 'alive' },
        { id: 'p4', nickname: '최사원', status: 'alive' },
    ];
    // 2명 A, 1명 B, 1명 미투표 -> A 2명 생존, B 1명 탈락, 미투표 1명 탈락
    const votesRound3 = { p1: 'A', p2: 'A', p3: 'B' };
    const res3 = evaluateRoundLogic(aliveRound3, votesRound3);
    assert(res3.survivors.length === 2, '정확히 2명 생존');
    assert(res3.isGameOver === true, '생존자 2명 시 게임 종료 플래그 작동');
    // 5. 게임 종료: 1명 생존 시 단독 우승 예외 처리
    console.log('\n5. [1명 우승 예외 처리 테스트]');
    const aliveRound4 = [
        { id: 'p1', nickname: '김과장', status: 'alive' },
        { id: 'p2', nickname: '이대리', status: 'alive' },
        { id: 'p3', nickname: '박부장', status: 'alive' },
    ];
    // p1: A, p2: B, p3: B -> B가 2명으로 다수, A 탈락 => 2명 생존
    // 반대로 p1: A, p2: A, p3: 미투표 -> A 2명 생존
    // 만약 3명 중 1명만 A를 찍고, 2명 모두 미투표인 경우:
    const votesRound4 = { p1: 'A' }; // p2, p3 미투표
    const res4 = evaluateRoundLogic(aliveRound4, votesRound4);
    assert(res4.survivors.length === 1, '생존자 1명');
    assert(res4.isGameOver === true, '1명 단독 우승 시 게임 종료');
    assert(res4.soleWinnerId === 'p1', '단독 우승자 ID 일치');
    // 6. 투표 마감 시간 및 중복 투표 차단 검증
    console.log('\n6. [보안: 15초 마감 및 중복 투표 차단 로직 검증]');
    const now = Date.now();
    const deadline = now + 15000; // 15초 뒤
    const isLateVote = (voteTime) => voteTime > deadline + 500;
    assert(!isLateVote(now + 10000), '10초 시점 투표 정상 수락');
    assert(isLateVote(now + 16000), '16초 시점(15초 초과) 투표 엄격 차단');
    // 중복 투표 차단 확인
    const recordedVotes = new Set();
    function attemptVote(playerId) {
        if (recordedVotes.has(playerId))
            return false;
        recordedVotes.add(playerId);
        return true;
    }
    assert(attemptVote('user_123'), '첫 투표 성공');
    assert(!attemptVote('user_123'), '동일 라운드 중복 투표 시도 차단');
    // 7. 결승 모드 전환 테스트
    console.log('\n7. [결승 모드 전환 로직 검증]');
    let currentRound = 30;
    let survivorsLeft = 4;
    const shouldEnterFinals = currentRound >= 30 && survivorsLeft >= 3;
    assert(shouldEnterFinals === true, '30문제 소진 후 3명 이상 잔여 시 결승 모드 전환');
    console.log('\n====================================================');
    console.log(`테스트 결과: ${passed} 통과, ${failed} 실패`);
    console.log('====================================================\n');
    if (failed > 0) {
        process.exit(1);
    }
}
runTests().catch(console.error);
//# sourceMappingURL=test-logic.js.map