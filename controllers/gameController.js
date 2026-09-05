const crypto = require('node:crypto');
const Game = require('../models/Game');
const { initializeGameBoard } = require('./gameSetup');
const { countRemaining, checkWinCondition, sanitizeBoardForRole } = require('./gameLogic');
const { normalizeArabic } = require('../utils/wordNormalizer');

const activeRooms = {};
const connectionsPerIp = new Map();

// ====================================
// الثوابت
// ====================================
const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;
// الأكواد المولّدة تلقائياً تتجنب 0/O و 1/I لتفادي الالتباس عند القراءة بصوت عالٍ
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 8;
const MAX_ROOMS = 500;
// مجموعة أصدقاء في بيت واحد يشتركون في IP واحد (NAT) — 8 لاعبين × تبويب احتياطي
const MAX_CONNECTIONS_PER_IP = 20;
const MAX_CLUE_LENGTH = 30;
const MAX_HISTORY = 50;
const DEFAULT_TURN_DURATION = 90;          // ثانية — 0 تعني بلا مؤقّت
const MAX_TURN_DURATION = 300;
const WAITING_REMOVE_DELAY = 30 * 1000;    // مهلة حذف اللاعب المنقطع في غرفة الانتظار
const WAITING_IDLE_TIMEOUT = 15 * 60 * 1000;   // غرفة انتظار خاملة تُحذف بعد 15 دقيقة
const ROOM_IDLE_TIMEOUT = 2 * 60 * 60 * 1000;  // غرفة فيها لعبة خاملة تُحذف بعد ساعتين

const TEAM_AR = { RED: 'الأحمر', BLUE: 'الأزرق' };

// ====================================
// دوال مساعدة
// ====================================
const getRoom = (roomCode) => roomCode ? activeRooms[roomCode.toUpperCase()] : null;
const getPlayer = (room, socketId) => room ? room.players.find(p => p.id === socketId) : null;
const isSpymaster = (player) => player && player.role === 'SPYMASTER';
const isGuesser = (player) => player && player.role === 'GUESSER';
const isMyTurn = (room, player) => player && room && room.currentTurn === player.team;
const isHost = (room, player) => player && room && room.hostUserId === player.userId;
const touch = (room) => { if (room) room.lastActivity = Date.now(); };
const otherTeam = (team) => team === 'RED' ? 'BLUE' : 'RED';

