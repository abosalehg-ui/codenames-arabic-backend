const Game = require('../models/Game');
const { v4: uuidv4 } = require('uuid');
const { initializeGameBoard } = require('./gameSetup');

const activeRooms = {};

// Helper functions
const getRoom = (roomCode) => roomCode ? activeRooms[roomCode.toUpperCase()] : null;
const getPlayer = (room, socketId) => room ? room.players.find(p => p.id === socketId) : null;
const isSpymaster = (player) => player && player.role === 'SPYMASTER';
const isGuesser = (player) => player && player.role === 'GUESSER';
const isMyTurn = (room, player) => player && room && room.currentTurn === player.team;

// Check win condition
const checkWinCondition = (board) => {
    if (!board) return null;
    
    let redRemaining = 0;
    let blueRemaining = 0;
    let assassinRevealed = false;
    let assassinBy = null;

    for (const card of board) {
        if (card.revealed) {
            if (card.type === 'ASSASSIN') {
                assassinRevealed = true;
                assassinBy = card.pickedBy;
            }
        } else {
            if (card.type === 'RED') redRemaining++;
            if (card.type === 'BLUE') blueRemaining++;
        }
    }
    
    // Assassin ends game immediately
    if (assassinRevealed) {
        return assassinBy === 'RED' ? 'BLUE' : 'RED';
    }
    
    // Normal win conditions
    if (redRemaining === 0) return 'RED';
    if (blueRemaining === 0) return 'BLUE';
    
    return null;
};

