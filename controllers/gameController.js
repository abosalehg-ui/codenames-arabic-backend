const Game = require('../models/Game');
const Stats = require('../models/Stats');
const { v4: uuidv4 } = require('uuid');
const { initializeGameBoard } = require('./gameSetup');
const { makeAIGuess } = require('../utils/aiGuesser');

const activeRooms = {};
const disconnectTimers = {}; // 👈 لإدارة مؤقتات فصل الاتصال المؤقت
const DISCONNECT_TIMEOUT = 300000; // 5 دقائق

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
        }
    }
    
    // الفوز بالنقاط (إذا وصل أحدهم للصفر)
    if (redRemaining === 0) return 'RED';
    if (blueRemaining === 0) return 'BLUE';

    // التحقق من فوز الاغتيال
    const assassinRevealed = board.some(card => card.type === 'ASSASSIN' && card.revealed);
    if (assassinRevealed) {
        // إذا كان الدور الحالي هو الفريق الذي كشف القاتل، يفوز الفريق الآخر
        // (افتراض: لم يتم تضمين logic assassin في gameController الأصلي، لذا نعتمد على نتيجة الكشف في مكان آخر)
        // إذا تم الكشف عن القاتل، اللعبة تنتهي بخسارة الفريق الذي كشفه.
        return null; // سيتم التعامل مع Assassin في مكان آخر عند وقوع الحدث
    }

    return null;
};

// ===============================================
// 🧠 منطق الذكاء الاصطناعي (مقتطف)
// ===============================================
const handleAITurn = (io, roomCode) => {
    const room = getRoom(roomCode);
    if (!room || room.gameState !== 'IN_PROGRESS' || room.currentTurn !== 'BLUE' || !room.isAIGame) return;

    // ... (منطق الذكاء الاصطناعي)
    // هذا الجزء يعتمد على makeAIGuess، نستخدم المنطق الأساسي لتمرير الدور
    
    setTimeout(async () => {
        try {
            if (room.turnPhase === 'CLUE_GIVING') {
                // ... (منطق إعطاء تلميح من الذكاء الاصطناعي) ...
                
                // مثال على إعطاء تلميح بسيط
                room.clue = 'كلمة';
                room.guessesLeft = 1;
                room.turnPhase = 'GUESSING';
                
                io.to(room.code).emit('gameUpdate', {
                    board: room.board,
                    currentTurn: room.currentTurn,
                    turnPhase: room.turnPhase,
                    clue: room.clue,
                    guessesLeft: room.guessesLeft
                });
                
                // الانتقال إلى دور التخمين للذكاء الاصطناعي
                handleAITurn(io, roomCode); 

            } else if (room.turnPhase === 'GUESSING') {
                // ... (منطق تخمين الذكاء الاصطناعي) ...
                
                // مثال على تمرير الدور
                // makeAIGuess(room.board, room.clue, room.guessesLeft, 'BLUE');
                
                // تمرير الدور بعد التخمين الافتراضي
                room.currentTurn = 'RED';
                room.turnPhase = 'CLUE_GIVING';
                room.clue = null;
                room.guessesLeft = 0;

                io.to(room.code).emit('gameUpdate', {
                    currentTurn: room.currentTurn,
                    clue: null,
                    guessesLeft: 0,
                    turnPhase: 'CLUE_GIVING' 
                });
            }
        } catch (error) {
            console.error('Error in AI Turn:', error);
        }
    }, 2000); // تأخير لمحاكاة التفكير
};


