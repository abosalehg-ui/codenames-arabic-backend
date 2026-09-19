const mongoose = require('mongoose');

// تعريف حالة البطاقة الواحدة في الشبكة (5x5)
const CardSchema = new mongoose.Schema({
    word: { type: String, required: true }, // الكلمة نفسها
    type: { type: String, enum: ['RED', 'BLUE', 'INNOCENT', 'ASSASSIN'], required: true }, // نوع البطاقة
    revealed: { type: Boolean, default: false }, // هل تم كشفها
    pickedBy: { type: String, enum: ['RED', 'BLUE', null], default: null } // الفريق الذي اختارها
});

const GameSchema = new mongoose.Schema({
    roomCode: {
        type: String,
        required: true,
        index: true, // ليس unique — الغرفة الواحدة تُنشئ ألعاباً متعددة (سجل لكل جولة)
        uppercase: true,
        trim: true
    },
    gameState: {
        type: String,
        enum: ['WAITING', 'IN_PROGRESS', 'FINISHED'],
        default: 'WAITING'
    },
    board: [CardSchema], // شبكة 5x5 (25 بطاقة)
    currentTurn: { // دور الفريق الحالي
        type: String,
        enum: ['RED', 'BLUE'],
        required: true
    },
    firstTeam: { // الفريق الذي يبدأ (لتحديد 8 أو 9 كلمات)
        type: String,
        enum: ['RED', 'BLUE'],
        required: true
    },
    winner: { type: String, enum: ['RED', 'BLUE', null], default: null }, // الفائز عند النهاية
    clue: { type: String, default: null }, // التلميح الأخير من القائد
    guessesLeft: { type: Number, default: 0 }, // عدد المحاولات المتبقية في هذا الدور
    history: [{ // سجل الكلمات المختارة
        team: String,
        username: String,
        word: String,
        result: String, // مثلاً: 'Correct', 'Innocent', 'Assassin'
        timestamp: { type: Date, default: Date.now }
    }],
    players: [{ // قائمة اللاعبين داخل الغرفة
        socketId: String,
        userId: String, // هوية إعادة الاتصال من العميل — لا علاقة لها بنموذج User
        username: String,
        team: { type: String, enum: ['RED', 'BLUE', null] },
        role: { type: String, enum: ['SPYMASTER', 'GUESSER', null] }
    }],
    timer: { type: Number, default: 90 } // مدة الدور بالثواني (0 = بلا مؤقّت)
}, {
    timestamps: true
});

module.exports = mongoose.model('Game', GameSchema);