// Main socket handler
const handleSocketConnections = (io) => {
    
    io.on('connection', (socket) => {
        console.log('🟢 New connection:', socket.id);
        
        // ====================================
        // CREATE ROOM
        // ====================================
        socket.on('createRoom', async (data) => {
            try {
                const roomCode = (data.customName || uuidv4().substring(0, 6)).toUpperCase();
                
                if (activeRooms[roomCode]) { 
                    socket.emit('roomError', 'هذا الكود مستخدم مسبقاً. جرب كود آخر.'); 
                    return; 
                }

                socket.join(roomCode);
                socket.roomCode = roomCode;
                
                activeRooms[roomCode] = {
                    code: roomCode,
                    players: [{
                        id: socket.id,
                        socketId: socket.id,
                        username: data.username || 'لاعب',
                        team: null,
                        role: null,
                        userId: data.userId || null,
                        disconnected: false
                    }],
                    gameState: 'WAITING',
                    board: [],
                    currentTurn: null,
                    firstTeam: null,
                    clue: null,
                    guessesLeft: 0,
                    currentGameId: null,
                    createdAt: Date.now()
                };
                
                console.log(`✅ Room created: ${roomCode} by ${data.username}`);
                socket.emit('roomCreated', activeRooms[roomCode]);
                io.to(roomCode).emit('roomUpdate', activeRooms[roomCode].players);
                
            } catch (error) {
                console.error('❌ Error creating room:', error);
                socket.emit('roomError', 'فشل إنشاء الغرفة. حاول مرة أخرى.');
            }
        });

        // ====================================
        // JOIN ROOM
        // ====================================
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
                
                // Check if player already in room
                const existingPlayer = room.players.find(p => p.socketId === socket.id);
                if (existingPlayer) {
                    socket.emit('roomError', 'أنت بالفعل في هذه الغرفة.');
                    return;
                }

                socket.join(roomCode);
                socket.roomCode = roomCode;
                
                room.players.push({
                    id: socket.id,
                    socketId: socket.id,
                    username: data.username || 'لاعب',
                    team: null,
                    role: null,
                    userId: data.userId || null,
                    disconnected: false
                });
                
                console.log(`✅ ${data.username} joined room: ${roomCode}`);
                io.to(roomCode).emit('roomUpdate', room.players);
                
            } catch (error) {
                console.error('❌ Error joining room:', error);
                socket.emit('roomError', 'فشل الانضمام للغرفة.');
            }
        });
        
        // ====================================
        // SET ROLE
        // ====================================
        socket.on('setRole', (data) => {
            try {
                const room = getRoom(socket.roomCode);
                if (!room) return;

                const { team, role } = data;
                const player = getPlayer(room, socket.id);

                // Check if spymaster role is already taken
                if (role === 'SPYMASTER') {
                    const isRoleTaken = room.players.some(p => 
                        p.team === team && p.role === 'SPYMASTER' && p.id !== socket.id
                    );

                    if (isRoleTaken) {
                        socket.emit('roleError', `فريق ${team === 'RED' ? 'الأحمر' : 'الأزرق'} لديه قائد بالفعل.`);
                        return;
                    }
                }

                if (player) {
                    player.team = team;
                    player.role = role;
                    console.log(`✅ ${player.username} set role: ${team} ${role}`);
                    io.to(room.code).emit('roomUpdate', room.players);
                }
            } catch (error) {
                console.error('❌ Error setting role:', error);
                socket.emit('roleError', 'فشل تعيين الدور.');
            }
        });

        // ====================================
        // START GAME
        // ====================================
        socket.on('startGame', async () => {
            try {
                const room = getRoom(socket.roomCode);
                if (!room) return;
                
                // Validate teams
                const redSpymaster = room.players.some(p => p.team === 'RED' && p.role === 'SPYMASTER');
                const blueSpymaster = room.players.some(p => p.team === 'BLUE' && p.role === 'SPYMASTER');

                if (!redSpymaster || !blueSpymaster) {
                    socket.emit('gameError', 'يجب أن يكون هناك قائد أحمر وقائد أزرق لبدء اللعبة.');
                    return;
                }
                
                const hasEnoughPlayers = room.players.filter(p => p.team && p.role).length >= 4;
                if (!hasEnoughPlayers) {
                    socket.emit('gameError', 'يجب وجود 4 لاعبين على الأقل (قائد ومخمن لكل فريق).');
                    return;
                }

                // Initialize game
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
                    clue: null,
                    guessesLeft: 0
                });
                
                room.gameState = 'IN_PROGRESS';
                room.currentGameId = newGame._id;
                room.board = newGame.board;
                room.currentTurn = newGame.currentTurn;
                room.firstTeam = newGame.firstTeam;
                room.clue = null;
                room.guessesLeft = 0;

                console.log(`✅ Game started in room: ${room.code}`);
                
                io.to(room.code).emit('gameStarted', {
                    ...newGame.toObject(),
                    players: room.players
                });
                
            } catch (error) {
                console.error('❌ Error starting game:', error);
                socket.emit('gameError', 'فشل بدء اللعبة.');
            }
        });
        
        // ====================================
        // GIVE CLUE
        // ====================================
        socket.on('giveClue', async (data) => {
            try {
                const room = getRoom(socket.roomCode);
                if (!room || room.gameState !== 'IN_PROGRESS') return;

                const player = getPlayer(room, socket.id);
                const { clue, count } = data;

                if (!player || !isSpymaster(player) || !isMyTurn(room, player)) {
                    socket.emit('clueError', 'ليس دورك أو ليس مسموحاً لك بإعطاء تلميح.');
                    return;
                }
                
                if (!clue || !count || count < 1 || count > 9) {
                    socket.emit('clueError', 'تلميح غير صالح. يرجى إدخال تلميح وعدد بين 1 و 9.');
                    return;
                }
                
                // Check if clue is on the board
                const normalizedClue = clue.trim().toLowerCase();
                const isClueOnBoard = room.board.some(card => 
                    card.word.trim().toLowerCase() === normalizedClue
                );
                
                if (isClueOnBoard) {
                    socket.emit('clueError', 'لا يمكن استخدام كلمة موجودة على لوح اللعب كتلميح.');
                    return;
                }

                room.clue = clue;
                room.guessesLeft = count + 1; // +1 for bonus guess

                let game = await Game.findById(room.currentGameId);
                if (game) {
                    game.clue = clue;
                    game.guessesLeft = room.guessesLeft;
                    await game.save();
                }

                console.log(`✅ Clue given: "${clue}" (${count}) by ${player.team}`);
                
                io.to(room.code).emit('clueGiven', { 
                    clue, 
                    count, 
                    team: player.team 
                });
                
                io.to(room.code).emit('gameUpdate', { 
                    clue: room.clue, 
                    guessesLeft: room.guessesLeft,
                    currentTurn: room.currentTurn
                });
                
            } catch (error) {
                console.error('❌ Error giving clue:', error);
                socket.emit('clueError', 'فشل إعطاء التلميح.');
            }
        });

        // ====================================
        // MAKE GUESS
        // ====================================
        socket.on('makeGuess', async (data) => {
            try {
                const room = getRoom(socket.roomCode);
                if (!room || room.gameState !== 'IN_PROGRESS') return;

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

                const card = room.board[cardIndex];
                if (!card || card.revealed) {
                    socket.emit('guessError', 'اختيار غير صالح.');
                    return;
                }

                // Reveal the card
                card.revealed = true;
                card.pickedBy = player.team;
                room.guessesLeft -= 1;

                let result = card.type;
                let turnOver = false;
                let winnerTeam = null;

                // Check game result
                if (result === 'ASSASSIN') {
                    // Hit assassin - opponent wins immediately
                    winnerTeam = player.team === 'RED' ? 'BLUE' : 'RED';
                    turnOver = true;
                } else if (result !== player.team) {
                    // Wrong guess - turn ends
                    turnOver = true;
                } else if (room.guessesLeft === 0) {
                    // No more guesses - turn ends
                    turnOver = true;
                }
                
                // Check normal win condition
                if (!winnerTeam) {
                    winnerTeam = checkWinCondition(room.board);
                }

                // Save to database
                let game = await Game.findById(room.currentGameId);
                if (game) {
                    game.board = room.board;
                    game.guessesLeft = room.guessesLeft;
                    
                    if (turnOver) {
                        const nextTeam = room.currentTurn === 'RED' ? 'BLUE' : 'RED';
                        room.currentTurn = nextTeam;
                        game.currentTurn = nextTeam;
                        room.clue = null;
                        game.clue = null;
                        room.guessesLeft = 0;
                        game.guessesLeft = 0;
                    }
                    
                    if (winnerTeam) {
                        room.gameState = 'FINISHED';
                        game.gameState = 'FINISHED';
                    }
                    
                    await game.save();
                }

                console.log(`✅ Card revealed: ${card.word} (${result}) by ${player.team}`);

                // Emit events
                io.to(room.code).emit('cardRevealed', { 
                    cardIndex, 
                    card: room.board[cardIndex], 
                    result 
                });
                
                io.to(room.code).emit('gameUpdate', { 
                    board: room.board,
                    guessesLeft: room.guessesLeft,
                    currentTurn: room.currentTurn,
                    clue: room.clue,
                    winner: winnerTeam
                });
                
            } catch (error) {
                console.error('❌ Error making guess:', error);
                socket.emit('guessError', 'فشل التخمين.');
            }
        });
        
        // ====================================
        // END TURN
        // ====================================
        socket.on('endTurn', async () => {
            try {
                const room = getRoom(socket.roomCode);
                if (!room || room.gameState !== 'IN_PROGRESS') return;

                const player = getPlayer(room, socket.id);
                if (!player || !isMyTurn(room, player)) return;

                const nextTeam = room.currentTurn === 'RED' ? 'BLUE' : 'RED';
                room.currentTurn = nextTeam;
                room.clue = null;
                room.guessesLeft = 0;

                let game = await Game.findById(room.currentGameId);
                if (game) {
                    game.currentTurn = nextTeam;
                    game.clue = null;
                    game.guessesLeft = 0;
                    await game.save();
                }

                console.log(`✅ Turn ended by ${player.team}, now ${nextTeam}'s turn`);

                io.to(room.code).emit('gameUpdate', {
                    currentTurn: room.currentTurn,
                    clue: null,
                    guessesLeft: 0
                });
                
            } catch (error) {
                console.error('❌ Error ending turn:', error);
            }
        });

        // ====================================
        // DISCONNECT
        // ====================================
        socket.on('disconnect', async () => {
            try {
                if (!socket.roomCode) return;
                
                const roomCode = socket.roomCode;
                const room = activeRooms[roomCode];

                if (room) {
                    const player = getPlayer(room, socket.id);
                    
                    if (player) {
                        console.log(`❌ ${player.username} disconnected from ${roomCode}`);
                        
                        // Remove player after delay
                        setTimeout(() => {
                            const stillInRoom = room.players.find(p => p.id === socket.id);
                            if (stillInRoom) {
                                room.players = room.players.filter(p => p.id !== socket.id);
                                
                                if (room.players.length === 0) {
                                    delete activeRooms[roomCode];
                                    console.log(`🗑️ Room ${roomCode} deleted (empty)`);
                                } else {
                                    io.to(roomCode).emit('roomUpdate', room.players);
                                    io.to(roomCode).emit('playerLeft', { 
                                        username: player.username 
                                    });
                                }
                            }
                        }, 30000); // 30 seconds grace period
                    }
                }
            } catch (error) {
                console.error('❌ Error on disconnect:', error);
            }
        });
    });
};

// Cleanup old rooms periodically
setInterval(() => {
    const now = Date.now();
    const ROOM_TIMEOUT = 60 * 60 * 1000; // 1 hour
    
    Object.keys(activeRooms).forEach(code => {
        const room = activeRooms[code];
        if (now - room.createdAt > ROOM_TIMEOUT) {
            delete activeRooms[code];
            console.log(`🗑️ Room ${code} deleted (timeout)`);
        }
    });
}, 10 * 60 * 1000); // Check every 10 minutes

module.exports = handleSocketConnections;