const handleSocketConnections = (io) => {
    
    io.on('connection', (socket) => {
        console.log('New client connected:', socket.id);
        
        // 🚨 معالجة إعادة الانضمام إلى لعبة نشطة
        socket.on('rejoinGame', async (data) => {
            const { roomCode, userId: incomingUserId } = data;
            const room = getRoom(roomCode);
            if (!room) return socket.emit('roomError', 'الغرفة غير موجودة');

            // إيجاد اللاعب المنفصل باستخدام userId الثابت
            const player = room.players.find(p => p.userId === incomingUserId);
            if (player) {
                
                // 1. إيقاف مؤقت الانفصال
                if (disconnectTimers[player.userId]) {
                    clearTimeout(disconnectTimers[player.userId]);
                    delete disconnectTimers[player.userId];
                }

                // 2. تحديث الـ socket.id وحالة اللاعب
                player.id = socket.id;
                player.isDisconnected = false; // إعادة اللاعب للحالة المتصلة
                socket.roomCode = roomCode;
                socket.join(roomCode);

                console.log(`Player ${player.username} reconnected to room ${roomCode}`);
                
                // 3. إرسال حالة الغرفة واللعبة الحالية للاعب العائد
                io.to(roomCode).emit('roomUpdate', room.players); // إبلاغ الجميع بالعودة
                socket.emit('joinedRoom', room); 
                
                if (room.gameState === 'IN_PROGRESS' && room.currentGameId) {
                     // إرسال حالة اللعبة إذا كانت جارية
                     const game = await Game.findById(room.currentGameId);
                     if (game) {
                         socket.emit('gameStarted', { 
                             board: room.board,
                             currentTurn: room.currentTurn,
                             turnPhase: room.turnPhase,
                             clue: room.clue,
                             guessesLeft: room.guessesLeft,
                             players: room.players
                         });
                     }
                }
            } else {
                 socket.emit('roomError', 'فشل في إعادة الربط: اللاعب غير موجود في الغرفة');
            }
        });
        
        // CREATE ROOM
        socket.on('createRoom', (data) => {
            const roomCode = uuidv4().substring(0, 4).toUpperCase();
            socket.roomCode = roomCode;
            socket.join(roomCode);

            activeRooms[roomCode] = {
                code: roomCode,
                gameState: 'WAITING',
                players: [{ 
                    id: socket.id, 
                    username: data.username || 'لاعب', 
                    team: null, 
                    role: null, 
                    userId: data.userId, // 👈 الحفاظ على userId
                    isReady: false,      // 👈 إضافة حالة الجاهزية
                    isDisconnected: false // 👈 إضافة حالة الانفصال
                }],
                board: [],
                turnPhase: 'CLUE_GIVING',
                currentTurn: 'RED',
                clue: null,
                guessesLeft: 0,
                winner: null,
                isAIGame: data.isAIGame || false,
                currentGameId: null,
            };

            socket.emit('joinedRoom', activeRooms[roomCode]);
            io.to(roomCode).emit('roomUpdate', activeRooms[roomCode].players);
            console.log(`Room ${roomCode} created by ${data.username}`);
        });

        // JOIN ROOM (تعديل مماثل لإضافة isReady و isDisconnected)
        socket.on('joinRoom', (data) => {
            const roomCode = data.roomCode.toUpperCase();
            const room = getRoom(roomCode);

            if (room) {
                if (room.gameState !== 'WAITING') {
                    return socket.emit('roomError', 'لا يمكن الانضمام، اللعبة جارية. حاول إعادة الاتصال.');
                }
                
                // التأكد من عدم وجود userId مكرر بالفعل
                const existingPlayer = room.players.find(p => p.userId === data.userId);
                if (existingPlayer) {
                    // إذا كان اللاعب موجوداً بالفعل (لكنه لم يخرج بالكامل)، حاول ربطه مجدداً
                    return socket.emit('reconnectRequired', { roomCode, userId: data.userId });
                }

                socket.roomCode = roomCode;
                socket.join(roomCode);

                const newPlayer = {
                    id: socket.id,
                    username: data.username || 'لاعب',
                    team: null,
                    role: null,
                    userId: data.userId, // 👈 الحفاظ على userId
                    isReady: false,      // 👈 إضافة حالة الجاهزية
                    isDisconnected: false
                };
                room.players.push(newPlayer);

                socket.emit('joinedRoom', room);
                io.to(roomCode).emit('roomUpdate', room.players);
                console.log(`Player ${data.username} joined room ${roomCode}`);

            } else {
                socket.emit('roomError', 'رمز الغرفة غير صحيح أو الغرفة غير موجودة.');
            }
        });

        // SET TEAM & ROLE
        socket.on('setTeamAndRole', (data) => {
            const room = getRoom(socket.roomCode);
            const player = getPlayer(room, socket.id);

            if (room && player && room.gameState === 'WAITING') {
                const { team, role } = data;
                
                // التحقق من صلاحية الدور والفريق
                if (role !== 'SPYMASTER' && role !== 'GUESSER') return;
                if (team !== 'RED' && team !== 'BLUE') return;

                // منع اختيار قائد مكرر (باستثناء وضع الذكاء الاصطناعي)
                const isRoleTaken = room.players.some(p => p.team === team && p.role === role && p.id !== socket.id);
                if (isRoleTaken && role === 'SPYMASTER' && !room.isAIGame) {
                    return socket.emit('roomError', 'هذا الدور (القائد) مأخوذ بالفعل في هذا الفريق.');
                }
                
                player.team = team;
                player.role = role;
                player.isReady = false; // إزالة الجاهزية عند تغيير الدور/الفريق

                io.to(room.code).emit('roomUpdate', room.players);
            }
        });
        
        // 🚨 إضافة معالجة "جاهز" للبدء التلقائي
        socket.on('playerReady', async (data) => {
            const room = getRoom(socket.roomCode);
            const player = getPlayer(room, socket.id);

            if (!room || !player || room.gameState !== 'WAITING') return;

            // تحديث حالة الجاهزية
            player.isReady = data.isReady;
            io.to(room.code).emit('roomUpdate', room.players);

            // التحقق من شروط بدء اللعبة تلقائياً
            const playersWithRoles = room.players.filter(p => p.team && p.role);
            // الجميع اختار دوراً وفريقاً وجاهزون
            const allRequiredPlayersReady = playersWithRoles.length > 0 && 
                                           playersWithRoles.length === room.players.length && 
                                           playersWithRoles.every(p => p.isReady);
            
            // تحقق من وجود قائد لكل فريق
            const redSpymaster = room.players.some(p => p.team === 'RED' && p.role === 'SPYMASTER') || room.isAIGame;
            const blueSpymaster = room.players.some(p => p.team === 'BLUE' && p.role === 'SPYMASTER') || room.isAIGame;
            
            // إذا كان الكل جاهزاً والأدوار الأساسية موجودة: ابدأ اللعبة
            if (allRequiredPlayersReady && redSpymaster && blueSpymaster) {
                try {
                    const gameData = initializeGameBoard(); // إنشاء لوحة لعب جديدة

                    room.board = gameData.board;
                    room.currentTurn = gameData.startingTeam; // الفريق البادئ
                    room.turnPhase = 'CLUE_GIVING';
                    room.clue = null;
                    room.guessesLeft = 0;
                    room.winner = null;
                    room.gameState = 'IN_PROGRESS';
                    
                    // حفظ اللعبة في قاعدة البيانات (كما كان موجوداً في الكود الأصلي)
                    const newGame = await Game.create({
                        roomCode: room.code,
                        players: room.players.map(p => ({ userId: p.userId, username: p.username, team: p.team, role: p.role })),
                        board: room.board,
                        startingTeam: room.currentTurn
                    });
                    room.currentGameId = newGame._id;

                    console.log(`Game started in room ${room.code}`);
                    io.to(room.code).emit('gameStarted', {
                        board: room.board,
                        currentTurn: room.currentTurn,
                        turnPhase: room.turnPhase,
                        clue: room.clue,
                        guessesLeft: room.guessesLeft,
                        players: room.players
                    });

                    // إذا كان الدور لفريق الذكاء الاصطناعي
                    if (room.currentTurn === 'BLUE' && room.isAIGame) {
                        handleAITurn(io, room.code);
                    }

                } catch (error) {
                    console.error('Error starting game automatically:', error);
                    io.to(room.code).emit('gameError', 'فشل بدء اللعبة تلقائياً.');
                }
            }
        });

        // GIVE CLUE
        socket.on('giveClue', async (data) => {
            const room = getRoom(socket.roomCode);
            const player = getPlayer(room, socket.id);
            
            if (!room || !player || room.gameState !== 'IN_PROGRESS' || !isSpymaster(player) || !isMyTurn(room, player) || room.turnPhase !== 'CLUE_GIVING') {
                return socket.emit('gameError', 'ليس دورك لإعطاء تلميح.');
            }
            
            const clueWord = normalizeArabic(data.word.trim());
            const clueCount = parseInt(data.count, 10);

            // التحقق من صلاحية التلميح (الكلمة والعدد)
            if (!clueWord || clueWord.split(/\s+/).length > 1 || clueWord.length < 2) {
                return socket.emit('gameError', 'يجب أن يكون التلميح كلمة واحدة وصالحة.');
            }
            if (clueCount < 1 || clueCount > 9) {
                return socket.emit('gameError', 'يجب أن يكون العدد بين 1 و 9.');
            }

            // منع استخدام كلمة تلميح مكررة أو كلمة موجودة في اللوحة (نحتاج إلى قائمة الكلمات في اللوحة)
            const isBoardWord = room.board.some(card => normalizeArabic(card.word) === clueWord);
            if (isBoardWord) {
                 return socket.emit('gameError', 'لا يمكن استخدام كلمة موجودة في اللوحة كتلميح.');
            }

            room.clue = clueWord;
            room.guessesLeft = clueCount + 1; // +1 لجعلها (العدد الأصلي + تخمين إضافي)
            room.turnPhase = 'GUESSING';

            io.to(room.code).emit('gameUpdate', {
                turnPhase: room.turnPhase,
                clue: room.clue,
                guessesLeft: room.guessesLeft
            });
        });

        // MAKE GUESS
        socket.on('makeGuess', async (data) => {
            const room = getRoom(socket.roomCode);
            const player = getPlayer(room, socket.id);
            
            if (!room || !player || room.gameState !== 'IN_PROGRESS' || !isGuesser(player) || !isMyTurn(room, player) || room.turnPhase !== 'GUESSING' || room.guessesLeft <= 0) {
                return socket.emit('gameError', 'ليس دورك للتخمين أو لا توجد تخمينات متبقية.');
            }
            
            const cardIndex = data.cardIndex;
            const card = room.board[cardIndex];

            if (!card || card.revealed) {
                return socket.emit('gameError', 'هذه البطاقة مكشوفة بالفعل.');
            }

            card.revealed = true;
            room.guessesLeft--;
            
            let endTurn = false;
            let winner = checkWinCondition(room.board);

            if (card.type === 'ASSASSIN') {
                winner = (player.team === 'RED' ? 'BLUE' : 'RED'); // يفوز الفريق الآخر
                endTurn = true;
            } else if (card.type !== player.team) {
                // تخمين خاطئ (محايد أو فريق الخصم)
                endTurn = true;
                // إذا خمن كلمة الخصم (لونه) فإنه يكشفها للخصم وينهي دوره
                if (card.type !== 'NEUTRAL') {
                    // إذا خمن كلمة الفريق الآخر، يتم احتسابها كنقطة لهم
                    // (هذا يعتمد على طريقة لعبك، لكن المنطق القياسي ينهي دورك)
                }
            } else {
                // تخمين صحيح (لونه)
                if (room.guessesLeft === 1 && card.type === player.team) {
                    // إذا كشف آخر كلمة له، يتبقى له التخمين الإضافي
                    // لا يتم إنهاء الدور تلقائيًا، يمكنه التمرير أو التخمين
                }
                
                // التحقق من الفوز بعد التخمين الصحيح
                winner = checkWinCondition(room.board);
            }
            
            // تحقق من الفوز بعد التخمين
            if (winner) {
                room.winner = winner;
                room.gameState = 'ENDED';
                io.to(room.code).emit('gameEnded', { winner: room.winner, board: room.board });
                return;
            }

            // إذا انتهى الدور (تخمين خاطئ أو قاتل أو نفاد التخمينات)
            if (endTurn || room.guessesLeft === 0) {
                room.currentTurn = (room.currentTurn === 'RED' ? 'BLUE' : 'RED');
                room.turnPhase = 'CLUE_GIVING';
                room.clue = null;
                room.guessesLeft = 0;
            }
            
            io.to(room.code).emit('gameUpdate', {
                board: room.board,
                currentTurn: room.currentTurn,
                turnPhase: room.turnPhase,
                clue: room.clue,
                guessesLeft: room.guessesLeft
            });

            // إذا انتهى الدور للفريق وكان الدور الجديد هو الذكاء الاصطناعي
            if (room.currentTurn === 'BLUE' && room.isAIGame) {
                handleAITurn(io, room.code);
            }
        });

        // PASS TURN
        socket.on('passTurn', async () => {
            const room = getRoom(socket.roomCode);
            const player = getPlayer(room, socket.id);

            if (!room || !player || room.gameState !== 'IN_PROGRESS' || !isGuesser(player) || !isMyTurn(room, player) || room.turnPhase !== 'GUESSING') {
                return socket.emit('gameError', 'ليس دورك لتمرير الدور.');
            }

            try {
                room.currentTurn = (room.currentTurn === 'RED' ? 'BLUE' : 'RED');
                room.turnPhase = 'CLUE_GIVING';
                room.clue = null;
                room.guessesLeft = 0;

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

        // 🚨 تعديل: معالج DISCONNECT مع مؤقت الـ 5 دقائق (المشكلة 6)
        socket.on('disconnect', async () => {
            try {
                if (!socket.roomCode) return;
                
                const roomCode = socket.roomCode;
                const room = activeRooms[roomCode];

                if (room) {
                    const player = room.players.find(p => p.id === socket.id);
                    if (player) {
                        // 1. وضع علامة الانفصال بدلاً من الحذف
                        player.isDisconnected = true;
                        
                        // إرسال التحديث للجميع (لتظهر علامة الانفصال)
                        io.to(roomCode).emit('roomUpdate', room.players); 
                        console.log(`Player ${player.userId} disconnected. Starting 5-min timer.`);
                        
                        // 2. بدأ مؤقت الـ 5 دقائق للحذف النهائي
                        disconnectTimers[player.userId] = setTimeout(async () => {
                            // التحقق مجدداً في حال قام بتحديث الصفحة
                            const stillDisconnected = room.players.find(p => p.userId === player.userId && p.isDisconnected);
                            
                            if (stillDisconnected) {
                                // إزالة اللاعب من قائمة اللاعبين
                                room.players = room.players.filter(p => p.userId !== player.userId);
                                
                                // إيقاف اللعبة وحذف الغرفة إذا أصبحت فارغة
                                if (room.players.length === 0) {
                                    delete activeRooms[roomCode];
                                    console.log(`Room ${roomCode} closed (empty after timeout).`);
                                } else {
                                    io.to(roomCode).emit('roomUpdate', room.players);
                                    console.log(`Player ${player.userId} removed after timeout.`);
                                }
                            }
                            delete disconnectTimers[player.userId]; // حذف المؤقت
                        }, DISCONNECT_TIMEOUT); 

                    }
                }
            } catch (error) {
                console.error('Error on disconnect:', error);
            }
        });
    });
};

module.exports = handleSocketConnections;
