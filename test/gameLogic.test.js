const { test } = require('node:test');
const assert = require('node:assert');
const { countRemaining, checkWinCondition, sanitizeBoardForRole } = require('../controllers/gameLogic');

const card = (type, revealed = false, pickedBy = null) => ({ word: 'كلمة', type, revealed, pickedBy });

test('countRemaining يعدّ البطاقات غير المكشوفة فقط', () => {
    const board = [card('RED'), card('RED', true, 'RED'), card('BLUE'), card('INNOCENT')];
    assert.deepStrictEqual(countRemaining(board), { redRemaining: 1, blueRemaining: 1 });
});

test('لا فائز في منتصف اللعبة', () => {
    const board = [card('RED'), card('BLUE'), card('ASSASSIN')];
    assert.strictEqual(checkWinCondition(board), null);
});

test('كشف كل بطاقات الفريق = فوز', () => {
    const board = [card('RED', true, 'RED'), card('BLUE'), card('ASSASSIN')];
    assert.strictEqual(checkWinCondition(board), 'RED');
});

test('ضرب القاتل = فوز الفريق الآخر فوراً حتى لو اكتملت بطاقات الضارب', () => {
    const board = [card('RED', true, 'RED'), card('BLUE'), card('ASSASSIN', true, 'RED')];
    assert.strictEqual(checkWinCondition(board), 'BLUE');
});

test('المخمن لا يستلم ألوان البطاقات غير المكشوفة', () => {
    const board = [card('RED'), card('ASSASSIN'), card('BLUE', true, 'RED')];
    const sanitized = sanitizeBoardForRole(board, 'GUESSER', 'IN_PROGRESS');

    assert.strictEqual(sanitized[0].type, null);
    assert.strictEqual(sanitized[1].type, null);
    assert.strictEqual(sanitized[2].type, 'BLUE'); // المكشوفة تبقى ظاهرة
    // الأصل لم يُمس
    assert.strictEqual(board[0].type, 'RED');
});

test('القائد يرى كل الألوان، والجميع يراها بعد النهاية', () => {
    const board = [card('RED'), card('ASSASSIN')];
    assert.strictEqual(sanitizeBoardForRole(board, 'SPYMASTER', 'IN_PROGRESS')[1].type, 'ASSASSIN');
    assert.strictEqual(sanitizeBoardForRole(board, 'GUESSER', 'FINISHED')[1].type, 'ASSASSIN');
});
