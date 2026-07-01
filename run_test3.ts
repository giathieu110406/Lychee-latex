import { renderContentWithMath } from './test_render3';

const math = `$$\\text{Tỷ lệ tăng trưởng } (g) = \\left[ \\frac{\\text{Giá trị}_{\\text{cuối}} - \\text{Giá trị}_{\\text{đầu}}}{\\text{Giá trị}_{\\text{đầu}}} \\right] \\times 100\\% \\quad \\text{Tham khảo tại: } \\href{https://example.com/finance_report?id=100_percent}{\\text{Báo cáo tài chính \\#1}}$$`;
const res = renderContentWithMath(math);
console.log(res);
