const Game = require('../models/Game');
const Stats = require('../models/Stats');
const { v4: uuidv4 } = require('uuid');
const { initializeGameBoard } = require('./gameSetup');
const { makeAIGuess } = require('../utils/aiGuesser');

const activeRooms = {}; 

// NEW: Constant for disconnection timeout (5 minutes)
const DISCONNECT_TIMEOUT = 5 * 60 * 1000; 

// دوال مساعدة
const getRoom = (roomCode) => roomCode ? activeRooms[roomCode.toUpperCase()] : null;
const getPlayer = (room, socketId) => room ? room.players.find(p => p.id === socketId) : null;
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
    if (!board) return null;
    
    let redRemaining = 0;
    let blueRemaining = 0;

    for (const card of board) {
        if (!card.revealed) {
            if (card.type === 'RED') redRemaining++;
            if (card.type === 'BLUE') blueRemaining++;
        } else if (card.type === 'ASSASSIN') {
            // Check if the assassin was revealed
            return card.revealedBy === 'RED' ? 'BLUE' : 'RED';
        }
    }
    
    if (redRemaining === 0) return 'RED';
    if (blueRemaining === 0) return 'BLUE';
    
    return null;
};

// NEW: Function to handle the actual game start logic
const startGameLogic = async (io, roomCode) => {
    const room = getRoom(roomCode);
    if (!room || room.gameState !== 'WAITING') return false;

    // Check pre-conditions before starting
    const hasEnoughPlayers = room.players.filter(p => p.team && p.role).length >= 4;
    const redSpymaster = room.players.some(p => p.team === 'RED' && p.role === 'SPYMASTER');
    const blueSpymaster = room.players.some(p => p.team === 'BLUE' && p.role === 'SPYMASTER') || room.isAIGame;
    const hasSpymasters = redSpymaster && blueSpymaster;
    const allReady = room.players.every(p => p.isReady && p.isOnline);

    if (!allReady || !hasEnoughPlayers || !hasSpymasters) {
        // Game conditions not met
        return false;
    }

    try {
        const { board, startingTeam } = initializeGameBoard();
        
        // 1. Create Game in DB
        const gameData = {
            roomCode: room.code,
            board: board,
            startingTeam: startingTeam,
            currentTurn: startingTeam,
            turnPhase: 'CLUE_GIVING',
            players: room.players.map(p => ({
                userId: p.userId,
                username: p.username,
                team: p.team,
                role: p.role
            })),
            startTime: new Date()
        };

        const newGame = await Game.create(gameData);
        
        // 2. Update Room State
        room.gameState = 'IN_PROGRESS';
        room.currentTurn = startingTeam;
        room.clue = null;
        room.guessesLeft = 0;
        room.turnPhase = 'CLUE_GIVING';
        room.currentGameId = newGame._id.toString();
        
        // 3. Emit Game Started
        io.to(roomCode).emit('gameStarted', {
            board: board,
            currentTurn: room.currentTurn,
            clue: room.clue,
            guessesLeft: room.guessesLeft,
            turnPhase: room.turnPhase,
            gameState: room.gameState
        });

        console.log(`Game started in room ${roomCode}. Starting team: ${startingTeam}`);

        return true;
    } catch (error) {
        console.error('Error starting game:', error);
        io.to(roomCode).emit('gameError', 'حدث خطأ أثناء بدء اللعبة.');
        return false;
    }
}

// Function to handle AI turn (if applicable)
const handleAITurn = (io, roomCode) => {
    // ... (Existing AI turn logic) ...
    // Placeholder to keep the structure
    console.log(`AI turn started for room ${roomCode}`);
}

