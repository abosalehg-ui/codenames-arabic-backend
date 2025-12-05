const Game = require('../models/Game');
const Stats = require('../models/Stats');
const { v4: uuidv4 } = require('uuid');
const { initializeGameBoard } = require('./gameSetup');
const { makeAIGuess } = require('../utils/aiGuesser');

const activeRooms = {}; 

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

// ===============================================
// ✅ منطق الجاهزية - الإضافات الجديدة
// ===============================================

// دالة مساعدة: التحقق من اكتمال الأدوار الأربعة المطلوبة
const areAllRolesFilled = (room) => {
    // تتطلب 4 أدوار بحد أدنى: قائد أحمر، مخمن أحمر، قائد أزرق، مخمن أزرق
    let redSpymaster = false;
    let redGuesser = false;
    // إذا كانت لعبة AI، فالقائد الأزرق يعتبر ممتلئاً
    let blueSpymaster = room.isAIGame || false; 
    let blueGuesser = false;

    for (const p of room.players) {
        if (p.team === 'RED' && p.role === 'SPYMASTER') redSpymaster = true;
        if (p.team === 'RED' && p.role === 'GUESSER') redGuesser = true;
        if (p.team === 'BLUE' && p.role === 'SPYMASTER') blueSpymaster = true;
        if (p.team === 'BLUE' && p.role === 'GUESSER') blueGuesser = true;
    }

    return redSpymaster && redGuesser && blueSpymaster && blueGuesser;
};

// دالة مساعدة: التحقق من جاهزية جميع اللاعبين الذين اختاروا دوراً
const areAllPlayersWithRolesReady = (room) => {
    // نعتبر فقط اللاعبين الذين اختاروا فريقاً ودوراً (بما في ذلك قائد AI الأزرق إذا كانت اللعبة AI)
    const playersWithRoles = room.players.filter(p => p.team && p.role);
    
    // إذا لم يكن هناك لاعبون بأدوار، لا يمكن بدء اللعبة
    if (playersWithRoles.length === 0) return false;
    
    // التحقق مما إذا كان كل لاعب لديه دور 'جاهز' (isReady === true)
    return playersWithRoles.every(p => p.isReady === true);
};

// دالة مساعدة: التحقق من جاهزية الغرفة لبدء اللعبة
const isRoomFullyReady = (room) => {
    return areAllRolesFilled(room) && areAllPlayersWithRolesReady(room);
};

// ===============================================
// 🔚 نهاية منطق الجاهزية
// ===============================================

// منطق التحقق من الفوز
const checkWinCondition = (board) => {
    if (!board) return null;
    
    let redRemaining = 0;
    let blueRemaining = 0;
    let assassinFound = false;

    for (const card of board) {
        if (!card.revealed) {
            if (card.type === 'RED') redRemaining++;
            if (card.type === 'BLUE') blueRemaining++;
        } else if (card.type === 'ASSASSIN') {
            assassinFound = true;
            return card.lastGuessedBy === 'RED' ? 'BLUE' : 'RED'; // الفائز هو الفريق الآخر
        }
    }

    if (redRemaining === 0) return 'RED';
    if (blueRemaining === 0) return 'BLUE';
    
    return null;
};

// منطق الدور الآلي
const handleAITurn = async (io, roomCode) => {
    const room = getRoom(roomCode);
    if (!room || room.gameState !== 'IN_PROGRESS' || room.currentTurn !== 'BLUE' || !room.isAIGame) return;
    
    // هذا مجرد نموذج مبسط لدور الـ AI
    // في لعبة Code Names، يجب أن يكون هناك منطق لإعطاء تلميح والتخمين
    
    // 1. منطق إعطاء التلميح (SPYMASTER)
    // لا يتطلب في هذه الحالة إذا كان الـ AI هو المخمن فقط أو اللعبة لا تدعم AI Spymaster
    
    // 2. منطق التخمين (GUESSER)
    // ننتظر قليلاً لمحاكاة التفكير
    await new Promise(resolve => setTimeout(resolve, 1500)); 

    const result = makeAIGuess(room.board, room.currentTurn); // افتراض وجود دالة AI متقدمة
    
    if (result && result.word) {
        // نبعث حدث تخمين الـ AI
        io.to(roomCode).emit('aiClueGiven', {
             clue: { word: 'كلمة_آلية', count: result.maxGuesses || 1 },
             guesserName: 'الذكاء الاصطناعي',
             guessesLeft: result.maxGuesses || 1
        });
        
        await new Promise(resolve => setTimeout(resolve, 1000)); 
        
        // ثم نبعث التخمين
        socket.to(roomCode).emit('aiGuessWord', { word: result.word }); 
        
    } else {
         // إذا لم يتمكن الـ AI من التخمين، يقوم بإنهاء دوره
         socket.to(roomCode).emit('aiEndTurn');
    }
    
    // (يجب أن يتم معالجة التخمينات داخل معالج 'guessWord' الموجود في الكود الأصلي)
};

