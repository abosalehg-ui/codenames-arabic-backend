const mongoose = require('mongoose');

const StatsSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true
    },
    gamesPlayed: {
        type: Number,
        default: 0
    },
    wins: {
        type: Number,
        default: 0
    },
    losses: {
        type: Number,
        default: 0
    },
    assassinPicks: { // عدد مرات اختيار كلمة القاتل
        type: Number,
        default: 0
    }
}, {
    timestamps: true // لتتبع تاريخ الإنشاء والتعديل
});

module.exports = mongoose.model('Stats', StatsSchema);