const handleSocketConnections = (io) => {
    io.on('connection', (socket) => {
        console.log('New client connected:', socket.id);
        
        const userId = socket.handshake.auth.userId; // Get userId from auth
        if (!userId) {
            socket.disconnect(true);
            return;
        }

        // NEW: RECONNECTION CHECK (for persistence)
        for (const roomCode in activeRooms) {
            const room = activeRooms[roomCode];
            // Find disconnected player
            const player = room.players.find(p => p.userId === userId && !p.isOnline);

            if (player) {
                // Player found: Reconnect logic
                if (player.timeout) clearTimeout(player.timeout); // Clear the removal timer
                
                player.id = socket.id; // Update socket ID
                player.isOnline = true; // Mark as online
                player.disconnectTime = null;
                player.timeout = null;
                
                socket.join(roomCode); // Re-join the socket room
                socket.roomCode = roomCode; // Set room code on the socket

                // Send full room/game state
                if (room.gameState === 'IN_PROGRESS' && room.currentGameId) {
                    Game.findById(room.currentGameId).then(game => {
                        if (game) {
                            // Send necessary game data
                            socket.emit('rejoinGame', { 
                                ...room, 
                                board: game.board,
                                currentTurn: room.currentTurn,
                                turnPhase: room.turnPhase,
                                clue: room.clue,
                                guessesLeft: room.guessesLeft
                            });
                            io.to(roomCode).emit('gameAlert', `انضم ${player.username} مجدداً إلى اللعبة.`);
                        }
                    }).catch(err => console.error("Rejoin Game Fetch Error:", err));
                } else {
                    socket.emit('roomCreated', room); // Send room details
                }
                
                io.to(roomCode).emit('roomUpdate', room.players); // Inform others of status change
                console.log(`Player ${userId} reconnected to room ${roomCode}.`);
                return; // Stop processing and don't try to create/join a new room
            }
        }
        // END RECONNECTION CHECK


        // CREATE ROOM
        socket.on('createRoom', (data) => {
            if (!data.username) return;

            const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
            
            activeRooms[roomCode] = {
                code: roomCode,
                gameState: 'WAITING',
                players: [{ 
                    id: socket.id, 
                    username: data.username, 
                    team: null, 
                    role: null, 
                    userId: data.userId,
                    isReady: false, // NEW
                    isOnline: true, // NEW
                    timeout: null   // NEW
                }],
                isAIGame: false, 
                currentTurn: null,
                clue: null,
                guessesLeft: 0,
                turnPhase: 'CLUE_GIVING',
                currentGameId: null
            };

            socket.join(roomCode);
            socket.roomCode = roomCode;
            
            io.to(roomCode).emit('roomCreated', activeRooms[roomCode]);
            console.log(`Room ${roomCode} created by ${data.username}`);
        });

        // JOIN ROOM
        socket.on('joinRoom', (data) => {
            if (!data.username || !data.roomCode || data.roomCode.length !== 4) return;
            
            const room = getRoom(data.roomCode);
            if (!room) {
                return socket.emit('gameError', 'رمز الغرفة غير صحيح.');
            }
            
            // Check if player with this userId is already in the room (should have been caught by reconnection logic, but as a fallback)
            if (room.players.some(p => p.userId === data.userId)) {
                 return socket.emit('gameError', 'أنت موجود بالفعل في هذه الغرفة.');
            }

            room.players.push({ 
                id: socket.id, 
                username: data.username, 
                team: null, 
                role: null, 
                userId: data.userId,
                isReady: false, // NEW
                isOnline: true, // NEW
                timeout: null   // NEW
            });

            socket.join(room.code);
            socket.roomCode = room.code;
            
            io.to(room.code).emit('roomCreated', room); // Send full room data to the new player
            io.to(room.code).emit('roomUpdate', room.players); // Send player list update to all
            console.log(`Player ${data.username} joined room ${room.code}`);
        });

        // SET TEAM
        socket.on('setTeam', (data) => {
            const room = getRoom(socket.roomCode);
            if (!room || room.gameState !== 'WAITING') return;

            const player = getPlayer(room, socket.id);
            if (!player) return;

            player.team = data.team;
            player.isReady = false; // Reset ready state on team change
            
            io.to(room.code).emit('roomUpdate', room.players);
            console.log(`Player ${player.username} set team to ${data.team}`);
        });

        // SET ROLE
        socket.on('setRole', (data) => {
            const room = getRoom(socket.roomCode);
            if (!room || room.gameState !== 'WAITING') return;

            const player = getPlayer(room, socket.id);
            if (!player) return;

            // Simple role assignment logic: clear the role if already taken by another player
            const existingPlayer = room.players.find(p => p.team === player.team && p.role === data.role);
            if (existingPlayer && existingPlayer.id !== player.id) {
                // If the player who has the role is disconnected, allow the new player to take it
                if (existingPlayer.isOnline === true) {
                    return socket.emit('gameError', `دور ${data.role} في الفريق ${player.team} محجوز بالفعل.`);
                }
            }
            
            // Clear existing role from previous players if they are offline/unselected
            room.players.forEach(p => {
                if (p.team === player.team && p.role === data.role && p.id !== player.id) {
                    p.role = null;
                }
            });

            player.role = data.role;
            player.isReady = false; // Reset ready state on role change
            
            io.to(room.code).emit('roomUpdate', room.players);
            console.log(`Player ${player.username} set role to ${data.role}`);
        });

        // NEW: SET READY
        socket.on('setReady', async (data) => {
            const room = getRoom(socket.roomCode);
            if (!room || room.gameState !== 'WAITING') return;

            const player = getPlayer(room, socket.id);
            if (!player || !player.team || !player.role) {
                socket.emit('gameError', 'يجب اختيار الفريق والدور أولاً.');
                return;
            }

            player.isReady = data.isReady;
            io.to(room.code).emit('roomUpdate', room.players); // Send update to show ready state

            // Attempt to start the game automatically
            await startGameLogic(io, room.code);
        });

        // LEAVE ROOM
        socket.on('leaveRoom', () => {
             // Logic to permanently remove the player from the room (used when clicking the 'leave room' button)
            if (!socket.roomCode) return;
            const room = getRoom(socket.roomCode);
            if (!room) return;
            
            const player = getPlayer(room, socket.id);
            if (player && player.timeout) {
                 clearTimeout(player.timeout); // Clear any pending removal timeout
            }

            room.players = room.players.filter(p => p.id !== socket.id);

            if (room.players.length === 0) {
                delete activeRooms[room.code];
                console.log(`Room ${room.code} closed (empty).`);
            } else {
                io.to(room.code).emit('roomUpdate', room.players);
                socket.emit('roomLeft'); // Inform player they successfully left
                console.log(`Player ${player.username || socket.id} explicitly left room ${room.code}`);
            }
        });


        // GIVE CLUE
        socket.on('giveClue', async (data) => {
            const room = getRoom(socket.roomCode);
            const player = getPlayer(room, socket.id);
            if (!room || !player || room.gameState !== 'IN_PROGRESS' || !isMyTurn(room, player) || !isSpymaster(player) || room.turnPhase !== 'CLUE_GIVING') {
                return socket.emit('gameError', 'ليس دورك لإعطاء تلميح.');
            }
            
            const clueWord = normalizeArabic(data.word);
            const count = parseInt(data.count);

            if (clueWord.split(' ').length > 1 || count < 1 || count > 9) {
                return socket.emit('gameError', 'يجب أن يكون التلميح كلمة واحدة والعدد بين 1 و 9.');
            }
            
            // Check if clue word is on the board
            const game = await Game.findById(room.currentGameId);
            if (game && game.board.some(card => normalizeArabic(card.word) === clueWord)) {
                return socket.emit('gameError', 'لا يمكن استخدام كلمة موجودة على اللوحة كتلميح.');
            }

            room.clue = { word: data.word, count: count };
            room.guessesLeft = count + 1; // N + 1 rule
            room.turnPhase = 'GUESSING';

            await Game.findByIdAndUpdate(room.currentGameId, {
                clue: room.clue,
                guessesLeft: room.guessesLeft,
                turnPhase: room.turnPhase,
                $push: { history: { team: player.team, type: 'CLUE', data: room.clue } }
            });

            io.to(room.code).emit('gameUpdate', {
                clue: room.clue,
                guessesLeft: room.guessesLeft,
                turnPhase: room.turnPhase
            });
            
            console.log(`${player.username} gave clue: ${data.word} (${data.count})`);
            
            // Handle AI turn switch if applicable
            if (room.currentTurn === 'BLUE' && room.isAIGame && room.turnPhase === 'GUESSING') {
                makeAIGuess(io, room.code, room.currentGameId);
            }
        });

        // SELECT CARD
        socket.on('selectCard', async (data) => {
            const room = getRoom(socket.roomCode);
            const player = getPlayer(room, socket.id);
            const cardIndex = data.cardIndex;
            
            if (!room || !player || room.gameState !== 'IN_PROGRESS' || !isMyTurn(room, player) || !isGuesser(player) || room.turnPhase !== 'GUESSING' || room.guessesLeft <= 0) {
                return socket.emit('gameError', 'ليس دورك للتخمين، أو لا يوجد تخمينات متبقية.');
            }

            const game = await Game.findById(room.currentGameId);
            if (!game || cardIndex < 0 || cardIndex >= game.board.length) return;

            let card = game.board[cardIndex];
            if (card.revealed) {
                return socket.emit('gameError', 'هذه البطاقة مكشوفة بالفعل.');
            }

            // 1. Reveal Card
            card.revealed = true;
            card.revealedBy = player.team;
            room.guessesLeft--;

            // 2. Check Card Type & Win Condition
            let endTurn = false;
            let alertMessage = null;
            const opponentTeam = player.team === 'RED' ? 'BLUE' : 'RED';

            if (card.type === 'ASSASSIN') {
                game.winner = opponentTeam;
                room.gameState = 'COMPLETED';
                alertMessage = `💀 قام ${player.username} بتخمين بطاقة القاتل! فاز الفريق ${opponentTeam === 'RED' ? 'الأحمر' : 'الأزرق'}.`;
                endTurn = true;
            } else if (card.type === opponentTeam) {
                alertMessage = `❌ قام ${player.username} بتخمين بطاقة الفريق المنافس!`;
                endTurn = true;
            } else if (card.type === 'NEUTRAL') {
                alertMessage = `⚪ قام ${player.username} بتخمين بطاقة محايدة.`;
                endTurn = true;
            } else { // Correct Team
                alertMessage = `✅ أحسنت ${player.username}! لقد خمنت بطاقة فريقك!`;
                // Turn continues, unless:
                if (room.guessesLeft === 0) {
                    endTurn = true;
                }
            }
            
            // 3. Update Game State / End Turn if needed
            if (endTurn) {
                room.currentTurn = opponentTeam;
                room.clue = null;
                room.guessesLeft = 0;
                room.turnPhase = 'CLUE_GIVING';
                
                if (!game.winner) {
                    // Check for normal win condition (all team cards revealed)
                    game.winner = checkWinCondition(game.board);
                    if (game.winner) {
                        room.gameState = 'COMPLETED';
                    }
                }
            }
            
            // 4. Update DB
            await Game.findByIdAndUpdate(room.currentGameId, {
                board: game.board,
                winner: game.winner,
                currentTurn: room.currentTurn,
                guessesLeft: room.guessesLeft,
                turnPhase: room.turnPhase,
                gameState: room.gameState,
                endTime: room.gameState === 'COMPLETED' ? new Date() : null,
                $push: { history: { team: player.team, type: 'GUESS', data: { card: card.word, cardIndex, result: card.type } } }
            });

            // 5. Emit Updates
            const updatePayload = {
                board: game.board,
                currentTurn: room.currentTurn,
                clue: room.clue,
                guessesLeft: room.guessesLeft,
                turnPhase: room.turnPhase,
                winner: game.winner,
                gameState: room.gameState
            };

            io.to(room.code).emit('gameUpdate', updatePayload);
            if (alertMessage) {
                io.to(room.code).emit('gameAlert', alertMessage);
            }
            
            console.log(`${player.username} selected card ${card.word}. Result: ${card.type}. Guesses left: ${room.guessesLeft}`);

            // 6. Handle AI turn switch if applicable
            if (!game.winner && endTurn && room.currentTurn === 'BLUE' && room.isAIGame) {
                handleAITurn(io, room.code);
            }
        });


        // END TURN
        socket.on('endTurn', async () => {
            const room = getRoom(socket.roomCode);
            const player = getPlayer(room, socket.id);
            if (!room || !player || room.gameState !== 'IN_PROGRESS' || !isMyTurn(room, player) || room.turnPhase !== 'GUESSING') {
                return socket.emit('gameError', 'ليس دورك لإنهاء الدور.');
            }

            try {
                const opponentTeam = player.team === 'RED' ? 'BLUE' : 'RED';
                
                room.currentTurn = opponentTeam;
                room.clue = null;
                room.guessesLeft = 0;
                room.turnPhase = 'CLUE_GIVING';
                
                await Game.findByIdAndUpdate(room.currentGameId, {
                    currentTurn: room.currentTurn,
                    clue: room.clue,
                    guessesLeft: room.guessesLeft,
                    turnPhase: room.turnPhase,
                    $push: { history: { team: player.team, type: 'END_TURN' } }
                });

                io.to(room.code).emit('gameUpdate', {
                    currentTurn: room.currentTurn,
                    clue: null,
                    guessesLeft: 0,
                    turnPhase: 'CLUE_GIVING' 
                });
                io.to(room.code).emit('gameAlert', `${player.username} أنهى دوره طوعاً.`);

                if (room.currentTurn === 'BLUE' && room.isAIGame) {
                    handleAITurn(io, room.code);
                }
            } catch (error) {
                console.error('Error ending turn:', error);
            }
        });

        // DISCONNECT (MODIFIED FOR PERSISTENCE)
        socket.on('disconnect', async () => {
            try {
                if (!socket.roomCode) return;
                
                const roomCode = socket.roomCode;
                const room = activeRooms[roomCode];

                if (room) {
                    const player = room.players.find(p => p.id === socket.id);
                    
                    if (player) {
                        player.isOnline = false; // Mark player as offline
                        player.disconnectTime = Date.now();
                        
                        // Set a timeout to remove the player permanently (5 minutes)
                        player.timeout = setTimeout(() => {
                            // This runs after the timeout expires
                            room.players = room.players.filter(p => p.userId !== player.userId);

                            if (room.players.length === 0) {
                                delete activeRooms[roomCode];
                                console.log(`Room ${roomCode} closed (empty after timeout).`);
                            } else {
                                io.to(roomCode).emit('roomUpdate', room.players);
                                // Alert others if a key player (Spymaster) was removed mid-game
                                if (room.gameState === 'IN_PROGRESS' && player.role === 'SPYMASTER') {
                                    io.to(roomCode).emit('gameAlert', `تمت إزالة القائد ${player.username} نهائياً. دوره أصبح شاغراً.`);
                                }
                                console.log(`Player ${player.userId} permanently left room ${roomCode} after timeout.`);
                            }
                        }, DISCONNECT_TIMEOUT);

                        io.to(roomCode).emit('roomUpdate', room.players); // Inform others of status change
                        console.log(`Player ${player.userId} disconnected from room ${roomCode}. Timeout set.`);
                    }
                }
            } catch (error) {
                console.error('Error on disconnect:', error);
            }
        });
    });
};

module.exports = handleSocketConnections;
