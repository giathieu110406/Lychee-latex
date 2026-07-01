import { marked } from 'marked';
import katex from 'katex';
  function protectUrls(text: string) { return { protectedText: text, urls: [] }; }
  function restoreUrls(text: string, urls: any, b: boolean) { return text; }
  function escHtml(str: string) { return str; }
  function applySmartFormatting(text: string) { return text; }
  let user = null;
  let toast = null;
  function isRealMathLaTeX(str: string): boolean {
  const content = str.trim();
  if (!content) return false;

  // 1. Ngày tháng dạng DD/MM/YYYY hoặc DD-MM-YYYY hoặc MM/YYYY
  const dateRegex = /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$|^\d{1,2}[/-]\d{2,4}$/;
  if (dateRegex.test(content)) {
    return false;
  }

  // Khử các ký hiệu escape phổ biến trước khi kiểm tra (ví dụ: \% thành %, \$ thành $)
  const cleaned = content.replace(/\\%/g, "%").replace(/\\([$#&_])/g, "$1");

  // 2. Chỉ từ chối số kèm đơn vị đo lường/tiền tệ (ví dụ: 50%, 10kg, 5m/s)
  const numberPlusUnitRegex =
    /^\d+(?:[.,]\d+)*\s*(?:%|đ|VND|VNĐ|USD|EUR|k|tr|m|cm|mm|kg|g|h|s|px)$/i;
  if (numberPlusUnitRegex.test(cleaned)) {
    return false;
  }

  // 3. Từ chối số thập phân (vì thường là văn bản thường, vd: 1.5, 2,5)
  // Số nguyên thuần (0, 1, 2) vẫn sẽ được parse KaTeX bình thường
  const decimalNumberRegex = /^\d+[.,]\d+$/;
  if (decimalNumberRegex.test(cleaned)) {
    return false;
  }

  // 3. Kiểm tra xem chuỗi có chứa chữ Tiếng Việt có dấu viết cách nhau hay không.
  // Nếu có chứa tiếng Việt có dấu và đồng thời KHÔNG chứa các cú pháp toán thực sự của LaTeX (như backslash \, caret ^, subscript _, curly braces {})
  // thì chắc chắn đây là đoạn văn bản chữ thuần chứ không phải LaTeX công thức.
  // Ví dụ: "$Dòng tiền thuần = LNST + Khấu hao + Lãi vay$" có dấu tiếng Việt, không có "\", "^", "_", "{" nên sẽ là văn bản thường.
  const vnAccentsPattern =
    /[áàảãạăắằẳẵặâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđĐ]/;
  if (vnAccentsPattern.test(cleaned)) {
    const hasLatexSyntax = /[\\[\]{}^_]/.test(cleaned);
    if (!hasLatexSyntax) {
      if (cleaned.length > 3 || cleaned.includes(" ")) {
        return false;
      }
    }
  }

  // 4. Nếu chỉ toàn chữ cái thông thường (kể cả Tiếng Việt có dấu), khoảng trắng, không có bất kỳ ký hiệu toán học chuyên dụng nào
  // Các ký hiệu toán học chuyên dụng cần LaTeX: \, ^, _, {, }, +, -, *, /, =, <, >, |, [ ] (trừ khoảng trắng)
  const nonMathTextRegex =
    /^[a-zA-ZĐĂÂÊÔƠƯáàảãạăắằẳẵặâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵ\s]+$/;
  if (nonMathTextRegex.test(cleaned)) {
    // Nếu là biến số đơn lẻ ngắn (như "x", "y", "a", "b", "c", "n") thì thường là biến toán học, vẫn giữ LaTeX.
    // Nếu dài từ 3 ký tự trở lên HOẶC chứa khoảng trắng, thì đó hẳn là từ văn bản thông thường (ví dụ: "$bài toán$").
    if (cleaned.length > 2 || cleaned.includes(" ")) {
      return false;
    }
  }

  return true;
}

export const renderContentWithMath = (input: string, smartNewline: boolean = false) => {
const convertTabTableToMarkdown = (text: string): string => {
    if (!text) return "";
    const lines = text.split("\n");
    const result: string[] = [];
    let inTable = false;
    let tableRows: string[][] = [];

    const renderCurrentTable = (rows: string[][]): string => {
      if (rows.length === 0) return "";
      const maxCols = Math.max(...rows.map((r) => r.length));
      if (maxCols < 2) {
        // If it has only 1 column, it is not a real table, return as plain text lines
        return rows.map((r) => r.join(" ")).join("\n");
      }

      const header = rows[0].map((c) => c || " ");
      while (header.length < maxCols) header.push(" ");

      const separator = Array(maxCols).fill("---");

      let md = "\n| " + header.join(" | ") + " |\n";
      md += "| " + separator.join(" | ") + " |\n";

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i].map((c) => c || " ");
        while (row.length < maxCols) row.push(" ");
        md += "| " + row.join(" | ") + " |\n";
      }
      md += "\n";
      return md;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hasTabs = line.includes("\t");

      if (hasTabs) {
        inTable = true;
        const cols = line.split("\t").map((c) => c.trim());
        tableRows.push(cols);
      } else {
        if (inTable && tableRows.length > 0) {
          result.push(renderCurrentTable(tableRows));
          tableRows = [];
          inTable = false;
        }
        result.push(line);
      }
    }

    if (inTable && tableRows.length > 0) {
      result.push(renderCurrentTable(tableRows));
    }

    return result.join("\n");
  };

  const renderContentWithMath = (text: string): string => {
    if (!text) return "";

    // Bước 1: Normalize input (NFC, loại bỏ BOM, chuẩn hoá smart quotes)
    let normalizedInput = text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/^\uFEFF/, "")
      .normalize("NFC")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\u2013/g, "--")
      .replace(/\u2014/g, "---")
      .replace(/\u2026/g, "...")
      .replace(/\u00A0/g, " ")
      .replace(/\u200B/g, "")
      .replace(/\u200C/g, "");

    // Auto convert tab-separated values pasted from Word/Excel to markdown tables
    let convertedText = convertTabTableToMarkdown(normalizedInput);

    // Protect URLs from being mangled or broken by applySmartFormatting or KaTeX parsing
    const { protectedText, urls } = protectUrls(convertedText);
    let input = protectedText;

    const codeRanges: [number, number][] = [];
    const CODE_BLOCK_REGEX = /```[\s\S]*?```|`[^`\n]+`/g;
    let codeMatch;
    CODE_BLOCK_REGEX.lastIndex = 0;
    while ((codeMatch = CODE_BLOCK_REGEX.exec(input)) !== null) {
      codeRanges.push([codeMatch.index, codeMatch.index + codeMatch[0].length]);
    }

    const DISPLAY_MATH_REGEX =
      "\\$\\$([\\s\\S]*?)\\$\\$|\\\\\\[([\\s\\S]*?)\\\\\\]|\\\\begin\\{(equation|align|gather|multline|eqnarray|alignat|flalign|split|cases|aligned|alignedat|pmatrix|bmatrix|vmatrix|Bmatrix|Vmatrix|matrix|array)(\\*?)\\}([\\s\\S]*?)\\\\end\\{\\3\\4\\}";
    const INLINE_MATH_REGEX =
      "(?<!\\$)\\$(?!\\$)((?:[^$\\n\\\\]|\\\\[\\s\\S])*?)(?<!\\$)\\$(?!\\$)";
    const INLINE_PAREN_REGEX = "\\\\\\([\\s\\S]*?\\\\\\)";

    const MATH_COMBINED_RE = new RegExp(
      `${DISPLAY_MATH_REGEX}|${INLINE_PAREN_REGEX}|${INLINE_MATH_REGEX}`,
      "g",
    );

    const mathBlocks: string[] = [];
    let mdText = "";
    let lastIdx = 0;
    let m;

    MATH_COMBINED_RE.lastIndex = 0;
    while ((m = MATH_COMBINED_RE.exec(input)) !== null) {
      const isInsideCode = codeRanges.some(
        ([start, end]) => m!.index >= start && m!.index < end,
      );

      if (isInsideCode) {
        if (m.index > lastIdx) {
          mdText += input.slice(lastIdx, m.index + m[0].length);
        } else if (m.index === lastIdx) {
          mdText += m[0];
        }
        lastIdx = m.index + m[0].length;
        continue;
      }

      if (m.index > lastIdx) {
        mdText += input.slice(lastIdx, m.index);
      }

      const raw = m[0];
      const isDisplay =
        raw.startsWith("$$") ||
        raw.startsWith("\\[") ||
        raw.startsWith("\\begin");
      let latex = "";

      if (raw.startsWith("$$")) latex = raw.slice(2, -2);
      else if (raw.startsWith("\\[")) latex = raw.slice(2, -2);
      else if (raw.startsWith("\\(")) latex = raw.slice(2, -2);
      else if (raw.startsWith("\\begin"))
        latex = raw; // KaTeX cần toàn bộ thẻ \begin...\end
      else latex = raw.slice(1, -1);

      // Nếu không phải là block math và là inline math bọc bởi dấu '$' đơn
      // đồng thời nội dung bên trong KHÔNG PHẢI là một công thức toán thực sự (ví dụ: chỉ là số 10, 20%, ngày tháng, bài toán...)
      if (!isDisplay && raw.startsWith("$") && !isRealMathLaTeX(latex)) {
        mdText += "$";
        MATH_COMBINED_RE.lastIndex = m.index + 1;
        lastIdx = m.index + 1;
        continue;
      }

      let mathHtml = "";
      try {
        const normalized = normalizeLaTeX
          ? normalizeLaTeX(latex.trim(), !isDisplay)
          : latex.trim();
        const rendered = katex.renderToString(normalized, {
          displayMode: isDisplay,
          output: "html",
          throwOnError: false,
          errorColor: "#f43f5e",
          strict: "ignore", trust: true,
        });

        const tag = "span";
        mathHtml = `<${tag} class="katex-custom-wrapper" data-latex="${escHtml(normalized)}" data-display="${isDisplay}" style="${isDisplay ? "display: block; text-align: center; margin: 0.8em 0;" : ""}">${rendered}</${tag}>`;
      } catch (e: any) {
        mathHtml = `<span style="color:#f43f5e">${escHtml(raw)}</span>`;
      }

      const blockIdx = mathBlocks.length;
      mathBlocks.push(mathHtml);
      mdText += `@@@MATH_BLOCK_${blockIdx}@@@`;
      lastIdx = m.index + raw.length;
    }

    if (lastIdx < input.length) {
      mdText += input.slice(lastIdx);
    }

    if (smartNewline) {
      mdText = applySmartFormatting(mdText);
    }

    // Standard Vietnamese cleanup space rules
    mdText = mdText.replace(
      /(?:[\s\u00a0\u200b]|&nbsp;)+([.,;:!?\)\}\]”’"`])/g,
      "$1",
    );

    // Restore URLs with linkification for bare ones just before passing to marked.parse
    mdText = restoreUrls(mdText, urls, false);

    // Parse Markdown synchronously using marked
    let htmlContent = "";
    try {
      htmlContent = marked.parse(mdText) as string;
    } catch {
      htmlContent = mdText;
    }

    // Ensure all links open in a new tab and are styled beautifully
    htmlContent = htmlContent.replace(
      /<a\s+href=/g,
      '<a target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline cursor-pointer font-medium" href=',
    );

    // Standard Vietnamese cleanup in HTML elements
    htmlContent = htmlContent.replace(
      /(<\/?[^>]+>)?(?:[\s\u00a0\u200b]|&nbsp;)+([.,;:!?\)\}\]”’"`])/g,
      (match, tag, punc) => {
        return (tag || "") + punc;
      },
    );

    // Replace equations back an toàn không tiêu thụ ký tự kế tiếp
    htmlContent = htmlContent.replace(
      /@@@MATH_BLOCK_(\d+)@@@/g,
      (match, idStr, offset, fullStr) => {
        const block = mathBlocks[+idStr] || "";
        if (!block) return "";
        const isDisplay = block.includes('data-display="true"');
        if (isDisplay) return block;
        // Thêm khoảng cách nếu inline math liền kề với từ thông thường phía sau
        const nextSlice = fullStr.slice(offset + match.length);
        const nextWordMatch = nextSlice.match(/^(?:[\s\u00a0\u200b]|&nbsp;)*([^.,;:!?\)\}\]”’"`\s<@])/);
        if (nextWordMatch && !nextSlice.startsWith(" ")) {
          return block + " ";
        }
        return block;
      },
    );

    return htmlContent;
  };