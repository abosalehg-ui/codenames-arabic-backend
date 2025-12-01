const express = require('express');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io'); // استيراد Server من socket.io
const cors = require('cors'); // استيراد CORS للتحكم في النطاقات
const connectDB = require('./config/mongo'); // دالة اتصال MongoDB
const handleSocketConnections = require('./controllers/gameController'); // متحكم Socket.io

// استيراد مسارات API
const userRoutes = require('./routes/userRoutes');

// تحميل متغيرات البيئة من ملف .env
dotenv.config();

// 1. الاتصال بقاعدة البيانات MongoDB
connectDB();

const app = express();
const httpServer = http.createServer(app); // إنشاء سيرفر HTTP

// 2. إعدادات CORS و Socket.io
const io = new Server(httpServer, {
    cors: {
        // 🚨 السماح للطلبات القادمة من الواجهة الأمامية (GitHub Pages)
        origin: process.env.FRONTEND_URL, 
        methods: ["GET", "POST"]
    }
});

// 3. تجهيز Middlewares
app.use(express.json()); // للسماح بتحليل بيانات JSON في جسم الطلب (req.body)

// تفعيل CORS لـ Express API أيضاً باستخدام FRONTEND_URL
app.use(cors({
    origin: process.env.FRONTEND_URL
}));

// 4. مسارات API (RESTful Endpoints)
app.use('/api/users', userRoutes);

// 5. مسار اختبار واستيقاظ الخادم (Render Cold Start Fix)
app.get('/', (req, res) => {
    // هذا المسار يُستخدم بواسطة الواجهة الأمامية للتأكد من أن الخادم مستيقظ
    res.send('Server is awake and running!');
});

// 6. ربط منطق Socket.io
handleSocketConnections(io);

app.get('/health', (req, res) => {
    res.json({ status: "ok" });
});

// Test API
app.get('/api/test', (req, res) => {
    res.json({ message: "API works" });
});

// 7. تشغيل الخادم
const PORT = process.env.PORT || 5000;

httpServer.listen(PORT, console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`));
