const Game = require('../models/Game');
const { v4: uuidv4 } = require('uuid');
const { initializeGameBoard } = require('./gameSetup');
const { countRemaining, checkWinCondition, sanitizeBoardForRole } = require('./gameLogic');
const { normalizeArabic } = require('../utils/wordNormalizer');

const activeRooms = {};

const ROOM_CODE_RE = /^[A-Z0-9]{6}$/;
const MAX_PLAYERS = 8;
const MAX_CLUE_LENGTH = 30;
const WAITING_REMOVE_DELAY = 30 * 1000;   // مهلة حذف اللاعب المنقطع في غرفة الانتظار
const ROOM_IDLE_TIMEOUT = 2 * 60 * 60 * 1000; // حذف الغرفة بعد ساعتين بلا نشاط

// Helper functions
const getRoom = (roomCode) => roomCode ? activeRooms[roomCode.toUpperCase()] : null;
const getPlayer = (room, socketId) => room ? room.players.find(p => p.id === socketId) : null;
const isSpymaster = (player) => player && player.role === 'SPYMASTER';
const isGuesser = (player) => player && player.role === 'GUESSER';
const isMyTurn = (room, player) => player && room && room.currentTurn === player.team;
const isHost = (room, player) => player && room && room.hostUserId === player.userId;
const touch = (room) => { if (room) room.lastActivity = Date.now(); };

