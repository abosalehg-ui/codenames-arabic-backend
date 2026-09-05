/**
 * اختبار تكاملي كامل: يشغّل الخادم ويحاكي لاعبين عبر socket.io-client
 * يغطي: إنشاء/انضمام، الأدوار، بدء المضيف فقط، تعقيم اللوحة حسب الدور،
 * تخمين الفريقين، إنهاء الدور، إعادة الاتصال أثناء اللعبة، القاتل وإنهاء اللعبة،
 * إعادة الاتصال بعد النهاية (FINISHED)، العودة للوبي (playAgain)،
 * منع المضيف الشبح، حد الغرف، التبويب الثاني (seatTaken)، مؤقّت الدور،
 * أخذ مقعد قائد منقطع، ومغادرة قائد بلا زملاء (gameAborted) وإنهاء المضيف (abortGame).
 *
 * التشغيل: npm run test:integration
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const { io } = require('socket.io-client');

const PORT = 34567;
const URL = `http://localhost:${PORT}`;
const ROOM = 'TESTAA';

const fail = (msg) => { console.error(`❌ FAIL: ${msg}`); process.exitCode = 1; throw new Error(msg); };
const ok = (msg) => console.log(`✅ ${msg}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// انتظار أول حدث "مطابق للشرط" — الأحداث تُبث للجميع وقد يصل تحديث قديم
// متأخراً، فالانتظار بلا شرط يلتقط الحدث الخطأ (سباق)
const once = (socket, event, pred = () => true, timeout = 8000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
        socket.off(event, handler);
        reject(new Error(`مهلة انتظار الحدث "${event}" انتهت`));
    }, timeout);
    const handler = (data) => {
        if (!pred(data)) return;
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(data);
    };
    socket.on(event, handler);
});

// التأكد من أن حدثاً معيناً لا يصل خلال مهلة
const never = async (socket, event, ms = 400) => {
    let got = false;
    const h = () => { got = true; };
    socket.on(event, h);
    await sleep(ms);
    socket.off(event, h);
    return !got;
};

const connect = () => {
    const s = io(URL, { transports: ['websocket'], reconnection: false });
    return once(s, 'connect').then(() => s);
};

const assertSanitized = (board, who) => {
    const leaked = board.filter(c => !c.revealed && c.type);
    if (leaked.length > 0) fail(`${who} استلم ألوان ${leaked.length} بطاقة غير مكشوفة!`);
    ok(`${who}: اللوحة معقّمة (لا ألوان مسرّبة)`);
};

const setupFullRoom = async (code, names) => {
    const [h, g1, s2, g2] = await Promise.all([connect(), connect(), connect(), connect()]);
    h.emit('createRoom', { customName: code, username: 'H', userId: names.h });
    await once(h, 'roomCreated');
    for (const [s, n, u] of [[g1, 'G1', names.g1], [s2, 'S2', names.s2], [g2, 'G2', names.g2]]) {
        s.emit('joinRoom', { roomCode: code, username: n, userId: u });
        await once(s, 'roomJoined');
    }
    h.emit('setRole', { team: 'RED', role: 'SPYMASTER' });
    g1.emit('setRole', { team: 'RED', role: 'GUESSER' });
    s2.emit('setRole', { team: 'BLUE', role: 'SPYMASTER' });
    g2.emit('setRole', { team: 'BLUE', role: 'GUESSER' });
    await once(h, 'roomUpdate', ps => ps.filter(p => p.role).length === 4);
    return { h, g1, s2, g2 };
};

const main = async () => {
    // 1) تشغيل الخادم بدون قاعدة بيانات
    const server = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(PORT), MONGO_URI: '', FRONTEND_URL: '', NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('الخادم لم يبدأ')), 8000);
        server.stdout.on('data', (d) => {
            if (String(d).includes('Server running')) { clearTimeout(t); resolve(); }
        });
    });
    ok('الخادم يعمل');

    try {
        // ================= اللعبة الأساسية =================
        const ids = { c1: 'uid-host-1', c2: 'uid-red-g', c3: 'uid-blue-s', c4: 'uid-blue-g' };
        const c1 = await connect(); // المضيف — قائد أحمر
        const c2 = await connect(); // مخمن أحمر
        const c3 = await connect(); // قائد أزرق
        const c4 = await connect(); // مخمن أزرق

        c1.emit('createRoom', { customName: ROOM, username: 'المضيف', userId: ids.c1 });
        const created = await once(c1, 'roomCreated');
        if (created.code !== ROOM) fail('كود الغرفة غير مطابق');
        if (created.players.some(p => p.userId)) fail('userId يُبث للجميع (تسريب هوية)');
        if (!created.settings || typeof created.settings.turnDuration !== 'number') fail('إعدادات الغرفة غائبة');
        ok('إنشاء الغرفة + عدم بث userId + إعدادات الغرفة');

        for (const [c, name, uid] of [[c2, 'أحمد', ids.c2], [c3, 'سارة', ids.c3], [c4, 'خالد', ids.c4]]) {
            c.emit('joinRoom', { roomCode: ROOM, username: name, userId: uid });
            await once(c, 'roomJoined');
        }
        ok('انضمام 3 لاعبين');

        // XSS: اسم بوسوم يجب أن يُقص
        const c5 = await connect();
        c5.emit('joinRoom', { roomCode: ROOM, username: '<img src=x onerror=alert(1)>', userId: 'uid-x' });
        const j5 = await once(c5, 'roomJoined');
        if (j5.players.some(p => p.username.includes('<') || p.username.includes('>'))) fail('اسم لاعب يحتوي وسوم HTML وصل كما هو');
        ok('تعقيم أسماء اللاعبين');
        c5.emit('leaveRoom');
        c5.disconnect();

        // المضيف الشبح: لاعب في غرفة ينشئ غرفة أخرى → يجب أن يُزال من الأولى
        const ghost = await connect();
        ghost.emit('joinRoom', { roomCode: ROOM, username: 'شبح', userId: 'uid-ghost' });
        await once(ghost, 'roomJoined');
        const leftP = once(c1, 'playerLeft', d => d.username === 'شبح');
        ghost.emit('createRoom', { username: 'شبح', userId: 'uid-ghost' });
        const ghostRoom = await once(ghost, 'roomCreated');
        await leftP;
        if (!/^[A-Z0-9]{6}$/.test(ghostRoom.code)) fail(`كود مولّد غير صالح: ${ghostRoom.code}`);
        ok('لا لاعب شبح: إنشاء غرفة ثانية أزال اللاعب من الأولى');
        ghost.disconnect();

        // غير المضيف لا يغيّر المؤقّت؛ المضيف يغيّره
        c2.emit('setTimer', { turnDuration: 60 });
        await once(c2, 'gameError');
        c1.emit('setTimer', { turnDuration: 0 });
        const settings = await once(c1, 'roomSettings');
        if (settings.turnDuration !== 0) fail('المؤقّت لم يتغيّر');
        ok('المضيف فقط يغيّر مدة الدور');

        // الأدوار
        c1.emit('setRole', { team: 'RED', role: 'SPYMASTER' });
        c2.emit('setRole', { team: 'RED', role: 'GUESSER' });
        c3.emit('setRole', { team: 'BLUE', role: 'SPYMASTER' });
        c4.emit('setRole', { team: 'BLUE', role: 'GUESSER' });
        await once(c1, 'roomUpdate', ps => ps.filter(p => p.role).length === 4);

        // غير المضيف لا يستطيع البدء
        c2.emit('startGame');
        await once(c2, 'gameError');
        ok('غير المضيف مُنع من بدء اللعبة');

        // بدء اللعبة والتحقق من التعقيم
        const started = [c1, c2, c3, c4].map(c => once(c, 'gameStarted'));
        c1.emit('startGame');
        const [g1, g2, , g4] = await Promise.all(started);

        const truth = g1.board; // لوحة القائد الأحمر = الحقيقة الكاملة
        if (truth.filter(c => c.type).length !== 25) fail('القائد لا يرى كل الألوان');
        if (g1.turnEndsAt !== null) fail('مؤقّت يعمل رغم تعطيله');
        assertSanitized(g2.board, 'المخمن الأحمر');
        assertSanitized(g4.board, 'المخمن الأزرق');

        const teamA = g1.currentTurn;
        const teamB = teamA === 'RED' ? 'BLUE' : 'RED';
        const spyA = teamA === 'RED' ? c1 : c3;
        const spyB = teamA === 'RED' ? c3 : c1;
        const guessA = teamA === 'RED' ? c2 : c4;
        const guessB = teamA === 'RED' ? c4 : c2;
        const idx = (type) => truth.findIndex(c => c.type === type && !c.revealed);
        ok(`الفريق البادئ: ${teamA}`);

        // تلميح بكلمة من اللوحة (مع همزة مختلفة) يجب أن يُرفض
        spyA.emit('giveClue', { clue: truth[0].word.replace(/ا/g, 'أ'), count: 1 });
        await once(spyA, 'clueError');
        ok('رفض تلميح مطابق لكلمة على اللوحة (بعد التطبيع العربي)');

        const guess = async (socket, cardIndex, updPred = null) => {
            const revP = once(socket, 'cardRevealed', d => d.cardIndex === cardIndex);
            const updP = updPred ? once(socket, 'gameUpdate', updPred) : null;
            socket.emit('makeGuess', { cardIndex });
            const rev = await revP;
            const upd = updP ? await updP : null;
            truth[cardIndex].revealed = true;
            return { rev, upd };
        };
        const clue = async (spy, listener, text, count) => {
            const clueP = once(listener, 'clueGiven', d => d.clue === text);
            spy.emit('giveClue', { clue: text, count });
            await clueP;
        };

        // تلميح صحيح + تخمينات الفريق الأول
        await clue(spyA, guessA, 'اختبار', 2);
        let res = await guess(guessA, idx(teamA), d => d.history && d.history.length === 1);
        if (res.rev.result !== teamA) fail('نتيجة كشف خاطئة');
        if (res.upd.history[0].result !== 'Correct' || res.upd.history[0].word !== res.rev.card.word) fail('سجل التخمينات غير صحيح');
        ok('الفريق الأول خمّن بطاقته + سجل التخمينات يُبث');

        res = await guess(guessA, idx(teamB), d => d.currentTurn === teamB);
        ok('تخمين بطاقة الخصم أنهى الدور');

        // الفريق الثاني يخمّن
        await clue(spyB, guessB, 'تجربة', 1);
        res = await guess(guessB, idx(teamB));
        if (res.rev.result !== teamB) fail('تخمين الفريق الثاني فشل');
        ok('الفريق الثاني يستطيع التخمين');

        const endP = once(guessB, 'gameUpdate', d => d.currentTurn === teamA && !d.clue);
        guessB.emit('endTurn');
        await endP;
        ok('إنهاء الدور يدوياً');

        // إعادة الاتصال أثناء اللعبة بنفس userId
        const guessAId = teamA === 'RED' ? ids.c2 : ids.c4;
        guessA.disconnect();
        await sleep(300);
        const guessA2 = await connect();
        guessA2.emit('joinRoom', { roomCode: ROOM, username: 'عائد', userId: guessAId });
        const rejoin = await once(guessA2, 'roomJoined');
        if (rejoin.gameState !== 'IN_PROGRESS') fail('حالة اللعبة غير صحيحة بعد إعادة الاتصال');
        const gRe = await once(guessA2, 'gameStarted');
        assertSanitized(gRe.board, 'المخمن العائد');
        ok('إعادة الاتصال أثناء اللعبة استعادت المقعد والحالة');

        // تبويب ثانٍ بنفس الهوية → التبويب الأول يستلم seatTaken
        const seatP = once(guessA2, 'seatTaken');
        const guessA3 = await connect();
        guessA3.emit('joinRoom', { roomCode: ROOM, username: 'عائد', userId: guessAId });
        await once(guessA3, 'gameStarted');
        await seatP;
        ok('التبويب القديم أُعلم بأن مقعده أُخذ (seatTaken)');
        guessA2.disconnect();

        // ضرب القاتل → فوز الفريق الآخر ولوحة مكشوفة للجميع
        await clue(spyA, guessA3, 'نهاية', 1);
        res = await guess(guessA3, idx('ASSASSIN'), d => !!d.winner);
        if (res.upd.winner !== teamB) fail(`القاتل لم يُفز الفريق الآخر (winner=${res.upd.winner})`);
        if (!res.upd.board || res.upd.board.filter(c => c.type).length !== 25) fail('اللوحة لم تُكشف كاملة عند النهاية');
        ok('القاتل أنهى اللعبة لصالح الخصم وكُشفت اللوحة');

        // إعادة اتصال بعد النهاية → يستلم الحالة FINISHED مع الفائز (لا يُرمى لغرفة الانتظار)
        c3.disconnect();
        await sleep(200);
        const c3b = await connect();
        c3b.emit('joinRoom', { roomCode: ROOM, username: 'سارة', userId: ids.c3 });
        const finJoin = await once(c3b, 'roomJoined');
        const finState = await once(c3b, 'gameStarted');
        if (finJoin.gameState !== 'FINISHED' || finState.gameState !== 'FINISHED' || finState.winner !== teamB) fail('إعادة الاتصال بعد النهاية لم تُرجع حالة FINISHED مع الفائز');
        ok('إعادة الاتصال بعد النهاية تُرجع شاشة النتيجة');

        // startGame من FINISHED مرفوض — يجب playAgain أولاً
        c1.emit('startGame');
        await once(c1, 'gameError');
        ok('startGame مرفوض في حالة FINISHED');

        // العودة للوبي (المضيف فقط)
        const lobbyP = once(c3b, 'returnedToLobby');
        c1.emit('playAgain');
        await lobbyP;
        ok('playAgain أعاد الغرفة للوبي');

        [c1, c2, c3b, c4, guessA3].forEach(c => c.disconnect());
        await sleep(200);

        // ================= المؤقّت + أخذ مقعد قائد منقطع =================
        const T = await setupFullRoom('TIMERR', { h: 't-h', g1: 't-g1', s2: 't-s2', g2: 't-g2' });
        T.h.emit('setTimer', { turnDuration: 1 });
        await once(T.h, 'roomSettings', s => s.turnDuration === 1);

        const tStarted = once(T.h, 'gameStarted');
        T.h.emit('startGame');
        const tGame = await tStarted;
        if (!tGame.turnEndsAt || tGame.turnEndsAt - tGame.serverNow > 1500) fail('turnEndsAt غير صحيح');
        const firstTurn = tGame.currentTurn;
        const toP = once(T.g1, 'turnTimeout', d => d.team === firstTurn);
        const swP = once(T.g1, 'gameUpdate', d => d.currentTurn !== firstTurn);
        await toP; await swP;
        ok('انتهاء المؤقّت نقل الدور للفريق الآخر');

        // مخمّن لا يستطيع أخذ مقعد قائد متصل
        T.g2.emit('setRole', { team: 'BLUE', role: 'SPYMASTER' });
        await once(T.g2, 'roleError');
        // القائد الأزرق ينقطع → المخمن الأزرق يأخذ المقعد ويستلم اللوحة بألوانها
        T.s2.disconnect();
        await once(T.g2, 'playerDisconnected', d => d.username === 'S2');
        const takeoverState = once(T.g2, 'gameStarted');
        T.g2.emit('setRole', { team: 'BLUE', role: 'SPYMASTER' });
        await once(T.h, 'spymasterChanged', d => d.team === 'BLUE' && d.username === 'G2');
        const spyBoard = (await takeoverState).board;
        if (spyBoard.filter(c => c.type).length !== 25) fail('القائد الجديد لا يرى الألوان');
        ok('مخمّن أخذ مقعد قائد منقطع واستلم اللوحة كاملة');

        // المضيف ينهي الجولة من منتصف اللعبة
        const abortP = once(T.g1, 'gameAborted');
        const lobby2 = once(T.g1, 'returnedToLobby');
        T.h.emit('abortGame');
        await abortP; await lobby2;
        ok('abortGame من المضيف أعاد الجميع للوبي');
        [T.h, T.g1, T.g2].forEach(c => c.disconnect());
        await sleep(200);

        // ================= مغادرة قائد بلا زملاء → gameAborted =================
        const A = await setupFullRoom('ABORTT', { h: 'a-h', g1: 'a-g1', s2: 'a-s2', g2: 'a-g2' });
        A.h.emit('setTimer', { turnDuration: 0 });
        await once(A.h, 'roomSettings');
        const aStart = once(A.h, 'gameStarted');
        A.h.emit('startGame'); await aStart;
        // المخمن الأزرق يغادر أولاً، ثم القائد الأزرق → الفريق فارغ → إنهاء
        A.g2.emit('leaveRoom'); await once(A.h, 'playerLeft', d => d.username === 'G2');
        const vacantNo = never(A.h, 'gameAborted', 100);
        await vacantNo;
        const abort2 = once(A.h, 'gameAborted');
        A.s2.emit('leaveRoom');
        await abort2;
        ok('مغادرة قائد بلا زملاء أنهت الجولة بدل تجميدها');
        [A.h, A.g1, A.s2, A.g2].forEach(c => c.disconnect());
        await sleep(200);

        // ================= مغادرة قائد مع زملاء → spymasterVacant (اللعبة تستمر) =================
        const V = await setupFullRoom('VACANT', { h: 'v-h', g1: 'v-g1', s2: 'v-s2', g2: 'v-g2' });
        const vStart = once(V.h, 'gameStarted');
        V.h.emit('startGame'); await vStart;
        const vacP = once(V.g2, 'spymasterVacant', d => d.team === 'BLUE');
        V.s2.emit('leaveRoom');
        await vacP;
        if (!(await never(V.g2, 'gameAborted', 200))) fail('اللعبة أُنهيت رغم وجود زملاء يمكنهم أخذ المقعد');
        const vTake = once(V.g2, 'gameStarted');
        V.g2.emit('setRole', { team: 'BLUE', role: 'SPYMASTER' });
        await vTake;
        ok('مغادرة قائد مع زملاء: المقعد شاغر واللعبة مستمرة وزميل أخذه');
        [V.h, V.g1, V.s2, V.g2].forEach(c => c.disconnect());

        console.log('\n🎉 كل اختبارات التكامل نجحت');
    } finally {
        server.kill();
    }
};

main().catch(err => {
    console.error(err.message);
    process.exit(1);
});
