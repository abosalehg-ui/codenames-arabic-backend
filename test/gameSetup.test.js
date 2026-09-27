const { test } = require('node:test');
const assert = require('node:assert');
const { initializeGameBoard, shuffle, ALL_WORDS } = require('../controllers/gameSetup');
const { normalizeArabic } = require('../utils/wordNormalizer');

test('قائمة الكلمات كافية وبلا تكرار (حتى بعد التطبيع العربي)', () => {
    assert.ok(ALL_WORDS.length >= 25);
    assert.strictEqual(new Set(ALL_WORDS).size, ALL_WORDS.length);
    // المقارنة على النص الخام لا تكفي: "أخطبوط" و"اخطبوط" نص مختلف لكنهما نفس
    // الكلمة بعد توحيد الهمزات — هذا الفحص يكتشف مثل هذا التكرار قبل أن يصل للوحة
    const normalized = ALL_WORDS.map(normalizeArabic);
    assert.strictEqual(new Set(normalized).size, normalized.length, 'كلمات مكررة بعد التطبيع العربي');
});

test('اللوحة: 25 بطاقة بتوزيع 9/8/7/1 وكلمات فريدة', () => {
    for (let run = 0; run < 50; run++) {
        const { board, firstTeam, currentTurn } = initializeGameBoard();

        assert.strictEqual(board.length, 25);
        assert.strictEqual(currentTurn, firstTeam);

        const counts = { RED: 0, BLUE: 0, INNOCENT: 0, ASSASSIN: 0 };
        const words = new Set();
        for (const card of board) {
            counts[card.type]++;
            words.add(card.word);
            assert.strictEqual(card.revealed, false);
            assert.strictEqual(card.pickedBy, null);
        }

        assert.strictEqual(words.size, 25, 'كلمات مكررة على اللوحة');
        assert.strictEqual(counts[firstTeam], 9);
        assert.strictEqual(counts[firstTeam === 'RED' ? 'BLUE' : 'RED'], 8);
        assert.strictEqual(counts.INNOCENT, 7);
        assert.strictEqual(counts.ASSASSIN, 1);
    }
});

test('الخلط لا يعدّل المصفوفة الأصلية', () => {
    const original = [1, 2, 3, 4, 5];
    const copy = [...original];
    const result = shuffle(original);
    assert.deepStrictEqual(original, copy);
    assert.deepStrictEqual([...result].sort(), copy);
});