// عنوان العميل خلف وكيل عكسي (Render) يأتي في X-Forwarded-For
const clientIp = (socket) => {
    const fwd = socket.handshake.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
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

// البيانات العامة للاعبين — لا نبث userId أبداً (يُستخدم لإعادة الاتصال)
const publicPlayers = (room) => room.players.map(p => ({
    id: p.id,
    username: p.username,
    team: p.team,
    role: p.role,
    disconnected: p.disconnected,
    isHost: p.userId === room.hostUserId
}));

const roomSettings = (room) => ({ turnDuration: room.turnDuration });

// حد بسيط لمعدل الأحداث لكل اتصال (30 حدثاً / 5 ثوانٍ)
const allowEvent = (socket) => {
    const now = Date.now();
    socket.eventTimes = (socket.eventTimes || []).filter(t => now - t < 5000);
    if (socket.eventTimes.length >= 30) return false;
    socket.eventTimes.push(now);
    return true;
};

// حفظ غير حاجب في MongoDB — فشل القاعدة لا يوقف اللعبة أبداً
const persistRoom = (room, fields) => {
    if (!room.currentGameId) return;
    Game.findByIdAndUpdate(room.currentGameId, fields)
        .catch(err => console.error(`⚠️ DB persist failed for ${room.code}:`, err.message));
};

// ====================================
// حالة اللعبة: تبديل الدور، المؤقّت، النهاية، العودة للوبي
// ====================================
const clearTurnTimer = (room) => {
    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.turnTimer = null;
    room.turnEndsAt = null;
};

const switchTurn = (room) => {
    room.currentTurn = otherTeam(room.currentTurn);
    room.clue = null;
    room.clueCount = 0;
    room.guessesLeft = 0;
};

const finishGame = (room, winner) => {
    clearTurnTimer(room);
    room.gameState = 'FINISHED';
    room.winner = winner;
    room.clue = null;
    room.clueCount = 0;
    room.guessesLeft = 0;
};

const resetToLobby = (room) => {
    clearTurnTimer(room);
    room.gameState = 'WAITING';
    room.board = [];
    room.currentTurn = null;
    room.firstTeam = null;
    room.clue = null;
    room.clueCount = 0;
    room.guessesLeft = 0;
    room.winner = null;
    room.history = [];
    room.currentGameId = null;
};

const deleteRoom = (room, reason) => {
    clearTurnTimer(room);
    room.players.forEach(p => { if (p.removalTimer) clearTimeout(p.removalTimer); });
    delete activeRooms[room.code];
    console.log(`🗑️ Room ${room.code} deleted (${reason})`);
};

// الحمولة المشتركة لكل تحديث — serverNow يسمح للعميل بتصحيح فرق الساعة عند العدّ التنازلي
const gameUpdatePayload = (room, extra = {}) => ({
    currentTurn: room.currentTurn,
    clue: room.clue,
    clueCount: room.clueCount,
    guessesLeft: room.guessesLeft,
    winner: room.winner,
    turnEndsAt: room.turnEndsAt,
    turnDuration: room.turnDuration,
    serverNow: Date.now(),
    history: room.history,
    ...countRemaining(room.board),
    ...extra
});

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

// المؤقّت يغطي الدور كاملاً (تفكير القائد + التخمين)؛ انتهاؤه ينقل الدور للفريق الآخر
const startTurnTimer = (io, room) => {
    clearTurnTimer(room);
    if (!room.turnDuration || room.gameState !== 'IN_PROGRESS') return;

    room.turnEndsAt = Date.now() + room.turnDuration * 1000;
    room.turnTimer = setTimeout(() => {
        room.turnTimer = null;
        if (room.gameState !== 'IN_PROGRESS' || activeRooms[room.code] !== room) return;

        const timedOutTeam = room.currentTurn;
        switchTurn(room);
        startTurnTimer(io, room);
        touch(room);
        persistRoom(room, { currentTurn: room.currentTurn, clue: null, guessesLeft: 0 });

        console.log(`⏱️ Turn timed out for ${timedOutTeam} in ${room.code}`);
        io.to(room.code).emit('turnTimeout', { team: timedOutTeam });
        io.to(room.code).emit('gameUpdate', gameUpdatePayload(room));
    }, room.turnDuration * 1000);
};

// إنهاء الجولة قسراً والعودة للوبي (مغادرة قائد بلا بديل، أو قرار المضيف)
const abortGame = (io, room, reason) => {
    persistRoom(room, { gameState: 'FINISHED' });
    resetToLobby(room);
    console.log(`🛑 Game aborted in ${room.code}: ${reason}`);
    io.to(room.code).emit('gameAborted', { reason });
    io.to(room.code).emit('returnedToLobby', { players: publicPlayers(room), settings: roomSettings(room) });
    io.to(room.code).emit('roomUpdate', publicPlayers(room));
};

// إزالة لاعب نهائياً من الغرفة (مغادرة صريحة أو انتهاء مهلة الانقطاع)
const removePlayerFromRoom = (io, room, socketId) => {
    const player = getPlayer(room, socketId);
    if (!player) return;

    if (player.removalTimer) clearTimeout(player.removalTimer);
    room.players = room.players.filter(p => p.id !== socketId);

    if (room.players.length === 0) {
        deleteRoom(room, 'empty');
        return;
    }

    // نقل الاستضافة إذا غادر المضيف
    if (room.hostUserId === player.userId) {
        room.hostUserId = room.players[0].userId;
    }

    io.to(room.code).emit('roomUpdate', publicPlayers(room));
    io.to(room.code).emit('playerLeft', { username: player.username });
    console.log(`👋 ${player.username} left room ${room.code}`);

    // مغادرة قائد أثناء اللعبة: إن بقي له زملاء يستطيع أحدهم أخذ المقعد (setRole)،
    // وإلا فالفريق لم يعد قابلاً للعب وتعود الغرفة للوبي بدل التجمّد
    if (room.gameState === 'IN_PROGRESS' && player.role === 'SPYMASTER') {
        const teammates = room.players.filter(p => p.team === player.team);
        if (teammates.length === 0) {
            abortGame(io, room, `غادر قائد الفريق ${TEAM_AR[player.team]} ولم يبقَ في فريقه أحد.`);
        } else {
            io.to(room.code).emit('spymasterVacant', {
                team: player.team,
                message: `غادر قائد الفريق ${TEAM_AR[player.team]}. يستطيع أحد مخمّني الفريق أخذ دور القائد.`
            });
        }
    }
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

        // ====================================
        // CREATE ROOM
        // ====================================
        socket.on('createRoom', (data = {}) => {
            if (!allowEvent(socket)) return;
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
                    turnDuration: DEFAULT_TURN_DURATION,
                    turnTimer: null,
                    turnEndsAt: null,
                    currentGameId: null,
                    createdAt: Date.now(),
                    lastActivity: Date.now()
                };
                activeRooms[roomCode] = room;

                console.log(`✅ Room created: ${roomCode} by ${username}`);
                socket.emit('roomCreated', { code: roomCode, players: publicPlayers(room), settings: roomSettings(room) });
                io.to(roomCode).emit('roomUpdate', publicPlayers(room));

            } catch (error) {
                console.error('❌ Error creating room:', error);
                socket.emit('roomError', 'فشل إنشاء الغرفة. حاول مرة أخرى.');
            }
        });

        // ====================================
        // JOIN ROOM (انضمام جديد أو إعادة اتصال)
        // ====================================
        socket.on('joinRoom', (data = {}) => {
            if (!allowEvent(socket)) return;
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

                    socket.emit('roomJoined', {
                        code: room.code,
                        players: publicPlayers(room),
                        gameState: room.gameState,
                        settings: roomSettings(room)
                    });
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
                socket.emit('roomJoined', {
                    code: room.code,
                    players: publicPlayers(room),
                    gameState: room.gameState,
                    settings: roomSettings(room)
                });
                io.to(room.code).emit('roomUpdate', publicPlayers(room));

            } catch (error) {
                console.error('❌ Error joining room:', error);
                socket.emit('roomError', 'فشل الانضمام للغرفة.');
            }
        });

        // ====================================
        // SET ROLE
        // ====================================
        socket.on('setRole', (data = {}) => {
            if (!allowEvent(socket)) return;
            try {
                const room = getRoom(socket.roomCode);
                if (!room) return;
                touch(room);

                const { team, role } = data;
                if (!['RED', 'BLUE'].includes(team) || !['SPYMASTER', 'GUESSER'].includes(role)) {
                    socket.emit('roleError', 'اختيار غير صالح.');
                    return;
                }

                const player = getPlayer(room, socket.id);
                if (!player) return;

                // أثناء اللعبة: التغيير الوحيد المسموح هو أخذ مقعد قائد فريقك إن كان شاغراً
                // أو صاحبه منقطعاً — حتى لا تتجمّد اللعبة على قائد غائب
                if (room.gameState === 'IN_PROGRESS') {
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
                    const isRoleTaken = room.players.some(p =>
                        p.team === team && p.role === 'SPYMASTER' && p.id !== socket.id
                    );
                    if (isRoleTaken) {
                        socket.emit('roleError', `فريق ${TEAM_AR[team]} لديه قائد بالفعل.`);
                        return;
                    }
                }

                player.team = team;
                player.role = role;
                console.log(`✅ ${player.username} set role: ${team} ${role}`);
                io.to(room.code).emit('roomUpdate', publicPlayers(room));

            } catch (error) {
                console.error('❌ Error setting role:', error);
                socket.emit('roleError', 'فشل تعيين الدور.');
            }
        });

        // ====================================
        // SET TIMER (المضيف فقط — في غرفة الانتظار)
        // ====================================
        socket.on('setTimer', (data = {}) => {
            if (!allowEvent(socket)) return;
            try {
                const room = getRoom(socket.roomCode);
                if (!room || room.gameState !== 'WAITING') return;
                touch(room);

                const player = getPlayer(room, socket.id);
                if (!isHost(room, player)) {
                    socket.emit('gameError', 'المضيف فقط يمكنه تغيير إعدادات الغرفة.');
                    return;
                }

                const seconds = data.turnDuration;
                if (!Number.isInteger(seconds) || seconds < 0 || seconds > MAX_TURN_DURATION) {
                    socket.emit('gameError', `مدة الدور يجب أن تكون بين 0 (بلا مؤقّت) و ${MAX_TURN_DURATION} ثانية.`);
                    return;
                }

                room.turnDuration = seconds;
                console.log(`⏱️ Turn duration set to ${seconds}s in ${room.code}`);
                io.to(room.code).emit('roomSettings', roomSettings(room));

            } catch (error) {
                console.error('❌ Error setting timer:', error);
            }
        });

        // ====================================
        // START GAME (المضيف فقط — من غرفة الانتظار)
        // ====================================
        socket.on('startGame', () => {
            if (!allowEvent(socket)) return;
            try {
                const room = getRoom(socket.roomCode);
                if (!room) return;
                if (room.gameState !== 'WAITING') {
                    socket.emit('gameError', 'الغرفة ليست في وضع الانتظار.');
                    return;
                }
                touch(room);

                const player = getPlayer(room, socket.id);
                if (!isHost(room, player)) {
                    socket.emit('gameError', 'المضيف فقط يمكنه بدء اللعبة.');
                    return;
                }

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
                        userId: null,
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

            } catch (error) {
                console.error('❌ Error starting game:', error);
                socket.emit('gameError', 'فشل بدء اللعبة.');
            }
        });

        // ====================================
        // GIVE CLUE
        // ====================================
        socket.on('giveClue', (data = {}) => {
            if (!allowEvent(socket)) return;
            try {
                const room = getRoom(socket.roomCode);
                if (!room || room.gameState !== 'IN_PROGRESS') return;
                touch(room);

                const player = getPlayer(room, socket.id);
                const clue = typeof data.clue === 'string' ? data.clue.trim() : '';
                const count = data.count;

                if (!player || !isSpymaster(player) || !isMyTurn(room, player)) {
                    socket.emit('clueError', 'ليس دورك أو ليس مسموحاً لك بإعطاء تلميح.');
                    return;
                }

                if (room.clue) {
                    socket.emit('clueError', 'تم إعطاء تلميح لهذا الدور بالفعل.');
                    return;
                }

                if (!clue || clue.length > MAX_CLUE_LENGTH || !Number.isInteger(count) || count < 1 || count > 9) {
                    socket.emit('clueError', `تلميح غير صالح. يرجى إدخال تلميح (${MAX_CLUE_LENGTH} حرفاً كحد أقصى) وعدد بين 1 و 9.`);
                    return;
                }

                // منع استخدام كلمة من اللوحة كتلميح — بمقارنة عربية موحّدة
                // (تتجاهل التشكيل والهمزات) حتى لا يُلتف على المنع
                const normalizedClue = normalizeArabic(clue);
                const isClueOnBoard = room.board.some(card =>
                    !card.revealed && normalizeArabic(card.word) === normalizedClue
                );
                if (isClueOnBoard) {
                    socket.emit('clueError', 'لا يمكن استخدام كلمة موجودة على لوح اللعب كتلميح.');
                    return;
                }

                room.clue = clue;
                room.clueCount = count;
                room.guessesLeft = count + 1; // +1 للمحاولة الإضافية

                persistRoom(room, { clue, guessesLeft: room.guessesLeft });
                console.log(`✅ Clue given: "${clue}" (${count}) by ${player.team}`);

                io.to(room.code).emit('clueGiven', { clue, count, team: player.team });
                io.to(room.code).emit('gameUpdate', gameUpdatePayload(room));

            } catch (error) {
                console.error('❌ Error giving clue:', error);
                socket.emit('clueError', 'فشل إعطاء التلميح.');
            }
        });

        // ====================================
        // MAKE GUESS
        // ====================================
        socket.on('makeGuess', (data = {}) => {
            if (!allowEvent(socket)) return;
            try {
                const room = getRoom(socket.roomCode);
                if (!room || room.gameState !== 'IN_PROGRESS') return;
                touch(room);

                const player = getPlayer(room, socket.id);
                const { cardIndex } = data;

                if (!player || !isGuesser(player) || !isMyTurn(room, player)) {
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
                    ...countRemaining(room.board)
                });

                io.to(room.code).emit('gameUpdate', gameUpdatePayload(room, {
                    // عند نهاية اللعبة فقط تُكشف اللوحة كاملة للجميع
                    board: winnerTeam ? room.board : undefined
                }));

            } catch (error) {
                console.error('❌ Error making guess:', error);
                socket.emit('guessError', 'فشل التخمين.');
            }
        });

        // ====================================
        // END TURN
        // ====================================
        socket.on('endTurn', () => {
            if (!allowEvent(socket)) return;
            try {
                const room = getRoom(socket.roomCode);
                if (!room || room.gameState !== 'IN_PROGRESS') return;
                touch(room);

                const player = getPlayer(room, socket.id);
                if (!player || !isGuesser(player) || !isMyTurn(room, player)) return;
                if (!room.clue) return; // لا معنى لإنهاء دور لم يبدأ بتلميح

                switchTurn(room);
                startTurnTimer(io, room);
                persistRoom(room, { currentTurn: room.currentTurn, clue: null, guessesLeft: 0 });

                console.log(`✅ Turn ended by ${player.team}, now ${room.currentTurn}'s turn`);
                io.to(room.code).emit('gameUpdate', gameUpdatePayload(room));

            } catch (error) {
                console.error('❌ Error ending turn:', error);
            }
        });

        // ====================================
        // ABORT GAME (المضيف فقط — في أي وقت أثناء اللعبة أو بعدها)
        // ====================================
        socket.on('abortGame', () => {
            if (!allowEvent(socket)) return;
            try {
                const room = getRoom(socket.roomCode);
                if (!room || room.gameState === 'WAITING') return;
                touch(room);

                const player = getPlayer(room, socket.id);
                if (!isHost(room, player)) {
                    socket.emit('gameError', 'المضيف فقط يمكنه إنهاء الجولة.');
                    return;
                }

                abortGame(io, room, 'أنهى المضيف الجولة وأعاد الجميع إلى غرفة الانتظار.');

            } catch (error) {
                console.error('❌ Error aborting game:', error);
            }
        });

        // ====================================
        // PLAY AGAIN (المضيف فقط — بعد نهاية اللعبة)
        // ====================================
        socket.on('playAgain', () => {
            if (!allowEvent(socket)) return;
            try {
                const room = getRoom(socket.roomCode);
                if (!room || room.gameState !== 'FINISHED') return;
                touch(room);

                const player = getPlayer(room, socket.id);
                if (!isHost(room, player)) {
                    socket.emit('gameError', 'المضيف فقط يمكنه بدء جولة جديدة.');
                    return;
                }

                resetToLobby(room);
                console.log(`🔁 Room ${room.code} returned to lobby`);
                io.to(room.code).emit('returnedToLobby', { players: publicPlayers(room), settings: roomSettings(room) });
                io.to(room.code).emit('roomUpdate', publicPlayers(room));

            } catch (error) {
                console.error('❌ Error on playAgain:', error);
            }
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

                // أثناء اللعبة نُبقي مقعد اللاعب محجوزاً ليعود بنفس userId (وزملاؤه يستطيعون
                // أخذ مقعد القائد إن كان هو القائد). في غرفة الانتظار يُحذف بعد مهلة قصيرة.
                if (room.gameState === 'WAITING') {
                    player.removalTimer = setTimeout(() => {
                        if (player.disconnected) {
                            removePlayerFromRoom(io, room, player.id);
                        }
                    }, WAITING_REMOVE_DELAY);
                }

            } catch (error) {
                console.error('❌ Error on disconnect:', error);
            }
        });
    });
};

// تنظيف دوري للغرف الخاملة حسب آخر نشاط (لا عمر الغرفة) — غرف الانتظار
// المهجورة تُحذف أسرع من غرفة فيها لعبة طويلة نشطة
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    Object.values(activeRooms).forEach(room => {
        const limit = room.gameState === 'WAITING' ? WAITING_IDLE_TIMEOUT : ROOM_IDLE_TIMEOUT;
        if (now - room.lastActivity > limit) deleteRoom(room, 'idle');
    });
}, 60 * 1000);
cleanupTimer.unref();

module.exports = handleSocketConnections;
module.exports.constants = { MAX_PLAYERS, MAX_ROOMS, MAX_CONNECTIONS_PER_IP, MAX_TURN_DURATION, DEFAULT_TURN_DURATION };
