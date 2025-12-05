const Game = require('../models/Game');
const Stats = require('../models/Stats');
const { v4: uuidv4 } = require('uuid');
const { initializeGameBoard } = require('./gameSetup');
const { makeAIGuess } = require('../utils/aiGuesser');

const activeRooms = {}; 
const ACTIVE_TIMEOUT_MS = 5 * 60 * 1000; // 5 دقائق مهلة لانقطاع الاتصال

// دوال مساعدة
const getRoom = (roomCode) => roomCode ? activeRooms[roomCode.toUpperCase()] : null;
const getPlayer = (room, socketId) => room ? room.players.find(p => p.id === socketId) : null;
const getPlayerByUserId = (room, userId) => room ? room.players.find(p => p.userId === userId) : null; // NEW
const isSpymaster = (player) => player && player.role === 'SPYMASTER';
const isGuesser = (player) => player && player.role === 'GUESSER';
const isMyTurn = (room, player) => player && room && room.currentTurn === player.team;
const normalizeArabic = (text) => {
    if (!text) return '';
    return text.normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[أإآ]/g, 'ا')
        .replace(/ى/g, 'ي');
};

// منطق التحقق من الفوز
const checkWinCondition = (board) => {
    // ... (existing logic) ...
    if (!board) return null;
    
    let redRemaining = 0;
    let blueRemaining = 0;

    for (const card of board) {
        if (!card.revealed) {
            if (card.type === 'RED') redRemaining++;
            if (card.type === 'BLUE') blueRemaining++;
        }
    }
    if (redRemaining === 0) return 'RED';
    if (blueRemaining === 0) return 'BLUE';
    return null;
};

// دالة معالجة دور الذكاء الاصطناعي (AI)
const handleAITurn = (io, roomCode) => {
    // ... (existing logic) ...
};

