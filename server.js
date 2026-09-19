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
    },
    // أكبر حدث شرعي (تلميح 30 حرفاً + عدد) بضع مئات البايتات؛ الافتراضي 1MB
    maxHttpBufferSize: 10 * 1024
});

// 3. Middlewares
app.disable('x-powered-by');
// خلف وكيل Render نثق بقفزة واحدة فقط: req.ip = العنوان الذي أضافه الوكيل، لا ما يكتبه العميل
// في X-Forwarded-For. TRUST_PROXY=true/false يتجاوز الافتراضي (الإنتاج = true).
const trustProxy = process.env.TRUST_PROXY ? process.env.TRUST_PROXY === 'true' : isProduction;
app.set('trust proxy', trustProxy ? 1 : false);
app.use(express.json({ limit: '10kb' }));
app.use(cors({ origin: corsOrigin }));

// 4. مسارات API
// نظام المستخدمين غير مستخدم من الواجهة حالياً، فلا يُفتح على الإنتاج إلا بطلب صريح
if (process.env.ENABLE_AUTH_API === 'true') {
    const secret = process.env.JWT_SECRET || '';
    if (secret.length < 32 || secret.startsWith('change-me')) {
        throw new Error('ENABLE_AUTH_API=true يتطلب JWT_SECRET عشوائياً بطول 32 حرفاً على الأقل (openssl rand -base64 48).');
    }
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