const handleSocketConnections = (io) => {
    io.on('connection', (socket) => {
        
        // CREATE ROOM
        socket.on('createRoom', (data) => {
            const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
            
            // تهيئة الغرفة
            activeRooms[roomCode] = {
                code: roomCode,
                players: [],
                gameState: 'WAITING', // انتظار اللاعبين
                currentTurn: null,
                board: [],
                clue: null,
                guessesLeft: 0,
                turnPhase: 'CLUE_GIVING',
                isAIGame: data.isAIGame || false,
                currentGameId: null
            };
            
            socket.roomCode = roomCode;
            socket.join(roomCode);
            
            // إضافة اللاعب بتهيئة حالة الجاهزية
            const newPlayer = {
                id: socket.id,
                userId: data.userId || uuidv4(),
                username: data.username || `Player${Math.floor(Math.random() * 100)}`,
                team: null,
                role: null,
                isConnected: true,
                isReady: false // 🆕 تهيئة حالة الجاهزية 
            };
            activeRooms[roomCode].players.push(newPlayer);

            socket.emit('roomCreated', roomCode);
            io.to(roomCode).emit('roomUpdate', activeRooms[roomCode].players);
            console.log(`Room ${roomCode} created by ${newPlayer.username}.`);
        });

        // JOIN ROOM
        socket.on('joinRoom', (data) => {
            const roomCode = data.roomCode.toUpperCase();
            const room = getRoom(roomCode);

            if (!room) {
                socket.emit('roomError', 'الغرفة غير موجودة.');
                return;
            }
            if (room.gameState !== 'WAITING') {
                 socket.emit('roomError', 'لا يمكن الانضمام، اللعبة قيد التنفيذ.');
                 return;
            }

            // التحقق من وجود اللاعب
            let player = room.players.find(p => p.userId === data.userId);
            if (player) {
                // إعادة اتصال
                player.id = socket.id;
                player.isConnected = true;
                player.username = data.username || player.username;
            } else {
                // لاعب جديد
                player = {
                    id: socket.id,
                    userId: data.userId || uuidv4(),
                    username: data.username || `Player${room.players.length + 1}`,
                    team: null,
                    role: null,
                    isConnected: true,
                    isReady: false // 🆕 تهيئة حالة الجاهزية
                };
                room.players.push(player);
            }

            socket.roomCode = roomCode;
            socket.join(roomCode);
            
            socket.emit('roomJoined', { 
                roomCode: roomCode, 
                players: room.players, 
                isAIGame: room.isAIGame 
            });
            io.to(roomCode).emit('roomUpdate', room.players);
            console.log(`${player.username} joined room ${roomCode}.`);
        });

        // SET ROLE (هذا مثال لحدث اختيار الدور)
        socket.on('setRole', (data) => {
            try {
                const room = getRoom(socket.roomCode);
                if (!room) return;
                
                const player = getPlayer(room, socket.id);
                if (!player) return;
                
                // التأكد من عدم تكرار الدور
                const existingPlayer = room.players.find(p => p.team === data.team && p.role === data.role);
                if (existingPlayer && existingPlayer.id !== player.id) {
                    socket.emit('roleError', 'هذا الدور محجوز بالفعل!');
                    return;
                }
                
                player.team = data.team;
                player.role = data.role;
                // عند تغيير الدور/الفريق، نعيد حالة الجاهزية لـ false لضمان إعادة الضغط
                player.isReady = false; 

                io.to(room.code).emit('roomUpdate', room.players);
                
            } catch (error) {
                console.error('Error setting role:', error);
            }
        });


        // ===============================================
        // ✅ معالج setReady - الإضافة الأساسية لحل المشكلة
        // ===============================================
        socket.on('setReady', async (data) => {
            try {
                const room = getRoom(socket.roomCode);
                if (!room || room.gameState !== 'WAITING') return;

                const player = getPlayer(room, socket.id);
                // يجب أن يكون اللاعب قد اختار دوراً أولاً
                if (!player || !player.team || !player.role) {
                    socket.emit('roleError', 'يجب اختيار الفريق والدور أولاً.');
                    return;
                }
                
                // تحديث حالة الجاهزية
                player.isReady = data.isReady; 
                
                // إرسال تحديث للغرفة ليعرف الجميع بحالة اللاعبين الجديدة
                io.to(room.code).emit('roomUpdate', room.players);
                
                // التحقق من بدء اللعبة تلقائياً عند جاهزية الجميع واكتمال الأدوار
                if (isRoomFullyReady(room)) {
                    
                    // ************ منطق بدء اللعبة (مأخوذ من دالة startGame الأصلية) ************
                    
                    const gameData = initializeGameBoard(); // تهيئة لوح الكلمات
                    
                    const newGame = await Game.create({ // إنشاء سجل اللعبة في قاعدة البيانات
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
                    
                    // تحديث حالة الغرفة
                    room.gameState = 'IN_PROGRESS';
                    room.currentGameId = newGame._id;
                    room.board = newGame.board;
                    room.currentTurn = newGame.currentTurn;
                    room.turnPhase = 'CLUE_GIVING';
                    room.clue = null;
                    room.guessesLeft = 0;
                    
                    // إرسال بدء اللعبة لجميع اللاعبين
                    io.to(room.code).emit('gameStarted', { 
                        ...newGame.toObject(), 
                        players: room.players,
                        isAIGame: room.isAIGame // التأكد من إرسال حالة الـ AI
                    });
                    
                    console.log(`Game started automatically in room: ${room.code}`);
                    
                    // إذا كان الدور الأول للفريق الأزرق وكانت اللعبة AI، ابدأ دور الـ AI
                    if (room.isAIGame && room.currentTurn === 'BLUE') {
                        handleAITurn(io, room.code);
                    }
                    // *******************************************
                }

            } catch (error) {
                console.error('Error setting ready status or starting game:', error);
                socket.emit('roomError', 'فشل تحديث حالة الجاهزية أو بدء اللعبة.');
            }
        });
        // 🔚 نهاية معالج setReady
        // ===============================================

        // GIVE CLUE (افتراض وجود معالج إعطاء التلميح)
        socket.on('giveClue', async (data) => {
            // ... منطق إعطاء التلميح
        });

        // GUESS WORD (افتراض وجود معالج تخمين الكلمة)
        socket.on('guessWord', async (data) => {
            // ... منطق تخمين الكلمة
        });

        // END TURN (افتراض وجود معالج إنهاء الدور)
        socket.on('endTurn', async () => {
            try {
                // ... منطق إنهاء الدور
                // مثال على ما قد يحدث في نهاية الدور:
                const room = getRoom(socket.roomCode);
                if (!room || room.gameState !== 'IN_PROGRESS') return;

                room.currentTurn = room.currentTurn === 'RED' ? 'BLUE' : 'RED';
                room.turnPhase = 'CLUE_GIVING'; 
                
                // حفظ حالة اللعبة في قاعدة البيانات
                await Game.findByIdAndUpdate(room.currentGameId, {
                    currentTurn: room.currentTurn,
                    clue: null,
                    guessesLeft: 0,
                    turnPhase: 'CLUE_GIVING' 
                });

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

        // DISCONNECT
        socket.on('disconnect', async () => {
            try {
                if (!socket.roomCode) return;
                
                const roomCode = socket.roomCode;
                const room = activeRooms[roomCode];

                if (room) {
                    // بدلاً من الحذف، يمكن تعيين isConnected: false
                    const player = room.players.find(p => p.id === socket.id);
                    if (player) {
                        player.isConnected = false;
                        // لا نحذف اللاعب، فقط نحدث حالته ليعرف الآخرون أنه غير متصل
                    }
                    
                    // حذف الغرفة إذا لم يتبقَ فيها أحد
                    const connectedPlayers = room.players.filter(p => p.isConnected);
                    if (connectedPlayers.length === 0) {
                        delete activeRooms[roomCode];
                        console.log(`Room ${roomCode} closed (empty).`);
                    } else {
                        io.to(roomCode).emit('roomUpdate', room.players);
                        console.log(`Player ${socket.id} left room ${roomCode}`);
                    }
                }
            } catch (error) {
                console.error('Error on disconnect:', error);
            }
        });
    });
};

module.exports = handleSocketConnections;
