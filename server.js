const express = require('express');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const connectDB = require('./config/mongo');
const handleSocketConnections = require('./controllers/gameController');
const userRoutes = require('./routes/userRoutes');

// تحميل متغيرات البيئة من ملف .env
dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

// 1. الاتصال بقاعدة البيانات MongoDB (اختياري — فشله لا يوقف الخادم)
connectDB();

const app = express();
const httpServer = http.createServer(app);

// 2. إعدادات CORS
// FRONTEND_URL يدعم أكثر من نطاق مفصولة بفواصل.
// في التطوير المحلي يُسمح للجميع إن لم يُعرَّف؛ في الإنتاج غيابه خطأ صريح
// بدل أن يفتح الخادم لكل النطاقات بصمت.
const allowedOrigins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

if (isProduction && allowedOrigins.length === 0) {
    throw new Error('FRONTEND_URL مطلوب في الإنتاج (NODE_ENV=production) — حدّد نطاق الواجهة المسموح.');
}
const corsOrigin = allowedOrigins.length > 0 ? allowedOrigins : true;

const io = new Server(httpServer, {
    cors: {
        origin: corsOrigin,
        methods: ['GET', 'POST']
    }
});

// 3. Middlewares
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(cors({ origin: corsOrigin }));

// 4. مسارات API
// نظام المستخدمين غير مستخدم من الواجهة حالياً، فلا يُفتح على الإنتاج إلا بطلب صريح
if (process.env.ENABLE_AUTH_API === 'true') {
    app.use('/api/users', userRoutes);
    console.log('🔐 Auth API enabled at /api/users');
}

// 5. مسار اختبار واستيقاظ الخادم (Render Cold Start Fix)
app.get('/', (req, res) => {
    res.send('Server is awake and running!');
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// 6. ربط منطق Socket.io
handleSocketConnections(io);

// 7. تشغيل الخادم
const PORT = process.env.PORT || 5000;

httpServer.listen(PORT, () => {
    console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
});
