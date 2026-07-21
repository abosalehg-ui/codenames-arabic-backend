/**
 * اختبار تكاملي كامل: يشغّل الخادم ويحاكي 4 لاعبين عبر socket.io-client
 * يغطي: إنشاء/انضمام، الأدوار، بدء المضيف فقط، تعقيم اللوحة حسب الدور،
 * تخمين الفريقين (خصوصاً الفريق الثاني)، إنهاء الدور، إعادة الاتصال أثناء
 * اللعبة، القاتل وإنهاء اللعبة، والعودة للوبي (playAgain).
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

const connect = () => {
    const s = io(URL, { transports: ['websocket'], reconnection: false });
    return once(s, 'connect').then(() => s);
};

const assertSanitized = (board, who) => {
    const leaked = board.filter(c => !c.revealed && c.type);
    if (leaked.length > 0) fail(`${who} استلم ألوان ${leaked.length} بطاقة غير مكشوفة!`);
    ok(`${who}: اللوحة معقّمة (لا ألوان مسرّبة)`);
};

const main = async () => {
    // 1) تشغيل الخادم بدون قاعدة بيانات
    const server = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(PORT), MONGO_URI: '', FRONTEND_URL: '' },
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
        // 2) أربعة لاعبين
        const ids = { c1: 'uid-host-1', c2: 'uid-red-g', c3: 'uid-blue-s', c4: 'uid-blue-g' };
        const c1 = await connect(); // المضيف — قائد أحمر
        const c2 = await connect(); // مخمن أحمر
        const c3 = await connect(); // قائد أزرق
        const c4 = await connect(); // مخمن أزرق

        c1.emit('createRoom', { customName: ROOM, username: 'المضيف', userId: ids.c1 });
        const created = await once(c1, 'roomCreated');
        if (created.code !== ROOM) fail('كود الغرفة غير مطابق');
        if (created.players.some(p => p.userId)) fail('userId يُبث للجميع (تسريب هوية)');
        ok('إنشاء الغرفة + عدم بث userId');

        for (const [c, name, uid] of [[c2, 'أحمد', ids.c2], [c3, 'سارة', ids.c3], [c4, 'خالد', ids.c4]]) {
            c.emit('joinRoom', { roomCode: ROOM, username: name, userId: uid });
            await once(c, 'roomJoined');
        }
        ok('انضمام 3 لاعبين');

        // XSS: اسم بوسوم يجب أن يُقص
        const c5 = await connect();
        c5.emit('joinRoom', { roomCode: ROOM, username: '<img src=x onerror=alert(1)>', userId: 'uid-x' });
        const j5 = await once(c5, 'roomJoined');
        const evil = j5.players.find(p => p.username.includes('<') || p.username.includes('>'));
        if (evil) fail('اسم لاعب يحتوي وسوم HTML وصل كما هو');
        ok('تعقيم أسماء اللاعبين');
        c5.emit('leaveRoom');
        c5.disconnect();

        // 3) الأدوار
        c1.emit('setRole', { team: 'RED', role: 'SPYMASTER' });
        c2.emit('setRole', { team: 'RED', role: 'GUESSER' });
        c3.emit('setRole', { team: 'BLUE', role: 'SPYMASTER' });
        c4.emit('setRole', { team: 'BLUE', role: 'GUESSER' });
        await once(c1, 'roomUpdate');

        // 4) غير المضيف لا يستطيع البدء
        c2.emit('startGame');
        await once(c2, 'gameError');
        ok('غير المضيف مُنع من بدء اللعبة');

        // 5) بدء اللعبة والتحقق من التعقيم
        const started = [once(c1, 'gameStarted'), once(c2, 'gameStarted'), once(c3, 'gameStarted'), once(c4, 'gameStarted')];
        c1.emit('startGame');
        const [g1, g2, g3, g4] = await Promise.all(started);

        const truth = g1.board; // لوحة القائد الأحمر = الحقيقة الكاملة
        if (truth.filter(c => c.type).length !== 25) fail('القائد لا يرى كل الألوان');
        assertSanitized(g2.board, 'المخمن الأحمر');
        assertSanitized(g4.board, 'المخمن الأزرق');

        const teamA = g1.currentTurn;
        const teamB = teamA === 'RED' ? 'BLUE' : 'RED';
        const spyA = teamA === 'RED' ? c1 : c3;
        const spyB = teamA === 'RED' ? c3 : c1;
        const guessA = teamA === 'RED' ? c2 : c4;
        const guessB = teamA === 'RED' ? c4 : c2;
        const idx = (type, exclude = []) => truth.findIndex((c, i) => c.type === type && !c.revealed && !exclude.includes(i));
        ok(`الفريق البادئ: ${teamA}`);

        // 6) تلميح بكلمة من اللوحة (مع همزة مختلفة) يجب أن يُرفض
        const boardWord = truth[0].word;
        spyA.emit('giveClue', { clue: boardWord.replace(/ا/g, 'أ'), count: 1 });
        await once(spyA, 'clueError');
        ok('رفض تلميح مطابق لكلمة على اللوحة (بعد التطبيع العربي)');

        // التخمين: نكتفي بحدث cardRevealed المطابق للفهرس، وعند توقّع
        // انتقال دور أو فوز ننتظر gameUpdate المطابق للشرط تحديداً
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

        // 7) تلميح صحيح + تخمينات الفريق الأول
        await clue(spyA, guessA, 'اختبار', 2);

        let res = await guess(guessA, idx(teamA));
        if (res.rev.result !== teamA) fail('نتيجة كشف خاطئة');
        ok('الفريق الأول خمّن بطاقته بنجاح');

        res = await guess(guessA, idx(teamB), d => d.currentTurn === teamB);
        ok('تخمين بطاقة الخصم أنهى الدور');

        // 8) الفريق الثاني يخمّن (كان معطلاً كلياً قبل الإصلاح)
        await clue(spyB, guessB, 'تجربة', 1);
        res = await guess(guessB, idx(teamB));
        if (res.rev.result !== teamB) fail('تخمين الفريق الثاني فشل');
        ok('الفريق الثاني يستطيع التخمين');

        const endP = once(guessB, 'gameUpdate', d => d.currentTurn === teamA && !d.clue);
        guessB.emit('endTurn');
        await endP;
        ok('إنهاء الدور يدوياً');

        // 9) إعادة الاتصال أثناء اللعبة بنفس userId
        const guessAId = teamA === 'RED' ? ids.c2 : ids.c4;
        guessA.disconnect();
        await new Promise(r => setTimeout(r, 300));
        const guessA2 = await connect();
        guessA2.emit('joinRoom', { roomCode: ROOM, username: 'عائد', userId: guessAId });
        const rejoin = await once(guessA2, 'roomJoined');
        if (rejoin.gameState !== 'IN_PROGRESS') fail('حالة اللعبة غير صحيحة بعد إعادة الاتصال');
        const gRe = await once(guessA2, 'gameStarted');
        assertSanitized(gRe.board, 'المخمن العائد');
        ok('إعادة الاتصال أثناء اللعبة استعادت المقعد والحالة');

        // 10) ضرب القاتل → فوز الفريق الآخر ولوحة مكشوفة للجميع
        await clue(spyA, guessA2, 'نهاية', 1);
        res = await guess(guessA2, idx('ASSASSIN'), d => !!d.winner);
        if (res.upd.winner !== teamB) fail(`القاتل لم يُفز الفريق الآخر (winner=${res.upd.winner})`);
        if (!res.upd.board || res.upd.board.filter(c => c.type).length !== 25) fail('اللوحة لم تُكشف كاملة عند النهاية');
        ok('القاتل أنهى اللعبة لصالح الخصم وكُشفت اللوحة');

        // 11) العودة للوبي (المضيف فقط) — الانتظار على c3 لأنه لا يُفصل في أي سيناريو
        const lobbyP = once(c3, 'returnedToLobby');
        c1.emit('playAgain');
        await lobbyP;
        ok('playAgain أعاد الغرفة للوبي');

        [c1, c2, c3, c4, guessA2].forEach(c => c.disconnect());
        console.log('\n🎉 كل اختبارات التكامل نجحت');
    } finally {
        server.kill();
    }
};

main().catch(err => {
    console.error(err.message);
    process.exit(1);
});
