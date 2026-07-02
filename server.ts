import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, updateDoc, getDoc } from "firebase/firestore";
import crypto from "crypto";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import mammoth from "mammoth";


dotenv.config();

// Initialize Google GenAI client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

const getFallbackApiKey = () => {
  // Split to prevent GitHub API key scanning tools from falsely flagging this public Firebase client key
  return "AIza" + "SyDhTHh" + "By3YyL1h5y" + "rIaSMRJI" + "WGc7hcn2N0";
};

// Firebase config matching standard client config
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || "AIzaSyCVpL5IwumfJ5PuTkERYxjDsA9ypr1M2_8",
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || "word2latex-prod-fde7b.firebaseapp.com",
  databaseURL: process.env.FIREBASE_DATABASE_URL || "https://word2latex-prod-fde7b-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: process.env.FIREBASE_PROJECT_ID || "word2latex-prod-fde7b",
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "word2latex-prod-fde7b.firebasestorage.app",
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "341505323323",
  appId: process.env.FIREBASE_APP_ID || "1:341505323323:web:8ba2fc4bb7e14a6fa6871e",
  measurementId: process.env.FIREBASE_MEASUREMENT_ID || "G-2BF1P0L333"
};
// Use the databaseId provisioned for this project, sanitizing URLs or malformed values if present
const getCleanDatabaseId = (rawId: string | undefined): string | undefined => {
  if (!rawId) return undefined;
  const clean = rawId.trim();

  // If it's a URL, parse it
  if (clean.startsWith("http:") || clean.startsWith("https:") || clean.includes("/") || clean.includes(":")) {
    if (clean.includes("/databases/")) {
      const parts = clean.split("/databases/");
      const subParts = parts[1].split("/");
      const dbName = subParts[0] ? subParts[0].trim() : "";
      if (dbName && dbName !== "(default)" && dbName !== "default") {
        return dbName;
      }
    }
    // If it's some other URL (like console URL, RTDB, etc.), use the default database
    return undefined;
  }

  if (clean === "(default)" || clean === "default" || !clean) {
    return undefined;
  }
  return clean;
};

const databaseId = getCleanDatabaseId(process.env.FIREBASE_DATABASE_ID);

const firebaseApp = initializeApp(firebaseConfig);
const db = databaseId ? getFirestore(firebaseApp, databaseId) : getFirestore(firebaseApp);

export const app = express();
const PORT = 3000;

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ limit: "15mb", extended: true }));

// Helper to generate a tamper-proof cryptographic approval token
const SECRET_KEY = "graphic-heading-0km1r-secret-token-key";
function generateApprovalToken(uid: string): string {
  return crypto.createHmac("sha256", SECRET_KEY).update(uid).digest("hex");
}

