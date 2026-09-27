const crypto = require('node:crypto');
const Game = require('../models/Game');
const { initializeGameBoard, COMPOUND_WORDS } = require('./gameSetup');
const { countRemaining, checkWinCondition, sanitizeBoardForRole } = require('./gameLogic');
const { normalizeArabic } = require('../utils/wordNormalizer');
const {
    activeRooms, TEAM_AR, WAITING_REMOVE_DELAY, GAME_REMOVE_DELAY,
    getRoom, getPlayer, touch, publicPlayers, roomSettings, roomSeries, roomPayload,
    gameUpdatePayload, persistRoom, clearTurnTimer, switchTurn, scheduleRemoval, resetToLobby,
    removePlayerFromRoom, startTurnTimer, emitReturnedToLobby, abortGame
} = require('./roomLifecycle');

const connectionsPerIp = new Map();

// ====================================
// الثوابت
// ====================================
const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;
// الأكواد المولّدة تلقائياً تتجنب 0/O و 1/I لتفادي الالتباس عند القراءة بصوت عالٍ
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 8;
const MAX_ROOMS = 500;
// حد سخي عمداً: شبكات الجوال السعودية (CGNAT) تجمع آلاف المشتركين خلف IP واحد،
// فحد صارم يرفض عدة مجموعات تلعب من نفس الشبكة بلا ذنب منها. حدود الغرف (500)
// وأحداث الاتصال الواحد (30/5 ثوانٍ) كافية لمنع إغراق الخادم من سكربت واحد
const MAX_CONNECTIONS_PER_IP = 150;
const MAX_CLUE_LENGTH = 30;
const MAX_HISTORY = 50;
const DEFAULT_TURN_DURATION = 90;          // ثانية — 0 تعني بلا مؤقّت
const MAX_TURN_DURATION = 300;

// خلف وكيل عكسي (Render) يُلحق الوكيل عنوان العميل الحقيقي في آخر X-Forwarded-For؛
// بدون وكيل الترويسة كلها من العميل ولا يُوثق بها
const TRUST_PROXY = process.env.TRUST_PROXY
    ? process.env.TRUST_PROXY === 'true'
    : process.env.NODE_ENV === 'production';

const UNLIMITED = 'unlimited';

// ====================================
// دوال مساعدة
// ====================================
const isSpymaster = (player) => player && player.role === 'SPYMASTER';
const isGuesser = (player) => player && player.role === 'GUESSER';
const isMyTurn = (room, player) => player && room && room.currentTurn === player.team;
const isHost = (room, player) => player && room && room.hostUserId === player.userId;

// المضيف غائب (منقطع أو غير موجود) → أي لاعب متصل يستطيع إدارة الجولة
// حتى لا تموت الغرفة إذا أغلق المضيف التبويب
const hostAbsent = (room) => {
    const host = room.players.find(p => p.userId === room.hostUserId);
    return !host || host.disconnected;
};
const canManage = (room, player) => isHost(room, player) || (player && !player.disconnected && hostAbsent(room));

const clientIp = (socket) => {
    const fwd = socket.handshake.headers['x-forwarded-for'];
    if (TRUST_PROXY && typeof fwd === 'string' && fwd.length) {
        const parts = fwd.split(',').map(s => s.trim()).filter(Boolean);
        if (parts.length) return parts[parts.length - 1];
    }
    return socket.handshake.address || 'unknown';
};

// تعقيم اسم اللاعب: نص فقط، بلا وسوم HTML، بطول محدود
const sanitizeName = (name, fallback = 'لاعب') => {
    if (typeof name !== 'string') return fallback;
    const clean = name.replace(/[<>&"'`]/g, '').trim().slice(0, 20);
    return clean || fallback;
};

const sanitizeUserId = (raw) => (typeof raw === 'string' && raw) ? raw.slice(0, 64) : crypto.randomUUID();

const generateRoomCode = () => {
    for (let attempt = 0; attempt < 20; attempt++) {
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)];
        }
        if (!activeRooms[code]) return code;
    }
    return null;
};

