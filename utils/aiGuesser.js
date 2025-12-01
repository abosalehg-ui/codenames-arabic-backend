/**
 * منطق المخمن الآلي (AI Guesser) البسيط
 * هذا المنطق يستخدم الاحتمالية لتخمين البطاقات.
 */

const makeAIGuess = (board, currentTeam, guessesLeft) => {
    
    // 1. تحديد البطاقات المتاحة التي لم يتم كشفها بعد
    const availableCards = board.map((card, index) => ({ 
        ...card, 
        index 
    })).filter(card => !card.revealed);

    if (availableCards.length === 0 || guessesLeft === 0) {
        return { action: 'END_TURN' }; // إذا لم تتبق كلمات أو انتهت المحاولات
    }

    // 2. تصنيف البطاقات المتاحة
    const ourTeamCards = availableCards.filter(card => card.type === currentTeam);
    const innocentCards = availableCards.filter(card => card.type === 'INNOCENT');
    const opponentCards = availableCards.filter(card => card.type !== currentTeam && card.type !== 'INNOCENT' && card.type !== 'ASSASSIN');
    const assassinCard = availableCards.find(card => card.type === 'ASSASSIN');
    
    let chosenCard = null;

    // 3. اتخاذ قرار التخمين (حكم الاحتمالية)
    
    // الأولوية 1: اختيار كلمة من فريقنا (إذا وجدت) باحتمالية عالية (90%)
    if (ourTeamCards.length > 0 && Math.random() < 0.90) {
        // يختار عشوائياً واحدة من كلمات فريقه المتبقية
        chosenCard = ourTeamCards[Math.floor(Math.random() * ourTeamCards.length)];
    } 
    
    // الأولوية 2: في حال عدم الاختيار أعلاه، يختار كلمة مدنية باحتمالية متوسطة (50%) لتجنب المخاطر
    else if (innocentCards.length > 0 && Math.random() < 0.50) {
        chosenCard = innocentCards[Math.floor(Math.random() * innocentCards.length)];
    } 
    
    // الأولوية 3: إذا لم يتم اختيار أي شيء، يختار عشوائياً من المتبقي، أو ينهي الدور
    else if (availableCards.length > 0) {
        // يختار عشوائياً من جميع البطاقات المتاحة (بما في ذلك المنافس والقاتل، بمخاطرة بسيطة)
        chosenCard = availableCards[Math.floor(Math.random() * availableCards.length)];
    }


    // 4. القرار النهائي: تخمين البطاقة أو إنهاء الدور
    
    // إذا تبقى عدد قليل جداً من المحاولات (مثلاً محاولة واحدة) والـ AI لم يجد كلمة لفريقه، أو خاف من القاتل
    // سيفضل الـ AI إنهاء الدور في 20% من الحالات المتبقية
    if (!chosenCard || (guessesLeft === 1 && Math.random() < 0.20)) {
        return { action: 'END_TURN' };
    }
    
    // إذا اختار البطاقة القاتلة بالصدفة، سيعيد النظر في 10% من الحالات ويتراجع
    if (chosenCard.type === 'ASSASSIN' && Math.random() < 0.10) {
        return { action: 'END_TURN' };
    }


    if (chosenCard) {
        return { 
            action: 'GUESS',
            cardIndex: chosenCard.index 
        };
    } else {
        return { action: 'END_TURN' };
    }
};

module.exports = { makeAIGuess };