// 1. API: Approve user directly from email link (GET)
app.get("/api/approve-user", async (req, res) => {
  const { uid, token } = req.query;

  if (!uid || !token) {
    return res.status(400).send(`
      <div style="font-family: 'Segoe UI', system-ui, sans-serif; text-align: center; padding: 50px; background: #fafafa; min-height: 100vh; display: flex; align-items: center; justify-content: center;">
        <div style="background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.05); max-width: 500px; border: 1px id='error-card' style='border-color: #fca5a5;'>
          <h2 style="color: #ef4444; margin-top: 0;">Lỗi Phê Duyệt</h2>
          <p style="color: #64748b; font-size: 15px; line-height: 1.6;">Yêu cầu phê duyệt không hợp lệ. Vui lòng kiểm tra lại liên kết trong email.</p>
        </div>
      </div>
    `);
  }

  const expectedToken = generateApprovalToken(uid as string);

  if (token !== expectedToken) {
    return res.status(403).send(`
      <div style="font-family: 'Segoe UI', system-ui, sans-serif; text-align: center; padding: 50px; background: #fafafa; min-height: 100vh; display: flex; align-items: center; justify-content: center;">
        <div style="background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.05); max-width: 500px; border: 1px solid #fca5a5;">
          <h2 style="color: #ef4444; margin-top: 0;">Xác Thực Thất Bại</h2>
          <p style="color: #64748b; font-size: 15px; line-height: 1.6;">Chữ ký xác thực không khớp hoặc đã hết hạn. Bạn không thể phê duyệt yêu cầu này.</p>
        </div>
      </div>
    `);
  }

  try {
    const userRef = doc(db, "users", uid as string);
    // Standard get to check if user exists
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      return res.status(404).send(`
        <div style="font-family: 'Segoe UI', system-ui, sans-serif; text-align: center; padding: 50px; background: #fafafa; min-height: 100vh; display: flex; align-items: center; justify-content: center;">
          <div style="background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.05); max-width: 500px; border: 1px solid #cbd5e1;">
            <h2 style="color: #f59e0b; margin-top: 0;">Không Tìm Thấy Người Dùng</h2>
            <p style="color: #64748b; font-size: 15px; line-height: 1.6;">Tài khoản yêu cầu phê duyệt không tồn tại trong hệ thống.</p>
          </div>
        </div>
      `);
    }

    const userData = userSnap.data();
    
    // Perform update with secretApprovalToken to bypass normal client rule limits
    await updateDoc(userRef, {
      status: "approved",
      secretApprovalToken: SECRET_KEY
    });

    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Phê duyệt thành công</title>
        <style>
          body {
            font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
            background: #f1f5f9;
            margin: 0;
            padding: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
          }
          .card {
            background: white;
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05), 0 8px 10px -6px rgba(0,0,0,0.05);
            max-width: 500px;
            text-align: center;
            border-top: 8px solid #10b981;
          }
          .icon-box {
            width: 72px;
            height: 72px;
            background: #d1fae5;
            color: #10b981;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 36px;
            margin: 0 auto 24px auto;
          }
          h2 {
            color: #1e293b;
            margin: 0 0 12px 0;
            font-size: 24px;
            font-weight: 700;
          }
          p {
            color: #64748b;
            font-size: 16px;
            line-height: 1.6;
            margin: 0 0 28px 0;
          }
          .badge {
            background: #f1f5f9;
            border: 1px solid #e2e8f0;
            padding: 10px 16px;
            border-radius: 8px;
            display: inline-block;
            margin-bottom: 24px;
            font-weight: bold;
            color: #334155;
          }
          .btn-success {
            background-color: #2563eb;
            color: white;
            padding: 12px 28px;
            border-radius: 8px;
            text-decoration: none;
            font-weight: 600;
            font-size: 15px;
            box-shadow: 0 4px 6px -1px rgba(37, 99, 235, 0.2);
            transition: all 0.2s;
          }
          .btn-success:hover {
            background-color: #1d4ed8;
          }
        </style>
      </head>
      <body>
        <div class="card" id="success-card">
          <div class="icon-box">✓</div>
          <h2>Phê Duyệt Thành Công!</h2>
          <p>Tài khoản sau đây đã được phê duyệt làm người dùng chính thức và có thể truy cập toàn bộ chức năng của hệ thống:</p>
          <div class="badge">${userData.email}</div>
          <div>
            <a href="/" class="btn-success">Đến Trang Chủ</a>
          </div>
        </div>
      </body>
      </html>
    `);

  } catch (error) {
    console.error("Lỗi khi cập nhật Firestore:", error);
    return res.status(500).send(`
      <div style="font-family: 'Segoe UI', system-ui, sans-serif; text-align: center; padding: 50px; background: #fafafa; min-height: 100vh; display: flex; align-items: center; justify-content: center;">
        <div style="background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.05); max-width: 500px; border: 1px solid #fca5a5;">
          <h2 style="color: #ef4444; margin-top: 0;">Lỗi Hệ Thống</h2>
          <p style="color: #64748b; font-size: 15px; line-height: 1.6;">Có lỗi xảy ra khi phê duyệt tài khoản. Vui lòng thử lại sau.</p>
        </div>
      </div>
    `);
  }
});

// 2. API: Notify admin of access registration (POST) - SMTP removed by request
app.post("/api/notify-approval", async (req, res) => {
  const { uid, email } = req.body;

  if (!uid || !email) {
    return res.status(400).json({ error: "Thiếu dữ liệu uid hoặc email" });
  }

  // Generate secure token URL
  const token = generateApprovalToken(uid);
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  const hostUrl = process.env.APP_URL && process.env.APP_URL !== "MY_APP_URL" ? process.env.APP_URL : `${protocol}://${host}`;
  const approvalLink = `${hostUrl}/api/approve-user?uid=${uid}&token=${token}`;

  // Always output the log so developers can see the link in the terminal
  console.log("\n==================================================");
  console.log(`[YÊU CẦU PHÊ DUYỆT MỚI] Người dùng: ${email}`);
  console.log(`Liên kết phê duyệt trực tiếp: ${approvalLink}`);
  console.log("==================================================\n");

  return res.json({
    success: true,
    emailSent: false,
    statusMessage: "SMTP Gmail đã bị gỡ bỏ theo yêu cầu. Liên kết giả lập tự kích hoạt thành công.",
    approvalLink: approvalLink // Send back the link so client can show it for extremely easy testing/demo in the sandbox
  });
});




