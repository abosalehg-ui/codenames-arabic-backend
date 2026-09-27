/**
 * دورة حياة الغرفة: التخزين في الذاكرة، تشكيل حمولات الحالة، تبديل الدور
 * ومؤقّته، إزالة اللاعبين والغرف، والعودة للوبي/إنهاء الجولة قسراً.
 *
 * فُصل هذا عن controllers/gameController.js (الذي يبقى مسؤولاً عن ربط أحداث
 * Socket.IO ومنطق اللعب: التلميح والتخمين وقواعدهما) لأن الملف الأصلي كان
 * يجمع أربع مسؤوليات في ملف واحد. هذا الملف يملك `activeRooms` كمصدر وحيد،
 * وكل الدوال هنا تأخذ `(io, room, ...)` بنفس التوقيعات التي كانت عليها.
 */
const Game = require('../models/Game');
const { countRemaining } = require('./gameLogic');

// ====================================
// التخزين + الثوابت
// ====================================
const activeRooms = {};

const TEAM_AR = { RED: 'الأحمر', BLUE: 'الأزرق' };

// مهل حذف اللاعب المنقطع — قابلة للتقصير من البيئة لتسريع الاختبارات
const WAITING_REMOVE_DELAY = Number(process.env.WAITING_REMOVE_DELAY_MS) || 30 * 1000;      // في غرفة الانتظار
const GAME_REMOVE_DELAY = Number(process.env.GAME_REMOVE_DELAY_MS) || 5 * 60 * 1000;        // أثناء اللعبة وبعدها
const WAITING_IDLE_TIMEOUT = 15 * 60 * 1000;   // غرفة انتظار خاملة تُحذف بعد 15 دقيقة
const ROOM_IDLE_TIMEOUT = 2 * 60 * 60 * 1000;  // غرفة فيها لعبة خاملة تُحذف بعد ساعتين

const otherTeam = (team) => team === 'RED' ? 'BLUE' : 'RED';

// ====================================
// دوال مساعدة على شكل الغرفة
// ====================================
const getRoom = (roomCode) => roomCode ? activeRooms[roomCode.toUpperCase()] : null;
const getPlayer = (room, socketId) => room ? room.players.find(p => p.id === socketId) : null;
const touch = (room) => { if (room) room.lastActivity = Date.now(); };

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
const roomSeries = (room) => ({ ...room.series });

// حمولة الغرفة المشتركة (إنشاء/انضمام/عودة للوبي)
const roomPayload = (room) => ({
    code: room.code,
    players: publicPlayers(room),
    gameState: room.gameState,
    settings: roomSettings(room),
    series: roomSeries(room)
});

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
    series: roomSeries(room),
    ...countRemaining(room.board),
    ...extra
});

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

// جدولة حذف لاعب منقطع — تُستدعى عند الانقطاع وعند العودة للوبي (بمهلة أقصر)
const scheduleRemoval = (io, room, player, delay) => {
    if (player.removalTimer) clearTimeout(player.removalTimer);
    player.removalTimer = setTimeout(() => {
        player.removalTimer = null;
        if (player.disconnected && activeRooms[room.code] === room) {
            removePlayerFromRoom(io, room, player.id);
        }
    }, delay);
};

const resetToLobby = (io, room) => {
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
    // من انقطع أثناء اللعبة ولم يعد: مهلة اللوبي القصيرة بدل بقائه شبحاً يحجز مقعده
    room.players.forEach(p => { if (p.disconnected) scheduleRemoval(io, room, p, WAITING_REMOVE_DELAY); });
};

const deleteRoom = (room, reason) => {
    clearTurnTimer(room);
    room.players.forEach(p => { if (p.removalTimer) clearTimeout(p.removalTimer); });
    delete activeRooms[room.code];
    console.log(`🗑️ Room ${room.code} deleted (${reason})`);
};

const emitReturnedToLobby = (io, room) => {
    io.to(room.code).emit('returnedToLobby', roomPayload(room));
    io.to(room.code).emit('roomUpdate', publicPlayers(room));
};

// إنهاء الجولة قسراً والعودة للوبي (مغادرة قائد بلا بديل، أو قرار المضيف)
const abortGame = (io, room, reason) => {
    persistRoom(room, { gameState: 'FINISHED' });
    resetToLobby(io, room);
    console.log(`🛑 Game aborted in ${room.code}: ${reason}`);
    io.to(room.code).emit('gameAborted', { reason });
    emitReturnedToLobby(io, room);
};

// إزالة لاعب نهائياً من الغرفة (مغادرة صريحة أو انتهاء مهلة الانقطاع أو طرد)
const removePlayerFromRoom = (io, room, socketId) => {
    const player = getPlayer(room, socketId);
    if (!player) return;

    if (player.removalTimer) clearTimeout(player.removalTimer);
    room.players = room.players.filter(p => p.id !== socketId);

    if (room.players.length === 0) {
        deleteRoom(room, 'empty');
        return;
    }

    // نقل الاستضافة إذا غادر المضيف — إلى لاعب متصل، لا إلى منقطع قد لا يعود
    if (room.hostUserId === player.userId) {
        const next = room.players.find(p => !p.disconnected) || room.players[0];
        room.hostUserId = next.userId;
        console.log(`⭐ Host of ${room.code} transferred to ${next.username}`);
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

// المؤقّت يغطي مرحلة القائد (التفكير بالتلميح)، ثم يُعاد ضبطه عند إعطاء التلميح
// ليغطي مرحلة التخمين كاملة؛ انتهاؤه في أي مرحلة ينقل الدور للفريق الآخر
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

module.exports = {
    activeRooms,
    TEAM_AR,
    WAITING_REMOVE_DELAY,
    GAME_REMOVE_DELAY,
    getRoom,
    getPlayer,
    touch,
    publicPlayers,
    roomSettings,
    roomSeries,
    roomPayload,
    gameUpdatePayload,
    persistRoom,
    clearTurnTimer,
    switchTurn,
    scheduleRemoval,
    resetToLobby,
    deleteRoom,
    removePlayerFromRoom,
    startTurnTimer,
    emitReturnedToLobby,
    abortGame
};
