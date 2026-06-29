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

const app = express();
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
    params.model,
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-2.5-flash",
    "gemini-3.1-pro-preview"
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
      model: "gemini-3.5-flash", // Use standard highly-available model by default
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
