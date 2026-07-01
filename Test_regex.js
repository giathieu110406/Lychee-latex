// Giả lập applySmartFormatting từ App.tsx
function protectUrls(text) {
  return { protectedText: text, urls: [] };
}
function restoreUrls(text, urls, force) {
  return text;
}

function applySmartFormatting(text) {
  if (!text) return "";

  const { protectedText, urls } = protectUrls(text);
  let formatted = protectedText;

  const capWords = "[\\p{Lu}][\\p{Ll}\\p{M}]+";
  const mathPattern = new RegExp("(\\$[^$\\n]+?\\$)(" + capWords + ")", "gu");
  formatted = formatted.replace(mathPattern, "$1\n$2");

  const puncPattern = new RegExp("([.:!?]|\\))(" + capWords + ")", "gu");
  formatted = formatted.replace(puncPattern, "$1\n$2");

  const commaPattern = new RegExp(
    "([,;])(" + capWords + "|[\\p{Ll}\\p{M}]+)",
    "gu"
  );
  formatted = formatted.replace(commaPattern, "$1 $2");

  const letterPatternStr = "[\\p{L}\\p{M}]";

  const letterDigitPattern = new RegExp(
    "(" + letterPatternStr + "{2,})(\\d)",
    "gu"
  );
  formatted = formatted.replace(letterDigitPattern, "$1 $2");

  const digitLetterPattern = new RegExp(
    "(\\d%?)(" + letterPatternStr + "{2,})",
    "gu"
  );
  formatted = formatted.replace(digitLetterPattern, "$1 $2");

  const wordOpenQuotePattern = new RegExp(
    "(" + letterPatternStr + '|\\d)(["“])',
    "gu"
  );
  formatted = formatted.replace(wordOpenQuotePattern, "$1 $2");

  const closeQuoteWordPattern = new RegExp(
    '(["”])(' + letterPatternStr + "|\\d|[(“])",
    "gu"
  );
  formatted = formatted.replace(closeQuoteWordPattern, "$1 $2");

  const wordOpenParenPattern = new RegExp(
    "(" + letterPatternStr + "|\\d|%|\\))(\\()",
    "gu"
  );
  formatted = formatted.replace(wordOpenParenPattern, "$1 $2");

  const closeParenWordPattern = new RegExp(
    "(\\))(" + letterPatternStr + "{2,})",
    "gu"
  );
  formatted = formatted.replace(closeParenWordPattern, "$1 $2");

  const letterMathStartPattern = new RegExp(
    "(" + letterPatternStr + "|\\d|%)(\\${1,2})",
    "gu"
  );
  formatted = formatted.replace(letterMathStartPattern, "$1 $2");

  const mathEndLetterPattern = new RegExp(
    "(\\${1,2})(" + letterPatternStr + "{2,})",
    "gu"
  );
  formatted = formatted.replace(mathEndLetterPattern, "$1 $2");

  // 11. Sửa lỗi in đậm thiếu dấu sao ở đầu: *chữ** -> **chữ**
  formatted = formatted.replace(/(?<!\*)\*(?!\*)([^\*\s\n][^\*\n]*?)\*\*/g, '**$1**');
  
  // 12. Sửa lỗi in đậm thiếu dấu sao ở cuối: **chữ* -> **chữ**
  formatted = formatted.replace(/\*\*([^\*\n]*?[^\*\s\n])(?<!\*)\*(?!\*)/g, '**$1**');

  // 13. Sửa khoảng trắng thừa sát dấu in đậm: ** chữ ** -> **chữ**
  formatted = formatted.replace(/\*\*\s+(.*?)\s+\*\*/g, '**$1**');

  return restoreUrls(formatted, urls, true);
}

const input = `- **Phương trình bậc hai và nghiệm:**
$$\\Delta = b^2 - 4 ac $$$$x_{1,2} = \\frac{-b \\pm \\sqrt{\\Delta}}{2a}$$

- **Tích phân xác định (Tính diện tích hình phẳng):**
$$\\int_{a}^{b} f (x) \\, dx = F (b) - F (a)$$`;

console.log("Original Input:");
console.log(input);
console.log("=========================================");
const output = applySmartFormatting(input);
console.log("Output of applySmartFormatting:");
console.log(output);
