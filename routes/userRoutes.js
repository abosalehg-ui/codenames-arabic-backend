// هيكل مستقبلي غير مستخدم حالياً — لا تستدعيه الواجهة إطلاقاً، ويبقى معطّلاً
// افتراضياً خلف ENABLE_AUTH_API (انظر server.js). إن فُعّل: يوجد توكن JWT صالح
// بعد تسجيل الدخول، لكن لا يوجد أي مسار في هذا المستودع يتحقق من ذاك التوكن
// أو يحمي به شيئاً — التفعيل وحده لا يحمي أي مورد، ويحتاج middleware تحقق
// (jsonwebtoken.verify على رأس Authorization) قبل أن يصبح مفيداً فعلياً.
const express = require('express');
const { registerUser, loginUser } = require('../controllers/authController');
const rateLimit = require('../utils/rateLimit');

const router = express.Router();

// 10 محاولات كل 15 دقيقة لكل IP — يمنع تخمين كلمات المرور بالقوة الغاشمة
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة.'
});

router.post('/register', authLimiter, registerUser);
router.post('/login', authLimiter, loginUser);

module.exports = router;
