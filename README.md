# Codenames العربية — الخادم (Backend)

خادم اللعبة: Node.js 18+ · Express · Socket.IO · MongoDB (اختياري للأرشفة).

الواجهة الأمامية: [codenames-arabic](https://github.com/abosalehg-ui/codenames-arabic)

> ⚠️ اقرأ [SECURITY.md](SECURITY.md) — فيه إجراء يدوي مطلوب (تبديل سر قديم مسرَّب في تاريخ git).

## البنية

```
server.js                    نقطة الدخول (Express + Socket.IO + CORS)
config/mongo.js              اتصال MongoDB (فشله لا يوقف الخادم)
controllers/
  gameController.js          أحداث Socket.IO وحالة الغرف (المصدر الأساسي في الذاكرة)
  gameLogic.js               منطق نقي قابل للاختبار (الفوز، العدّ، تعقيم اللوحة)
  gameSetup.js               توليد اللوحة 5×5 (خلط Fisher-Yates)
  authController.js          تسجيل/دخول (معطّل افتراضياً — ENABLE_AUTH_API)
models/                      نماذج Mongoose (أرشفة الألعاب + مستخدمون)
utils/wordNormalizer.js      توحيد النص العربي لمقارنة التلميحات
utils/rateLimit.js           حد معدل بسيط في الذاكرة لمسارات المصادقة
words.json                   قوائم الكلمات (655 كلمة بلا تكرار)
test/                        اختبارات وحدة + اختبار تكاملي كامل
.github/workflows/test.yml   CI: الاختبارات + فحص الاعتماديات على كل push
```

## مبادئ التصميم

- **الخادم هو الحَكَم**: كل تحقق (الدور، الصلاحية، صحة التلميح والتخمين) يتم هنا.
- **لا تسريب معلومات**: المخمنون يستلمون اللوحة بدون ألوان البطاقات غير المكشوفة؛ القادة فقط يرون كل شيء. تُكشف اللوحة للجميع عند نهاية اللعبة.
- **الذاكرة أولاً**: حالة اللعبة تعيش في الذاكرة؛ الكتابة إلى MongoDB غير حاجبة وفشلها لا يؤثر على اللعب.
- **إعادة اتصال حقيقية**: هوية اللاعب `userId` ثابتة من العميل؛ الانقطاع أثناء اللعبة يحجز المقعد، والعودة بنفس الهوية تستعيد الحالة كاملة (أثناء اللعبة وبعد نهايتها).
- **اللعبة لا تتجمّد**: مؤقّت دور يضبطه المضيف، مخمّن يستطيع أخذ مقعد قائد منقطع أو مغادر، والمضيف يستطيع إنهاء الجولة في أي وقت (`abortGame`). مغادرة قائد لم يبقَ في فريقه أحد تُرجع الغرفة للوبي تلقائياً.
- **حدود واضحة**: 500 غرفة، 8 لاعبين للغرفة، 20 اتصالاً لكل IP، 30 حدثاً / 5 ثوانٍ لكل اتصال. غرف الانتظار الخاملة تُحذف بعد 15 دقيقة، وغرف اللعب بعد ساعتين بلا نشاط.

## أحداث Socket.IO

| من العميل | البيانات | ملاحظات |
|---|---|---|
| `createRoom` | `{ customName?, username, userId }` | يُخرج الـ socket من أي غرفة سابقة أولاً |
| `joinRoom` | `{ roomCode, username, userId }` | نفس `userId` = إعادة اتصال واستعادة المقعد |
| `setRole` | `{ team, role }` | أثناء اللعبة: فقط أخذ مقعد قائد فريقك الشاغر/المنقطع |
| `setTimer` | `{ turnDuration }` | المضيف، في الانتظار. 0–300 ثانية (0 = بلا مؤقّت) |
| `startGame` / `playAgain` / `abortGame` | — | المضيف فقط |
| `giveClue` | `{ clue, count }` | القائد في دوره، تلميح ≤ 30 حرفاً وعدد 1–9 |
| `makeGuess` | `{ cardIndex }` | المخمن في دوره |
| `endTurn` / `leaveRoom` | — | |

| من الخادم | متى |
|---|---|
| `roomCreated` / `roomJoined` / `roomUpdate` / `roomSettings` | إدارة الغرفة (تحمل `settings.turnDuration`) |
| `gameStarted` | بدء اللعبة أو إعادة اتصال — نسخة اللوحة حسب الدور + `history` + `turnEndsAt` + `serverNow` |
| `gameUpdate` | بعد كل تلميح/تخمين/تبديل دور — نفس الحقول، و`board` كاملة عند `winner` |
| `clueGiven` / `cardRevealed` / `turnTimeout` | أحداث اللعب |
| `spymasterVacant` / `spymasterChanged` | مقعد قائد شغر أو أُخذ |
| `gameAborted` / `returnedToLobby` | العودة للوبي |
| `seatTaken` | تبويب آخر أخذ مقعدك |
| `playerDisconnected` / `playerReconnected` / `playerLeft` | حضور اللاعبين |
| `roomError` / `roleError` / `gameError` / `clueError` / `guessError` | رسائل خطأ عربية للعرض المباشر |

## التشغيل

```bash
npm install
cp .env.example .env   # ثم عبّئ القيم
npm start              # أو للتطوير: npm run dev
```

- بدون `MONGO_URI` يعمل الخادم بشكل كامل (بدون أرشفة الألعاب).
- مع `NODE_ENV=production` يجب تعريف `FRONTEND_URL` وإلا يرفض الخادم التشغيل (حماية من CORS مفتوح بالخطأ).
- نظام المستخدمين `/api/users` معطّل افتراضياً؛ فعّله بـ `ENABLE_AUTH_API=true` مع `JWT_SECRET` قوي.

## الاختبارات

```bash
npm test                 # اختبارات الوحدة (منطق اللوحة والفوز والتطبيع)
npm run test:integration # لعبة كاملة عبر socket.io-client: تعقيم اللوحة، تخمين الفريقين،
                         # إعادة اتصال أثناء اللعبة وبعدها، القاتل، المؤقّت، أخذ مقعد القائد،
                         # إنهاء الجولة، منع اللاعب الشبح، seatTaken
```

تعمل الاختبارات آلياً على GitHub Actions مع كل push.
