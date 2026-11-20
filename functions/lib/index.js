"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminResetGame = exports.adminNextRound = exports.adminEvaluateResult = exports.adminStartVoting = exports.adminStartGame = exports.adminLogin = exports.submitVote = exports.joinGame = exports.deleteQuestion = exports.updateQuestion = exports.addQuestion = exports.listQuestions = exports.seedQuestions = void 0;
const admin = __importStar(require("firebase-admin"));
const https_1 = require("firebase-functions/v2/https");
const questionsData_1 = require("./questionsData");
admin.initializeApp();
const db = admin.firestore();
// ===== 헬퍼: 관리자 권한 확인 =====
async function verifyAdminAuth(auth, adminSecret) {
    if (!auth)
        return false;
    if (auth.token?.admin === true)
        return true;
    const expectedSecret = process.env.ADMIN_SECRET_KEY || 'admin_secret_key_change_me';
    if (adminSecret && adminSecret === expectedSecret) {
        await admin.auth().setCustomUserClaims(auth.uid, { admin: true });
        await db.collection('admins').doc(auth.uid).set({
            uid: auth.uid,
            grantedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return true;
    }
    const adminDoc = await db.collection('admins').doc(auth.uid).get();
    return adminDoc.exists;
}
// =========================================================================
// [문제 관리 CRUD 및 시드]
// =========================================================================
// 1. 기본 30문제 + 결승 10문제 시딩
exports.seedQuestions = (0, https_1.onCall)({ cors: true }, async (request) => {
    const isAdmin = await verifyAdminAuth(request.auth, request.data?.secretKey);
    if (!isAdmin) {
        throw new https_1.HttpsError('permission-denied', '관리자 권한이 필요합니다.');
    }
    const batch = db.batch();
    const questionsCol = db.collection('questions');
    // 기존 문제 확인
    const existing = await questionsCol.limit(1).get();
    if (!existing.empty && !request.data?.force) {
        return { success: true, message: '이미 문제가 등록되어 있습니다.' };
    }
    let index = 1;
    for (const q of questionsData_1.DEFAULT_QUESTIONS) {
        const docRef = questionsCol.doc(`q_${index}`);
        batch.set(docRef, {
            ...q,
            id: `q_${index}`,
            order: index,
            createdAt: Date.now(),
        });
        index++;
    }
    for (const q of questionsData_1.FINALS_QUESTIONS) {
        const docRef = questionsCol.doc(`q_${index}`);
        batch.set(docRef, {
            ...q,
            id: `q_${index}`,
            order: index,
            createdAt: Date.now(),
        });
        index++;
    }
    await batch.commit();
    return { success: true, total: index - 1 };
});
// 2. 문제 목록 조회 (전체 / 일반 / 결승)
exports.listQuestions = (0, https_1.onCall)({ cors: true }, async (request) => {
    const isFinalsFilter = request.data?.isFinals;
    let query = db.collection('questions').orderBy('order', 'asc');
    if (typeof isFinalsFilter === 'boolean') {
        query = query.where('isFinals', '==', isFinalsFilter);
    }
    const snapshot = await query.get();
    if (snapshot.empty) {
        // DB에 아직 없으면 기본 데이터 반환
        const all = [
            ...questionsData_1.DEFAULT_QUESTIONS.map((q, i) => ({ ...q, id: `default_${i + 1}`, order: i + 1 })),
            ...questionsData_1.FINALS_QUESTIONS.map((q, i) => ({ ...q, id: `finals_${i + 1}`, order: 31 + i })),
        ];
        if (typeof isFinalsFilter === 'boolean') {
            return { success: true, questions: all.filter((q) => q.isFinals === isFinalsFilter) };
        }
        return { success: true, questions: all };
    }
    const questions = [];
    snapshot.forEach((doc) => {
        questions.push(doc.data());
    });
    return { success: true, questions };
});
// 3. 문제 추가
exports.addQuestion = (0, https_1.onCall)({ cors: true }, async (request) => {
    const isAdmin = await verifyAdminAuth(request.auth, request.data?.secretKey);
    if (!isAdmin) {
        throw new https_1.HttpsError('permission-denied', '관리자 권한이 필요합니다.');
    }
    const { category, optionA, optionB, isFinals } = request.data;
    if (!category || !optionA || !optionB) {
        throw new https_1.HttpsError('invalid-argument', '모든 항목을 입력해야 합니다.');
    }
    const countSnap = await db.collection('questions').count().get();
    const newOrder = countSnap.data().count + 1;
    const newDocRef = db.collection('questions').doc();
    const questionData = {
        id: newDocRef.id,
        category: String(category).trim(),
        optionA: String(optionA).trim(),
        optionB: String(optionB).trim(),
        isFinals: Boolean(isFinals),
        createdAt: Date.now(),
    };
    await newDocRef.set({ ...questionData, order: newOrder });
    return { success: true, question: questionData };
});
// 4. 문제 수정
exports.updateQuestion = (0, https_1.onCall)({ cors: true }, async (request) => {
    const isAdmin = await verifyAdminAuth(request.auth, request.data?.secretKey);
    if (!isAdmin) {
        throw new https_1.HttpsError('permission-denied', '관리자 권한이 필요합니다.');
    }
    const { id, category, optionA, optionB, isFinals } = request.data;
    if (!id) {
        throw new https_1.HttpsError('invalid-argument', '문제 ID가 필요합니다.');
    }
    const docRef = db.collection('questions').doc(id);
    const existing = await docRef.get();
    if (!existing.exists) {
        throw new https_1.HttpsError('not-found', '해당 문제를 찾을 수 없습니다.');
    }
    const updates = {};
    if (category !== undefined)
        updates.category = String(category).trim();
    if (optionA !== undefined)
        updates.optionA = String(optionA).trim();
    if (optionB !== undefined)
        updates.optionB = String(optionB).trim();
    if (isFinals !== undefined)
        updates.isFinals = Boolean(isFinals);
    await docRef.update(updates);
    return { success: true, id, updates };
});
// 5. 문제 삭제
exports.deleteQuestion = (0, https_1.onCall)({ cors: true }, async (request) => {
    const isAdmin = await verifyAdminAuth(request.auth, request.data?.secretKey);
    if (!isAdmin) {
        throw new https_1.HttpsError('permission-denied', '관리자 권한이 필요합니다.');
    }
    const { id } = request.data;
    if (!id) {
        throw new https_1.HttpsError('invalid-argument', '문제 ID가 필요합니다.');
    }
    await db.collection('questions').doc(id).delete();
    return { success: true, id };
});
// =========================================================================
// [참가자 관리: joinGame]
// - 익명 인증 필수
// - 최대 100명 제한
// - 닉네임 중복 방지 (원자적 트랜잭션)
// - 새로고침 후 재참여 보장
// =========================================================================
exports.joinGame = (0, https_1.onCall)({ cors: true }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError('unauthenticated', '로그인(익명 인증)이 필요합니다.');
    }
    const uid = request.auth.uid;
    const rawNickname = request.data?.nickname;
    if (!rawNickname || typeof rawNickname !== 'string') {
        throw new https_1.HttpsError('invalid-argument', '올바른 닉네임을 입력해주세요.');
    }
    const nickname = rawNickname.trim();
    if (nickname.length < 1 || nickname.length > 10) {
        throw new https_1.HttpsError('invalid-argument', '닉네임은 1자 이상 10자 이하여야 합니다.');
    }
    const nicknameKey = nickname.toLowerCase();
    return await db.runTransaction(async (transaction) => {
        // 기존 참가자인지 확인 (새로고침 후 복구)
        const playerDocRef = db.collection('players').doc(uid);
        const existingPlayer = await transaction.get(playerDocRef);
        if (existingPlayer.exists) {
            return {
                success: true,
                player: existingPlayer.data(),
                isReconnected: true,
            };
        }
        // 참가자 수 제한 (최대 100명)
        const playersSnapshot = await transaction.get(db.collection('players'));
        if (playersSnapshot.size >= 100) {
            throw new https_1.HttpsError('resource-exhausted', '참가 인원이 초과되었습니다. (최대 100명)');
        }
        // 닉네임 중복 방지
        const nicknameDocRef = db.collection('nicknames').doc(nicknameKey);
        const existingNickname = await transaction.get(nicknameDocRef);
        if (existingNickname.exists) {
            throw new https_1.HttpsError('already-exists', '이미 사용 중인 닉네임입니다.');
        }
        const playerData = {
            id: uid,
            nickname,
            status: 'alive',
            joinedAt: Date.now(),
        };
        transaction.set(playerDocRef, playerData);
        transaction.set(nicknameDocRef, {
            uid,
            nickname,
            createdAt: Date.now(),
        });
        return {
            success: true,
            player: playerData,
            isReconnected: false,
        };
    });
});
// =========================================================================
// [투표: submitVote]
// - 15초 제한 시간 (서버 시간 기준 엄격 적용)
// - 단일 선택, 투표 수정/재투표 차단
// - 탈락자 투표 차단
// - 100명 동시 투표에도 격리된 문서 쓰기로 동시성 경합 없이 정확 처리
// =========================================================================
exports.submitVote = (0, https_1.onCall)({ cors: true }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError('unauthenticated', '인증이 필요합니다.');
    }
    const uid = request.auth.uid;
    const choice = request.data?.choice;
    if (choice !== 'A' && choice !== 'B') {
        throw new https_1.HttpsError('invalid-argument', "선택지는 'A' 또는 'B'이어야 합니다.");
    }
    return await db.runTransaction(async (transaction) => {
        // 1. 생존 여부 확인
        const playerRef = db.collection('players').doc(uid);
        const playerDoc = await transaction.get(playerRef);
        if (!playerDoc.exists) {
            throw new https_1.HttpsError('not-found', '참가자 정보를 찾을 수 없습니다.');
        }
        const player = playerDoc.data();
        if (player?.status !== 'alive') {
            throw new https_1.HttpsError('permission-denied', '탈락자는 투표에 참여할 수 없습니다.');
        }
        // 2. 현재 라운드 및 페이즈 검증
        const gameRef = db.collection('game').doc('current');
        const gameDoc = await transaction.get(gameRef);
        if (!gameDoc.exists) {
            throw new https_1.HttpsError('failed-precondition', '게임이 시작되지 않았습니다.');
        }
        const gameState = gameDoc.data();
        if (gameState?.phase !== 'voting') {
            throw new https_1.HttpsError('failed-precondition', '현재는 투표 시간이 아닙니다.');
        }
        // 3. 서버 기준 15초 마감 검증 (네트워크 지연 500ms 버퍼)
        const now = Date.now();
        const deadline = gameState?.votingDeadline || 0;
        if (now > deadline + 500) {
            throw new https_1.HttpsError('deadline-exceeded', '투표 시간이 마감되었습니다.');
        }
        // 4. 중복 투표 차단
        const roundId = `round_${gameState.roundNumber}`;
        const voteRef = db.collection('rounds').doc(roundId).collection('votes').doc(uid);
        const existingVote = await transaction.get(voteRef);
        if (existingVote.exists) {
            throw new https_1.HttpsError('already-exists', '이미 투표를 제출하셨습니다. 변경할 수 없습니다.');
        }
        // 투표 기록
        transaction.set(voteRef, {
            playerId: uid,
            nickname: player.nickname,
            choice,
            timestamp: now,
        });
        return { success: true, choice };
    });
});
// =========================================================================
// [관리자 인증: adminLogin]
// =========================================================================
exports.adminLogin = (0, https_1.onCall)({ cors: true }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError('unauthenticated', '인증이 필요합니다.');
    }
    const secretKey = request.data?.secretKey;
    const isValid = await verifyAdminAuth(request.auth, secretKey);
    if (!isValid) {
        throw new https_1.HttpsError('permission-denied', '관리자 시크릿 키가 일치하지 않습니다.');
    }
    return { success: true, admin: true };
});
// =========================================================================
// [게임 진행: adminStartGame]
// - 30개 문제 중 무작위 1번 문제 출제
// - 중복 출제 방지 추적 시작
// =========================================================================
exports.adminStartGame = (0, https_1.onCall)({ cors: true }, async (request) => {
    const isAdmin = await verifyAdminAuth(request.auth, request.data?.secretKey);
    if (!isAdmin) {
        throw new https_1.HttpsError('permission-denied', '관리자 권한이 필요합니다.');
    }
    // 문제 목록에서 일반 문제 가져오기
    const questionsSnap = await db.collection('questions').where('isFinals', '==', false).get();
    let pool = [];
    if (!questionsSnap.empty) {
        questionsSnap.forEach((doc) => pool.push(doc.data()));
    }
    else {
        pool = questionsData_1.DEFAULT_QUESTIONS.map((q, i) => ({ ...q, id: `default_${i + 1}` }));
    }
    const firstQuestion = pool[Math.floor(Math.random() * pool.length)];
    await db.collection('game').doc('current').set({
        phase: 'question',
        roundNumber: 1,
        currentQuestion: firstQuestion,
        usedQuestionIds: [firstQuestion.id],
        isFinals: false,
        updatedAt: Date.now(),
    });
    await db.collection('rounds').doc('round_1').set({
        roundNumber: 1,
        question: firstQuestion,
        phase: 'question',
        createdAt: Date.now(),
    });
    return { success: true, question: firstQuestion };
});
// =========================================================================
// [게임 진행: adminStartVoting - 15초 카운트다운 시작]
// =========================================================================
exports.adminStartVoting = (0, https_1.onCall)({ cors: true }, async (request) => {
    const isAdmin = await verifyAdminAuth(request.auth, request.data?.secretKey);
    if (!isAdmin) {
        throw new https_1.HttpsError('permission-denied', '관리자 권한이 필요합니다.');
    }
    const now = Date.now();
    const votingDeadline = now + 15000; // 정확히 15초
    const gameDoc = await db.collection('game').doc('current').get();
    const roundNumber = gameDoc.data()?.roundNumber || 1;
    const roundId = `round_${roundNumber}`;
    await db.collection('game').doc('current').update({
        phase: 'voting',
        votingDeadline,
        votingStartedAt: now,
    });
    await db.collection('rounds').doc(roundId).update({
        phase: 'voting',
        deadline: votingDeadline,
    });
    return { success: true, deadline: votingDeadline };
});
// =========================================================================
// [핵심 로직: adminEvaluateResult (생존 판정 & 멱등성 보장)]
// - 멱등성(Idempotency): 이미 산출된 라운드는 재연산 없이 즉시 반환
// - 투표한 사람만 집계 (미투표자는 다수/소수/동률 판정에서 완전 제외)
// - A 다수 -> A 생존, B 탈락
// - B 다수 -> B 생존, A 탈락
// - 동률 -> 실제 투표자 전원 생존!
// - 미투표자 -> 항상 무조건 탈락
// - 생존자 2명 -> 즉시 게임 종료 (THE LAST TWO)
// - 생존자 1명 -> 1명 우승 예외 처리 (단독 우승)
// =========================================================================
exports.adminEvaluateResult = (0, https_1.onCall)({ cors: true }, async (request) => {
    const isAdmin = await verifyAdminAuth(request.auth, request.data?.secretKey);
    if (!isAdmin) {
        throw new https_1.HttpsError('permission-denied', '관리자 권한이 필요합니다.');
    }
    const gameRef = db.collection('game').doc('current');
    const gameDoc = await gameRef.get();
    const gameState = gameDoc.data();
    if (!gameState) {
        throw new https_1.HttpsError('failed-precondition', '게임 상태가 없습니다.');
    }
    const roundNumber = gameState.roundNumber;
    const roundId = `round_${roundNumber}`;
    const roundRef = db.collection('rounds').doc(roundId);
    // 1. [멱등성 체크] 이미 결과가 산출(revealed)된 경우 이전 결과를 그대로 반환
    const roundDoc = await roundRef.get();
    if (roundDoc.exists && roundDoc.data()?.phase === 'revealed') {
        const existingResult = roundDoc.data()?.result;
        return {
            success: true,
            result: existingResult,
            survivorCount: existingResult?.survivors?.length || 0,
            isGameOver: gameState.phase === 'gameover',
            alreadyEvaluated: true,
        };
    }
    // 2. 현재 생존자 목록 조회
    const alivePlayersSnapshot = await db.collection('players').where('status', '==', 'alive').get();
    const alivePlayers = alivePlayersSnapshot.docs.map((doc) => doc.data());
    const aliveIds = alivePlayers.map((p) => p.id);
    // 3. 투표 전체 집계
    const votesSnapshot = await roundRef.collection('votes').get();
    const votesMap = {};
    let votesA = 0;
    let votesB = 0;
    votesSnapshot.forEach((doc) => {
        const data = doc.data();
        votesMap[data.playerId] = data.choice;
        if (data.choice === 'A')
            votesA++;
        else if (data.choice === 'B')
            votesB++;
    });
    // 4. 미투표자 식별 (생존자 중 이번 라운드 미투표)
    const voterIds = Object.keys(votesMap);
    const nonVoterIds = aliveIds.filter((id) => !voterIds.includes(id));
    // 5. 다수/소수/동률 서바이벌 판정
    let majority;
    let eliminatedIds = [];
    if (votesA === votesB) {
        // [규칙] 동률이면 실제 투표자 전원 생존! 미투표자만 탈락
        majority = 'tie';
        eliminatedIds = [...nonVoterIds];
    }
    else if (votesA > votesB) {
        // [규칙] A 다수 -> B 소수 탈락 + 미투표자 탈락
        majority = 'A';
        const minorityIds = Object.entries(votesMap)
            .filter(([, choice]) => choice === 'B')
            .map(([id]) => id);
        eliminatedIds = [...minorityIds, ...nonVoterIds];
    }
    else {
        // [규칙] B 다수 -> A 소수 탈락 + 미투표자 탈락
        majority = 'B';
        const minorityIds = Object.entries(votesMap)
            .filter(([, choice]) => choice === 'A')
            .map(([id]) => id);
        eliminatedIds = [...minorityIds, ...nonVoterIds];
    }
    const survivorIds = aliveIds.filter((id) => !eliminatedIds.includes(id));
    // 6. 플레이어 상태 업데이트 (원자적 배치 작업)
    const batch = db.batch();
    for (const elimId of eliminatedIds) {
        const pRef = db.collection('players').doc(elimId);
        batch.update(pRef, {
            status: 'eliminated',
            eliminatedRound: roundNumber,
        });
    }
    // 7. [게임 종료 조건 판정]
    // - 2명 생존: THE LAST TWO 종료
    // - 1명 생존: 단독 우승 예외 처리 종료
    // - 0명 생존 (전원 미투표 등): 직전 생존자 부활 또는 무승부 처리
    let nextPhase = 'result';
    let isGameOver = false;
    let soleWinnerId = null;
    if (survivorIds.length === 2) {
        nextPhase = 'gameover';
        isGameOver = true;
    }
    else if (survivorIds.length === 1) {
        nextPhase = 'gameover';
        isGameOver = true;
        soleWinnerId = survivorIds[0];
    }
    else if (survivorIds.length === 0 && aliveIds.length > 0) {
        // 전원 미투표 등으로 0명이 된 경우, 직전 투표 참여자를 부활시켜 재경기 유도
        nextPhase = 'result';
    }
    const roundResult = {
        questionId: gameState.currentQuestion.id,
        question: gameState.currentQuestion,
        votesA,
        votesB,
        totalVoters: voterIds.length,
        nonVoters: nonVoterIds.length,
        majority,
        eliminated: eliminatedIds,
        survivors: survivorIds,
        winnerCount: isGameOver ? survivorIds.length : 0,
        soleWinnerId,
        evaluatedAt: Date.now(),
    };
    // 라운드 문서 완료 처리 (멱등성 보장 플래그)
    batch.update(roundRef, {
        phase: 'revealed',
        result: roundResult,
    });
    // 게임 메인 문서 업데이트
    batch.update(gameRef, {
        phase: nextPhase,
        currentResult: roundResult,
        isGameOver,
        soleWinnerId,
    });
    await batch.commit();
    return {
        success: true,
        result: roundResult,
        survivorCount: survivorIds.length,
        isGameOver,
        soleWinnerId,
    };
});
// =========================================================================
// [게임 진행: adminNextRound]
// - 30개 문제 소진 후 3명 이상 잔여 시 결승 모드(Finals) 자동 전환
// - 결승 전용 추가 문제 우선 투입
// - 정확히 2명이 남을 때까지 무한 진행
// =========================================================================
exports.adminNextRound = (0, https_1.onCall)({ cors: true }, async (request) => {
    const isAdmin = await verifyAdminAuth(request.auth, request.data?.secretKey);
    if (!isAdmin) {
        throw new https_1.HttpsError('permission-denied', '관리자 권한이 필요합니다.');
    }
    const gameRef = db.collection('game').doc('current');
    const gameDoc = await gameRef.get();
    const gameState = gameDoc.data();
    if (!gameState) {
        throw new https_1.HttpsError('failed-precondition', '게임 정보가 없습니다.');
    }
    // 현재 생존자 수 확인
    const aliveSnap = await db.collection('players').where('status', '==', 'alive').get();
    if (aliveSnap.size <= 2) {
        await gameRef.update({ phase: 'gameover' });
        return { success: true, phase: 'gameover' };
    }
    let usedIds = gameState.usedQuestionIds || [];
    let isFinals = gameState.isFinals || false;
    const roundNumber = (gameState.roundNumber || 1) + 1;
    // 문제 로드
    let questionsSnap = await db.collection('questions').get();
    let allQuestions = [];
    if (!questionsSnap.empty) {
        questionsSnap.forEach((d) => allQuestions.push(d.data()));
    }
    else {
        allQuestions = [
            ...questionsData_1.DEFAULT_QUESTIONS.map((q, i) => ({ ...q, id: `default_${i + 1}` })),
            ...questionsData_1.FINALS_QUESTIONS.map((q, i) => ({ ...q, id: `finals_${i + 1}` })),
        ];
    }
    // 30개 문제 종료 후 3명 이상이면 결승 모드 전환
    if (roundNumber > 30 || isFinals) {
        isFinals = true;
    }
    // 문제 풀 필터링
    let candidateQuestions;
    if (isFinals) {
        // 결승 모드에서는 결승 전용 문제를 우선 고려하고, 다 쓰면 전체 풀에서 리셋 선택
        const unusedFinals = allQuestions.filter((q) => q.isFinals && !usedIds.includes(q.id));
        if (unusedFinals.length > 0) {
            candidateQuestions = unusedFinals;
        }
        else {
            // 결승 문제도 소진되면 전체 문제 풀 리셋 순환
            candidateQuestions = allQuestions.filter((q) => !usedIds.includes(q.id));
            if (candidateQuestions.length === 0) {
                usedIds = []; // 리셋
                candidateQuestions = allQuestions;
            }
        }
    }
    else {
        // 일반 라운드
        candidateQuestions = allQuestions.filter((q) => !q.isFinals && !usedIds.includes(q.id));
        if (candidateQuestions.length === 0) {
            // 30개 일반 문제가 모두 끝난 경우 결승 모드로 전환
            isFinals = true;
            candidateQuestions = allQuestions.filter((q) => q.isFinals);
        }
    }
    const nextQuestion = candidateQuestions[Math.floor(Math.random() * candidateQuestions.length)];
    const nextRoundId = `round_${roundNumber}`;
    await db.collection('rounds').doc(nextRoundId).set({
        roundNumber,
        question: nextQuestion,
        phase: 'question',
        createdAt: Date.now(),
    });
    await gameRef.update({
        phase: 'question',
        roundNumber,
        currentQuestion: nextQuestion,
        usedQuestionIds: [...usedIds, nextQuestion.id],
        isFinals,
        currentResult: null,
    });
    return {
        success: true,
        roundNumber,
        question: nextQuestion,
        isFinals,
    };
});
// =========================================================================
// [게임 진행: adminResetGame]
// - 게임 상태 초기화 및 참가자/투표 전체 클린업
// =========================================================================
exports.adminResetGame = (0, https_1.onCall)({ cors: true }, async (request) => {
    const isAdmin = await verifyAdminAuth(request.auth, request.data?.secretKey);
    if (!isAdmin) {
        throw new https_1.HttpsError('permission-denied', '관리자 권한이 필요합니다.');
    }
    await db.collection('game').doc('current').set({
        phase: 'lobby',
        roundNumber: 0,
        currentQuestion: null,
        usedQuestionIds: [],
        isFinals: false,
        currentResult: null,
        updatedAt: Date.now(),
    });
    const playersSnap = await db.collection('players').get();
    const pBatch = db.batch();
    playersSnap.forEach((doc) => pBatch.delete(doc.ref));
    await pBatch.commit();
    const nicksSnap = await db.collection('nicknames').get();
    const nBatch = db.batch();
    nicksSnap.forEach((doc) => nBatch.delete(doc.ref));
    await nBatch.commit();
    return { success: true };
});
//# sourceMappingURL=index.js.map