// تعقيم اسم اللاعب: نص فقط، بلا وسوم HTML، بطول محدود
const sanitizeName = (name, fallback = 'لاعب') => {
    if (typeof name !== 'string') return fallback;
    const clean = name.replace(/[<>&"'`]/g, '').trim().slice(0, 20);
    return clean || fallback;
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

// إرسال حالة اللعبة كاملة للاعب واحد بنسخة مناسبة لدوره
const emitGameStateTo = (io, room, player) => {
    io.to(player.id).emit('gameStarted', {
        board: sanitizeBoardForRole(room.board, player.role, room.gameState),
        gameState: room.gameState,
        currentTurn: room.currentTurn,
        firstTeam: room.firstTeam,
        clue: room.clue,
        clueCount: room.clueCount,
        guessesLeft: room.guessesLeft,
        players: publicPlayers(room),
        ...countRemaining(room.board)
    });
};

// Main socket handler
const handleSocketConnections = (io) => {

    io.on('connection', (socket) => {
        console.log('🟢 New connection:', socket.id);

        // ====================================
        // CREATE ROOM
        // ====================================
        socket.on('createRoom', (data = {}) => {
            if (!allowEvent(socket)) return;
            try {
                const custom = typeof data.customName === 'string' ? data.customName.trim().toUpperCase() : '';
                const roomCode = custom || uuidv4().substring(0, 6).toUpperCase();

                if (!ROOM_CODE_RE.test(roomCode)) {
                    socket.emit('roomError', 'كود الغرفة يجب أن يكون 6 خانات من أحرف إنجليزية أو أرقام.');
                    return;
                }

                if (activeRooms[roomCode]) {
                    socket.emit('roomError', 'هذا الكود مستخدم مسبقاً. جرب كود آخر.');
                    return;
                }

                const username = sanitizeName(data.username);
                const userId = typeof data.userId === 'string' && data.userId
                    ? data.userId.slice(0, 64)
                    : uuidv4();

                socket.join(roomCode);
                socket.roomCode = roomCode;

                activeRooms[roomCode] = {
                    code: roomCode,
                    hostUserId: userId,
                    players: [{
                        id: socket.id,
                        socketId: socket.id,
                        username,
                        team: null,
                        role: null,
                        userId,
                        disconnected: false,
                        removalTimer: null
                    }],
                    gameState: 'WAITING',
                    board: [],
                    currentTurn: null,
                    firstTeam: null,
                    clue: null,
                    clueCount: 0,
                    guessesLeft: 0,
                    currentGameId: null,
                    createdAt: Date.now(),
                    lastActivity: Date.now()
                };

                const room = activeRooms[roomCode];
                console.log(`✅ Room created: ${roomCode} by ${username}`);
                socket.emit('roomCreated', { code: roomCode, players: publicPlayers(room) });
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
                touch(room);

                const userId = typeof data.userId === 'string' && data.userId
                    ? data.userId.slice(0, 64)
                    : uuidv4();

                // إعادة اتصال: نفس الهوية موجودة في الغرفة → استعادة المقعد والحالة
                const existing = room.players.find(p => p.userId === userId);
                if (existing) {
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
                        gameState: room.gameState
                    });
                    if (room.gameState === 'IN_PROGRESS') {
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
                    socket.emit('roomError', 'الغرفة ممتلئة (8 لاعبين كحد أقصى).');
                    return;
                }

                const username = sanitizeName(data.username);
                socket.join(room.code);
                socket.roomCode = room.code;

                room.players.push({
                    id: socket.id,
                    socketId: socket.id,
                    username,
                    team: null,
                    role: null,
                    userId,
                    disconnected: false,
                    removalTimer: null
                });

                console.log(`✅ ${username} joined room: ${room.code}`);
                socket.emit('roomJoined', {
                    code: room.code,
                    players: publicPlayers(room),
                    gameState: room.gameState
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

                if (room.gameState === 'IN_PROGRESS') {
                    socket.emit('roleError', 'لا يمكن تغيير الدور أثناء اللعبة.');
                    return;
                }

                const { team, role } = data;
                if (!['RED', 'BLUE'].includes(team) || !['SPYMASTER', 'GUESSER'].includes(role)) {
                    socket.emit('roleError', 'اختيار غير صالح.');
                    return;
                }

                const player = getPlayer(room, socket.id);
                if (!player) return;

                if (role === 'SPYMASTER') {
                    const isRoleTaken = room.players.some(p =>
                        p.team === team && p.role === 'SPYMASTER' && p.id !== socket.id
                    );

                    if (isRoleTaken) {
                        socket.emit('roleError', `فريق ${team === 'RED' ? 'الأحمر' : 'الأزرق'} لديه قائد بالفعل.`);
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
        // START GAME (المضيف فقط)
        // ====================================
        socket.on('startGame', () => {
            if (!allowEvent(socket)) return;
            try {
                const room = getRoom(socket.roomCode);
                if (!room || room.gameState === 'IN_PROGRESS') return;
                touch(room);

                const player = getPlayer(room, socket.id);
                if (!isHost(room, player)) {
                    socket.emit('gameError', 'المضيف فقط يمكنه بدء اللعبة.');
                    return;
                }

                // Validate teams
                const redSpymaster = room.players.some(p => p.team === 'RED' && p.role === 'SPYMASTER');
                const blueSpymaster = room.players.some(p => p.team === 'BLUE' && p.role === 'SPYMASTER');
                const redGuesser = room.players.some(p => p.team === 'RED' && p.role === 'GUESSER');
                const blueGuesser = room.players.some(p => p.team === 'BLUE' && p.role === 'GUESSER');

                if (!redSpymaster || !blueSpymaster) {
                    socket.emit('gameError', 'يجب أن يكون هناك قائد أحمر وقائد أزرق لبدء اللعبة.');
                    return;
                }

                if (!redGuesser || !blueGuesser) {
                    socket.emit('gameError', 'يجب أن يكون لكل فريق مخمن واحد على الأقل.');
                    return;
                }

                // Initialize game — الحالة في الذاكرة هي المصدر الأساسي
                const gameData = initializeGameBoard();

                room.gameState = 'IN_PROGRESS';
                room.board = gameData.board;
                room.currentTurn = gameData.currentTurn;
                room.firstTeam = gameData.firstTeam;
                room.clue = null;
                room.clueCount = 0;
                room.guessesLeft = 0;
                room.currentGameId = null;

                console.log(`✅ Game started in room: ${room.code}`);

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
                    socket.emit('clueError', 'تلميح غير صالح. يرجى إدخال تلميح (30 حرفاً كحد أقصى) وعدد بين 1 و 9.');
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
                room.guessesLeft = count + 1; // +1 for bonus guess

                persistRoom(room, { clue, guessesLeft: room.guessesLeft });

                console.log(`✅ Clue given: "${clue}" (${count}) by ${player.team}`);

                io.to(room.code).emit('clueGiven', {
                    clue,
                    count,
                    team: player.team
                });

                io.to(room.code).emit('gameUpdate', {
                    clue: room.clue,
                    clueCount: room.clueCount,
                    guessesLeft: room.guessesLeft,
                    currentTurn: room.currentTurn,
                    ...countRemaining(room.board)
                });

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

                // Reveal the card
                card.revealed = true;
                card.pickedBy = player.team;
                room.guessesLeft -= 1;

                const result = card.type;
                let turnOver = false;

                if (result === 'ASSASSIN') {
                    turnOver = true;
                } else if (result !== player.team) {
                    // Wrong guess - turn ends
                    turnOver = true;
                } else if (room.guessesLeft === 0) {
                    // No more guesses - turn ends
                    turnOver = true;
                }

                const winnerTeam = checkWinCondition(room.board);

                // منطق اللعبة يُطبَّق على حالة الذاكرة دائماً — بمعزل عن قاعدة البيانات
                if (turnOver && !winnerTeam) {
                    room.currentTurn = room.currentTurn === 'RED' ? 'BLUE' : 'RED';
                    room.clue = null;
                    room.clueCount = 0;
                    room.guessesLeft = 0;
                }

                if (winnerTeam) {
                    room.gameState = 'FINISHED';
                    room.clue = null;
                    room.clueCount = 0;
                    room.guessesLeft = 0;
                }

                const historyEntry = {
                    team: player.team,
                    word: card.word,
                    result: result === player.team ? 'Correct'
                        : result === 'ASSASSIN' ? 'Assassin'
                        : result === 'INNOCENT' ? 'Innocent' : 'Opponent'
                };

                persistRoom(room, {
                    board: room.board,
                    guessesLeft: room.guessesLeft,
                    currentTurn: room.currentTurn,
                    clue: room.clue,
                    gameState: room.gameState,
                    $push: { history: historyEntry }
                });

                console.log(`✅ Card revealed: ${card.word} (${result}) by ${player.team}`);

                const remaining = countRemaining(room.board);

                io.to(room.code).emit('cardRevealed', {
                    cardIndex,
                    card,
                    result,
                    ...remaining
                });

                io.to(room.code).emit('gameUpdate', {
                    guessesLeft: room.guessesLeft,
                    currentTurn: room.currentTurn,
                    clue: room.clue,
                    clueCount: room.clueCount,
                    winner: winnerTeam,
                    // عند نهاية اللعبة فقط تُكشف اللوحة كاملة للجميع
                    board: winnerTeam ? room.board : undefined,
                    ...remaining
                });

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

                room.currentTurn = room.currentTurn === 'RED' ? 'BLUE' : 'RED';
                room.clue = null;
                room.clueCount = 0;
                room.guessesLeft = 0;

                persistRoom(room, {
                    currentTurn: room.currentTurn,
                    clue: null,
                    guessesLeft: 0
                });

                console.log(`✅ Turn ended by ${player.team}, now ${room.currentTurn}'s turn`);

                io.to(room.code).emit('gameUpdate', {
                    currentTurn: room.currentTurn,
                    clue: null,
                    clueCount: 0,
                    guessesLeft: 0,
                    ...countRemaining(room.board)
                });

            } catch (error) {
                console.error('❌ Error ending turn:', error);
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

                room.gameState = 'WAITING';
                room.board = [];
                room.currentTurn = null;
                room.firstTeam = null;
                room.clue = null;
                room.clueCount = 0;
                room.guessesLeft = 0;
                room.currentGameId = null;

                console.log(`🔁 Room ${room.code} returned to lobby`);
                io.to(room.code).emit('returnedToLobby', { players: publicPlayers(room) });
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
                const room = getRoom(socket.roomCode);
                if (!room) return;

                removePlayerFromRoom(io, room, socket.id);
                socket.leave(room.code);
                socket.roomCode = null;

            } catch (error) {
                console.error('❌ Error on leaveRoom:', error);
            }
        });

        // ====================================
        // DISCONNECT
        // ====================================
        socket.on('disconnect', () => {
            try {
                const room = getRoom(socket.roomCode);
                if (!room) return;

                const player = getPlayer(room, socket.id);
                if (!player) return;

                console.log(`❌ ${player.username} disconnected from ${room.code}`);
                player.disconnected = true;
                io.to(room.code).emit('roomUpdate', publicPlayers(room));
                io.to(room.code).emit('playerDisconnected', { username: player.username });

                // أثناء اللعبة نُبقي مقعد اللاعب محجوزاً ليعود بنفس userId.
                // في غرفة الانتظار يُحذف بعد مهلة قصيرة إن لم يعد.
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

// إزالة لاعب نهائياً من الغرفة (مغادرة صريحة أو انتهاء مهلة الانقطاع)
const removePlayerFromRoom = (io, room, socketId) => {
    const player = getPlayer(room, socketId);
    if (!player) return;

    if (player.removalTimer) clearTimeout(player.removalTimer);
    room.players = room.players.filter(p => p.id !== socketId);

    if (room.players.length === 0) {
        delete activeRooms[room.code];
        console.log(`🗑️ Room ${room.code} deleted (empty)`);
        return;
    }

    // نقل الاستضافة إذا غادر المضيف
    if (room.hostUserId === player.userId) {
        room.hostUserId = room.players[0].userId;
    }

    io.to(room.code).emit('roomUpdate', publicPlayers(room));
    io.to(room.code).emit('playerLeft', { username: player.username });
    console.log(`👋 ${player.username} left room ${room.code}`);
};

// Cleanup idle rooms periodically (حسب آخر نشاط، لا عمر الغرفة —
// حتى لا تُحذف لعبة طويلة نشطة من تحت اللاعبين)
setInterval(() => {
    const now = Date.now();

    Object.keys(activeRooms).forEach(code => {
        const room = activeRooms[code];
        if (now - room.lastActivity > ROOM_IDLE_TIMEOUT) {
            delete activeRooms[code];
            console.log(`🗑️ Room ${code} deleted (idle)`);
        }
    });
}, 10 * 60 * 1000);

module.exports = handleSocketConnections;
