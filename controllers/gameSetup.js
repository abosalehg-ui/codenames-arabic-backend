// تحميل قائمة الكلمات من الملف
const wordsData = require('../words.json');

// دمج كل التصنيفات في قائمة واحدة مع إزالة أي تكرار (ضمانة إضافية
// فوق تنظيف words.json نفسه — الكلمة المكررة تعني بطاقتين متطابقتين على اللوحة)
const ALL_WORDS = [...new Set(Object.values(wordsData).flat())];

if (ALL_WORDS.length < 25) {
    throw new Error(`words.json يحتوي ${ALL_WORDS.length} كلمة فقط — المطلوب 25 على الأقل`);
}

/**
 * خلط Fisher-Yates غير منحاز — يعمل على نسخة ولا يعدّل المصفوفة الأصلية
 * (sort مع دالة عشوائية يعطي توزيعاً منحازاً ويعدّل المصفوفة في مكانها)
 */
const shuffle = (array) => {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
};

/**
 * توليد شبكة اللعب (الـ 5x5) وتوزيع الألوان (KeyCard)
 * @returns {Object} يحتوي على لوحة اللعب، والفريق البادئ
 */
const initializeGameBoard = () => {
    // 1. اختيار 25 كلمة عشوائية
    const selectedWords = shuffle(ALL_WORDS).slice(0, 25);

    // 2. تحديد الفريق البادئ
    const startingTeam = Math.random() < 0.5 ? 'RED' : 'BLUE';
    const otherTeam = startingTeam === 'RED' ? 'BLUE' : 'RED';

    // 3. تحديد عدد بطاقات كل نوع (9 للبادئ، 8 للآخر، 7 مدني، 1 قاتل)
    const cardTypes = [];

    for (let i = 0; i < 9; i++) cardTypes.push(startingTeam);
    for (let i = 0; i < 8; i++) cardTypes.push(otherTeam);
    for (let i = 0; i < 7; i++) cardTypes.push('INNOCENT');
    cardTypes.push('ASSASSIN');

    // 4. خلط الألوان وإقرانها بالكلمات
    const shuffledTypes = shuffle(cardTypes);

    const board = selectedWords.map((word, index) => ({
        word,
        type: shuffledTypes[index], // تحديد نوع البطاقة (لونها)
        revealed: false,
        pickedBy: null
    }));

    return {
        board,
        firstTeam: startingTeam,
        currentTurn: startingTeam
    };
};

module.exports = { initializeGameBoard, shuffle, ALL_WORDS };
