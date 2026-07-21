const mongoose = require('mongoose');

// فشل الاتصال بالقاعدة لا يوقف الخادم: اللعبة تعمل من الذاكرة،
// والقاعدة تُستخدم للأرشفة فقط (انظر persistRoom في gameController)
const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    console.warn('⚠️ MONGO_URI غير معرّف — الخادم يعمل بدون قاعدة بيانات (الحالة في الذاكرة فقط).');
    return;
  }
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`⚠️ Error connecting to MongoDB: ${error.message}`);
    console.error('الخادم مستمر بدون قاعدة بيانات — الألعاب لن تُؤرشف.');
  }
};

module.exports = connectDB;
