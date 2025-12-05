const Game = require('../models/Game');
const Stats = require('../models/Stats');
const { v4: uuidv4 } = require('uuid');
const { initializeGameBoard } = require('./gameSetup');
const { makeAIGuess } = require('../utils/aiGuesser');

const activeRooms = {};
const ROOM_EXPIRY = 5 * 60 * 1000; // 5 minutes

// ============================================
// 🧹 ROOM CLEANUP - Auto-delete expired rooms
// ============================================
setInterval(() => {
    const now = Date.now();
    Object.keys(activeRooms).forEach(code => {
        const room = activeRooms[code];
        if (room.lastActivity && (now - room.lastActivity > ROOM_EXPIRY)) {
            delete activeRooms[code];
            console.log(`Room ${code} expired and deleted`);
        }
    });
}, 60 * 1000); // Check every minute

// ============================================
// 🔧 HELPER FUNCTIONS
// ============================================
const getRoom = (roomCode) => roomCode ? activeRooms[roomCode.toUpperCase()] : null;
const getPlayer = (room, socketId) => room ? room.players.find(p => p.id === socketId || p.socketId === socketId) : null;
const getPlayerByUserId = (room, userId) => room ? room.players.find(p => p.userId === userId) : null;
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

const checkWinCondition = (board) => {
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

// ============================================
// 🤖 AI TURN HANDLER
// ============================================
const handleAITurn = (io, roomCode) => {
    const room = getRoom(roomCode);
    if (!room || room.gameState !== 'IN_PROGRESS' || room.currentTurn !== 'BLUE') return;

    setTimeout(async () => {
        let game = await Game.findById(room.currentGameId);
        if (!game) return;

        room.clue = "كلمة_آلية";
        room.guessesLeft = 9 + 1;
        
        io.to(room.code).emit('clueGiven', { clue: room.clue, count: 9, team: 'BLUE' });
        io.to(room.code).emit('gameUpdate', { 
            clue: room.clue, 
            guessesLeft: room.guessesLeft,
            turnPhase: 'GUESSING' 
        });

        while (room.guessesLeft > 0 && room.currentTurn === 'BLUE' && room.gameState === 'IN_PROGRESS') {
            const aiDecision = makeAIGuess(room.board, room.currentTurn, room.guessesLeft);
            
            if (aiDecision.action === 'END_TURN') {
                break;
            } else if (aiDecision.action === 'GUESS') {
                const cardIndex = aiDecision.cardIndex;
                const card = room.board[cardIndex];

                if (card.revealed) break;

                card.revealed = true;
                card.pickedBy = room.currentTurn;
                room.guessesLeft -= 1;
                let result = card.type;
                let turnOver = false;
                let winnerTeam = checkWinCondition(room.board);

                if (result === 'ASSASSIN') {
                    winnerTeam = 'RED';
                } else if (result !== room.currentTurn) {
                    turnOver = true;
                } else if (room.guessesLeft === 0) {
                    turnOver = true;
                }
                
                game.board = room.board;
                game.guessesLeft = room.guessesLeft;

                io.to(room.code).emit('cardRevealed', { cardIndex, card: room.board[cardIndex], result });
                
                if (turnOver) {
                    room.currentTurn = 'RED';
                    room.clue = null;
                    game.currentTurn = 'RED';
                    game.clue = null;
                }
                
                if (winnerTeam) {
                    room.gameState = 'FINISHED';
                    game.gameState = 'FINISHED';
                }

                room.lastActivity = Date.now();
                await game.save();

                io.to(room.code).emit('gameUpdate', { 
                    guessesLeft: room.guessesLeft,
                    currentTurn: room.currentTurn,
                    turnPhase: turnOver ? 'CLUE_GIVING' : 'GUESSING',
                    winner: winnerTeam,
                });
                
                if (turnOver || winnerTeam) break;
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }
    }, 1000);
};

// ============================================
// 🎮 MAIN SOCKET HANDLER
// ============================================
const handleSocketConnections = (io) => {
    io.on('connection', (socket) => {
        console.log('New client connected:', socket.id);
        
        // ==========================================
        // CREATE ROOM
        // ==========================================
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
                        socketId: socket.id,
                        username: data.username || 'لاعب',
                        team: null,
                        role: null,
                        userId: data.userId,
                        ready: false
                    }],
                    gameState: 'WAITING',
                    isAIGame: data.isAIGame || false,
                    history: [],
                    lastActivity: Date.now()
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

        // ==========================================
        // JOIN ROOM
        // ==========================================
        socket.on('joinRoom', async (data) => {
            try {
                const roomCode = data.roomCode ? data.roomCode.toUpperCase() : null;
                const room = getRoom(roomCode);

                if (!room) {
                    socket.emit('roomError', 'الغرفة غير موجودة أو انتهت.');
                    return;
                }
                if (room.gameState !== 'WAITING') {
                    socket.emit('roomError', 'لا يمكن الانضمام، اللعبة قيد التقدم.');
                    return;
                }

                // Check if user already in room
                const existingPlayer = getPlayerByUserId(room, data.userId);
                if (existingPlayer) {
                    socket.emit('roomError', 'أنت موجود بالفعل في الغرفة');
                    return;
                }

                socket.join(roomCode);
                room.players.push({ 
                    id: socket.id,
                    socketId: socket.id,
                    username: data.username || 'لاعب',
                    team: null,
                    role: null,
                    userId: data.userId,
                    ready: false
                });
                socket.roomCode = roomCode;
                room.lastActivity = Date.now();
                
                socket.emit('roomJoined', room);
                io.to(roomCode).emit('roomUpdate', room.players);
                
                console.log(`Player ${socket.id} joined room: ${roomCode}`);
            } catch (error) {
                console.error('Error joining room:', error);
                socket.emit('roomError', 'فشل الانضمام للغرفة.');
            }
        });

        // ==========================================
        // RECONNECT TO ROOM - NEW
        // ==========================================
        socket.on('reconnectToRoom', async ({ roomCode, userId, username }) => {
            try {
                const room = getRoom(roomCode);
                
                if (!room) {
                    socket.emit('reconnectError', 'الغرفة غير موجودة أو انتهت صلاحيتها');
                    return;
                }
                
                const player = getPlayerByUserId(room, userId);
                
                if (!player) {
                    socket.emit('reconnectError', 'لم يتم العثور على بيانات اللاعب');
                    return;
                }
                
                // Update socket ID
                player.socketId = socket.id;
                player.id = socket.id;
                socket.roomCode = roomCode;
                room.lastActivity = Date.now();
                
                socket.join(roomCode);
                
                // Send appropriate response based on game state
                if (room.gameState === 'IN_PROGRESS') {
                    socket.emit('roomReconnected', {
                        code: roomCode,
                        gameStarted: true,
                        board: room.board,
                        currentTurn: room.currentTurn,
                        clue: room.clue,
                        guessesLeft: room.guessesLeft,
                        players: room.players
                    });
                } else {
                    socket.emit('roomReconnected', {
                        code: roomCode,
                        gameStarted: false,
                        players: room.players
                    });
                }
                
                io.to(roomCode).emit('roomUpdate', room.players);
                console.log(`${username} reconnected to room ${roomCode}`);
                
            } catch (error) {
                console.error('Error reconnecting:', error);
                socket.emit('reconnectError', 'فشل إعادة الاتصال');
            }
        });
        
        // ==========================================
        // SET ROLE
        // ==========================================
        socket.on('setRole', (data) => {
            try {
                const room = getRoom(socket.roomCode);
                if (!room) return;

                const { team, role } = data;
                const player = getPlayer(room, socket.id);

                const isRoleTaken = room.players.some(p => 
                    p.team === team && p.role === role && (p.id !== socket.id && p.socketId !== socket.id)
                );

                if (isRoleTaken && role === 'SPYMASTER') {
                    socket.emit('roleError', `فريق ${team === 'RED' ? 'الأحمر' : 'الأزرق'} لديه قائد بالفعل.`);
                    return;
                }

                if (player) {
                    player.team = team;
                    player.role = role;
                    room.lastActivity = Date.now();
                    io.to(room.code).emit('roomUpdate', room.players);
                }
            } catch (error) {
                console.error('Error setting role:', error);
                socket.emit('roleError', 'فشل تعيين الدور.');
            }
        });

        // ==========================================
        // PLAYER READY - NEW
        // ==========================================
        socket.on('playerReady', ({ ready }) => {
            try {
                const room = getRoom(socket.roomCode);
                if (!room) return;
                
                const player = getPlayer(room, socket.id);
                if (player) {
                    player.ready = ready;
                    room.lastActivity = Date.now();
                    io.to(room.code).emit('playerReady', { playerId: socket.id, ready });
                    io.to(room.code).emit('roomUpdate', room.players);
                }
            } catch (error) {
                console.error('Error setting ready status:', error);
            }
        });

        // ==========================================
        // START GAME - UPDATED (Auto-start when all ready)
        // ==========================================
        socket.on('startGame', async () => {
            try {
                const room = getRoom(socket.roomCode);
                if (!room) return;
                
                const redSpymaster = room.players.some(p => p.team === 'RED' && p.role === 'SPYMASTER');
                const blueSpymaster = room.players.some(p => p.team === 'BLUE' && p.role === 'SPYMASTER') || room.isAIGame;

                if (!redSpymaster || !blueSpymaster) {
                    socket.emit('gameError', 'يجب أن يكون هناك قائد أحمر وقائد أزرق لبدء اللعبة.');
                    return;
                }

                // Check if all players with roles are ready
                const playersWithRoles = room.players.filter(p => p.team && p.role);
                const allReady = playersWithRoles.every(p => p.ready);
                
                if (!allReady && playersWithRoles.length >= 4) {
                    socket.emit('gameError', 'جميع اللاعبين يجب أن يكونوا جاهزين');
                    return;
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
                room.lastActivity = Date.now();

                io.to(room.code).emit('gameStarted', {
                    ...newGame.toObject(),
                    players: room.players
                });
                
                console.log(`Game started in room: ${room.code}`);
                
                if (room.isAIGame && room.currentTurn === 'BLUE') {
                    handleAITurn(io, room.code);
                }
            } catch (error) {
                console.error('Error starting game:', error);
                socket.emit('gameError', 'فشل بدء اللعبة.');
            }
        });
        
        // ==========================================
        // GIVE CLUE
        // ==========================================
        socket.on('giveClue', async (data) => {
            try {
                const room = getRoom(socket.roomCode);
                if (!room || room.gameState !== 'IN_PROGRESS' || room.currentTurn === 'BLUE') return;

                const player = getPlayer(room, socket.id);
                const { clue, count } = data;

                if (!player || !isSpymaster(player) || !isMyTurn(room, player)) {
                    socket.emit('clueError', 'ليس دورك أو ليس مسموحاً لك بإعطاء تلميح.');
                    return;
                }
                
                const normalizedClue = normalizeArabic(clue);
                const isClueOnBoard = room.board.some(card => 
                    normalizeArabic(card.word) === normalizedClue
                );
                
                if (isClueOnBoard) {
                    socket.emit('clueError', 'لا يمكن استخدام كلمة موجودة على لوح اللعب كتلميح.');
                    return;
                }

                room.clue = clue;
                room.guessesLeft = count + 1;
                room.lastActivity = Date.now();

                let game = await Game.findById(room.currentGameId);
                if (!game) return;
                game.clue = room.clue;
                game.guessesLeft = room.guessesLeft;
                await game.save();

                io.to(room.code).emit('clueGiven', { clue, count, team: player.team });
                io.to(room.code).emit('gameUpdate', { 
                    clue: room.clue,
                    guessesLeft: room.guessesLeft,
                    turnPhase: 'GUESSING'
                });
            } catch (error) {
                console.error('Error giving clue:', error);
                socket.emit('clueError', 'فشل إعطاء التلميح.');
            }
        });

        // ==========================================
        // MAKE GUESS
        // ==========================================
        socket.on('makeGuess', async (data) => {
            try {
                const room = getRoom(socket.roomCode);
                if (!room || room.gameState !== 'IN_PROGRESS' || room.guessesLeft === 0) return;

                const player = getPlayer(room, socket.id);
                const { cardIndex } = data;
                const card = room.board[cardIndex];

                if (!player || !isGuesser(player) || !isMyTurn(room, player) || card.revealed) {
                    socket.emit('guessError', 'إجراء غير مسموح به.');
                    return;
                }

                card.revealed = true;
                card.pickedBy = player.team;
                room.guessesLeft -= 1;

                let result = card.type;
                let turnOver = false;
                let winnerTeam = checkWinCondition(room.board);

                if (result === 'ASSASSIN') {
                    winnerTeam = (player.team === 'RED') ? 'BLUE' : 'RED';
                    turnOver = true;
                } else if (result !== player.team) {
                    turnOver = true;
                } else if (room.guessesLeft === 0) {
                    turnOver = true;
                }

                let game = await Game.findById(room.currentGameId);
                if (!game) return;
                game.board = room.board;
                game.guessesLeft = room.guessesLeft;
                
                if (turnOver) {
                    const nextTeam = room.currentTurn === 'RED' ? 'BLUE' : 'RED';
                    room.currentTurn = nextTeam;
                    game.currentTurn = nextTeam;
                    room.clue = null;
                    game.clue = null;
                    room.guessesLeft = 0;
                }
                
                if (winnerTeam) {
                    room.gameState = 'FINISHED';
                    game.gameState = 'FINISHED';
                }

                room.lastActivity = Date.now();
                await game.save();

                io.to(room.code).emit('cardRevealed', { cardIndex, card: room.board[cardIndex], result });
                io.to(room.code).emit('gameUpdate', { 
                    guessesLeft: room.guessesLeft,
                    currentTurn: room.currentTurn,
                    turnPhase: turnOver ? 'CLUE_GIVING' : 'GUESSING',
                    winner: winnerTeam,
                });
                
                if (turnOver && room.currentTurn === 'BLUE' && room.isAIGame) {
                    handleAITurn(io, room.code);
                }
            } catch (error) {
                console.error('Error making guess:', error);
                socket.emit('guessError', 'فشل التخمين.');
            }
        });
        
        // ==========================================
        // END TURN
        // ==========================================
        socket.on('endTurn', async () => {
            try {
                const room = getRoom(socket.roomCode);
                if (!room || room.gameState !== 'IN_PROGRESS') return;

                const player = getPlayer(room, socket.id);
                if (!player || (!isGuesser(player) && !isSpymaster(player)) || !isMyTurn(room, player)) return;

                const nextTeam = room.currentTurn === 'RED' ? 'BLUE' : 'RED';
                room.currentTurn = nextTeam;
                room.clue = null;
                room.guessesLeft = 0;
                room.lastActivity = Date.now();

                let game = await Game.findById(room.currentGameId);
                if (!game) return;
                game.currentTurn = room.currentTurn;
                game.clue = null;
                game.guessesLeft = 0;
                await game.save();

                io.to(room.code).emit('gameUpdate', {
                    currentTurn: room.currentTurn,
                    clue: null,
                    guessesLeft: 0,
                    turnPhase: 'CLUE_GIVING'
                });

                if (room.currentTurn === 'BLUE' && room.isAIGame) {
                    handleAITurn(io, room.code);
                }
            } catch (error) {
                console.error('Error ending turn:', error);
            }
        });

        // ==========================================
        // LEAVE ROOM - NEW
        // ==========================================
        socket.on('leaveRoom', () => {
            try {
                const roomCode = socket.roomCode;
                const room = getRoom(roomCode);
                
                if (room) {
                    room.players = room.players.filter(p => p.socketId !== socket.id && p.id !== socket.id);
                    
                    if (room.players.length === 0) {
                        delete activeRooms[roomCode];
                        console.log(`Room ${roomCode} closed (empty)`);
                    } else {
                        room.lastActivity = Date.now();
                        io.to(roomCode).emit('roomUpdate', room.players);
                        console.log(`Player ${socket.id} left room ${roomCode}`);
                    }
                    
                    socket.leave(roomCode);
                    socket.roomCode = null;
                }
            } catch (error) {
                console.error('Error leaving room:', error);
            }
        });

        // ==========================================
        // DISCONNECT
        // ==========================================
        socket.on('disconnect', async () => {
            try {
                console.log(`User disconnected: ${socket.id}`);
                
                // Don't remove player immediately - allow reconnection for 5 minutes
                // Player data stays in room.players for reconnection
                
                if (socket.roomCode) {
                    const room = getRoom(socket.roomCode);
                    if (room) {
                        room.lastActivity = Date.now();
                        console.log(`Player ${socket.id} disconnected from room ${socket.roomCode} (reconnection allowed)`);
                    }
                }
            } catch (error) {
                console.error('Error on disconnect:', error);
            }
        });
    });
};

module.exports = handleSocketConnections;
