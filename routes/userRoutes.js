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
