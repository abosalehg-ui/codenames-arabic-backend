const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        minlength: 2,
        maxlength: 20
    },
    email: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true
    },
    password: {
        type: String,
        required: true,
        select: false // لا تُرجع كلمة المرور في الاستعلامات إلا بطلب صريح
    }
}, {
    timestamps: true
});

// تجزئة كلمة المرور قبل الحفظ — فقط عندما تتغيّر.
// (الخروج المبكر بـ return ضروري: بدونه كانت الكلمة المجزّأة تُجزَّأ مرة أخرى
// في كل حفظ لاحق، فيفشل تسجيل الدخول)
UserSchema.pre('save', async function () {
    if (!this.isModified('password')) return;
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

// مقارنة كلمة المرور
UserSchema.methods.matchPassword = async function (enteredPassword) {
    return bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', UserSchema);