// حد بسيط لمعدل الأحداث لكل اتصال (30 حدثاً / 5 ثوانٍ)
const allowEvent = (socket) => {
    const now = Date.now();
    socket.eventTimes = (socket.eventTimes || []).filter(t => now - t < 5000);
    if (socket.eventTimes.length >= 30) return false;
    socket.eventTimes.push(now);
    return true;
};

// حمولة بيانات حدث سليمة دائماً (كائن عادي) — بعض العملاء قد يرسلون null صراحة،
// والقيمة الافتراضية `data = {}` في توقيع الدالة لا تحمي إلا من undefined
const normalizeData = (data) => (data && typeof data === 'object') ? data : {};

// إرسال حالة اللعبة كاملة للاعب واحد بنسخة مناسبة لدوره
const emitGameStateTo = (io, room, player) => {
    io.to(player.id).emit('gameStarted', {
        board: sanitizeBoardForRole(room.board, player.role, room.gameState),
        gameState: room.gameState,
        firstTeam: room.firstTeam,
        players: publicPlayers(room),
        ...gameUpdatePayload(room)
    });
};

// إخراج الـ socket من غرفته الحالية إن وُجدت — يمنع "اللاعب الشبح" الذي يبقى مضيفاً
// في غرفة قديمة بعد أن أنشأ أو انضم إلى غرفة أخرى
const leaveCurrentRoom = (io, socket) => {
    if (!socket.roomCode) return;
    const room = getRoom(socket.roomCode);
    if (room) removePlayerFromRoom(io, room, socket.id);
    socket.leave(socket.roomCode);
    socket.roomCode = null;
};

const newPlayer = (socket, username, userId) => ({
    id: socket.id,
    socketId: socket.id,
    username,
    team: null,
    role: null,
    userId,
    disconnected: false,
    removalTimer: null
});

const finishGame = (room, winner) => {
    clearTurnTimer(room);
    room.gameState = 'FINISHED';
    room.winner = winner;
    room.clue = null;
    room.clueCount = 0;
    room.guessesLeft = 0;
    room.series[winner] += 1;
};

// مقعد القائد "محجوز" فقط إذا كان صاحبه متصلاً؛ القائد المنقطع يعود مخمّناً
const takeSpymasterSeat = (room, team, player) => {
    const currentSpy = room.players.find(p => p.team === team && p.role === 'SPYMASTER' && p.id !== player.id);
    if (currentSpy && !currentSpy.disconnected) return currentSpy;
    if (currentSpy) currentSpy.role = 'GUESSER';
    player.team = team;
    player.role = 'SPYMASTER';
    return null;
};

