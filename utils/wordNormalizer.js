/**
 * توحيد النصوص العربية للمقارنة الدقيقة في اللعبة
 * @param {string} text - النص المراد توحيده.
 * @returns {string} النص الموحد بحروف صغيرة (Lowercase) وخالٍ من التشكيل وبعض الحروف المتشابهة.
 */
const normalizeArabic = (text) => {
    if (!text) return '';
    
    // 1. إزالة التشكيل (الحركات)
    let normalized = text.replace(/[\u064B-\u0652]/g, ""); 
    
    // 2. توحيد الهمزات: 'أ', 'إ', 'آ', 'ء' -> 'ا'
    normalized = normalized.replace(/[أإآء]/g, 'ا');
    
    // 3. توحيد الياء: 'ى' -> 'ي'
    normalized = normalized.replace(/ى/g, 'ي');
    
    // 4. توحيد التاء المربوطة: 'ة' -> 'ه'
    normalized = normalized.replace(/ة/g, 'ه');
    
    // 5. إزالة أي مسافات زائدة وتحويل النص إلى حروف صغيرة (إذا كان هناك أي حروف لاتينية)
    return normalized.trim().toLowerCase();
};

module.exports = { normalizeArabic };