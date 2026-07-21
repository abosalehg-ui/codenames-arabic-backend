/**
 * منطق اللعبة النقي (بدون Socket أو قاعدة بيانات) — قابل للاختبار بشكل مستقل
 */

// عدّ البطاقات المتبقية لكل فريق
const countRemaining = (board) => {
    let redRemaining = 0;
    let blueRemaining = 0;

    for (const card of board) {
        if (!card.revealed) {
            if (card.type === 'RED') redRemaining++;
            if (card.type === 'BLUE') blueRemaining++;
        }
    }

    return { redRemaining, blueRemaining };
};

// تحديد الفائز: القاتل ينهي اللعبة فوراً، وإلا الفريق الذي كشف كل بطاقاته
const checkWinCondition = (board) => {
    if (!board) return null;

    for (const card of board) {
        if (card.revealed && card.type === 'ASSASSIN') {
            return card.pickedBy === 'RED' ? 'BLUE' : 'RED';
        }
    }

    const { redRemaining, blueRemaining } = countRemaining(board);
    if (redRemaining === 0) return 'RED';
    if (blueRemaining === 0) return 'BLUE';

    return null;
};

/**
 * نسخة اللوحة المسموح إرسالها للاعب حسب دوره:
 * القائد يرى كل الألوان، والمخمن يرى ألوان البطاقات المكشوفة فقط.
 * بعد نهاية اللعبة تُكشف الألوان للجميع.
 */
const sanitizeBoardForRole = (board, role, gameState) => {
    if (role === 'SPYMASTER' || gameState === 'FINISHED') {
        return board.map(card => ({ ...card }));
    }

    return board.map(card => card.revealed
        ? { ...card }
        : { word: card.word, type: null, revealed: false, pickedBy: null }
    );
};

module.exports = { countRemaining, checkWinCondition, sanitizeBoardForRole };