// الدالة الرئيسية لمعالجة اتصالات Socket.io
const handleSocketConnections = (io) => {
    
    // دوال مساعدة إضافية تحتاج إلى io و activeRooms
    const getRoomByUserId = (userId) => {
        for (const roomCode in activeRooms) {
            if (activeRooms[roomCode].players.some(p => p.userId === userId)) {
                return activeRooms[roomCode];
            }
        }
        return null;
    };
    
    // دالة تنظيف اللاعبين المنقطعين (Issue 5)
    const cleanupDisconnectedPlayer = (roomCode, userId) => {
        const room = getRoom(roomCode);
        if (!room) return;
        
        const playerIndex = room.players.findIndex(p => p.userId === userId);
        if (playerIndex > -1 && room.players[playerIndex].isConnected === false) {
            
            // إزالة اللاعب
            room.players.splice(playerIndex, 1);
            
            if (room.players.length === 0) {
                delete activeRooms[roomCode];
                console.log(`Room ${roomCode} closed (empty).`);
            } else {
                io.to(roomCode).emit('roomUpdate', room.players);
                console.log(`Player ${userId} permanently removed from room ${roomCode}`);
            }
        }
    };
    
    // دالة بدء اللعبة (معدلة لنظام الجاهزية)
    const startGame = async (room) => {
        try {
            const redSpymaster = room.players.some(p => p.team === 'RED' && p.role === 'SPYMASTER' && p.isConnected);
            const blueSpymaster = room.players.some(p => p.team === 'BLUE' && p.role === 'SPYMASTER' && p.isConnected) || room.isAIGame;
            
            const connectedPlayersWithRole = room.players.filter(p => p.team && p.role && p.isConnected);
            if (connectedPlayersWithRole.length < 4) {
                io.to(room.code).emit('gameError', 'يجب أن يكون هناك 4 لاعبين متصلين على الأقل لاختيار الأدوار.');
                return false;
            }

            if (!redSpymaster || !blueSpymaster) {
                io.to(room.code).emit('gameError', 'يجب أن يكون هناك قائد أحمر وقائد أزرق (أو ذكاء اصطناعي) لبدء اللعبة.');
                return false;
            }

            const gameData = initializeGameBoard();
            const newGame = await Game.create({ 
                roomCode: room.code, 
                board: gameData.board, 
                currentTurn: gameData.currentTurn, 
                firstTeam: gameData.firstTeam, 
                players: room.players.map(p => ({ 
                    socketId: p.id, 
                    userId: p.userId, 
                    username: p.username, 
                    team: p.team, 
                    role: p.role 
                })), 
                gameState: 'IN_PROGRESS',
            });

            room.gameState = 'IN_PROGRESS';
            room.currentGameId = newGame._id;
            room.board = newGame.board;
            room.currentTurn = newGame.currentTurn;
            room.firstTeam = newGame.firstTeam;
            room.clue = null;
            room.guessesLeft = 0;
            
            io.to(room.code).emit('gameStarted', { ...newGame.toObject(), players: room.players });
            console.log(`Game started in room: ${room.code}`);

            if (room.isAIGame && room.currentTurn === 'BLUE') {
                handleAITurn(io, room.code);
            }
            return true;
        } catch (error) {
            console.error('Error starting game:', error);
            io.to(room.code).emit('gameError', 'فشل بدء اللعبة.');
            return false;
        }
    }
    // نهاية الدوال المساعدة
    
    io.on('connection', (socket) => {
        console.log('New client connected:', socket.id);
        
        const { userId, username } = socket.handshake.auth; // الحصول على بيانات المصادقة

        // 1. منطق إعادة الاتصال (Issue 5)
        if (userId) {
            const room = getRoomByUserId(userId);
            if (room) {
                const player = getPlayerByUserId(room, userId);
                
                if (player) {
                    clearTimeout(player.disconnectTimeout); // إلغاء مؤقت الانقطاع
                    
                    // تحديث معرف السوكت وحالة الاتصال
                    player.id = socket.id;
                    player.isConnected = true;
                    socket.roomCode = room.code;
                    socket.join(room.code);
                    
                    console.log(`Player ${userId} reconnected to room ${room.code}`);
                    
                    // إرسال حالة الغرفة الحالية لاستئناف اللعب
                    const gameStateToSend = { 
                        ...room, 
                        players: room.players
                    };
                    socket.emit('resumeGame', gameStateToSend); 
                    io.to(room.code).emit('roomUpdate', room.players); // إبلاغ الآخرين بحالة الاتصال
                    return; 
                }
            }
        }
        
        // CREATE ROOM (تعديل: إضافة isReady, isConnected, disconnectTimeout)
        socket.on('createRoom', async (data) => {
            try {
                const roomCode = (data.customName || uuidv4().substring(0, 6)).toUpperCase();
                
                if (activeRooms[roomCode]) { 
                    socket.emit('roomError', 'هذا الكود مستخدم مسبقاً.'); 
                    return; 
                }

                socket.join(roomCode);
                activeRooms[roomCode] = {
                    code: roomCode,
                    players: [{ 
                        id: socket.id, 
                        username: data.username || 'لاعب', 
                        team: null, 
                        role: null, 
                        userId: data.userId,
                        isReady: false,
                        isConnected: true, // NEW
                        disconnectTimeout: null // NEW
                    }],
                    gameState: 'WAITING',
                    isAIGame: data.isAIGame || false,
                    history: []
                };
                socket.roomCode = roomCode;
                
                socket.emit('roomCreated', activeRooms[roomCode]);
                io.to(roomCode).emit('roomUpdate', activeRooms[roomCode].players);
                
                console.log(`Room created: ${roomCode}`);
            } catch (error) {
                console.error('Error creating room:', error);
                socket.emit('roomError', 'فشل إنشاء الغرفة. حاول مرة أخرى.');
            }
        });

        // JOIN ROOM (تعديل: إضافة isReady, isConnected, disconnectTimeout)
        socket.on('joinRoom', async (data) => {
            try {
                const roomCode = data.roomCode ? data.roomCode.toUpperCase() : null;
                const room = getRoom(roomCode);

                if (!room) { 
                    socket.emit('roomError', 'الغرفة غير موجودة أو انتهت.'); 
                    return; 
                }
                // ... (existing checks) ...
                
                // NEW: Check if user is already in the room but disconnected
                if (getPlayerByUserId(room, data.userId)) {
                    socket.emit('roomError', 'أنت متواجد بالفعل في هذه الغرفة ولكنك منقطع. قم بتحديث الصفحة لإعادة الاتصال.');
                    return;
                }
                
                socket.join(roomCode);
                room.players.push({ 
                    id: socket.id, 
                    username: data.username || 'لاعب', 
                    team: null, 
                    role: null, 
                    userId: data.userId,
                    isReady: false,
                    isConnected: true, // NEW
                    disconnectTimeout: null // NEW
                });
                
                socket.roomCode = roomCode;
                socket.emit('roomCreated', room); 
                io.to(roomCode).emit('roomUpdate', room.players);
                
                console.log(`Player ${socket.id} joined room ${roomCode}`);
            } catch (error) {
                console.error('Error joining room:', error);
                socket.emit('roomError', 'فشل الانضمام للغرفة. تأكد من الكود.');
            }
        });
        
        // NEW: setReady handler (Issue 1)
        socket.on('setReady', (data) => {
            const room = getRoom(socket.roomCode);
            if (!room || room.gameState !== 'WAITING') return;

            const player = getPlayer(room, socket.id);
            if (!player || !player.team || !player.role) {
                socket.emit('gameError', 'يجب اختيار الفريق والدور أولاً.');
                return;
            }

            player.isReady = data.isReady;
            
            // التحقق من البدء التلقائي (الكل جاهز)
            const playersWithRole = room.players.filter(p => p.team && p.role && p.isConnected);
            const allReady = playersWithRole.length >= 4 && playersWithRole.every(p => p.isReady); // 4 players min
            
            if (allReady) {
                // بدء اللعبة تلقائياً
                startGame(room);
            }
            
            io.to(room.code).emit('roomUpdate', room.players);
        });

        // ... (existing setRole handler) ...
        socket.on('setRole', (data) => {
            // ... (existing logic) ...
            const player = getPlayer(room, socket.id);
            
            // عند تغيير الدور/الفريق يتم إعادة تعيين حالة الجاهزية
            if (player) {
                player.isReady = false; 
            }
            // ... (existing logic) ...
            io.to(room.code).emit('roomUpdate', room.players);
        });
        
        // OLD: socket.on('startGame') handler REMOVED, replaced by auto-start in setReady

        // NEW: Explicit leave room handler (Issue 5)
        socket.on('leaveRoom', () => {
            const roomCode = socket.roomCode;
            const room = getRoom(roomCode);
            const player = getPlayer(room, socket.id);
            
            if (room && player) {
                clearTimeout(player.disconnectTimeout); 
                cleanupDisconnectedPlayer(roomCode, player.userId);
                socket.leave(roomCode);
                delete socket.roomCode;
                socket.emit('leftRoom');
            }
        });
        
        // ... (existing giveClue, guessCard, endTurn handlers) ...

        // DISCONNECT (Issue 5)
        socket.on('disconnect', async () => {
            try {
                if (!socket.roomCode || !userId) return; 
                
                const roomCode = socket.roomCode;
                const room = activeRooms[roomCode];

                if (room) {
                    const player = getPlayer(room, socket.id);
                    if (player) {
                        player.isConnected = false; // تعيين حالة الانقطاع
                        
                        // بدء مؤقت 5 دقائق
                        player.disconnectTimeout = setTimeout(() => {
                            cleanupDisconnectedPlayer(roomCode, player.userId); 
                        }, ACTIVE_TIMEOUT_MS);
                        
                        io.to(roomCode).emit('roomUpdate', room.players);
                        console.log(`Player ${userId} disconnected. 5 min grace period started.`);
                    }
                }
            } catch (error) {
                console.error('Error on disconnect:', error);
            }
        });
    });
};
module.exports = handleSocketConnections
