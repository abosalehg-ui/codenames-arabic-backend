const User = require('../models/User');
const Stats = require('../models/Stats');
const generateToken = require('../utils/generateToken');

// @الوصف: تسجيل مستخدم جديد
// @المسار: POST /api/users/register
// @الوصول: عام
exports.registerUser = async (req, res) => {
  const { username, email, password } = req.body;

  try {
    const userExists = await User.findOne({ email });

    if (userExists) {
      return res.status(400).json({ message: 'البريد الإلكتروني مستخدم مسبقاً.' });
    }

    const user = await User.create({ username, email, password });

    if (user) {
      // 1. إنشاء سجل إحصائيات للمستخدم الجديد
      const userStats = await Stats.create({ userId: user._id });
      // 2. ربط سجل الإحصائيات بحساب المستخدم
      user.stats = userStats._id;
      await user.save();
      
      res.status(201).json({
        _id: user._id,
        username: user.username,
        email: user.email,
        token: generateToken(user._id),
      });
    } else {
      res.status(400).json({ message: 'بيانات مستخدم غير صالحة.' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @الوصف: تسجيل دخول المستخدم
// @المسار: POST /api/users/login
// @الوصول: عام
exports.loginUser = async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });

    // استخدام دالة matchPassword المعرفة في نموذج User.js
    if (user && (await user.matchPassword(password))) {
      res.json({
        _id: user._id,
        username: user.username,
        email: user.email,
        token: generateToken(user._id),
      });
    } else {
      res.status(401).json({ message: 'بريد إلكتروني أو كلمة مرور غير صحيحة.' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};