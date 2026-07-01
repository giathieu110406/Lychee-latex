
  const marked = require('marked');
  const katex = require('katex');
  function protectUrls(t) { return { protectedText: t, urls: [] }; }
  function restoreUrls(t) { return t; }
  function applySmartFormatting(t) { return t; }
  function isRealMathLaTeX() { return true; }
  function normalizeLaTeX(t) { return t; }
  function escHtml(t) { return t; }
  function renderContentWithMath (text: string): string => {
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
        let normalized = normalizeLaTeX
          ? normalizeLaTeX(latex.trim(), !isDisplay)
          : latex.trim();
        normalized = restoreUrls(normalized, urls, true);
        const rendered = katex.renderToString(normalized, {
          displayMode: isDisplay,
          output: "html",
          throwOnError: false,
          errorColor: "#f43f5e",
          strict: "ignore",
          trust: true,
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
  const text = '2830 \\href{https://example.com/finance_report?id=100_percent}{\\text{Báo cáo tài chính \\#1}} 2830';
  console.log(renderContentWithMath(text));
  