// ====================================
// معالج الاتصالات الرئيسي
// ====================================
const handleSocketConnections = (io) => {

    // حد اتصالات لكل عنوان IP — يمنع إغراق الخادم بآلاف الـ sockets من سكربت واحد
    io.use((socket, next) => {
        const ip = clientIp(socket);
        const current = connectionsPerIp.get(ip) || 0;
        if (current >= MAX_CONNECTIONS_PER_IP) {
            return next(new Error('too_many_connections'));
        }
        connectionsPerIp.set(ip, current + 1);
        socket.clientIp = ip;
        next();
    });

    io.on('connection', (socket) => {
        console.log('🟢 New connection:', socket.id);

        // غلاف موحّد لأحداث "داخل الغرفة": حد المعدل، الغرفة، الحالة، اللاعب، الصلاحية، الأخطاء
        // opts: { states, stateError, manage, hostError, errorEvent, errorMessage }
        const on = (event, opts, fn) => socket.on(event, (data) => {
            if (!allowEvent(socket)) return;
            data = normalizeData(data);
            try {
                const room = getRoom(socket.roomCode);
                if (!room) return;
                if (opts.states && !opts.states.includes(room.gameState)) {
                    if (opts.stateError) socket.emit('gameError', opts.stateError);
                    return;
                }
                const player = getPlayer(room, socket.id);
                if (!player) return;
                if (opts.host && !isHost(room, player)) { socket.emit('gameError', opts.hostError); return; }
                if (opts.manage && !canManage(room, player)) { socket.emit('gameError', opts.hostError); return; }
                touch(room);
                fn(room, player, data);
            } catch (error) {
                console.error(`❌ Error on ${event}:`, error);
                if (opts.errorEvent) socket.emit(opts.errorEvent, opts.errorMessage);
            }
        });

        // ====================================
        // CREATE ROOM
        // ====================================
        socket.on('createRoom', (data) => {
            if (!allowEvent(socket)) return;
            data = normalizeData(data);
            try {
                leaveCurrentRoom(io, socket);

                if (Object.keys(activeRooms).length >= MAX_ROOMS) {
                    socket.emit('roomError', 'الخادم مشغول حالياً (وصل الحد الأقصى للغرف). حاول بعد دقائق.');
                    return;
                }

                const custom = typeof data.customName === 'string' ? data.customName.trim().toUpperCase() : '';
                if (custom && !ROOM_CODE_RE.test(custom)) {
                    socket.emit('roomError', 'كود الغرفة يجب أن يكون 6 خانات من أحرف إنجليزية أو أرقام.');
                    return;
                }
                if (custom && activeRooms[custom]) {
                    socket.emit('roomError', 'هذا الكود مستخدم مسبقاً. جرب كود آخر.');
                    return;
                }

                const roomCode = custom || generateRoomCode();
                if (!roomCode) {
                    socket.emit('roomError', 'تعذر توليد كود غرفة. حاول مرة أخرى.');
                    return;
                }

                const username = sanitizeName(data.username);
                const userId = sanitizeUserId(data.userId);

                socket.join(roomCode);
                socket.roomCode = roomCode;

                const room = {
                    code: roomCode,
                    hostUserId: userId,
                    players: [newPlayer(socket, username, userId)],
                    gameState: 'WAITING',
                    board: [],
                    currentTurn: null,
                    firstTeam: null,
                    clue: null,
                    clueCount: 0,
                    guessesLeft: 0,
                    winner: null,
                    history: [],
                    series: { RED: 0, BLUE: 0 },
                    turnDuration: DEFAULT_TURN_DURATION,
                    turnTimer: null,
                    turnEndsAt: null,
                    currentGameId: null,
                    createdAt: Date.now(),
                    lastActivity: Date.now(),
                    // من طرده المضيف لا يعود بنفس الهوية أو نفس عنوان الشبكة (انظر kickPlayer)
                    bannedUserIds: new Set(),
                    bannedIps: new Set()
                };
                activeRooms[roomCode] = room;

                console.log(`✅ Room created: ${roomCode} by ${username}`);
                socket.emit('roomCreated', roomPayload(room));
                io.to(roomCode).emit('roomUpdate', publicPlayers(room));

            } catch (error) {
                console.error('❌ Error creating room:', error);
                socket.emit('roomError', 'فشل إنشاء الغرفة. حاول مرة أخرى.');
            }
        });

        // ====================================
        // JOIN ROOM (انضمام جديد أو إعادة اتصال)
        // ====================================
        socket.on('joinRoom', (data) => {
            if (!allowEvent(socket)) return;
            data = normalizeData(data);
            try {
                const room = getRoom(typeof data.roomCode === 'string' ? data.roomCode : null);

                if (!room) {
                    socket.emit('roomError', 'الغرفة غير موجودة أو انتهت.');
                    return;
                }
                if (socket.roomCode && socket.roomCode !== room.code) {
                    leaveCurrentRoom(io, socket);
                }
                touch(room);

                const userId = sanitizeUserId(data.userId);

                // مطرود سابقاً من هذه الغرفة (بنفس الهوية أو نفس عنوان الشبكة) — الطرد نهائي
                if (room.bannedUserIds.has(userId) || (socket.clientIp && room.bannedIps.has(socket.clientIp))) {
                    socket.emit('roomError', 'أُخرجت من هذه الغرفة ولا يمكنك الانضمام إليها مرة أخرى.');
                    return;
                }

                // إعادة اتصال: نفس الهوية موجودة في الغرفة → استعادة المقعد والحالة
                const existing = room.players.find(p => p.userId === userId);
                if (existing) {
                    // تبويب ثانٍ بنفس الهوية بينما الأول ما زال متصلاً: نُعلم الأول صراحةً
                    // بدل أن يموت بصمت (أحداثه تُهمل لأن مقعده صار لـ socket آخر)
                    if (existing.id !== socket.id) {
                        const oldSocket = io.sockets.sockets.get(existing.id);
                        if (oldSocket && oldSocket.connected) {
                            oldSocket.emit('seatTaken', 'تم فتح اللعبة من تبويب أو جهاز آخر بنفس الهوية.');
                            oldSocket.roomCode = null;
                            oldSocket.leave(room.code);
                        }
                    }

                    existing.id = socket.id;
                    existing.socketId = socket.id;
                    const wasDisconnected = existing.disconnected;
                    existing.disconnected = false;
                    if (existing.removalTimer) {
                        clearTimeout(existing.removalTimer);
                        existing.removalTimer = null;
                    }

                    socket.join(room.code);
                    socket.roomCode = room.code;

                    socket.emit('roomJoined', roomPayload(room));
                    // الحالة الكاملة تُرسل أثناء اللعبة وبعد نهايتها (شاشة النتيجة) على السواء
                    if (room.gameState !== 'WAITING') {
                        emitGameStateTo(io, room, existing);
                    }
                    io.to(room.code).emit('roomUpdate', publicPlayers(room));
                    if (wasDisconnected) {
                        socket.to(room.code).emit('playerReconnected', { username: existing.username });
                        console.log(`🔄 ${existing.username} reconnected to ${room.code}`);
                    }
                    return;
                }

                if (room.gameState !== 'WAITING') {
                    socket.emit('roomError', 'لا يمكن الانضمام، اللعبة قيد التقدم.');
                    return;
                }

                if (room.players.length >= MAX_PLAYERS) {
                    socket.emit('roomError', `الغرفة ممتلئة (${MAX_PLAYERS} لاعبين كحد أقصى).`);
                    return;
                }

                const username = sanitizeName(data.username);
                socket.join(room.code);
                socket.roomCode = room.code;
                room.players.push(newPlayer(socket, username, userId));

                console.log(`✅ ${username} joined room: ${room.code}`);
                socket.emit('roomJoined', roomPayload(room));
                io.to(room.code).emit('roomUpdate', publicPlayers(room));

            } catch (error) {
                console.error('❌ Error joining room:', error);
                socket.emit('roomError', 'فشل الانضمام للغرفة.');
            }
        });

        // ====================================
        // SET ROLE
        // ====================================
        on('setRole', { errorEvent: 'roleError', errorMessage: 'فشل تعيين الدور.' }, (room, player, data) => {
            const { team, role } = data;
            if (!['RED', 'BLUE'].includes(team) || !['SPYMASTER', 'GUESSER'].includes(role)) {
                socket.emit('roleError', 'اختيار غير صالح.');
                return;
            }

            if (room.gameState === 'IN_PROGRESS') {
                // متفرج بلا فريق: ينضم مخمّناً لأي فريق (لا يستلم ألواناً فلا تسريب)
                if (!player.team) {
                    if (role !== 'GUESSER') {
                        socket.emit('roleError', 'أثناء اللعبة يمكنك الانضمام مخمّناً فقط.');
                        return;
                    }
                    player.team = team;
                    player.role = 'GUESSER';
                    console.log(`👀 ${player.username} joined ${team} as guesser mid-game in ${room.code}`);
                    io.to(room.code).emit('roomUpdate', publicPlayers(room));
                    emitGameStateTo(io, room, player);
                    return;
                }

                // غير ذلك: التغيير الوحيد المسموح هو أخذ مقعد قائد فريقك إن كان شاغراً
                // أو صاحبه منقطعاً — حتى لا تتجمّد اللعبة على قائد غائب
                if (role !== 'SPYMASTER' || team !== player.team || player.role !== 'GUESSER') {
                    socket.emit('roleError', 'أثناء اللعبة يمكن فقط أخذ مقعد قائد فريقك إذا كان شاغراً.');
                    return;
                }
                const currentSpy = room.players.find(p => p.team === team && p.role === 'SPYMASTER');
                if (currentSpy && !currentSpy.disconnected) {
                    socket.emit('roleError', 'قائد فريقك موجود ومتصل.');
                    return;
                }
                if (currentSpy) currentSpy.role = 'GUESSER'; // القائد المنقطع يعود مخمّناً عند عودته
                player.role = 'SPYMASTER';

                console.log(`👑 ${player.username} took over as ${team} spymaster in ${room.code}`);
                io.to(room.code).emit('roomUpdate', publicPlayers(room));
                io.to(room.code).emit('spymasterChanged', { team, username: player.username });
                // القائد الجديد يستلم اللوحة بألوانها؛ والقديم (إن عاد) يستلم نسخة المخمّن
                emitGameStateTo(io, room, player);
                if (currentSpy) emitGameStateTo(io, room, currentSpy);
                return;
            }

            if (room.gameState === 'FINISHED') {
                socket.emit('roleError', 'انتظر عودة المضيف إلى غرفة الانتظار لتغيير الدور.');
                return;
            }

            if (role === 'SPYMASTER') {
                const holder = takeSpymasterSeat(room, team, player);
                if (holder) {
                    socket.emit('roleError', `فريق ${TEAM_AR[team]} لديه قائد بالفعل.`);
                    return;
                }
            } else {
                player.team = team;
                player.role = role;
            }
            console.log(`✅ ${player.username} set role: ${team} ${role}`);
            io.to(room.code).emit('roomUpdate', publicPlayers(room));
        });

        // ====================================
        // SET TIMER (المضيف فقط — في غرفة الانتظار)
        // ====================================
        on('setTimer', { states: ['WAITING'], host: true, hostError: 'المضيف فقط يمكنه تغيير إعدادات الغرفة.' }, (room, player, data) => {
            const seconds = data.turnDuration;
            if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_TURN_DURATION) {
                socket.emit('gameError', `مدة الدور يجب أن تكون بين 0 (بلا مؤقّت) و ${MAX_TURN_DURATION} ثانية.`);
                return;
            }
            room.turnDuration = seconds;
            console.log(`⏱️ Turn duration set to ${seconds}s in ${room.code}`);
            io.to(room.code).emit('roomSettings', roomSettings(room));
        });

        // ====================================
        // KICK PLAYER (المضيف فقط — في غرفة الانتظار)
        // ====================================
        on('kickPlayer', { states: ['WAITING'], host: true, hostError: 'المضيف فقط يمكنه إخراج لاعب.' }, (room, player, data) => {
            const target = typeof data.playerId === 'string' ? getPlayer(room, data.playerId) : null;
            if (!target || target.id === socket.id) {
                socket.emit('gameError', 'اللاعب غير موجود.');
                return;
            }
            // الطرد نهائي: لا يعود بنفس الهوية ولا من نفس عنوان الشبكة (وإلا فالطرد بلا أثر)
            room.bannedUserIds.add(target.userId);
            const targetSocket = io.sockets.sockets.get(target.id);
            if (targetSocket) {
                if (targetSocket.clientIp) room.bannedIps.add(targetSocket.clientIp);
                targetSocket.emit('kicked', 'أخرجك المضيف من الغرفة.');
                targetSocket.leave(room.code);
                targetSocket.roomCode = null;
            }
            console.log(`🚪 ${target.username} kicked from ${room.code} by ${player.username}`);
            removePlayerFromRoom(io, room, target.id);
        });

        // ====================================
        // START GAME (المضيف فقط — من غرفة الانتظار)
        // ====================================
        on('startGame', {
            states: ['WAITING'], stateError: 'الغرفة ليست في وضع الانتظار.',
            host: true, hostError: 'المضيف فقط يمكنه بدء اللعبة.',
            errorEvent: 'gameError', errorMessage: 'فشل بدء اللعبة.'
        }, (room) => {
            const has = (team, role) => room.players.some(p => p.team === team && p.role === role && !p.disconnected);
            if (!has('RED', 'SPYMASTER') || !has('BLUE', 'SPYMASTER')) {
                socket.emit('gameError', 'يجب أن يكون هناك قائد أحمر وقائد أزرق لبدء اللعبة.');
                return;
            }
            if (!has('RED', 'GUESSER') || !has('BLUE', 'GUESSER')) {
                socket.emit('gameError', 'يجب أن يكون لكل فريق مخمن واحد على الأقل.');
                return;
            }

            // الحالة في الذاكرة هي المصدر الأساسي
            const gameData = initializeGameBoard();
            room.gameState = 'IN_PROGRESS';
            room.board = gameData.board;
            room.currentTurn = gameData.currentTurn;
            room.firstTeam = gameData.firstTeam;
            room.clue = null;
            room.clueCount = 0;
            room.guessesLeft = 0;
            room.winner = null;
            room.history = [];
            room.currentGameId = null;
            // من انقطع في اللوبي ولم يُحذف بعد: يحتفظ بمقعده بمهلة اللعبة الأطول
            room.players.forEach(p => { if (p.disconnected) scheduleRemoval(io, room, p, GAME_REMOVE_DELAY); });
            startTurnTimer(io, room);

            console.log(`✅ Game started in room: ${room.code} (timer: ${room.turnDuration}s)`);

            // كل لاعب يستلم نسخة مناسبة لدوره (المخمن لا يرى الألوان)
            room.players.forEach(p => {
                if (!p.disconnected) emitGameStateTo(io, room, p);
            });

            // الحفظ في القاعدة غير حاجب — فشله لا يمنع اللعبة
            Game.create({
                roomCode: room.code,
                board: room.board,
                currentTurn: room.currentTurn,
                firstTeam: room.firstTeam,
                timer: room.turnDuration,
                players: room.players.map(p => ({
                    socketId: p.id,
                    userId: p.userId,
                    username: p.username,
                    team: p.team,
                    role: p.role
                })),
                gameState: 'IN_PROGRESS'
            }).then(game => {
                room.currentGameId = game._id;
            }).catch(err => {
                console.error(`⚠️ DB save failed for game in ${room.code}:`, err.message);
            });
        });

        // ====================================
        // GIVE CLUE
        // ====================================
        on('giveClue', { states: ['IN_PROGRESS'], errorEvent: 'clueError', errorMessage: 'فشل إعطاء التلميح.' }, (room, player, data) => {
            const clue = typeof data.clue === 'string' ? data.clue.trim() : '';
            // العدد: 0..9، أو "unlimited" (تخمينات بلا حد — القواعد الرسمية)
            const unlimited = data.count === UNLIMITED;
            const count = unlimited ? 0 : data.count;

            if (!isSpymaster(player) || !isMyTurn(room, player)) {
                socket.emit('clueError', 'ليس دورك أو ليس مسموحاً لك بإعطاء تلميح.');
                return;
            }

            if (room.clue) {
                socket.emit('clueError', 'تم إعطاء تلميح لهذا الدور بالفعل.');
                return;
            }

            if (!clue || clue.length > MAX_CLUE_LENGTH || !Number.isInteger(count) || count < 0 || count > 9) {
                socket.emit('clueError', `تلميح غير صالح. يرجى إدخال تلميح (${MAX_CLUE_LENGTH} حرفاً كحد أقصى) وعدد بين 0 و 9 أو "غير محدود".`);
                return;
            }

            const normalizedClue = normalizeArabic(clue);

            // التلميح كلمة واحدة — يُستثنى ما يُعدّ كلمة واحدة في القاموس ("أسد البحر")
            if (/\s/.test(clue) && !COMPOUND_WORDS.has(normalizedClue)) {
                socket.emit('clueError', 'التلميح يجب أن يكون كلمة واحدة.');
                return;
            }

            // منع استخدام كلمة من اللوحة كتلميح — بمقارنة عربية موحّدة
            // (تتجاهل التشكيل والهمزات) حتى لا يُلتف على المنع
            const isClueOnBoard = room.board.some(card =>
                !card.revealed && normalizeArabic(card.word) === normalizedClue
            );
            if (isClueOnBoard) {
                socket.emit('clueError', 'لا يمكن استخدام كلمة موجودة على لوح اللعب كتلميح.');
                return;
            }

            const unrevealed = room.board.filter(c => !c.revealed).length;
            room.clue = clue;
            room.clueCount = unlimited ? UNLIMITED : count;
            // 0 و"غير محدود" = تخمينات حتى الخطأ؛ غير ذلك العدد + محاولة إضافية
            room.guessesLeft = (unlimited || count === 0) ? unrevealed : count + 1;

            // إعادة ضبط المؤقّت: مرحلة التخمين تأخذ وقتها كاملاً بعد تفكير القائد
            startTurnTimer(io, room);

            persistRoom(room, { clue, guessesLeft: room.guessesLeft });
            console.log(`✅ Clue given: "${clue}" (${room.clueCount}) by ${player.team}`);

            io.to(room.code).emit('clueGiven', { clue, count: room.clueCount, team: player.team });
            io.to(room.code).emit('gameUpdate', gameUpdatePayload(room));
        });

        // ====================================
        // MAKE GUESS
        // ====================================
        on('makeGuess', { states: ['IN_PROGRESS'], errorEvent: 'guessError', errorMessage: 'فشل التخمين.' }, (room, player, data) => {
            const { cardIndex } = data;

            if (!isGuesser(player) || !isMyTurn(room, player)) {
                socket.emit('guessError', 'ليس دورك أو ليس مسموحاً لك بالتخمين.');
                return;
            }

            if (room.guessesLeft === 0) {
                socket.emit('guessError', 'لا توجد محاولات متبقية.');
                return;
            }

            if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= room.board.length) {
                socket.emit('guessError', 'اختيار غير صالح.');
                return;
            }

            const card = room.board[cardIndex];
            if (!card || card.revealed) {
                socket.emit('guessError', 'اختيار غير صالح.');
                return;
            }

            card.revealed = true;
            card.pickedBy = player.team;
            room.guessesLeft -= 1;

            const result = card.type;
            const turnOver = result !== player.team || room.guessesLeft === 0;
            const winnerTeam = checkWinCondition(room.board);

            const historyEntry = {
                team: player.team,
                username: player.username,
                word: card.word,
                result: result === player.team ? 'Correct'
                    : result === 'ASSASSIN' ? 'Assassin'
                    : result === 'INNOCENT' ? 'Innocent' : 'Opponent',
                timestamp: Date.now()
            };
            room.history.push(historyEntry);
            if (room.history.length > MAX_HISTORY) room.history.shift();

            if (winnerTeam) {
                finishGame(room, winnerTeam);
            } else if (turnOver) {
                switchTurn(room);
                startTurnTimer(io, room);
            }

            persistRoom(room, {
                board: room.board,
                guessesLeft: room.guessesLeft,
                currentTurn: room.currentTurn,
                clue: room.clue,
                gameState: room.gameState,
                winner: room.winner,
                $push: { history: historyEntry }
            });

            console.log(`✅ Card revealed: ${card.word} (${result}) by ${player.team}`);

            io.to(room.code).emit('cardRevealed', {
                cardIndex,
                card,
                result,
                username: player.username,
                ...countRemaining(room.board)
            });

            io.to(room.code).emit('gameUpdate', gameUpdatePayload(room, {
                // عند نهاية اللعبة فقط تُكشف اللوحة كاملة للجميع
                board: winnerTeam ? room.board : undefined
            }));
        });

        // ====================================
        // END TURN
        // ====================================
        on('endTurn', { states: ['IN_PROGRESS'] }, (room, player) => {
            if (!isGuesser(player) || !isMyTurn(room, player)) return;
            if (!room.clue) return; // لا معنى لإنهاء دور لم يبدأ بتلميح

            switchTurn(room);
            startTurnTimer(io, room);
            persistRoom(room, { currentTurn: room.currentTurn, clue: null, guessesLeft: 0 });

            console.log(`✅ Turn ended by ${player.team}, now ${room.currentTurn}'s turn`);
            io.to(room.code).emit('gameUpdate', gameUpdatePayload(room));
        });

        // ====================================
        // ABORT GAME (المضيف — أو أي متصل إن كان المضيف غائباً — أثناء اللعبة أو بعدها)
        // ====================================
        on('abortGame', { states: ['IN_PROGRESS', 'FINISHED'], manage: true, hostError: 'المضيف فقط يمكنه إنهاء الجولة.' }, (room) => {
            abortGame(io, room, 'أنهى المضيف الجولة وأعاد الجميع إلى غرفة الانتظار.');
        });

        // ====================================
        // PLAY AGAIN (المضيف — أو أي متصل إن كان المضيف غائباً — بعد نهاية اللعبة)
        // ====================================
        on('playAgain', { states: ['FINISHED'], manage: true, hostError: 'المضيف فقط يمكنه بدء جولة جديدة.' }, (room) => {
            resetToLobby(io, room);
            console.log(`🔁 Room ${room.code} returned to lobby`);
            emitReturnedToLobby(io, room);
        });

        // ====================================
        // LEAVE ROOM (مغادرة صريحة)
        // ====================================
        socket.on('leaveRoom', () => {
            try {
                leaveCurrentRoom(io, socket);
            } catch (error) {
                console.error('❌ Error on leaveRoom:', error);
            }
        });

        // ====================================
        // DISCONNECT
        // ====================================
        socket.on('disconnect', () => {
            try {
                const ip = socket.clientIp;
                if (ip) {
                    const current = connectionsPerIp.get(ip) || 0;
                    if (current <= 1) connectionsPerIp.delete(ip);
                    else connectionsPerIp.set(ip, current - 1);
                }

                const room = getRoom(socket.roomCode);
                if (!room) return;

                const player = getPlayer(room, socket.id);
                if (!player) return;

                console.log(`❌ ${player.username} disconnected from ${room.code}`);
                player.disconnected = true;
                io.to(room.code).emit('roomUpdate', publicPlayers(room));
                io.to(room.code).emit('playerDisconnected', { username: player.username });

                // المقعد محجوز للعودة بنفس userId، لكن بمهلة دائماً: قصيرة في اللوبي، وأطول
                // أثناء اللعبة (زملاؤه يستطيعون أخذ مقعد القائد في الأثناء). بلا مهلة كان
                // اللاعب يبقى شبحاً يحجز مقعده ويقفل الجولة التالية.
                const delay = room.gameState === 'WAITING' ? WAITING_REMOVE_DELAY : GAME_REMOVE_DELAY;
                scheduleRemoval(io, room, player, delay);

            } catch (error) {
                console.error('❌ Error on disconnect:', error);
            }
        });
    });
};

module.exports = handleSocketConnections;
module.exports.constants = {
    MAX_PLAYERS, MAX_ROOMS, MAX_CONNECTIONS_PER_IP, MAX_TURN_DURATION, DEFAULT_TURN_DURATION,
    WAITING_REMOVE_DELAY, GAME_REMOVE_DELAY
};