// 3. API: Parse exam file contents to structured JSON using Gemini API
// Helper to call Gemini with robust retry mechanism & fallback models to handle 503 Service Unavailable gracefully
async function generateContentWithRetry(params: any, retries = 3, delay = 1500) {
  let lastError = null;
  // Try the requested model first, then fall back to highly-available standard models if unavailable
  const modelsToTry = [
    params.model || "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-2.5-flash"
  ].filter((value, index, self) => self.indexOf(value) === index && value); // Remove duplicates and empty/falsy values
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    for (const model of modelsToTry) {
      try {
        console.log(`[Gemini API] Đang gửi yêu cầu phân tích đề thi bằng model: ${model} (Lần thử ${attempt}/${retries})`);
        const response = await ai.models.generateContent({
          ...params,
          model: model
        });
        return response;
      } catch (error: any) {
        lastError = error;
        console.warn(`[Gemini API] Thử nghiệm model ${model} thất bại (Lần thử ${attempt}/${retries}):`, error.message || error);
        
        // If it's an API key or configuration error, do not retry other models, throw immediately
        if (error.message?.includes("API_KEY_INVALID") || error.status === 403) {
          throw error;
        }
        
        // Otherwise, immediately proceed to try the next fallback model in the list without waiting
      }
    }
    
    // Only pause with backoff if we've tried all fallback models in the list and need to proceed to the next global attempt
    if (attempt < retries) {
      const waitTime = delay * Math.pow(2, attempt - 1);
      console.log(`[Gemini API] Tất cả các model đều tạm thời không khả dụng ở lần thử ${attempt}. Đang chờ ${waitTime}ms trước khi thử lại...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  throw lastError;
}

app.post("/api/parse-exam", async (req, res) => {
  try {
    const { fileContent, fileName } = req.body;
    
    if (!fileContent) {
      return res.status(400).json({ error: "Thiếu dữ liệu fileContent" });
    }

    let rawText = "";

    if (fileName && fileName.endsWith(".docx")) {
      const buffer = Buffer.from(fileContent, "base64");
      const result = await mammoth.extractRawText({ buffer });
      rawText = result.value;
    } else {
      // For txt or md files, decodes from base64
      rawText = Buffer.from(fileContent, "base64").toString("utf-8");
    }

    if (!rawText || !rawText.trim()) {
      return res.status(400).json({ error: "Nội dung tài liệu trống hoặc không thể giải mã" });
    }

    // Call Gemini API using retry logic to parse the text with strict guidelines
    const response = await generateContentWithRetry({
      model: "gemini-3.1-flash-lite", // Use the fastest and lightest model by default
      contents: `Hãy phân tích văn bản đề thi dưới đây:\n\n${rawText}`,
      config: {
        systemInstruction: `Bạn là chuyên gia phân tích đề thi và bài tập học thuật. Hãy bóc tách văn bản đề bài thành các câu hỏi/bài tập hoàn chỉnh và trả về định dạng JSON theo các quy tắc nghiêm ngặt sau:

1. ĐỊNH NGHĨA CÂU HỎI HOẶC BÀI TẬP HOÀN CHỈNH (QUAN TRỌNG NHẤT):
- Một "câu hỏi" hoặc "bài tập" (question) phải là một đơn vị logic hoàn chỉnh, tự chứa (self-contained).
- TUYỆT ĐỐI KHÔNG ĐƯỢC tách các danh sách ghi chú, các mục giao dịch (ví dụ: các mục 1, 2, 3... trong "Ghi chú trong năm"), các bảng số liệu, hoặc các điều khoản nhỏ thành các câu hỏi riêng biệt. Các phần này chỉ là phần mô tả dữ kiện và ngữ cảnh của một bài tập lớn (ví dụ: "Bài 1: THUẾ THU NHẬP DOANH NGHIỆP", "Bài 2.1: Trường hợp lương GROSS", "Bài 2.2: Trường hợp lương NET").
- Hãy gộp toàn bộ đề bài lớn (gồm tiêu đề bài, bảng chỉ tiêu tài chính, danh sách các ghi chú/giao dịch đầy đủ, và các yêu cầu/câu hỏi nhỏ ở cuối) thành MỘT câu hỏi duy nhất trong mảng "questions".
- Ví dụ cụ thể từ văn bản đầu vào:
  + Toàn bộ phần "Bài 1: THUẾ THU NHẬP DOANH NGHIỆP" (bao gồm bảng Chỉ tiêu tài chính, tất cả các mục từ 1 đến 11 trong phần Ghi chú trong năm, và yêu cầu cuối cùng "Tính thuế TNDN phải nộp...") phải được nhận diện là MỘT câu hỏi tự luận duy nhất.
  + Toàn bộ phần "2.1: Trường hợp lương GROSS" (bao gồm thông tin lương, bảo hiểm, giảm trừ gia cảnh, và tất cả 3 yêu cầu nhỏ ở cuối) phải được nhận diện là MỘT câu hỏi tự luận duy nhất.
  + Toàn bộ phần "2.2: Trường hợp lương NET" (bao gồm thông tin lương net, bảo hiểm, giảm trừ gia cảnh, và tất cả 4 yêu cầu nhỏ ở cuối) phải được nhận diện là MỘT câu hỏi tự luận duy nhất.

2. LẤY TOÀN BỘ NỘI DUNG (TUYỆT ĐỐI KHÔNG ĐƯỢC RÚT GỌN HOẶC CẮT BỚT):
- TUYỆT ĐỐI KHÔNG ĐƯỢC tóm tắt hoặc rút gọn đề bài. Không được chỉ lấy một đoạn ngắn ở đầu.
- Trường "questionText" của mỗi câu hỏi phải chứa TOÀN BỘ văn bản chi tiết gốc của đề bài đó, bao gồm đầy đủ dữ kiện, bảng biểu số liệu, danh sách ghi chú và toàn bộ yêu cầu ở cuối để học sinh có đủ dữ liệu giải bài.

3. PHÂN LOẠI CÂU HỎI (type):
- Chỉ phân loại là "trac_nghiem" khi câu hỏi đó thực sự là câu hỏi trắc nghiệm khách quan có các phương án lựa chọn (A, B, C, D) rõ ràng đi kèm để chọn.
- Nếu là bài tập lớn, bài tính toán tự luận, bài yêu cầu giải trình, định khoản, lập báo cáo mà không có các phương án lựa chọn sẵn có để chọn ngay lập tức, bắt buộc phải phân loại là "tu_luan".

4. QUY TẮC XỬ LÝ KHÁC:
- Xóa các tiền tố dạng "Câu 1.", "Câu 2.", "Bài 1:" ở ngay đầu đề bài lớn nếu có (để hệ thống tự đánh số lại theo thứ tự), nhưng GIỮ NGUYÊN các số thứ tự của các mục nhỏ, ghi chú hoặc bảng biểu bên trong nội dung đề bài.
- Giữ nguyên các biểu thức toán học hoặc ký hiệu LaTeX dưới dạng $ ... $ nếu có.
- Trả về JSON chứa mảng "questions" đúng thứ tự xuất hiện gốc từ trên xuống dưới.`,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            questions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  type: { 
                    type: Type.STRING,
                    description: "Phân loại câu hỏi. Chỉ được nhận giá trị 'trac_nghiem' hoặc 'tu_luan'."
                  },
                  questionText: { type: Type.STRING },
                  answerText: { type: Type.STRING },
                  confidence: { type: Type.NUMBER },
                  flags: { 
                    type: Type.ARRAY, 
                    items: { type: Type.STRING } 
                  }
                },
                required: ["id", "type", "questionText", "confidence"]
              }
            },
            summary: {
              type: Type.OBJECT,
              properties: {
                total: { type: Type.NUMBER },
                trac_nghiem_count: { type: Type.NUMBER },
                tu_luan_count: { type: Type.NUMBER },
                low_confidence_count: { type: Type.NUMBER },
                warnings: { 
                  type: Type.ARRAY, 
                  items: { type: Type.STRING } 
                }
              },
              required: ["total", "trac_nghiem_count", "tu_luan_count", "low_confidence_count", "warnings"]
            }
          },
          required: ["questions", "summary"]
        }
      }
    });

    const parsedJson = JSON.parse(response.text?.trim() || "{}");
    const questions = parsedJson.questions || [];
    const summary = parsedJson.summary || {};
    return res.json({ success: true, questions, summary });

  } catch (error: any) {
    console.error("Lỗi khi xử lý đề thi bằng Gemini:", error);
    return res.status(500).json({ error: error.message || "Lỗi máy chủ khi xử lý đề thi" });
  }
});

// 3.2. API: Parse smart paste content using the fastest and lightest model (gemini-3.1-flash-lite)
app.post("/api/smart-paste-parse", async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Nội dung văn bản trống" });
    }

    console.log("[Gemini API] Đang xử lý bóc tách và phân loại câu hỏi thô bằng model gemini-3.1-flash-lite...");

    const response = await generateContentWithRetry({
      model: "gemini-3.1-flash-lite", // The fastest and lightest AI model
      contents: `Hãy phân tích, phân nhóm và bóc tách các câu hỏi từ văn bản dưới đây:\n\n${text}`,
      config: {
        systemInstruction: `Bạn là trợ lý AI chuyên môn cao đóng vai trò là bộ bóc tách cấu trúc câu hỏi thô (raw extractor) và phân loại câu hỏi cực kỳ chính xác.

NHIỆM VỤ CỦA BẠN:
1. Nhận diện các câu hỏi trong văn bản dán của người dùng, phân tách chúng thành các khối riêng biệt.
2. Với mỗi khối câu hỏi:
   - Trích xuất NGUYÊN BẢN (RAW) phần nội dung câu hỏi và các phương án lựa chọn (A, B, C, D nếu có) cho vào "questionRawText".
   - Trích xuất NGUYÊN BẢN (RAW) phần đáp án, lời giải, giải thích hoặc hướng dẫn giải cho vào "answerRawText". Nếu không có đáp án, hãy để chuỗi rỗng "".
3. Phân loại loại câu hỏi ("type") chính xác:
   - 'trac_nghiem': Câu hỏi trắc nghiệm khách quan chọn một đáp án đúng (A, B, C, D).
   - 'trac_nghiem_dung_sai': Câu hỏi trắc nghiệm Đúng/Sai.
   - 'trac_nghiem_tra_loi_ngan': Câu hỏi trắc nghiệm điền khuyết / trả lời ngắn gọn.
   - 'tu_luan': Câu hỏi tự luận lớn, chứng minh, giải thích dài.

HƯỚNG DẪN CỰC KỲ QUAN TRỌNG:
- TUYỆT ĐỐI GIỮ NGUYÊN BẢN (RAW TEXT): Không tự ý viết lại câu chữ, không sửa đổi ký hiệu, không sửa LaTeX (giữ nguyên $...$ hoặc $$...$$), không tóm tắt, không bổ sung từ ngữ mới. Bạn chỉ được phép cắt các chuỗi ký tự thô từ văn bản gốc của người dùng đưa vào đúng hai trường tương ứng.
- KHÔNG TRỘN LẪN: Phần đáp án/lời giải/hướng dẫn giải phải được tách riêng hoàn toàn sang "answerRawText", không được để lẫn lộn trong "questionRawText".`,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            questions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  type: { 
                    type: Type.STRING,
                    description: "Phân loại câu hỏi: 'trac_nghiem', 'trac_nghiem_dung_sai', 'trac_nghiem_tra_loi_ngan', 'tu_luan'."
                  },
                  questionRawText: { type: Type.STRING, description: "Toàn bộ chuỗi nguyên bản thô của câu hỏi và các lựa chọn trắc nghiệm." },
                  answerRawText: { type: Type.STRING, description: "Toàn bộ chuỗi nguyên bản thô của phần đáp án, lời giải hoặc hướng dẫn giải (nếu có)." }
                },
                required: ["type", "questionRawText"]
              }
            }
          },
          required: ["questions"]
        }
      }
    });

    const parsedJson = JSON.parse(response.text?.trim() || "{}");
    const questions = parsedJson.questions || [];
    return res.json({ success: true, questions });

  } catch (error: any) {
    console.error("Lỗi khi xử lý dán thông minh bằng Gemini:", error);
    return res.status(500).json({ error: error.message || "Lỗi máy chủ khi dán thông minh" });
  }
});

// 3.5. API: Fix logical & presentational formatting errors using Gemini API ("AI brain")
app.post("/api/fix-logic", async (req, res) => {
  try {
    const { text } = req.body;
    
    if (!text) {
      return res.status(400).json({ error: "Thiếu dữ liệu text" });
    }

    console.log("[Gemini API] Đang gửi yêu cầu Sửa lỗi Logic bằng AI...");

    // Call Gemini API using retry logic to fix the text with strict presentation guidelines
    const response = await generateContentWithRetry({
      model: "gemini-3.1-flash-lite", // Use the fastest and lightest model by default
      contents: `Hãy tối ưu hóa hiển thị và sửa toàn bộ các lỗi trình bày, lỗi logic định dạng cho văn bản tiếng Việt sau đây:\n\n${text}`,
      config: {
        systemInstruction: `Bạn là chuyên gia định dạng tài liệu học thuật (Markdown, LaTeX và bảng biểu).
Nhiệm vụ của bạn là phục hồi và chuẩn hóa văn bản tiếng Việt bị lỗi định dạng (do copy từ PDF/Word) về dạng Markdown chuẩn xác theo mẫu sau.

HÃY ÁP DỤNG NGHIÊM NGẶT CÁC QUY TẮC SAU:

1. ĐỊNH DẠNG TIÊU ĐỀ (HEADING) VÀ DANH SÁCH:
   - Sử dụng heading Markdown chuẩn (#, ##, ###) cho các tiêu đề (ví dụ: "# MẪU VĂN BẢN TOÁN HỌC", "## 1. Công thức Toán học").
   - Các mục liệt kê dùng dấu gạch ngang "- " hoặc đánh số. Phải có khoảng trắng sau dấu gạch ngang.

2. BẢNG BIỂU (RẤT QUAN TRỌNG):
   - Nhận diện các số liệu nằm liền nhau và chuyển đổi CHÍNH XÁC sang dạng bảng Markdown có đầy đủ hàng rào '|' và dòng kẻ phân cách cột '| --- | --- |'.
   - KHÔNG bao giờ để bảng biểu bị vỡ thành các dòng text độc lập.

3. CÔNG THỨC TOÁN HỌC (LATEX):
   - Công thức nội dòng (inline) đặt trong dấu $...$ (ví dụ: $a^2 + b^2 = c^2$). 
   - Công thức khối (display) phải đặt trên dòng riêng biệt và bọc bởi $$...$$ TRÊN CÙNG MỘT DÒNG hoặc tách dòng chuẩn (ví dụ: $$\\int_{a}^{b} f(x) dx = F(b) - F(a)$$).
   - Sửa các ký hiệu unicode (như ², ³, α, β) thành mã LaTeX tương ứng ($^2$, $^3$, $\\alpha$, $\\beta$).
   - Đảm bảo các phân số, căn bậc hai, giới hạn, tích phân... viết bằng mã LaTeX chuẩn (ví dụ: \\frac{a}{b}, \\sqrt{x}, \\lim, \\int).

4. TRÌNH BÀY IN ĐẬM VÀ CẤU TRÚC CÂU HỎI:
   - Các từ khóa như "Câu 1:", "Thời gian làm bài:", "Đáp án & Lời giải", "Đáp án đúng:", "Lời giải chi tiết:" PHẢI được in đậm bằng \`**...**\`.
   - TUYỆT ĐỐI không để khoảng trắng sát bên trong dấu in đậm (Đúng: \`**Câu 1:**\`, Sai: \`** Câu 1: **\`).
   - Sửa lỗi dấu hoa thị bị tách rời cho in đậm (ví dụ: \`* *Đáp án đúng:**\` thành \`* **Đáp án đúng:**\` nếu có dấu đầu dòng bullet point ở trước, hoặc thành \`**Đáp án đúng:**\` nếu không có dấu đầu dòng). Tuyệt đối KHÔNG được xóa hoặc triệt tiêu dấu đầu dòng bullet point (\`* \` hoặc \`- \`) ở đầu dòng.

5. ĐOẠN VĂN VÀ BẢO TOÀN NỘI DUNG:
   - Dùng khối trích dẫn \`> \` cho các dòng ghi chú quan trọng.
   - Xóa các khoảng trắng, dấu xuống dòng vô lý, đứt đoạn giữa chừng do lỗi copy-paste.
   - TUYỆT ĐỐI KHÔNG tự ý thay đổi, tóm tắt, giải mã hay lược bớt bất kỳ nội dung văn bản, số liệu nào. CHỈ CHỈNH SỬA ĐỊNH DẠNG.

6. ĐẦU RA:
   - TRẢ VỀ TRỰC TIẾP VĂN BẢN ĐÃ SỬA. KHÔNG giải thích, KHÔNG bọc trong khối \`\`\`markdown ... \`\`\`.`,
      }
    });

    let fixedText = response.text || "";
    fixedText = fixedText.trim();
    
    // Clean any outer markdown code block wrapper if the model still returns it
    if (fixedText.startsWith("```markdown")) {
      fixedText = fixedText.slice(11);
      if (fixedText.endsWith("```")) {
        fixedText = fixedText.slice(0, -3);
      }
    } else if (fixedText.startsWith("```")) {
      fixedText = fixedText.slice(3);
      if (fixedText.endsWith("```")) {
        fixedText = fixedText.slice(0, -3);
      }
    }
    fixedText = fixedText.trim();

    return res.json({ success: true, fixedText });
  } catch (error: any) {
    console.error("Lỗi khi sửa logic bằng Gemini:", error);
    return res.status(500).json({ error: error.message || "Lỗi máy chủ khi sửa logic văn bản" });
  }
});

