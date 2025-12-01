const Game = require('../models/Game');
const Stats = require('../models/Stats'); // لاستخدامه في تحديث الإحصائيات عند الفوز
const { v4: uuidv4 } = require('uuid');
const { initializeGameBoard } = require('./gameSetup');
const { makeAIGuess } = require('../utils/aiGuesser'); // المخمن الآلي

// قائمة الغرف النشطة في الذاكرة (لتجنب البحث المتكرر في DB)
const activeRooms = {}; 

// دوال مساعدة
const getRoom = (roomCode) => activeRooms[roomCode.toUpperCase()];
const getPlayer = (room, socketId) => room.players.find(p => p.id === socketId);
const isSpymaster = (player) => player && player.role === 'SPYMASTER';
const isGuesser = (player) => player && player.role === 'GUESSER';
const isMyTurn = (room, player) => player && room.currentTurn === player.team;
const normalizeArabic = (text) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي');


// ----------------------------------------------------
// منطق التحقق من الفوز
// ----------------------------------------------------
const checkWinCondition = (board) => {
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

// ----------------------------------------------------
// دالة مساعدة لتحديث الإحصائيات (لم يتم تنفيذها بالكامل، مجرد هيكل)
// ----------------------------------------------------
const saveStats = async (game, winnerTeam) => {
    // يمكن تنفيذ منطق تحديث الفوز/الخسارة هنا
    // مثال: تحديث سجلات Stats لكل لاعب في الغرفة
    // if (winnerTeam) { ... }
};

// ----------------------------------------------------
// دالة معالجة دور الذكاء الاصطناعي (AI)
// ----------------------------------------------------
const handleAITurn = (io, roomCode) => {
    const room = getRoom(roomCode);
    if (!room || room.gameState !== 'IN_PROGRESS' || room.currentTurn !== 'BLUE') return;

    // محاكاة تأخير بسيط للواقعية
    setTimeout(async () => {
        let game = await Game.findById(room.currentGameId);
        if (!game) return;

        // القائد الآلي يعطي تلميحاً وهمياً بـ 9 محاولات
        room.clue = "كلمة_آلية"; 
        room.guessesLeft = 9 + 1;
        
        io.to(room.code).emit('clueGiven', { clue: room.clue, count: 9, team: 'BLUE' });
        io.to(room.code).emit('gameUpdate', { 
            clue: room.clue, 
            guessesLeft: room.guessesLeft,
            turnPhase: 'GUESSING' 
        });

        // 1. محاكاة التخمينات المتتالية للـ AI
        while (room.guessesLeft > 0 && room.currentTurn === 'BLUE' && room.gameState === 'IN_PROGRESS') {
            
            const aiDecision = makeAIGuess(room.board, room.currentTurn, room.guessesLeft);
            
            if (aiDecision.action === 'END_TURN') {
                break; // ينهي الدور
            } else if (aiDecision.action === 'GUESS') {
                const cardIndex = aiDecision.cardIndex;
                const card = room.board[cardIndex];

                if (card.revealed) break; // للتأكد فقط

                card.revealed = true;
                card.pickedBy = room.currentTurn; // 'BLUE'
                room.guessesLeft -= 1;
                let result = card.type;
                let turnOver = false;
                let winnerTeam = checkWinCondition(room.board);

                // تحديد ما إذا كان الدور ينتهي
                if (result === 'ASSASSIN') {
                    winnerTeam = 'RED'; 
                } else if (result !== room.currentTurn) {
                    turnOver = true; // اختار مدنية أو حمراء
                } else if (room.guessesLeft === 0) {
                    turnOver = true; // انتهت المحاولات المتاحة
                }
                
                // تحديث حالة اللعبة
                game.board = room.board;
                game.guessesLeft = room.guessesLeft;

                // بث النتائج
                io.to(room.code).emit('cardRevealed', { cardIndex, card: room.board[cardIndex], result });
                
                if (turnOver) {
                    room.currentTurn = 'RED'; // تبديل الدور
                    room.clue = null;
                    game.currentTurn = 'RED';
                    game.clue = null;
                }
                
                if (winnerTeam) {
                    room.gameState = 'FINISHED';
                    game.gameState = 'FINISHED';
                    // saveStats(game, winnerTeam);
                }

                await game.save();

                io.to(room.code).emit('gameUpdate', { 
                    guessesLeft: room.guessesLeft,
                    currentTurn: room.currentTurn,
                    turnPhase: turnOver ? 'CLUE_GIVING' : 'GUESSING',
                    winner: winnerTeam,
                });
                
                if (turnOver || winnerTeam) break; // إنهاء حلقة التخمين
                await new Promise(resolve => setTimeout(resolve, 1500)); 
            }
        }
    }, 1000); // تأخير بدء دور الـ AI
};

// ----------------------------------------------------
// الدالة الرئيسية لمعالجة اتصالات Socket.io
// ----------------------------------------------------
const handleSocketConnections = (io) => {
    
    io.on('connection', (socket) => {
        
        // ... (1. CREATE ROOM - منطق إنشاء الغرفة)
        socket.on('createRoom', async (data) => {
            const roomCode = (data.customName || uuidv4().substring(0, 6).toUpperCase());
            if (activeRooms[roomCode]) { socket.emit('roomError', 'هذا الكود مستخدم مسبقاً.'); return; }

            socket.join(roomCode);
            activeRooms[roomCode] = {
                code: roomCode,
                players: [{ id: socket.id, username: data.username, team: null, role: null, userId: data.userId }],
                gameState: 'WAITING',
                isAIGame: data.isAIGame || false, // تحديد ما إذا كانت اللعبة ضد AI
                history: []
            };
            socket.roomCode = roomCode;
            
            socket.emit('roomCreated', activeRooms[roomCode]);
            io.to(roomCode).emit('roomUpdate', activeRooms[roomCode].players);
        });

        // ... (2. JOIN ROOM - منطق الانضمام للغرفة)
        socket.on('joinRoom', async (data) => {
            const roomCode = data.roomCode.toUpperCase();
            const room = getRoom(roomCode);

            if (!room) { socket.emit('roomError', 'الغرفة غير موجودة أو انتهت.'); return; }
            if (room.gameState !== 'WAITING') { socket.emit('roomError', 'لا يمكن الانضمام، اللعبة قيد التقدم.'); return; }

            socket.join(roomCode);
            room.players.push({ id: socket.id, username: data.username, team: null, role: null, userId: data.userId });
            socket.roomCode = roomCode; 
            
            io.to(roomCode).emit('roomUpdate', room.players);
        });
        
        // ... (3. SET ROLE - منطق اختيار الدور)
        socket.on('setRole', (data) => {
            const room = getRoom(socket.roomCode);
            if (!room) return;

            const { team, role } = data;
            const player = getPlayer(room, socket.id);

            const isRoleTaken = room.players.some(p => p.team === team && p.role === role && p.id !== socket.id);

            if (isRoleTaken && role === 'SPYMASTER') {
                socket.emit('roleError', `فريق ${team === 'RED' ? 'الأحمر' : 'الأزرق'} لديه قائد بالفعل.`);
                return;
            }

            if (player) {
                player.team = team;
                player.role = role;
                io.to(room.code).emit('roomUpdate', room.players);
            }
        });

        // ... (4. START GAME - منطق بدء اللعبة)
        socket.on('startGame', async () => {
            const room = getRoom(socket.roomCode);
            if (!room) return;
            
            const redSpymaster = room.players.some(p => p.team === 'RED' && p.role === 'SPYMASTER');
            const blueSpymaster = room.players.some(p => p.team === 'BLUE' && p.role === 'SPYMASTER') || room.isAIGame;

            if (!redSpymaster || !blueSpymaster) {
                socket.emit('gameError', 'يجب أن يكون هناك قائد أحمر وقائد أزرق لبدء اللعبة.');
                return;
            }

            const gameData = initializeGameBoard(); 
            
            const newGame = await Game.create({
                roomCode: room.code,
                board: gameData.board,
                currentTurn: gameData.currentTurn,
                firstTeam: gameData.firstTeam,
                players: room.players.map(p => ({
                    socketId: p.id, userId: p.userId, username: p.username, team: p.team, role: p.role
                })),
                gameState: 'IN_PROGRESS',
            });
            
            room.gameState = 'IN_PROGRESS';
            room.currentGameId = newGame._id;
            room.board = newGame.board; // حفظ اللوحة في الذاكرة لتسهيل الوصول
            room.currentTurn = newGame.currentTurn;

            io.to(room.code).emit('gameStarted', {
                ...newGame.toObject(),
                players: room.players 
            });
            
            // 🚨 إذا كان الفريق البادئ هو AI، ابدأ دوره مباشرة
            if (room.isAIGame && room.currentTurn === 'BLUE') {
                handleAITurn(io, room.code);
            }
        });
        
        // ... (5. GIVE CLUE - منطق إعطاء التلميح)
        socket.on('giveClue', async (data) => {
            const room = getRoom(socket.roomCode);
            if (!room || room.gameState !== 'IN_PROGRESS' || room.currentTurn === 'BLUE') return; // AI لا يعطي تلميحات هنا

            const player = getPlayer(room, socket.id);
            const { clue, count } = data; 

            if (!player || !isSpymaster(player) || !isMyTurn(room, player)) {
                socket.emit('clueError', 'ليس دورك أو ليس مسموحاً لك بإعطاء تلميح.');
                return;
            }
            
            const normalizedClue = normalizeArabic(clue);
            const isClueOnBoard = room.board.some(card => normalizeArabic(card.word) === normalizedClue);
            
            if (isClueOnBoard) {
                socket.emit('clueError', 'لا يمكن استخدام كلمة موجودة على لوح اللعب كتلميح.');
                return;
            }

            room.clue = clue;
            room.guessesLeft = count + 1; 

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
        });


        // ... (6. MAKE GUESS - منطق التخمين)
        socket.on('makeGuess', async (data) => {
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

            // 🚨 تحديد ما إذا كان الدور ينتهي
            if (result === 'ASSASSIN') {
                winnerTeam = (player.team === 'RED') ? 'BLUE' : 'RED';
                turnOver = true; 
            } else if (result !== player.team) {
                turnOver = true; // اختار كلمة مدنية أو كلمة الخصم
            } else if (room.guessesLeft === 0) {
                turnOver = true; // انتهت المحاولات
            }

            // 7. تحديث قاعدة البيانات
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
                // saveStats(game, winnerTeam);
            }

            await game.save();

            // 8. بث النتائج للجميع
            io.to(room.code).emit('cardRevealed', { cardIndex, card: room.board[cardIndex], result });
            io.to(room.code).emit('gameUpdate', { 
                guessesLeft: room.guessesLeft,
                currentTurn: room.currentTurn,
                turnPhase: turnOver ? 'CLUE_GIVING' : 'GUESSING',
                winner: winnerTeam,
            });
            
            // 🚨 إذا تم تبديل الدور إلى AI، ابدأ دوره
            if (turnOver && room.currentTurn === 'BLUE' && room.isAIGame) {
                handleAITurn(io, room.code);
            }
        });
        
        // ... (7. END TURN - إنهاء الدور يدوياً)
        socket.on('endTurn', async () => {
            const room = getRoom(socket.roomCode);
            if (!room || room.gameState !== 'IN_PROGRESS') return;

            const player = getPlayer(room, socket.id);
            if (!player || (!isGuesser(player) && !isSpymaster(player)) || !isMyTurn(room, player)) return;

            // تبديل الدور
            const nextTeam = room.currentTurn === 'RED' ? 'BLUE' : 'RED';
            room.currentTurn = nextTeam;
            room.clue = null;
            room.guessesLeft = 0; 

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

            // 🚨 إذا تم تبديل الدور إلى AI، ابدأ دوره
            if (room.currentTurn === 'BLUE' && room.isAIGame) {
                handleAITurn(io, room.code);
            }
        });

        // ... (8. DISCONNECT - عند قطع الاتصال)
        socket.on('disconnect', async () => {
            if (!socket.roomCode) return;
            
            const roomCode = socket.roomCode;
            const room = activeRooms[roomCode];

            if (room) {
                room.players = room.players.filter(p => p.id !== socket.id);
                
                if (room.players.length === 0) {
                    delete activeRooms[roomCode];
                    console.log(`Room ${roomCode} closed.`);
                } else {
                    io.to(roomCode).emit('roomUpdate', room.players);
                }
            }
        });
    });
};

module.exports = handleSocketConnections;