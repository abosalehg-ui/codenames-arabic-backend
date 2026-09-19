/**
 * حد معدل بسيط في الذاكرة لكل عنوان IP — بلا اعتمادية خارجية.
 * كافٍ لخادم بعملية واحدة (Render). عند التوسّع لأكثر من عملية استبدله بـ express-rate-limit + Redis.
 */
const rateLimit = ({ windowMs, max, message }) => {
    const hits = new Map();

    const cleanup = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) {
            if (entry.resetAt <= now) hits.delete(key);
        }
    }, windowMs);
    cleanup.unref();

    return (req, res, next) => {
        // req.ip يحترم إعداد trust proxy في server.js (آخر قفزة موثوقة فقط) —
        // قراءة X-Forwarded-For مباشرة كانت تثق بأول عنصر وهو ما يكتبه العميل بنفسه
        const ip = req.ip || 'unknown';
        const now = Date.now();

        let entry = hits.get(ip);
        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(ip, entry);
        }
        entry.count += 1;

        if (entry.count > max) {
            res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
            return res.status(429).json({ message });
        }
        next();
    };
};

module.exports = rateLimit;
