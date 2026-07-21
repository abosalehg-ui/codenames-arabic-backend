const { test } = require('node:test');
const assert = require('node:assert');
const { initializeGameBoard, shuffle, ALL_WORDS } = require('../controllers/gameSetup');

test('قائمة الكلمات كافية وبلا تكرار', () => {
    assert.ok(ALL_WORDS.length >= 25);
    assert.strictEqual(new Set(ALL_WORDS).size, ALL_WORDS.length);
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
