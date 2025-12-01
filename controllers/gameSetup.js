// تحميل قائمة الكلمات من الملف
// تأكد من أن هذا المسار صحيح بناءً على موقع الملف
const wordsData = require('../words.json'); 
const ALL_WORDS = Object.values(wordsData).flat(); // دمج كل التصنيفات في قائمة واحدة

/**
 * توليد شبكة اللعب (الـ 5x5) وتوزيع الألوان (KeyCard)
 * @returns {Object} يحتوي على لوحة اللعب، والفريق البادئ
 */
const initializeGameBoard = () => {
    // 1. اختيار 25 كلمة عشوائية
    const shuffledWords = ALL_WORDS.sort(() => 0.5 - Math.random());
    const selectedWords = shuffledWords.slice(0, 25);

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
    const shuffledTypes = cardTypes.sort(() => 0.5 - Math.random());

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

module.exports = { initializeGameBoard };