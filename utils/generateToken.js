const jwt = require('jsonwebtoken');

/**
 * إنشاء توكن JWT لجلسة المستخدم
 * @param {string} id - معرّف المستخدم (UserId)
 * @returns {string} توكن الجلسة المشفر
 */
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: '30d', // انتهاء الصلاحية بعد 30 يوماً
  });
};

module.exports = generateToken;