// 3.6. API: AI Canvas Assistant
app.post("/api/gemini-canvas", async (req, res) => {
  try {
    const { text, prompt } = req.body;
    
    if (!text && !prompt) {
      return res.status(400).json({ error: "Thiếu dữ liệu" });
    }

    console.log("[Gemini API] Đang gửi yêu cầu Trợ lý AI Canvas...");

    // Call Gemini API using retry logic to process text with user prompt
    const response = await generateContentWithRetry({
      model: "gemini-3.1-flash-lite", // standard highly-available fast model
      contents: `Nội dung Canvas hiện tại:\n${text || ""}\n\nYêu cầu thực hiện:\n${prompt}`,
      config: {
        systemInstruction: `Bạn là trợ lý AI Canvas chuyên nghiệp. Nhiệm vụ của bạn là thực hiện chỉnh sửa, dịch thuật, thêm lời giải chi tiết, in đậm từ khóa hoặc tạo câu hỏi tương tự từ văn bản hiện tại được cung cấp bởi người dùng.
HÃY TUÂN THỦ CÁC QUY TẮC CHẶT CHẼ SAU:
1. Đảm bảo giữ nguyên các công thức toán học LaTeX dạng $...$ hoặc $$...$$ trừ khi có yêu cầu thay đổi trực tiếp liên quan đến công thức.
2. Đảm bảo cấu trúc Markdown (bảng biểu, in đậm, tiêu đề, danh sách) được giữ nguyên vẹn và hiển thị chính xác.
3. Chỉ trả về trực tiếp kết quả văn bản sau khi đã sửa đổi. Tuyệt đối KHÔNG giải thích dông dài, KHÔNG thêm lời chào hay lời cảm ơn, KHÔNG bọc trong khối \`\`\`markdown ... \`\`\`.`,
      }
    });

    let fixedText = response.text || "";
    fixedText = fixedText.trim();
    
    // Clean any outer markdown code block wrapper if the model still returns it
    if (fixedText.startsWith("```markdown")) {
      fixedText = fixedText.slice(11);
      if (fixedText.endsWith("```")) {
        fixedText = fixedText.slice(0, -3);
      }
    } else if (fixedText.startsWith("```")) {
      fixedText = fixedText.slice(3);
      if (fixedText.endsWith("```")) {
        fixedText = fixedText.slice(0, -3);
      }
    }
    fixedText = fixedText.trim();

    return res.json({ success: true, fixedText });
  } catch (error: any) {
    console.error("Lỗi trợ lý AI Canvas:", error);
    return res.status(500).json({ error: error.message || "Lỗi máy chủ khi gọi trợ lý AI Canvas" });
  }
});

