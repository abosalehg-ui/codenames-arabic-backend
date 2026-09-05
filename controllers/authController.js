const User = require('../models/User');
const generateToken = require('../utils/generateToken');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

// رسائل الخطأ الداخلية لا تُرسل للعميل — تُسجَّل فقط
const serverError = (res, context, error) => {
    console.error(`❌ ${context}:`, error.message);
    res.status(500).json({ message: 'حدث خطأ في الخادم. حاول مرة أخرى.' });
};

const validateCredentials = ({ username, email, password }, { requireUsername }) => {
    if (requireUsername) {
        if (typeof username !== 'string' || username.trim().length < 2 || username.trim().length > 20) {
            return 'اسم المستخدم يجب أن يكون بين 2 و 20 حرفاً.';
        }
    }
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim()) || email.length > 254) {
        return 'البريد الإلكتروني غير صالح.';
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > 128) {
        return `كلمة المرور يجب أن تكون ${MIN_PASSWORD_LENGTH} أحرف على الأقل.`;
    }
    return null;
};

// @الوصف: تسجيل مستخدم جديد
// @المسار: POST /api/users/register
exports.registerUser = async (req, res) => {
    const invalid = validateCredentials(req.body || {}, { requireUsername: true });
    if (invalid) return res.status(400).json({ message: invalid });

    const username = req.body.username.trim();
    const email = req.body.email.trim().toLowerCase();
    const { password } = req.body;

    try {
        const exists = await User.findOne({ $or: [{ email }, { username }] });
        if (exists) {
            return res.status(400).json({ message: 'البريد الإلكتروني أو اسم المستخدم مستخدم مسبقاً.' });
        }

        const user = await User.create({ username, email, password });
        res.status(201).json({
            _id: user._id,
            username: user.username,
            email: user.email,
            token: generateToken(user._id)
        });
    } catch (error) {
        serverError(res, 'registerUser', error);
    }
};

// @الوصف: تسجيل دخول المستخدم
// @المسار: POST /api/users/login
exports.loginUser = async (req, res) => {
    const invalid = validateCredentials(req.body || {}, { requireUsername: false });
    if (invalid) return res.status(401).json({ message: 'بريد إلكتروني أو كلمة مرور غير صحيحة.' });

    const email = req.body.email.trim().toLowerCase();
    const { password } = req.body;

    try {
        const user = await User.findOne({ email }).select('+password');
        if (user && (await user.matchPassword(password))) {
            res.json({
                _id: user._id,
                username: user.username,
                email: user.email,
                token: generateToken(user._id)
            });
        } else {
            res.status(401).json({ message: 'بريد إلكتروني أو كلمة مرور غير صحيحة.' });
        }
    } catch (error) {
        serverError(res, 'loginUser', error);
    }
};
