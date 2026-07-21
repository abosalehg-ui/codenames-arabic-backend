const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeArabic } = require('../utils/wordNormalizer');

test('توحيد الهمزات والتاء المربوطة والياء', () => {
    assert.strictEqual(normalizeArabic('أسد'), normalizeArabic('اسد'));
    assert.strictEqual(normalizeArabic('مدرسة'), normalizeArabic('مدرسه'));
    assert.strictEqual(normalizeArabic('مستشفى'), normalizeArabic('مستشفي'));
});

test('إزالة التشكيل', () => {
    assert.strictEqual(normalizeArabic('كَلِمَة'), normalizeArabic('كلمة'));
});

test('قيم فارغة', () => {
    assert.strictEqual(normalizeArabic(''), '');
    assert.strictEqual(normalizeArabic(null), '');
});