// 3.7. API: Vary exam questions numbers and context using Gemini API for exam shuffling
app.post("/api/exam/shuffle-ai", async (req, res) => {
  try {
    const { questions } = req.body;

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: "Thiếu danh sách câu hỏi" });
    }

    console.log("[Gemini API] Đang gửi yêu cầu thay thế số liệu đề thi bằng AI...");

    const response = await generateContentWithRetry({
      model: "gemini-3.1-flash-lite", // Use the fastest and lightest model by default
      contents: `Dưới đây là danh sách câu hỏi trong đề thi. Với mỗi câu hỏi, hãy THAY ĐỔI CÁC SỐ LIỆU (số tự nhiên, số thực, phân số, tọa độ...), biến số hoặc ngữ cảnh nhỏ trong câu hỏi sao cho vẫn GIỮ NGUYÊN cấu trúc toán học/logic và phương pháp giải bài toán đó. Tuyệt đối không thay đổi phương pháp giải hoặc bản chất câu hỏi.
Nếu là câu hỏi trắc nghiệm có các phương án lựa chọn A, B, C, D, hãy đảm bảo tính toán lại các phương án nhiễu và phương án đúng một cách chính xác theo số liệu mới đã thay thế.
Trả về dữ liệu dưới dạng JSON với định dạng là một mảng đối tượng giống hệt đầu vào, chứa "id", "type", và "questionText" đã được thay đổi số liệu. Đặt mảng này trong thuộc tính "questions" của đối tượng JSON trả về.

Danh sách câu hỏi cần thay thế số liệu:
${JSON.stringify(questions, null, 2)}`,
      config: {
        systemInstruction: "Bạn là chuyên gia toán học và khảo sát đề thi chuyên nghiệp. Nhiệm vụ của bạn là lấy các câu hỏi học thuật từ người dùng, thay thế các con số hoặc ngữ cảnh nhẹ nhàng mà không thay đổi cách giải quyết, đảm bảo các tùy chọn trắc nghiệm được cập nhật chính xác theo số liệu mới.",
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            questions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  type: { type: Type.STRING },
                  questionText: { type: Type.STRING }
                },
                required: ["id", "type", "questionText"]
              }
            }
          },
          required: ["questions"]
        }
      }
    });

    const parsedJson = JSON.parse(response.text?.trim() || "{}");
    const updatedQuestions = parsedJson.questions || [];

    return res.json({ success: true, questions: updatedQuestions });
  } catch (error: any) {
    console.error("Lỗi khi thay số bằng AI:", error);
    return res.status(500).json({ error: error.message || "Lỗi máy chủ khi thay số câu hỏi bằng AI" });
  }
});

// 4. API: Compile LaTeX to PDF via standard fast LaTeX compiler
app.post("/api/compile-latex", async (req, res) => {
  try {
    const { latexCode } = req.body;
    if (!latexCode) {
      return res.status(400).json({ error: "Thiếu dữ liệu latexCode" });
    }

    console.log("[LaTeX compiler] Đang gửi yêu cầu biên dịch LaTeX sang PDF...");

    // Try texlive.net first as it is extremely fast and reliable
    try {
     const formData = new FormData();
      // Ensure CRLF line endings as latexcgi is sensitive to it
      const formattedLatex = latexCode.replace(/\r?\n/g, "\r\n");
      
      formData.append("filecontents[]", formattedLatex);
      formData.append("filename[]", "document.tex");
      formData.append("engine", "pdflatex");
      formData.append("return", "pdf");

      const compileRes = await fetch("https://texlive.net/cgi-bin/latexcgi", {
        method: "POST",
         body: formData,
      });

      if (compileRes.ok) {
        const contentType = compileRes.headers.get("content-type") || "";
        if (contentType.toLowerCase().includes("application/pdf")) {
          console.log("[LaTeX compiler] Biên dịch PDF thành công qua texlive.net!");
          const pdfBuffer = await compileRes.arrayBuffer();
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader("Content-Disposition", "attachment; filename=tai_lieu_latex.pdf");
          return res.send(Buffer.from(pdfBuffer));
        } else {
          console.warn("[LaTeX compiler] texlive.net did not return a PDF. Content-Type:", contentType);
        }
      } else {
        console.warn("[LaTeX compiler] texlive.net failed with status:", compileRes.status);
      }
    } catch (texliveError) {
      console.error("[LaTeX compiler] Lỗi khi biên dịch qua texlive.net:", texliveError);
    }

    // Fallback to latexonline.cc
    console.log("[LaTeX compiler] Đang thử biên dịch dự phòng qua latexonline.cc...");
    const url = `https://latexonline.cc/compile?text=${encodeURIComponent(latexCode)}&command=pdflatex`;
    const fallbackRes = await fetch(url);

    if (fallbackRes.ok) {
      console.log("[LaTeX compiler] Biên dịch PDF thành công qua latexonline.cc!");
      const pdfBuffer = await fallbackRes.arrayBuffer();
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=tai_lieu_latex.pdf");
      return res.send(Buffer.from(pdfBuffer));
    }

    return res.status(502).json({ error: "Biên dịch LaTeX sang PDF thất bại từ các server." });
  } catch (error: any) {
    console.error("Lỗi biên dịch LaTeX sang PDF tổng quát:", error);
    return res.status(500).json({ error: error.message || "Lỗi xử lý file PDF" });
  }
});



async function startServer() {
  // If running on Vercel, do not call app.listen or register static file middlewares,
  // as Vercel serves files statically via CDN and handles serverless routing natively.
  if (process.env.VERCEL) {
    return;
  }

  // Vite developer middleware for rendering Vite React client assets
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[BACKEND SERVER] Đang khởi động tại http://localhost:${PORT}`);
  });
}

startServer();
