import React, { useState, useRef, useEffect, startTransition } from "react";
import {
  HelpCircle,
  FileText,
  Upload,
  Check,
  X,
  Loader2,
  AlertTriangle,
  ShieldAlert,
  Sparkles,
  CheckCircle2,
  LogOut,
  Bell,
  MessageSquare,
  Settings,
  Camera,
  Image,
  Trash2,
  ZoomIn,
  ArrowRight
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import katex from "katex";
import { marked } from "marked";

// Firebase integrations
import { auth, db } from "./firebase";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updateProfile,
  User as FirebaseUser,
  GoogleAuthProvider,
  signInWithPopup,
} from "firebase/auth";
import {
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  onSnapshot,
  collection,
  query,
  orderBy,
  where,
  deleteDoc,
  increment,
} from "firebase/firestore";

enum OperationType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LIST = "list",
  GET = "get",
  WRITE = "write",
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error("Firestore Error: ", JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Helper to escape HTML safely for attributes
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// LaTeX special character escape for normal text blocks in the Overleaf document template
function escapeLaTeX(text: string): string {
  return text
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

// Module-level cache to make KaTeX MathML generation instant during Word download/copy
const mathmlCache = new Map<string, string>();

// Helper functions to protect URLs from being mangled by formatting or KaTeX regexes
interface ProtectedUrl {
  placeholder: string;
  original: string;
  isBare: boolean;
}

function protectUrls(text: string): {
  protectedText: string;
  urls: ProtectedUrl[];
} {
  if (!text) return { protectedText: "", urls: [] };

  const urls: ProtectedUrl[] = [];
  const URL_RE = /https?:\/\/[^\s<>\"{}]+[^.,;:!?\s<>\"){}]/gi;

  let match;
  let lastIndex = 0;
  let protectedText = "";

  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    const original = match[0];
    const index = match.index;

    const beforeStr = text.slice(Math.max(0, index - 10), index);
    const isBare =
      !beforeStr.endsWith("](") &&
      !beforeStr.includes("href=") &&
      !beforeStr.includes("src=") &&
      !beforeStr.endsWith("<");

    const placeholder = `@@@URL_PLACE_HOLDER_${urls.length}@@@`;
    urls.push({ placeholder, original, isBare });

    protectedText += text.slice(lastIndex, index) + placeholder;
    lastIndex = URL_RE.lastIndex;
  }
  protectedText += text.slice(lastIndex);

  return { protectedText, urls };
}

function restoreUrls(
  text: string,
  urls: ProtectedUrl[],
  forceOriginal: boolean = false,
): string {
  let restored = text;
  for (const item of urls) {
    if (item.isBare && !forceOriginal) {
      // Convert bare URLs into Markdown links so marked can render them as clickable links
      restored = restored.replace(
        item.placeholder,
        `[${item.original}](${item.original})`,
      );
    } else {
      // Restore as original for pre-existing markdown links, html, or if forced
      restored = restored.replace(item.placeholder, item.original);
    }
  }
  return restored;
}

// Smart formatting to fix run-on sentences or stuck equations, numbers, percentages, quotes, etc.
function applySmartFormatting(text: string): string {
  if (!text) return "";

  let formatted = text;

  // 1. Nhận dạng in đậm thiếu dấu sao ở đầu: *Đáp án đúng:** -> **Đáp án đúng**
  // (ví dụ: * *Đáp án đúng:** sẽ thành * **Đáp án đúng**)
  formatted = formatted.replace(/(?<!\*)\*(?!\s)([^\*\n]+?)\*\*/g, '**$1**');

  // 2. Nhận dạng in nghiêng thiếu dấu sao ở đầu cho mục danh sách: * Nội dung*: -> * *Nội dung*:
  formatted = formatted.replace(/^(\s*\*\s+)([^\*\n]+?)\*(?!\*)/gm, '$1*$2*');

  return formatted;
}

// Bộ lọc tối ưu hóa kiểm tra xem một cụm có thực sự là công thức toán học cần LaTeX không
// hay chỉ là các con số đơn lẻ, ngày tháng, phần trăm hoặc ký tự thông thường vô lý.
function isRealMathLaTeX(str: string): boolean {
  // Always recognize inline math enclosed by $...$ as a math equation directly, with no error-correction blocks
  return str.trim().length > 0;
}

// Normalize LaTeX helper inside mathematical formulas for MS Word rendering and KaTeX compatibility
function normalizeLaTeX(latex: string, isInline: boolean = false): string {
  // Do not perform automatic normalization/manipulation to preserve exact user latex formulas
  return latex;
}

// Check for unclosed/unpaired dollar tags ($) in input text
function hasUnclosedDollar(text: string): boolean {
  if (!text) return false;
  // Exclude double dollars and escaped dollars
  let cleaned = text.replace(/\$\$/g, "");
  cleaned = cleaned.replace(/\\\$/g, "");
  const matches = cleaned.match(/\$/g);
  return matches ? matches.length % 2 !== 0 : false;
}

interface ParsedQuestion {
  questionBody: string;
  options: { label: string; text: string }[];
}

function parseMultipleChoice(text: string): ParsedQuestion {
  if (!text) return { questionBody: "", options: [] };

  const lines = text.split("\n");
  const questionLines: string[] = [];
  const options: { label: string; text: string }[] = [];

  const optionRegex = /^\s*([A-D])[\.\)\/]\s*(.*)$/;
  // Các dòng bắt đầu bằng đánh số danh sách, bullet, ký hiệu đặc biệt hoặc từ khóa đề mục
  const nonOptionContinuationRegex =
    /^\s*(?:\d+[\.\)\/\s-]|[\-\*•]|\b(?:Bài|Yêu cầu|Biết rằng|Ghi chú|Lưu ý|Chú ý|Đề số|Mã số|Thời gian)\b)/i;

  let currentOption: { label: string; text: string } | null = null;
  const postQuestionLines: string[] = []; // Chứa các dòng không phải option nằm sau khi các option bắt đầu

  for (const line of lines) {
    const match = line.match(optionRegex);
    if (match) {
      if (currentOption) {
        options.push(currentOption);
      }
      currentOption = {
        label: match[1].toUpperCase(),
        text: match[2].trim(),
      };
    } else {
      if (currentOption) {
        // Nếu đã có option đang chạy, nhưng dòng hiện tại trống hoặc bắt đầu bằng số/bullet/từ khóa đề mục
        // thì ta ngắt option đó và coi dòng này thuộc về phần nội dung sau option (sẽ được nối vào questionBody)
        if (!line.trim() || nonOptionContinuationRegex.test(line)) {
          options.push(currentOption);
          currentOption = null;
          postQuestionLines.push(line);
        } else {
          // Ngược lại thì vẫn tiếp tục gộp vào option hiện tại
          currentOption.text += "\n" + line.trim();
        }
      } else {
        if (options.length > 0) {
          // Đã xong các option trước đó, dòng này là nội dung xuất hiện sau các option
          postQuestionLines.push(line);
        } else {
          // Chưa bắt đầu option nào, dòng này thuộc về đề bài
          questionLines.push(line);
        }
      }
    }
  }

  if (currentOption) {
    options.push(currentOption);
  }

  let questionBody = questionLines.join("\n").trim();
  if (postQuestionLines.length > 0) {
    questionBody += "\n\n" + postQuestionLines.join("\n").trim();
  }

  if (options.length >= 2) {
    return {
      questionBody: questionBody.trim(),
      options,
    };
  }

  // If we couldn't parse 2 distinct options from separate lines, try inline parsing (e.g., A. $1$ B. $2$ C. $3$ D. $4$)
  const inlineRegex =
    /([A-D])[\.\)\/]\s*([\s\S]*?)(?=\s*[A-D][\.\)\/]|(?:\s*$))/g;
  const plainText = text;
  const firstOptionIdx = plainText.search(/\b[A-D][\.\)\/]/);

  if (firstOptionIdx !== -1) {
    const questionBodyInline = plainText.substring(0, firstOptionIdx).trim();
    const optionsPart = plainText.substring(firstOptionIdx);

    const foundOptions: { label: string; text: string }[] = [];
    let m;
    while ((m = inlineRegex.exec(optionsPart)) !== null) {
      foundOptions.push({
        label: m[1].toUpperCase(),
        text: m[2].trim(),
      });
    }

    if (foundOptions.length >= 2) {
      return {
        questionBody: questionBodyInline,
        options: foundOptions,
      };
    }
  }

  return {
    questionBody: text.trim(),
    options: [],
  };
}

function checkIsOwnerEmail(user: any): boolean {
  const email = user?.email || user?.providerData?.[0]?.email;
  if (!email) return false;
  return email.toLowerCase().trim() === "giathieu110406@gmail.com";
}

function isAdminByRole(userDoc: any): boolean {
  return userDoc?.role === "admin";
}

function isAdminUser(user: any, userDoc: any): boolean {
  return checkIsOwnerEmail(user) || isAdminByRole(userDoc);
}

export default function App() {
  // --- AUTH & CONTROL STATE ---
  const [user, setUser] = useState<FirebaseUser | null>(() => {
    try {
      const cached = localStorage.getItem("q_builder_cached_user");
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  });
  const [userDoc, setUserDoc] = useState<any | null>(() => {
    try {
      const cached = localStorage.getItem("q_builder_cached_user_doc");
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  });


  const [authLoading, setAuthLoading] = useState<boolean>(() => {
    try {
      const cachedUser = localStorage.getItem("q_builder_cached_user");
      const cachedDoc = localStorage.getItem("q_builder_cached_user_doc");
      return !(cachedUser && cachedDoc);
    } catch {
      return true;
    }
  });
  const [authError, setAuthError] = useState<string | null>(null);

  // --- ADMIN STATE ---
  const [adminTab, setAdminTab] = useState<"tool" | "admin">("tool");
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [userSearchQuery, setUserSearchQuery] = useState<string>("");
  const [allFeedbacks, setAllFeedbacks] = useState<any[]>([]);
  const [feedbackSearchQuery, setFeedbackSearchQuery] = useState<string>("");
  const [feedbackTypeFilter, setFeedbackTypeFilter] = useState<string>("all");
  const [adminSubTab, setAdminSubTab] = useState<"members" | "feedbacks" | "notify">("members");

  // Notification creation form state for admin
  const [generalNoticeTitle, setGeneralNoticeTitle] = useState<string>("");
  const [generalNoticeContent, setGeneralNoticeContent] = useState<string>("");
  const [generalNoticeTarget, setGeneralNoticeTarget] = useState<string>("all");
  const [isSendingGeneralNotice, setIsSendingGeneralNotice] = useState<boolean>(false);

  // Reply form state
  const [activeReplyFeedbackId, setActiveReplyFeedbackId] = useState<string | null>(null);
  const [feedbackReplyText, setFeedbackReplyText] = useState<string>("");
  const [isSendingReply, setIsSendingReply] = useState<boolean>(false);

  // --- FEEDBACK STATE ---
  const [isFeedbackOpen, setIsFeedbackOpen] = useState<boolean>(false);
  const [feedbackText, setFeedbackText] = useState<string>("");
  const [feedbackType, setFeedbackType] = useState<
    "bug" | "request" | "suggestion" | "other"
  >("suggestion");
  const [feedbackRating, setFeedbackRating] = useState<number>(5);
  const [isSubmittingFeedback, setIsSubmittingFeedback] =
    useState<boolean>(false);
  const [feedbackImage, setFeedbackImage] = useState<string>("");
  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null);
  const [deletingFeedbackId, setDeletingFeedbackId] = useState<string | null>(null);

  // --- NOTIFICATION STATE ---
  const [notifications, setNotifications] = useState<any[]>([]);
  const [isNotificationsOpen, setIsNotificationsOpen] =
    useState<boolean>(false);
  const [readNotificationIds, setReadNotificationIds] = useState<string[]>([]);

  const [archivedNotificationIds, setArchivedNotificationIds] = useState<
    string[]
  >([]);

  // Load and save read/archived notification state per user from localStorage
  useEffect(() => {
    if (!user) {
      setReadNotificationIds([]);
      setArchivedNotificationIds([]);
      return;
    }
    const storedRead = localStorage.getItem(`read_notifs_${user.uid}`);
    const storedArchived = localStorage.getItem(`archived_notifs_${user.uid}`);
    if (storedRead) {
      try {
        setReadNotificationIds(JSON.parse(storedRead));
      } catch (e) {
        console.error(e);
      }
    } else {
      setReadNotificationIds([]);
    }
    if (storedArchived) {
      try {
        setArchivedNotificationIds(JSON.parse(storedArchived));
      } catch (e) {
        console.error(e);
      }
    } else {
      setArchivedNotificationIds([]);
    }
  }, [user]);

  const markNotificationAsRead = (notifId: string) => {
    if (!user) return;
    setReadNotificationIds((prev) => {
      if (prev.includes(notifId)) return prev;
      const updated = [...prev, notifId];
      localStorage.setItem(`read_notifs_${user.uid}`, JSON.stringify(updated));
      return updated;
    });
  };

  const markAllNotificationsAsRead = () => {
    if (!user) return;
    const allIds = notifications.map((n) => n.id);
    setReadNotificationIds(allIds);
    localStorage.setItem(`read_notifs_${user.uid}`, JSON.stringify(allIds));
    triggerToast("Đã đánh dấu tất cả thông báo là đã đọc!", true);
  };

  const archiveNotification = (notifId: string) => {
    if (!user) return;
    setArchivedNotificationIds((prev) => {
      if (prev.includes(notifId)) return prev;
      const updated = [...prev, notifId];
      localStorage.setItem(
        `archived_notifs_${user.uid}`,
        JSON.stringify(updated),
      );
      return updated;
    });
    // Also mark it as read when archiving to keep badges clean
    markNotificationAsRead(notifId);
    triggerToast("Đã ẩn thông báo thành công.");
  };

  // Auto-read notifications when bell is opened
  useEffect(() => {
    if (isNotificationsOpen && user && notifications.length > 0) {
      const visible = notifications.filter(
        (n) => !archivedNotificationIds.includes(n.id),
      );
      const unreadIds = visible
        .map((n) => n.id)
        .filter((id) => !readNotificationIds.includes(id));
      if (unreadIds.length > 0) {
        setReadNotificationIds((prev) => {
          const updated = [...new Set([...prev, ...unreadIds])];
          localStorage.setItem(
            `read_notifs_${user.uid}`,
            JSON.stringify(updated),
          );
          return updated;
        });
      }
    }
  }, [isNotificationsOpen, notifications, user, archivedNotificationIds]);

  const visibleNotifications = notifications.filter(
    (n) => !archivedNotificationIds.includes(n.id),
  );
  const unreadCount = visibleNotifications.filter(
    (n) => !readNotificationIds.includes(n.id),
  ).length;

  const [inputText, setInputText] = useState<string>("");
  const [isCanvasMaximized, setIsCanvasMaximized] = useState<boolean>(false);

  const insertAtCursor = (before: string, after: string = "") => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const currentVal = textarea.value;
    const selectedText = currentVal.substring(start, end);

    const replacement = before + (selectedText || after) + (selectedText ? after : "");
    const newVal = currentVal.substring(0, start) + replacement + currentVal.substring(end);

    setInputText(newVal);
    
    // Focus and select back
    setTimeout(() => {
      textarea.focus();
      const cursorOffset = start + before.length + (selectedText ? selectedText.length + after.length : 0);
      textarea.setSelectionRange(cursorOffset, cursorOffset);
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;

    const pairs: Record<string, string> = {
      "$": "$",
      "{": "}",
      "[": "]",
      "(": ")",
      '"': '"',
      "'": "'"
    };

    const char = e.key;
    if (pairs[char] !== undefined) {
      e.preventDefault();
      const closeChar = pairs[char];
      
      // If there's selected text, wrap it
      if (start !== end) {
        const selected = value.substring(start, end);
        const newVal = value.substring(0, start) + char + selected + closeChar + value.substring(end);
        setInputText(newVal);
        setTimeout(() => {
          textarea.setSelectionRange(start + 1, end + 1);
        }, 0);
      } else {
        // If no selected text, insert both and place cursor in middle
        const newVal = value.substring(0, start) + char + closeChar + value.substring(end);
        setInputText(newVal);
        setTimeout(() => {
          textarea.setSelectionRange(start + 1, start + 1);
        }, 0);
      }
    } else if (char === "Backspace" && start === end && start > 0) {
      // If backspace is pressed, and we have a matching pair right around the cursor, delete both!
      const prevChar = value[start - 1];
      const nextChar = value[start];
      if (
        (prevChar === "$" && nextChar === "$") ||
        (prevChar === "{" && nextChar === "}") ||
        (prevChar === "[" && nextChar === "]") ||
        (prevChar === "(" && nextChar === ")") ||
        (prevChar === '"' && nextChar === '"') ||
        (prevChar === "'" && nextChar === "'")
      ) {
        e.preventDefault();
        const newVal = value.substring(0, start - 1) + value.substring(start + 1);
        setInputText(newVal);
        setTimeout(() => {
          textarea.setSelectionRange(start - 1, start - 1);
        }, 0);
      }
    }
  };
  const [showAiCanvas, setShowAiCanvas] = useState<boolean>(false);
  const [aiCanvasPrompt, setAiCanvasPrompt] = useState<string>("");
  const [isProcessingCanvas, setIsProcessingCanvas] = useState<boolean>(false);
  const [smartNewline, setSmartNewline] = useState<boolean>(true);
  const [wordFont, setWordFont] = useState<string>(
    "'Times New Roman', Times, serif",
  );
  const [activeTab, setActiveTab] = useState<"word" | "latex">("word");

  // Clean states for processed HTML and Overleaf document
  const [processedHtml, setProcessedHtml] = useState<string>("");
  const [overleafCode, setOverleafCode] = useState<string>("");

  // Toast for visual feedbacks
  const [toast, setToast] = useState<{
    show: boolean;
    msg: string;
    success: boolean;
  }>({
    show: false,
    msg: "",
    success: true,
  });

  const previewRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Note: Selection prevention on Word preview container was removed to allow users to highlight text.
  useEffect(() => {
    // Legacy behavior removed
  }, [processedHtml, activeTab]);

  // --- STATE FOR DOCUMENT BUILDER (v3.4) ---
  const [docQuestions, setDocQuestions] = useState<any[]>([
    {
      id: "sample_1",
      type: "trac_nghiem",
      questionText:
        "Câu 1. Cho hàm số $f(x) = x^3 - 3x^2 + 2$. Tính đạo hàm $f'(x)$ tại điểm $x_0 = 1$.\nA. $f'(1) = 0$\nB. $f'(1) = -3$\nC. $f'(1) = 3$\nD. $f'(1) = -1$",
      columns: 4,
    },
    {
      id: "sample_2",
      type: "tu_luan",
      questionText:
        "Câu 2. Giải phương trình vi phân sau đây:\n$$\\frac{dy}{dx} + 2xy = xe^{-x^2}$$",
      answerText:
        "Nhân hai vế với thừa số tích phân $I(x) = e^{\\int 2x dx} = e^{x^2}$:\n$$e^{x^2}\\frac{dy}{dx} + 2xe^{x^2}y = x \\implies \\frac{d}{dx}\\left(ye^{x^2}\\right) = x$$\nTích phân hai vế ta được:\n$$ye^{x^2} = \\frac{1}{2}x^2 + C \\implies y(x) = \\left(\\frac{1}{2}x^2 + C\\right)e^{-x^2}$$",
    },
  ]);
  const [newQuestionType, setNewQuestionType] = useState<
    "trac_nghiem" | "trac_nghiem_dung_sai" | "trac_nghiem_tra_loi_ngan" | "tu_luan"
  >("trac_nghiem");
  const [tracNghiemText, setTracNghiemText] = useState<string>("");
  const [tracNghiemAnswerText, setTracNghiemAnswerText] = useState<string>("");
  const [newTracNghiemColumns, setNewTracNghiemColumns] = useState<number>(4);
  const [dungSaiText, setDungSaiText] = useState<string>("");
  const [dungSaiAnswerText, setDungSaiAnswerText] = useState<string>("");
  const [traLoiNganText, setTraLoiNganText] = useState<string>("");
  const [traLoiNganAnswerText, setTraLoiNganAnswerText] = useState<string>("");
  const [tuLuanQuestionText, setTuLuanQuestionText] = useState<string>("");
  const [tuLuanAnswerText, setTuLuanAnswerText] = useState<string>("");
  const [showSmartPasteModal, setShowSmartPasteModal] = useState<boolean>(false);
  const [smartPasteText, setSmartPasteText] = useState<string>("");
  const [smartPasteStep, setSmartPasteStep] = useState<1 | 2>(1);
  const [parsedPreviewQuestions, setParsedPreviewQuestions] = useState<any[]>([]);
  const [docTitle, setDocTitle] = useState<string>(
    "ĐỀ KIỂM TRA ĐỊNH KỲ MÔN TOÁN SỐ HỌC & GIẢI TÍCH",
  );
  const [docSubtitle, setDocSubtitle] = useState<string>(
    "Thời gian làm bài: 90 phút (Không kể thời gian phát đề) - Đề số 1",
  );
  const [docHeaderStyle, setDocHeaderStyle] = useState<"centered" | "split">(
    "centered",
  );
  const [docStudentInfoFormat, setDocStudentInfoFormat] = useState<string>(
    `Họ và tên: ....................................................\nLớp: ................... STT: .........`,
  );
  const [docTimeLimit, setDocTimeLimit] = useState<string>(
    "90 phút (Không kể thời gian phát đề)",
  );
  const [docExamCode, setDocExamCode] = useState<string>("101");
  const [docSchoolName, setDocSchoolName] = useState<string>(
    "TRƯỜNG THPT CHUYÊN QUỐC GIA",
  );
  const [docExamName, setDocExamName] = useState<string>(
    "KỲ THI THỬ TỐT NGHIỆP THPT",
  );
  const [docSubjectName, setDocSubjectName] =
    useState<string>("Môn thi: TOÁN HỌC");
  const docPreviewRef = useRef<HTMLDivElement>(null);
  const [editingQuestionId, setEditingQuestionId] = useState<string | null>(
    null,
  );
  const [savedQuestionTab, setSavedQuestionTab] = useState<"all" | "trac_nghiem" | "trac_nghiem_dung_sai" | "trac_nghiem_tra_loi_ngan" | "tu_luan">("all");

  const tracNghiemList = docQuestions.filter((q) => q.type === "trac_nghiem");
  const dungSaiList = docQuestions.filter((q) => q.type === "trac_nghiem_dung_sai");
  const traLoiNganList = docQuestions.filter((q) => q.type === "trac_nghiem_tra_loi_ngan");
  const tuLuanList = docQuestions.filter((q) => q.type === "tu_luan");
  
  let sectionIndex = 1;
  const toRoman = (num: number) => {
    switch(num) {
        case 1: return "I";
        case 2: return "II";
        case 3: return "III";
        case 4: return "IV";
        default: return "";
    }
  }

  const labelTracNghiem = tracNghiemList.length > 0 ? `${toRoman(sectionIndex++)}. PHẦN TRẮC NGHIỆM NHIỀU LỰA CHỌN` : "";
  const labelDungSai = dungSaiList.length > 0 ? `${toRoman(sectionIndex++)}. PHẦN TRẮC NGHIỆM ĐÚNG/SAI` : "";
  const labelTraLoiNgan = traLoiNganList.length > 0 ? `${toRoman(sectionIndex++)}. PHẦN TRẮC NGHIỆM TRẢ LỜI NGẮN` : "";
  const labelTuLuan = tuLuanList.length > 0 ? `${toRoman(sectionIndex++)}. PHẦN TỰ LUẬN` : "";

  const handleUpdateQuestionColumns = (id: string, columns: number) => {
    setDocQuestions((prev) =>
      prev.map((q) => (q.id === id ? { ...q, columns } : q)),
    );
  };

  const handleStartEditQuestion = (q: any) => {
    setEditingQuestionId(q.id);
    setNewQuestionType(q.type);

    // Auto strip the "Câu X." pattern for clean insertion into textarea
    const cleanText = getCleanQuestionBody(q.questionText);

    switch (q.type) {
      case "trac_nghiem":
        setTracNghiemText(cleanText);
        setNewTracNghiemColumns(q.columns || 4);
        setTracNghiemAnswerText(q.answerText || "");
        break;
      case "trac_nghiem_dung_sai":
        setDungSaiText(cleanText);
        setDungSaiAnswerText(q.answerText || "");
        break;
      case "trac_nghiem_tra_loi_ngan":
        setTraLoiNganText(cleanText);
        setTraLoiNganAnswerText(q.answerText || "");
        break;
      case "tu_luan":
        setTuLuanQuestionText(cleanText);
        setTuLuanAnswerText(q.answerText || "");
        break;
    }

    // Smooth scroll to input section for immediate focus
    const formSection = document.getElementById("question-input-section");
    if (formSection) {
      formSection.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    triggerToast("Đã tải câu hỏi vào khung nhập để chỉnh sửa!", true);
  };

  const handleAddQuestion = () => {
    let typeToUse = newQuestionType;
    let questionTextRaw = "";
    let answerTextRaw = "";
    let columns = newTracNghiemColumns;

    switch (typeToUse) {
      case "trac_nghiem":
        questionTextRaw = tracNghiemText;
        answerTextRaw = tracNghiemAnswerText;
        break;
      case "trac_nghiem_dung_sai":
        questionTextRaw = dungSaiText;
        answerTextRaw = dungSaiAnswerText;
        break;
      case "trac_nghiem_tra_loi_ngan":
        questionTextRaw = traLoiNganText;
        answerTextRaw = traLoiNganAnswerText;
        break;
      case "tu_luan":
        questionTextRaw = tuLuanQuestionText;
        answerTextRaw = tuLuanAnswerText;
        break;
    }

    const questionText = getCleanQuestionBody(normalizeInputText(questionTextRaw));
    const answerText = normalizeInputText(answerTextRaw).trim();

    if (!questionText) {
      triggerToast("Nội dung câu hỏi không được để trống!", false);
      return;
    }

    if (editingQuestionId) {
      const idx = docQuestions.findIndex((q) => q.id === editingQuestionId);
      if (idx !== -1) {
        setDocQuestions((prev) => {
          const next = [...prev];
          next[idx] = {
            ...next[idx],
            type: typeToUse,
            questionText: questionText,
            answerText: answerText,
            columns: typeToUse === "trac_nghiem" ? columns : undefined,
          };
          return renumberQuestions(next);
        });
        setEditingQuestionId(null);
        triggerToast("Đã cập nhật câu hỏi thành công!", true);
      } else {
        triggerToast("Không tìm thấy câu hỏi để cập nhật!", false);
      }
    } else {
      const newId = "q_" + Date.now();
      setDocQuestions((prev) => {
        const next = [
          ...prev,
          {
            id: newId,
            type: typeToUse,
            questionText: questionText,
            answerText: answerText,
            columns: typeToUse === "trac_nghiem" ? columns : undefined,
          },
        ];
        return renumberQuestions(next);
      });
      triggerToast("Đã thêm câu hỏi thành công!", true);
    }

    // Clear inputs
    switch (typeToUse) {
      case "trac_nghiem":
        setTracNghiemText("");
        setTracNghiemAnswerText("");
        setNewTracNghiemColumns(4);
        break;
      case "trac_nghiem_dung_sai":
        setDungSaiText("");
        setDungSaiAnswerText("");
        break;
      case "trac_nghiem_tra_loi_ngan":
        setTraLoiNganText("");
        setTraLoiNganAnswerText("");
        break;
      case "tu_luan":
        setTuLuanQuestionText("");
        setTuLuanAnswerText("");
        break;
    }
  };

  const handleMoveQuestion = (index: number, direction: "up" | "down") => {
    if (direction === "up" && index === 0) return;
    if (direction === "down" && index === docQuestions.length - 1) return;
    const targetIdx = direction === "up" ? index - 1 : index + 1;
    setDocQuestions((prev) => {
      const updated = [...prev];
      const temp = updated[index];
      updated[index] = updated[targetIdx];
      updated[targetIdx] = temp;

      // Update prefixes to reflect new positions by type
      let tnCount = 0;
      let tlCount = 0;
      return updated.map((q) => {
        const cleanContent = getCleanQuestionBody(q.questionText);
        if (q.type === "trac_nghiem") {
          tnCount++;
          return {
            ...q,
            questionText: `Câu ${tnCount}. ` + cleanContent,
          };
        } else {
          tlCount++;
          return {
            ...q,
            questionText: `Câu ${tlCount}. ` + cleanContent,
          };
        }
      });
    });
  };

  const handleDeleteQuestion = (id: string) => {
    setDocQuestions((prev) => {
      const filtered = prev.filter((q) => q.id !== id);
      // Re-index remaining questions by type
      let tnCount = 0;
      let tlCount = 0;
      return filtered.map((q) => {
        const cleanContent = getCleanQuestionBody(q.questionText);
        if (q.type === "trac_nghiem") {
          tnCount++;
          return {
            ...q,
            questionText: `Câu ${tnCount}. ` + cleanContent,
          };
        } else {
          tlCount++;
          return {
            ...q,
            questionText: `Câu ${tlCount}. ` + cleanContent,
          };
        }
      });
    });
    if (editingQuestionId === id) {
      setEditingQuestionId(null);
      setTracNghiemText("");
      setTracNghiemAnswerText("");
      setDungSaiText("");
      setDungSaiAnswerText("");
      setTraLoiNganText("");
      setTraLoiNganAnswerText("");
      setTuLuanQuestionText("");
      setTuLuanAnswerText("");
    }
    triggerToast("Đã xóa câu hỏi.");
  };

  const detectQuestionTypeFromBlockContent = (
    qText: string,
    fallbackType: "trac_nghiem" | "trac_nghiem_dung_sai" | "trac_nghiem_tra_loi_ngan" | "tu_luan"
  ): "trac_nghiem" | "trac_nghiem_dung_sai" | "trac_nghiem_tra_loi_ngan" | "tu_luan" => {
    const cleanText = qText.trim().toLowerCase();
    
    // Check for A., B., C., D. options (for Multiple Choice)
    const hasA = /^[A-D][.\s\)-]/m.test(qText) || /(?:\s|^|\n)A[.\s\)-]/m.test(qText) || /a\.\s/i.test(qText);
    const hasB = /^[A-D][.\s\)-]/m.test(qText) || /(?:\s|^|\n)B[.\s\)-]/m.test(qText) || /b\.\s/i.test(qText);
    const hasC = /^[A-D][.\s\)-]/m.test(qText) || /(?:\s|^|\n)C[.\s\)-]/m.test(qText) || /c\.\s/i.test(qText);
    const hasD = /^[A-D][.\s\)-]/m.test(qText) || /(?:\s|^|\n)D[.\s\)-]/m.test(qText) || /d\.\s/i.test(qText);
    
    // If we have at least A, B, C, D options, it's definitely trac_nghiem
    if (hasA && hasB && hasC && hasD) {
      return "trac_nghiem";
    }

    // Check for True/False (đúng sai): a) Đúng. b) Sai.
    const hasDungSaiKeywords = cleanText.includes("đúng sai") || cleanText.includes("đúng/sai") || cleanText.includes("đúng hay sai") || cleanText.includes("mệnh đề sau");
    const hasDungSaiOptions = /^[a-d][\s.\)\-]*\s*(?:đúng|sai)\b/mi.test(cleanText) || /[\s\n][a-d][\s.\)\-]*\s*(?:đúng|sai)\b/mi.test(cleanText);
    if (hasDungSaiKeywords || hasDungSaiOptions) {
      return "trac_nghiem_dung_sai";
    }

    // Check for short answer keywords
    const hasShortAnswerKeywords = cleanText.includes("trả lời ngắn") || cleanText.includes("đáp số") || cleanText.includes("điền vào");
    if (hasShortAnswerKeywords) {
      return "trac_nghiem_tra_loi_ngan";
    }

    // If fallback is not tu_luan, we can respect fallback if it's not a clear essay
    // But we should double check if fallback is trac_nghiem and we didn't find ABCD options, then maybe it's actually tu_luan
    if (fallbackType === "trac_nghiem" && (!hasA || !hasB)) {
      return "tu_luan";
    }

    return fallbackType;
  };

  const processMultipleQuestionsText = (text: string) => {
    if (!text) return;

    // 1. Chuẩn hoá văn bản đầu vào chuẩn Unicode & Dấu câu giống hệt LaTeX Converter
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

    // 2. Tự động chuyển đổi tab thành bảng Markdown
    let convertedText = convertTabTableToMarkdown(normalizedInput);

    // 3. Áp dụng thuật toán Định dạng thông minh chuẩn (bao gồm xử lý dính chữ, dính số, dính ngoặc...) của LaTeX Converter
    let formattedText = applySmartFormatting(convertedText);

    // Fix logic bugs in markdown
    const fixMarkdown = (t: string) => {
      let result = t.replace(/(^|[ \t])\*[ \t]+\*(.*?)\*\*/g, '$1**$2**');
      result = result.replace(/\*[ \t]+\*\*/g, '***');
      result = result.replace(/\*\*[ \t]+\*/g, '***');
      result = result.replace(/^#[ \t]+#/gm, '##');
      result = result.replace(/\*[ \t]+\*(.*?)\*[ \t]+\*/g, '**$1**');
      return result;
    };

    const fixedText = fixMarkdown(formattedText);
    const lines = fixedText.split('\n');
    
    let blocks: {text: string, typeContext: "trac_nghiem" | "trac_nghiem_dung_sai" | "trac_nghiem_tra_loi_ngan" | "tu_luan"}[] = [];
    let currentBlock = "";
    let currentTypeContext = newQuestionType;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineTrimmed = line.trim();
        const lowerLine = lineTrimmed.toLowerCase();
        
        // Nhận diện câu hỏi an toàn: Tránh các dòng trống, lệnh LaTeX (\begin, \section), hoặc dòng bảng biểu (|)
        const isTableLine = lineTrimmed.startsWith("|");
        const isLaTeXCommand = lineTrimmed.startsWith("\\");
        
        const isNewQuestion = !isTableLine && !isLaTeXCommand && /^(?:[\-\*•\+]\s*)?(?:\*\s*\*|\*\*|\*)?\s*(?:Câu|Bài)\s*(?:hỏi)?\s*(?:\d+)?\s*(?:[:.\-|\*]|$)/i.test(lineTrimmed);
        const isNewSection = /^Phần\s+\d+/i.test(lineTrimmed);

        if (isNewQuestion || isNewSection) {
            if (currentBlock.trim()) blocks.push({ text: currentBlock, typeContext: currentTypeContext });
            
            if (isNewSection) {
                currentBlock = "";
            } else {
                currentBlock = line + '\n';
            }
        } else {
            currentBlock += line + '\n';
        }
    }
    if (currentBlock.trim()) blocks.push({ text: currentBlock, typeContext: currentTypeContext });
    
    blocks = blocks.filter(b => /^(?:[\-\*•\+]\s*)?(?:\*\s*\*|\*\*|\*)?\s*(?:Câu|Bài)/i.test(b.text.trim()));
    
    if (blocks.length === 0) {
        blocks.push({ text: fixedText, typeContext: currentTypeContext });
    }
    
    const parsedQuestions = blocks.map(blockObj => {
        const block = blockObj.text;
        let qLines: string[] = [];
        let aLines: string[] = [];
        let isAnswer = false;
        
        const blockLines = block.split('\n');
        for (let i = 0; i < blockLines.length; i++) {
            const lower = blockLines[i].toLowerCase().trim();
            const plain = lower.replace(/\*/g, '').trim();
            
            if (
                plain.startsWith('đáp án:') || 
                plain.startsWith('đáp án') || 
                plain.startsWith('hướng dẫn giải') || 
                plain.startsWith('lời giải') || 
                plain.startsWith('giải thích') ||
                plain.match(/^--+$/)
            ) {
                isAnswer = true;
            }
            
            if (isAnswer) {
                aLines.push(blockLines[i]);
            } else {
                qLines.push(blockLines[i]);
            }
        }
        
        const questionContent = qLines.join('\n').trim();
        const detectedType = detectQuestionTypeFromBlockContent(questionContent, blockObj.typeContext);
        
        return {
           type: detectedType,
           q: questionContent,
           a: aLines.join('\n').trim()
        };
    });
    
    if (parsedQuestions.length > 0) {
        setDocQuestions((prev) => {
          const updated = [...prev];
          
          parsedQuestions.forEach(item => {
              updated.push({
                  id: "q_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9),
                  type: item.type,
                  questionText: getCleanQuestionBody(item.q),
                  columns: item.type === "trac_nghiem" ? newTracNghiemColumns : undefined,
                  answerText: getCleanAnswerBody(item.a),
              });
          });
          
          // Re-number them properly
          return renumberQuestions(updated);
        });
        
        triggerToast(`Đã tự động phân tách và thêm ${parsedQuestions.length} câu hỏi vào đề thi!`, true);
    }
  };

  const handleSmartPasteProcess = () => {
    if (!smartPasteText.trim()) {
      triggerToast("Nội dung dán không được để trống!", false);
      return;
    }
    const currentPromptCount = userDoc?.promptCount || 0;
    if (!isApproved && currentPromptCount >= 10) {
      triggerToast(
        "Bạn đã đạt giới hạn tính năng dán thông minh (AI) trong ngày (tối đa 10 lượt/ngày). Hãy liên hệ Admin qua email giathieu110406@gmail.com để được cấp quyền không giới hạn!",
        false,
      );
      return;
    }

    if (smartPasteStep === 1) {
      const previewList = parseMultipleQuestionsTextToPreview(smartPasteText);
      if (previewList.length === 0) {
        triggerToast("Không nhận diện được câu hỏi nào. Vui lòng kiểm tra lại định dạng!", false);
        return;
      }
      setParsedPreviewQuestions(previewList);
      setSmartPasteStep(2);
      triggerToast("Đã phân tách thành công! Hãy xem trước kết quả bên dưới.", true);
    } else {
      if (parsedPreviewQuestions.length === 0) {
        triggerToast("Không có câu hỏi nào để nhập!", false);
        return;
      }
      setDocQuestions((prev) => {
        const updated = [...prev, ...parsedPreviewQuestions];
        return renumberQuestions(updated);
      });
      incrementPromptCount();
      triggerToast(`Đã tự động thêm ${parsedPreviewQuestions.length} câu hỏi vào đề thi!`, true);
      
      // Reset state and close modal
      setSmartPasteText("");
      setParsedPreviewQuestions([]);
      setSmartPasteStep(1);
      setShowSmartPasteModal(false);
    }
  };

  const closeSmartPasteModal = () => {
    setShowSmartPasteModal(false);
    setSmartPasteStep(1);
    setParsedPreviewQuestions([]);
  };

  const copyDocToWord = async () => {
    if (docQuestions.length === 0) {
      triggerToast("Không có nội dung để sao chép cho Word!", false);
      return;
    }

    const currentExamCount = userDoc?.examCount || 0;
    if (!isApproved && currentExamCount >= 5) {
      triggerToast(
        "Bạn đã đạt giới hạn tính năng tạo tài liệu đề thi trong ngày (tối đa 5 lượt/ngày). Vui lòng liên hệ Admin qua email giathieu110406@gmail.com để được cấp quyền không giới hạn!",
        false,
      );
      return;
    }

    if (!docPreviewRef.current) return;

    const clone = docPreviewRef.current.cloneNode(true) as HTMLDivElement;
    injectMathML(clone);
    injectInlineStyles(clone);

    const bodyHtml = clone.innerHTML;

    const wordDoc = `<html>
    <head>
    <meta charset="UTF-8">
    <meta name="ProgId" content="Word.Document">
    <style>
        @page {
            size: A4;
            margin: 2cm;
        }
        body {
            font-family: ${wordFont};
            font-size: 13pt;
            line-height: 1.15;
            color: #000000;
            margin: 0;
        }
        h1, h2, h3, h4, h5, h6, h1, h2, h3, h4, h5, h6, p, li, span, select, tr, td, th {
            font-family: ${wordFont} !important;
            font-size: 13pt !important;
            line-height: 1.15 !important;
            margin-top: 0 !important;
            margin-bottom: 0 !important;
        }
        div, table {
            font-family: ${wordFont} !important;
            font-size: 13pt !important;
            line-height: 1.15 !important;
        }
        div.doc-display-math {
            margin-top: 6pt !important;
            margin-bottom: 6pt !important;
            text-align: center !important;
        }
        table.doc-answer-table {
            margin-top: 16pt !important;
            margin-bottom: 12pt !important;
            border: 1px solid #10b981 !important;
            background-color: #ecfdf5 !important;
        }
        table.doc-answer-table th, table.doc-answer-table td {
            border: none !important;
            padding: 10pt !important;
        }
        table.doc-options-table, table.doc-options-table th, table.doc-options-table td {
            border: none !important;
        }
        table.doc-header-table, table.doc-header-table th, table.doc-header-table td {
            border: none !important;
        }
        table {
            border-collapse: collapse;
            width: 100%;
            margin-top: 12pt !important;
            margin-bottom: 12pt !important;
        }
        table th, table td {
            border: 1px solid #475569 !important;
            padding: 6px !important;
        }
        table th {
            font-weight: bold !important;
            background-color: transparent !important;
        }
    </style>
    </head>
    <body>
    ${bodyHtml}
    </body>
    </html>`;

    const tempDiv = document.createElement("div");
    tempDiv.contentEditable = "true";
    tempDiv.style.position = "absolute";
    tempDiv.style.left = "-9999px";
    tempDiv.innerHTML = bodyHtml;
    document.body.appendChild(tempDiv);

    const selection = window.getSelection();
    if (!selection) return;

    const range = document.createRange();
    range.selectNodeContents(tempDiv);
    selection.removeAllRanges();
    selection.addRange(range);

    const copyListener = (e: ClipboardEvent) => {
      e.preventDefault();
      if (e.clipboardData) {
        e.clipboardData.setData("text/html", wordDoc);
        e.clipboardData.setData(
          "text/plain",
          docPreviewRef.current?.innerText || "",
        );
      }
    };

    document.addEventListener("copy", copyListener);
    let success = false;
    try {
      success = document.execCommand("copy");
    } catch (err) {
      console.error(err);
    }
    document.removeEventListener("copy", copyListener);

    selection.removeAllRanges();
    document.body.removeChild(tempDiv);

    if (success) {
      triggerToast("Đã sao chép tài liệu! Hãy mở Word và nhấn Ctrl+V.");
      await incrementExamCount();
    } else {
      triggerToast(
        "Sao chép lỗi. Vui lòng tự bôi đen ở căn lề xem trước để copy.",
        false,
      );
    }
  };

  const downloadDocAsWord = async () => {
    if (docQuestions.length === 0) {
      triggerToast("Không có nội dung để tải về!", false);
      return;
    }

    const currentExamCount = userDoc?.examCount || 0;
    if (!isApproved && currentExamCount >= 5) {
      triggerToast(
        "Bạn đã đạt giới hạn tính năng tạo tài liệu đề thi trong ngày (tối đa 5 lượt/ngày). Vui lòng liên hệ Admin qua email giathieu110406@gmail.com để được cấp quyền không giới hạn!",
        false,
      );
      return;
    }

    if (!docPreviewRef.current) return;

    const clone = docPreviewRef.current.cloneNode(true) as HTMLDivElement;
    injectMathML(clone);
    injectInlineStyles(clone);

    const bodyHtml = clone.innerHTML;

    const wordDoc = `<html>
    <head>
    <meta charset="UTF-8">
    <meta name="ProgId" content="Word.Document">
    <style>
        @page {
            size: A4;
            margin: 2cm;
        }
        body {
            font-family: ${wordFont};
            font-size: 13pt;
            line-height: 1.15;
            color: #000000;
            margin: 0;
        }
        p, li, span, select, tr, td, th {
            font-family: ${wordFont} !important;
            font-size: 13pt !important;
            line-height: 1.15 !important;
            margin-top: 0 !important;
            margin-bottom: 0 !important;
        }
        div, table {
            font-family: ${wordFont} !important;
            font-size: 13pt !important;
            line-height: 1.15 !important;
        }
        div.doc-display-math {
            margin-top: 6pt !important;
            margin-bottom: 6pt !important;
            text-align: center !important;
        }
        table.doc-answer-table {
            margin-top: 16pt !important;
            margin-bottom: 12pt !important;
            border: 1px solid #10b981 !important;
            background-color: #ecfdf5 !important;
        }
        table.doc-answer-table th, table.doc-answer-table td {
            border: none !important;
            padding: 10pt !important;
        }
        table.doc-options-table, table.doc-options-table th, table.doc-options-table td {
            border: none !important;
        }
        table.doc-header-table, table.doc-header-table th, table.doc-header-table td {
            border: none !important;
        }
        table {
            border-collapse: collapse;
            width: 100%;
            margin-top: 12pt !important;
            margin-bottom: 12pt !important;
        }
        table th, table td {
            border: 1px solid #475569 !important;
            padding: 6px !important;
        }
        table th {
            font-weight: bold !important;
            background-color: transparent !important;
        }
    </style>
    </head>
    <body>
    ${bodyHtml}
    </body>
    </html>`;

    const blob = new Blob(["\ufeff" + wordDoc], {
      type: "application/msword;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "Tai_Lieu_Tu_Luan_Trac_Nghiem.doc";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    triggerToast("Đã tạo và tải file Word (.doc) thành công!");
    await incrementExamCount();
  };

  const normalizeInputText = (text: string): string => {
    if (!text) return "";
    return text
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
  };

  const mergeAdjacentBoldBlocks = (text: string): string => {
    if (!text) return "";
    let merged = text;
    let previous;
    do {
      previous = merged;
      // Merge '**A** <math> **B**' into '**A <math> B**'
      merged = merged.replace(/\*\*(.*?)\*\*([ \t]*)(\$[^\$]+\$|\\\(.*?\\\))([ \t]*)\*\*(.*?)\*\*/g, '**$1$2$3$4$5**');
    } while (merged !== previous);
    return merged;
  };

  const getCleanQuestionBody = (text: string): string => {
    if (!text) return "";
    let clean = mergeAdjacentBoldBlocks(normalizeInputText(text)).trim();
    
    // Clean any leading list bullets or punctuation that appear before the question prefix
    const qMatch = clean.match(/(?:Câu|Bài)\s*(?:\d+|[IVXLCDM]+)\b/i);
    if (qMatch && qMatch.index !== undefined) {
      const idx = qMatch.index;
      const prefix = clean.substring(0, idx);
      // count number of * in prefix
      const starCount = (prefix.match(/\*/g) || []).length;
      // If there are stars, we want to keep them.
      const newPrefix = "*".repeat(starCount);
      clean = newPrefix + clean.substring(idx);
    } else {
      let preCleaned = true;
      while (preCleaned) {
        preCleaned = false;
        if (clean.startsWith("**") && !clean.startsWith("***")) {
          // It starts with a bold indicator, so don't strip
          break;
        }
        
        const firstChar = clean[0];
        if (firstChar && "-+•–—o*›»■▪●:.~>".includes(firstChar)) {
          if (firstChar === "*") {
            if (/^\*\s+/.test(clean)) {
              clean = clean.substring(1).trim();
              preCleaned = true;
            }
          } else {
            clean = clean.substring(1).trim();
            preCleaned = true;
          }
        }
      }
    }
    
    let changed = true;
    while (changed) {
      changed = false;
      
      // Pattern 1: Bold prefix like **Câu 1:** or **Câu 1.** or **Câu 1**
      const boldPrefixRegex = /^\s*\*\*\s*(?:Câu|Bài)\s*\d+\s*[:.\-]*\s*\*\*\s*(?:\s*\d+\s*[:.\-]\s*)?/i;
      if (boldPrefixRegex.test(clean)) {
        clean = clean.replace(boldPrefixRegex, "").trim();
        changed = true;
        continue;
      }
      
      // Pattern 2: Normal prefix like Câu 1: or Câu 1. or Câu 1 - or Bài 1: or Câu 1: 1.
      const normalPrefixRegex = /^\s*(?:Câu|Bài)\s*\d+\s*[:.\-]*\s*(?:\s*\d+\s*[:.\-]\s*)?/i;
      if (normalPrefixRegex.test(clean)) {
        clean = clean.replace(normalPrefixRegex, "").trim();
        changed = true;
        continue;
      }
      
      // Pattern 3: Number prefix like 1. or 1: or 1-
      const numberPrefixRegex = /^\s*\d+\s*[:.\-]\s*/;
      if (numberPrefixRegex.test(clean)) {
        clean = clean.replace(numberPrefixRegex, "").trim();
        changed = true;
        continue;
      }
      
      // Pattern 4: Bold sentence starting with Câu X: inside bold, e.g. **Câu 1: Tìm cực đại**
      const boldSentencePrefixRegex = /^\s*\*\*\s*(?:Câu|Bài)\s*\d+\s*[:.\-]\s*/i;
      if (boldSentencePrefixRegex.test(clean)) {
        clean = clean.replace(/^\s*\*\*\s*(?:Câu|Bài)\s*\d+\s*[:.\-]\s*/i, "**").trim();
        changed = true;
        continue;
      }
      
      // Pattern 5: Bold sentence starting with number prefix inside bold, e.g. **1. Tìm cực đại**
      const boldNumberPrefixRegex = /^\s*\*\*\s*\d+\s*[:.\-]\s*/i;
      if (boldNumberPrefixRegex.test(clean)) {
        clean = clean.replace(/^\s*\*\*\s*\d+\s*[:.\-]\s*/i, "**").trim();
        changed = true;
        continue;
      }
    }
    
    clean = clean.replace(/^\s*\*\*\s*\*\*\s*/, "").trim();
    return clean;
  };

  const getCleanAnswerBody = (text: string): string => {
    return text ? text.trim() : "";
  };

  const hasQuestionPrefix = (text: string): boolean => {
    if (!text) return false;
    return /^\s*(?:[\-\*•\+]\s*)?(?:\**|\*)\s*(?:Câu|Bài)\s*\d+/i.test(text.trim());
  };

  const parseMultipleQuestionsTextToPreview = (text: string): any[] => {
    if (!text) return [];

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

    let convertedText = convertTabTableToMarkdown(normalizedInput);
    let formattedText = applySmartFormatting(convertedText);

    const fixMarkdown = (t: string) => {
      let result = t.replace(/(^|[ \t])\*[ \t]+\*(.*?)\*\*/g, '$1**$2**');
      result = result.replace(/\*[ \t]+\*\*/g, '***');
      result = result.replace(/\*\*[ \t]+\*/g, '***');
      result = result.replace(/^#[ \t]+#/gm, '##');
      result = result.replace(/\*[ \t]+\*(.*?)\*[ \t]+\*/g, '**$1**');
      return result;
    };

    const fixedText = fixMarkdown(formattedText);
    const lines = fixedText.split('\n');
    
    let blocks: {text: string, typeContext: "trac_nghiem" | "trac_nghiem_dung_sai" | "trac_nghiem_tra_loi_ngan" | "tu_luan"}[] = [];
    let currentBlock = "";
    let currentTypeContext = newQuestionType;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineTrimmed = line.trim();
        const lowerLine = lineTrimmed.toLowerCase();
        
        const isTableLine = lineTrimmed.startsWith("|");
        const isLaTeXCommand = lineTrimmed.startsWith("\\");
        
        const isNewQuestion = !isTableLine && !isLaTeXCommand && /^(?:[\-\*•\+]\s*)?(?:\*\s*\*|\*\*|\*)?\s*(?:Câu|Bài)\s*(?:hỏi)?\s*(?:\d+)?\s*(?:[:.\-|\*]|$)/i.test(lineTrimmed);
        const isNewSection = /^Phần\s+\d+/i.test(lineTrimmed);

        if (isNewQuestion || isNewSection) {
            if (currentBlock.trim()) blocks.push({ text: currentBlock, typeContext: currentTypeContext });
            
            if (isNewSection) {
                currentBlock = "";
            } else {
                currentBlock = line + '\n';
            }
        } else {
            currentBlock += line + '\n';
        }
    }
    if (currentBlock.trim()) blocks.push({ text: currentBlock, typeContext: currentTypeContext });
    
    blocks = blocks.filter(b => /^(?:[\-\*•\+]\s*)?(?:\*\s*\*|\*\*|\*)?\s*(?:Câu|Bài)/i.test(b.text.trim()));
    
    if (blocks.length === 0) {
        blocks.push({ text: fixedText, typeContext: currentTypeContext });
    }
    
    const parsedQuestions = blocks.map(blockObj => {
        const block = blockObj.text;
        let qLines: string[] = [];
        let aLines: string[] = [];
        let isAnswer = false;
        
        const blockLines = block.split('\n');
        for (let i = 0; i < blockLines.length; i++) {
            const lower = blockLines[i].toLowerCase().trim();
            const plain = lower.replace(/\*/g, '').trim();
            
            if (
                plain.startsWith('đáp án:') || 
                plain.startsWith('đáp án') || 
                plain.startsWith('hướng dẫn giải') || 
                plain.startsWith('lời giải') || 
                plain.startsWith('giải thích') ||
                plain.match(/^--+$/)
            ) {
                isAnswer = true;
            }
            
            if (isAnswer) {
                aLines.push(blockLines[i]);
            } else {
                qLines.push(blockLines[i]);
            }
        }
        
        const questionContent = qLines.join('\n').trim();
        const detectedType = detectQuestionTypeFromBlockContent(questionContent, blockObj.typeContext);
        
        return {
           type: detectedType,
           q: questionContent,
           a: aLines.join('\n').trim()
        };
    });
    
    return parsedQuestions.map(item => ({
        id: "q_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9),
        type: item.type,
        questionText: getCleanQuestionBody(item.q),
        columns: item.type === "trac_nghiem" ? newTracNghiemColumns : undefined,
        answerText: getCleanAnswerBody(item.a),
    }));
  };

  const renumberQuestions = (questions: any[]) => {
    let counts: Record<string, number> = {
      trac_nghiem: 0,
      trac_nghiem_dung_sai: 0,
      trac_nghiem_tra_loi_ngan: 0,
      tu_luan: 0
    };
    return questions.map((q) => {
      counts[q.type] = (counts[q.type] || 0) + 1;
      const currentNum = counts[q.type];
      const text = q.questionText || "";
      
      const prefixRegex = /^(\s*(?:[\-\*•\+]\s*)?)(\**|\*)\s*(Câu|Bài)\s*(\d+)\s*([:.\-]*\s*(?:\**|\*)\s*[:.\-]*|[:.\-]*)/i;
      
      if (prefixRegex.test(text)) {
        const newText = text.replace(prefixRegex, (match, bullet, starsBefore, word, num, after) => {
          return `${bullet || ""}${starsBefore || ""}${word} ${currentNum}${after || ""}`;
        });
        return { ...q, questionText: newText };
      } else {
        return { ...q, questionText: `Câu ${currentNum}. ` + text };
      }
    });
  };

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
       "\\$\\$([\\s\\S]*?)\\$\\$|\\\\\\[([\\s\\S]*?)\\\\\\]|\\\\begin\\{(equation|align|gather|multline|eqnarray|alignat|flalign|split|cases|aligned|alignedat|pmatrix|bmatrix|vmatrix|Bmatrix|Vmatrix|matrix|array)(\\*?)\\}([\\s\\S]*?)\\\\end\\{(?:equation|align|gather|multline|eqnarray|alignat|flalign|split|cases|aligned|alignedat|pmatrix|bmatrix|vmatrix|Bmatrix|Vmatrix|matrix|array)\\*?\\}";
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
        if (isDisplay) {
        mdText += `\n\n@@@MATH_BLOCK_${blockIdx}@@@\n\n`;
      } else {
        mdText += `@@@MATH_BLOCK_${blockIdx}@@@`;
      }
      lastIdx = m.index + raw.length;
    }

    if (lastIdx < input.length) {
      mdText += input.slice(lastIdx);
    }

    if (smartNewline) {
      mdText = applySmartFormatting(mdText);
    }

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

  // Khôi phục công thức khối và loại bỏ thẻ <p> bao ngoài nếu đứng riêng lẻ
    htmlContent = htmlContent.replace(
      /<p>(?:\s|<br\s*\/?>)*@@@MATH_BLOCK_(\d+)@@@(?:\s|<br\s*\/?>)*<\/p>/g,
      (match, idStr) => {
        const block = mathBlocks[+idStr] || "";
        const isDisplay = block.includes('data-display="true"');
        return isDisplay ? block : match;
      }
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

  // --- SYNCHRONIZE LOCAL CACHE ---
  useEffect(() => {
    try {
      if (user) {
        const serializableUser = {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
          photoURL: user.photoURL,
        };
        localStorage.setItem(
          "q_builder_cached_user",
          JSON.stringify(serializableUser),
        );
      } else {
        localStorage.removeItem("q_builder_cached_user");
        localStorage.removeItem("q_builder_cached_user_doc");
      }
    } catch (e) {
      console.error("Lỗi đồng bộ cache user:", e);
    }
  }, [user]);

  useEffect(() => {
    try {
      if (userDoc) {
        localStorage.setItem(
          "q_builder_cached_user_doc",
          JSON.stringify(userDoc),
        );
      } else {
        localStorage.removeItem("q_builder_cached_user_doc");
      }
    } catch (e) {
      console.error("Lỗi đồng bộ cache userDoc:", e);
    }
  }, [userDoc]);

  // --- FIREBASE EFFETS & CONTROLLERS ---
  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      if (!firebaseUser) {
        setUserDoc(null);
        setAuthLoading(false);
      }
    });
    return unsubscribeAuth;
  }, []);

  // Listen to current user's profile document dynamically
  useEffect(() => {
    if (!user) return;
    const todayStr = new Date().toLocaleDateString("vi-VN");

    console.log("[USER AUTH] Đăng nhập:", {
      originalEmail: user.email,
      cleanEmail: user.email?.trim().toLowerCase() || "",
      uid: user.uid,
    });

    // Đặt bộ đếm thời gian tối đa 1.2 giây để tránh bị kẹt loading do kết nối Firestore chậm
    const loadingTimeout = setTimeout(() => {
      setAuthLoading((currentLoading) => {
        if (currentLoading) {
          console.warn(
            "[USER AUTH] Đang tải chậm hơn bình thường, tự động kích hoạt giao diện nhanh fallback...",
          );
          setUserDoc((currentDoc) => {
            if (!currentDoc) {
              const isOwner = checkIsOwnerEmail(user);
              const targetRole = isOwner ? "admin" : "user";
              return {
                uid: user.uid,
                email: user.email || "",
                displayName:
                  user.displayName || user.email?.split("@")[0] || "Người dùng",
                role: targetRole,
                status: isOwner ? "approved" : "pending",
                queryCount: 0,
                latexCount: 0,
                examCount: 0,
                promptCount: 0,
                createdAt: new Date().toISOString(),
                lastLatexResetDate: todayStr,
              };
            }
            return currentDoc;
          });
          return false;
        }
        return currentLoading;
      });
    }, 1200);

    const userDocRef = doc(db, "users", user.uid);
    const unsubscribeDoc = onSnapshot(
      userDocRef,
      (docSnap) => {
        clearTimeout(loadingTimeout);

        if (docSnap.exists()) {
          const data = docSnap.data();
          let needsUpdate = false;
          const updateData: any = {};

          const currentEmail = user.email || user.providerData?.[0]?.email || "";
          if (currentEmail && data.email !== currentEmail) {
            updateData.email = currentEmail;
            needsUpdate = true;
          }

          if (data.lastLatexResetDate !== todayStr) {
            updateData.latexCount = 0;
            updateData.promptCount = 0;
            updateData.lastLatexResetDate = todayStr;
            needsUpdate = true;
          }

          const isOwner = checkIsOwnerEmail(user);

          if (needsUpdate && !(window as any)._hasAttemptedProfileUpdate) {
            (window as any)._hasAttemptedProfileUpdate = true;
            updateDoc(userDocRef, updateData).catch((err) => {
              console.error("Lỗi tự động cập nhật quyền lợi:", err);
            });
          }

          const mergedProfile = { ...data, ...updateData };
          if (isOwner) {
            mergedProfile.role = "admin";
            mergedProfile.status = "approved";
          }
          setUserDoc(mergedProfile);
          setAuthLoading(false);
        } else {
          const isOwner = checkIsOwnerEmail(user);
          const targetRole = isOwner ? "admin" : "user";
          const currentEmail = user.email || user.providerData?.[0]?.email || "";
          const initialProfile = {
            uid: user.uid,
            email: currentEmail,
            displayName:
              user.displayName || currentEmail.split("@")[0] || "Người dùng",
            role: targetRole,
            status: isOwner ? "approved" : "pending",
            queryCount: 0,
            latexCount: 0,
            examCount: 0,
            promptCount: 0,
            createdAt: new Date().toISOString(),
            lastLatexResetDate: todayStr,
          };
          setDoc(userDocRef, initialProfile)
            .then(() => {
              setUserDoc(initialProfile);
              setAuthLoading(false);
            })
            .catch((err) => {
              console.error("Lỗi tạo hồ sơ:", err);
              setUserDoc(initialProfile);
              setAuthLoading(false);
            });
        }
      },
      (err) => {
        clearTimeout(loadingTimeout);
        console.error("Lỗi theo dõi hồ sơ:", err);
        const isOwner = checkIsOwnerEmail(user);
        const currentEmail = user.email || user.providerData?.[0]?.email || "";
        const fallbackProfile = {
          uid: user.uid,
          email: currentEmail,
          displayName: user.displayName || "Người dùng",
          role: isOwner ? "admin" : "user",
          status: isOwner ? "approved" : "pending",
          queryCount: 0,
          latexCount: 0,
          examCount: 0,
          promptCount: 0,
          createdAt: new Date().toISOString(),
          lastLatexResetDate: todayStr,
        };
        setUserDoc(fallbackProfile);
        setAuthLoading(false);
      },
    );

    return () => {
      clearTimeout(loadingTimeout);
      unsubscribeDoc();
    };
  }, [user]);

  // Load user's notifications in real-time
  useEffect(() => {
    if (!user) {
      setNotifications([]);
      return;
    }
    const notificationsQuery = collection(db, "notifications");
    const q = query(
      notificationsQuery,
      where("targetUid", "in", ["all", user.uid]),
    );
    const unsubscribeNotifications = onSnapshot(
      q,
      (querySnap) => {
        const list: any[] = [];
        querySnap.forEach((doc) => {
          list.push({ id: doc.id, ...doc.data() });
        });
        list.sort((a, b) => {
          const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return dateB - dateA;
        });
        setNotifications(list);
      },
      (err) => {
        console.error("Lỗi tải danh sách thông báo:", err);
      },
    );
    return unsubscribeNotifications;
  }, [user]);

  // Synchronize all users for the admin console
  useEffect(() => {
    const isAdmin = isAdminUser(user, userDoc);
    if (!user || !isAdmin) {
      setAllUsers([]);
      return;
    }

    const unsubscribeUsers = onSnapshot(
      collection(db, "users"),
      (querySnap) => {
        const list: any[] = [];
        querySnap.forEach((docSnap) => {
          const data = docSnap.data();
          if (checkIsOwnerEmail({ uid: docSnap.id, email: data.email, displayName: data.displayName } as any)) {
            data.role = "admin";
            data.status = "approved";
          }
          list.push({ uid: docSnap.id, ...data });
        });
        // Sort users by email alphabetically
        list.sort((a, b) => {
          const emailA = a.email || "";
          const emailB = b.email || "";
          return emailA.localeCompare(emailB);
        });
        setAllUsers(list);
      },
      (err) => {
        console.warn("Cảnh báo đồng bộ danh sách thành viên (có thể do độ trễ cập nhật rule):", err);
      }
    );

    return unsubscribeUsers;
  }, [user, userDoc]);

  // Synchronize all feedbacks for the admin console
  useEffect(() => {
    const isAdmin = isAdminUser(user, userDoc);
    if (!user || !isAdmin) {
      setAllFeedbacks([]);
      return;
    }

    const unsubscribeFeedbacks = onSnapshot(
      collection(db, "feedbacks"),
      (querySnap) => {
        const list: any[] = [];
        querySnap.forEach((docSnap) => {
          list.push({ id: docSnap.id, ...docSnap.data() });
        });
        list.sort((a, b) => {
          const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return dateB - dateA;
        });
        setAllFeedbacks(list);
      },
      (err) => {
        console.warn("Cảnh báo đồng bộ danh sách phản hồi (có thể do độ trễ cập nhật rule):", err);
      }
    );

    return unsubscribeFeedbacks;
  }, [user, userDoc]);

  // --- ADMIN PANEL HANDLERS ---
  const handleUpdateUserStatus = async (targetUid: string, status: "approved" | "pending" | "rejected") => {
    try {
      await updateDoc(doc(db, "users", targetUid), { status });
      triggerToast(`Đã chuyển đổi trạng thái thành ${status === "approved" ? "Đã duyệt" : status === "pending" ? "Chờ duyệt" : "Khóa"}!`);
    } catch (e) {
      triggerToast("Lỗi thay đổi trạng thái thành viên.", false);
    }
  };

  const handleUpdateUserRole = async (targetUid: string, role: "admin" | "user") => {
    try {
      await updateDoc(doc(db, "users", targetUid), { role });
      triggerToast(`Đã chuyển đổi vai trò thành ${role === "admin" ? "Quản trị viên" : "Thành viên"}!`);
    } catch (e) {
      triggerToast("Lỗi thay đổi vai trò thành viên.", false);
    }
  };

  const handleResetUserUsage = async (targetUid: string) => {
    try {
      await updateDoc(doc(db, "users", targetUid), {
        latexCount: 0,
        queryCount: 0,
        examCount: 0,
        promptCount: 0,
      });
      triggerToast("Đã thiết lập lại (reset) số lượt sử dụng của thành viên!");
    } catch (e) {
      triggerToast("Lỗi thiết lập lại số lượt sử dụng.", false);
    }
  };

  const handleAdjustUserLimit = async (targetUid: string, field: "latexCount" | "queryCount" | "examCount" | "promptCount", value: number) => {
    try {
      await updateDoc(doc(db, "users", targetUid), {
        [field]: value,
      });
      triggerToast("Đã điều chỉnh chỉ số sử dụng thành công!");
    } catch (e) {
      triggerToast("Lỗi điều chỉnh chỉ số sử dụng.", false);
    }
  };

  const handleSendFeedbackReply = async (fbId: string, targetUid: string, targetEmail: string) => {
    if (!feedbackReplyText.trim()) {
      triggerToast("Vui lòng nhập nội dung phản hồi.", false);
      return;
    }
    setIsSendingReply(true);
    try {
      await updateDoc(doc(db, "feedbacks", fbId), {
        replyText: feedbackReplyText.trim(),
        replyAt: new Date().toISOString(),
      });

      await addDoc(collection(db, "notifications"), {
        title: "Phản hồi từ Admin về đóng góp ý kiến",
        content: `Admin đã phản hồi góp ý của bạn: "${feedbackReplyText.trim()}"`,
        type: "feedback_reply",
        targetUid,
        targetEmail: targetEmail || "Thành viên",
        senderName: "Trần Gia Thiều (Admin)",
        createdAt: new Date().toISOString(),
      });

      triggerToast("Gửi phản hồi thành công!");
      setFeedbackReplyText("");
      setActiveReplyFeedbackId(null);
    } catch (e) {
      console.error("Lỗi gửi phản hồi:", e);
      triggerToast("Lỗi gửi phản hồi và thông báo.", false);
    } finally {
      setIsSendingReply(false);
    }
  };

  const handleSendGeneralNotification = async () => {
    if (!generalNoticeTitle.trim() || !generalNoticeContent.trim()) {
      triggerToast("Vui lòng nhập đầy đủ tiêu đề và nội dung.", false);
      return;
    }
    setIsSendingGeneralNotice(true);
    try {
      let targetEmail = "Tất cả thành viên";
      if (generalNoticeTarget !== "all") {
        const found = allUsers.find((u) => u.uid === generalNoticeTarget);
        targetEmail = found ? found.email || "Người dùng" : "Thành viên được chỉ định";
      }

      await addDoc(collection(db, "notifications"), {
        title: generalNoticeTitle.trim(),
        content: generalNoticeContent.trim(),
        type: generalNoticeTarget === "all" ? "system" : "user",
        targetUid: generalNoticeTarget,
        targetEmail: targetEmail,
        senderName: "Trần Gia Thiều (Admin)",
        createdAt: new Date().toISOString(),
      });

      triggerToast("Đã phát thông báo thành công!");
      setGeneralNoticeTitle("");
      setGeneralNoticeContent("");
      setGeneralNoticeTarget("all");
    } catch (e) {
      console.error("Lỗi phát thông báo:", e);
      triggerToast("Lỗi gửi thông báo hệ thống.", false);
    } finally {
      setIsSendingGeneralNotice(false);
    }
  };

  const handleDeleteFeedback = async (feedbackId: string) => {
    if (!confirm("Bạn có chắc chắn muốn xóa phản hồi này?")) return;
    try {
      await deleteDoc(doc(db, "feedbacks", feedbackId));
      triggerToast("Xóa phản hồi thành công.");
    } catch (e) {
      triggerToast("Lỗi khi xóa phản hồi.", false);
    }
  };

  const handleDeleteUserRecord = async (targetUid: string) => {
    if (!confirm("Bạn có chắc muốn xóa bản ghi thành viên này khỏi cơ sở dữ liệu? (Hành động này không xóa tài khoản Google Auth)")) return;
    try {
      await deleteDoc(doc(db, "users", targetUid));
      triggerToast("Đã xóa bản ghi thành viên.");
    } catch (e) {
      triggerToast("Lỗi khi xóa bản ghi.", false);
    }
  };

  // Auth Operations
  const handleGoogleLogin = async () => {
    setAuthError(null);
    const provider = new GoogleAuthProvider();
    provider.addScope('email');
    provider.addScope('profile');
    provider.setCustomParameters({
      prompt: 'select_account'
    });
    try {
      await signInWithPopup(auth, provider);
      triggerToast("Đăng nhập bằng Google thành công!", true);
    } catch (err: any) {
      if (err.code !== "auth/cancelled-popup-request" && err.code !== "auth/popup-closed-by-user") {
        console.error(err);
      }
      if (err.code === "auth/popup-blocked") {
        setAuthError(
          "Trình duyệt đã chặn cửa sổ bật lên (popup). Vui lòng cấp quyền bật popup hoặc mở trang web trong tab mới.",
        );
      } else if (err.code === "auth/cancelled-popup-request" || err.code === "auth/popup-closed-by-user") {
        // User cancelled, do nothing
      } else {
        setAuthError(err.message || "Đăng nhập bằng Google thất bại.");
      }
    }
  };

  const handleLogout = async () => {
    try {
      setAdminTab("tool");
      await signOut(auth);
      triggerToast("Đã đăng xuất tài khoản!");
    } catch (err) {
      console.error("Đăng xuất lỗi:", err);
    }
  };

  // --- FEEDBACK SUBMISSION & DELETION ---
  const handleSubmitFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      triggerToast("Vui lòng đăng nhập để gửi phản hồi.", false);
      return;
    }
    if (!feedbackText.trim()) {
      triggerToast("Vui lòng nhập nội dung góp ý phản hồi.", false);
      return;
    }
    setIsSubmittingFeedback(true);
    try {
      await addDoc(collection(db, "feedbacks"), {
        uid: user.uid,
        email: user.email || "",
        displayName:
          userDoc?.displayName ||
          user.displayName ||
          user.email?.split("@")[0] ||
          "Người dùng",
        feedbackText: feedbackText.trim(),
        type: feedbackType,
        rating: feedbackRating,
        feedbackImage: feedbackImage || "",
        createdAt: new Date().toISOString(),
        version: "v3.6",
      });
      triggerToast("Cám ơn bạn đã gửi ý kiến đóng góp!", true);
      setFeedbackText("");
      setFeedbackRating(5);
      setFeedbackType("suggestion");
      setFeedbackImage("");
      setIsFeedbackOpen(false);
    } catch (err) {
      console.error("Lỗi gửi phản hồi:", err);
      triggerToast("Gửi ý kiến phản hồi không thành công.", false);
      handleFirestoreError(err, OperationType.CREATE, "feedbacks");
    } finally {
      setIsSubmittingFeedback(false);
    }
  };

  const handleFeedbackDeleteAction = async (fbId: string) => {
    try {
      await deleteDoc(doc(db, "feedbacks", fbId));
      triggerToast("Đã xóa phản hồi thành công.");
    } catch (err) {
      console.error(err);
      triggerToast("Lỗi khi xóa phản hồi.", false);
    }
  };

  // Helper to increment user query logs
  const incrementUserQuery = async () => {
    if (user && userDoc) {
      try {
        await updateDoc(doc(db, "users", user.uid), {
          queryCount: increment(1),
        });
      } catch (err) {
        console.error("Lỗi đếm số truy vấn:", err);
      }
    }
  };

  const incrementLatexCount = async () => {
    if (user && userDoc) {
      try {
        await updateDoc(doc(db, "users", user.uid), {
          latexCount: increment(1),
          queryCount: increment(1),
        });
      } catch (err) {
        console.error("Lỗi đếm số truy cập LaTeX:", err);
      }
    }
  };

  const incrementExamCount = async () => {
    if (user && userDoc) {
      try {
        await updateDoc(doc(db, "users", user.uid), {
          examCount: increment(1),
          queryCount: increment(1),
        });
      } catch (err) {
        console.error("Lỗi đếm số lần biên soạn đề:", err);
      }
    }
  };

  const incrementPromptCount = async () => {
    if (user && userDoc) {
      try {
        await updateDoc(doc(db, "users", user.uid), {
          promptCount: increment(1),
          queryCount: increment(1),
        });
      } catch (err) {
        console.error("Lỗi đếm số lượt dán thông minh AI:", err);
      }
    }
  };

  // Parse HTML string to Markdown recursively
  const nodeToMarkdown = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue || "";
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node as HTMLElement;
    const style = element.getAttribute("style") || "";
    if (style.includes("display: none") || style.includes("display:none")) {
      return "";
    }

    let childContent = "";
    node.childNodes.forEach((child) => {
      childContent += nodeToMarkdown(child);
    });

    const tagName = element.tagName.toLowerCase();
    const isBold =
      tagName === "strong" ||
      tagName === "b" ||
      style.includes("font-weight: bold") ||
      style.includes("font-weight: 700");
    const isItalic =
      tagName === "em" ||
      tagName === "i" ||
      style.includes("font-style: italic");

    let content = childContent;

    if (isBold && content.trim()) {
      const trimmed = content.trim();
      if (!trimmed.startsWith("**") && !trimmed.endsWith("**")) {
        content = `**${trimmed}**`;
      }
    }
    if (isItalic && content.trim()) {
      const trimmed = content.trim();
      if (!trimmed.startsWith("*") && !trimmed.endsWith("*")) {
        content = `*${trimmed}*`;
      }
    }

    switch (tagName) {
      case "table": {
        const rows = Array.from(element.querySelectorAll("tr"));
        if (rows.length === 0) return "";

        let markdownTable = "\n\n";
        rows.forEach((row, rowIndex) => {
          const cells = Array.from(row.querySelectorAll("th, td"));
          const cellContents = cells.map((cell) => {
            let cellText = nodeToMarkdown(cell).trim();
            cellText = cellText.replace(/\|/g, "\\|");
            cellText = cellText.replace(/\r?\n/g, " ");
            return cellText || " ";
          });

          markdownTable += "| " + cellContents.join(" | ") + " |\n";

          if (rowIndex === 0) {
            const separators = cellContents.map(() => "---");
            markdownTable += "| " + separators.join(" | ") + " |\n";
          }
        });
        return markdownTable + "\n";
      }
      case "p":
      case "div":
        return `\n${content.trim()}\n`;
      case "br":
        return "\n";
      case "h1":
        return `\n# ${content.trim()}\n`;
      case "h2":
        return `\n## ${content.trim()}\n`;
      case "h3":
        return `\n### ${content.trim()}\n`;
      case "h4":
      case "h5":
      case "h6":
        return `\n#### ${content.trim()}\n`;
      case "li": {
        const trimmedContent = content.trim();
        // Kiểm tra xem nội dung li đã có sẵn ký tự đánh dấu danh sách ở đầu hay chưa
        const matchNumbered = trimmedContent.match(
          /^\s*(?:(?:Bài\s+)?(\d+)|([a-zA-Z]))[\.\)\/\s-]\s*(.*)$/i,
        );
        const matchBullet = trimmedContent.match(/^\s*([\-\*•·o])\s*(.*)$/);

        if (matchNumbered) {
          const num = matchNumbered[1] || matchNumbered[2];
          const separator = trimmedContent.includes(")") ? ")" : ".";
          const isBai = trimmedContent.toLowerCase().startsWith("bài");
          const prefix = isBai ? `Bài ${num}` : num;
          return `\n${prefix}${separator} ${matchNumbered[3].trim()}\n`;
        } else if (matchBullet) {
          const bulletChar =
            matchBullet[1] === "·" || matchBullet[1] === "o"
              ? "•"
              : matchBullet[1];
          return `\n${bulletChar} ${matchBullet[2].trim()}\n`;
        } else {
          const parent = element.parentNode as HTMLElement | null;
          const isOrdered = parent && parent.tagName.toLowerCase() === "ol";
          if (isOrdered) {
            const siblings = Array.from(parent.children);
            const idx = siblings.indexOf(element) + 1;
            return `\n${idx}. ${trimmedContent}\n`;
          } else {
            return `\n- ${trimmedContent}\n`;
          }
        }
      }
      case "a": {
        const href = element.getAttribute("href") || "";
        if (href) {
          return `[${content.trim()}](${href})`;
        }
        return content;
      }
      case "ul":
      case "ol":
        return `\n${content.trim()}\n`;
      case "blockquote":
        return `\n> ${content.trim()}\n`;
      case "code":
        return ` \`${content.trim()}\` `;
      case "pre":
        return `\n\`\`\`\n${content.trim()}\n\`\`\`\n`;
      default:
        return content;
    }
  };

  // Convert rich HTML to Markdown
  const convertHtmlToMarkdown = (htmlString: string): string => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, "text/html");

    const isWord =
      htmlString.includes("mso-") ||
      htmlString.includes("MsoNormal") ||
      htmlString.includes("urn:schemas-microsoft-com:office");
    if (isWord) {
      // 1. Loại bỏ các thẻ rác, xml, style của Word
      doc
        .querySelectorAll("style, script, xml, meta, link, o\\:p")
        .forEach((el) => el.remove());

      // 2. Xử lý các thẻ li có chứa span mso-list:Ignore để tránh trùng lặp đánh số
      doc.querySelectorAll("li").forEach((li) => {
        const ignoreSpan = li.querySelector(
          '[style*="mso-list:Ignore"], [style*="mso-list: ignore"]',
        );
        if (ignoreSpan) {
          ignoreSpan.remove();
        }
      });

      // 3. Xử lý các đoạn văn MsoListParagraph có mso-list:Ignore của Word
      doc
        .querySelectorAll('.MsoListParagraph, [style*="mso-list:"]')
        .forEach((el) => {
          const ignoreSpan = el.querySelector(
            '[style*="mso-list:Ignore"], [style*="mso-list: ignore"]',
          );
          if (ignoreSpan) {
            let bulletText = ignoreSpan.textContent || "";
            bulletText = bulletText.replace(/\s+/g, " ").trim();
            if (bulletText) {
              if (
                /^[\u00b7\u2022\u25aa\u25fc\u25cf\u2023\-o\*]$/.test(
                  bulletText,
                ) ||
                bulletText.charCodeAt(0) === 183 ||
                bulletText.charCodeAt(0) === 8226
              ) {
                ignoreSpan.textContent = "• ";
              } else {
                ignoreSpan.textContent = bulletText + " ";
              }
            }
          }
        });
    }

    // 1. Recover Katex formulas
    const katexElements = doc.querySelectorAll(".katex, .katex-display");
    katexElements.forEach((el) => {
      const annotation = el.querySelector(
        'annotation[encoding="application/x-tex"]',
      );
      if (annotation) {
        const latex = annotation.textContent?.trim() || "";
        const isDisplay =
          el.classList.contains("katex-display") || el.tagName === "DIV";
        const replacement = isDisplay ? `\n$$${latex}$$\n` : `$${latex}$`;
        el.replaceWith(doc.createTextNode(replacement));
      } else {
        const mathMl = el.querySelector("math");
        if (mathMl && mathMl.getAttribute("alttext")) {
          const latex = mathMl.getAttribute("alttext") || "";
          const isDisplay = el.classList.contains("katex-display");
          const replacement = isDisplay ? `\n$$${latex}$$\n` : `$${latex}$`;
          el.replaceWith(doc.createTextNode(replacement));
        }
      }
    });

    // 2. Handle MathJax script types if present
    doc.querySelectorAll(".MathJax, .MathJax_Display").forEach((el) => {
      const script = el.querySelector('script[type^="math/tex"]');
      if (script) {
        const latex = script.textContent?.trim() || "";
        const isDisplay =
          script.getAttribute("type")?.includes("mode=display") || false;
        const replacement = isDisplay ? `\n$$${latex}$$\n` : `$${latex}$`;
        el.replaceWith(doc.createTextNode(replacement));
      }
    });

    return nodeToMarkdown(doc.body).trim();
  };

  // HTML to Overleaf Compiler recursively
  const nodeToLaTeX = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeLaTeX(node.nodeValue || "");
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node as HTMLElement;

    // Fast-path extract of custom raw KaTeX elements saved dynamically
    if (element.classList.contains("katex-custom-wrapper")) {
      const latex = element.getAttribute("data-latex") || "";
      const isDisplay = element.getAttribute("data-display") === "true";
      if (isDisplay) {
        return `\n\\begin{equation*}\n${latex.trim()}\n\\end{equation*}\n`;
      } else {
        return `$${latex.trim()}$`;
      }
    }

    let childContent = "";
    node.childNodes.forEach((child) => {
      childContent += nodeToLaTeX(child);
    });

    const tagName = element.tagName.toLowerCase();
    switch (tagName) {
      case "table": {
        const rows = Array.from(element.querySelectorAll("tr"));
        if (rows.length === 0) return "";

        let maxCols = 0;
        const rowsData = rows.map((row) => {
          const cells = Array.from(row.querySelectorAll("th, td"));
          if (cells.length > maxCols) {
            maxCols = cells.length;
          }
          return cells.map((cell) => {
            let cellContent = "";
            cell.childNodes.forEach((child) => {
              cellContent += nodeToLaTeX(child);
            });
            return cellContent.trim();
          });
        });

        if (maxCols === 0) return "";

        const colSpec = "|" + "c|".repeat(maxCols);
        let latexTable =
          "\n\\begin{table}[h]\n\\centering\n\\begin{tabular}{" +
          colSpec +
          "}\n\\hline\n";

        rowsData.forEach((rowCells) => {
          const paddedCells = [...rowCells];
          while (paddedCells.length < maxCols) {
            paddedCells.push("");
          }
          latexTable += paddedCells.join(" & ") + " \\\\ \\hline\n";
        });

        latexTable += "\\end{tabular}\n\\end{table}\n";
        return latexTable;
      }
      case "p":
      case "div":
        return `\n\n${childContent.trim()}\n\n`;
      case "br":
        return " \\\\\n";
      case "h1":
         return `\n\\section*{${childContent.trim()}}\n`;
      case "h2":
        return `\n\\subsection*{${childContent.trim()}}\n`;
      case "h3":
         return `\n\\subsubsection*{${childContent.trim()}}\n`;
      case "h4":
      case "h5":
      case "h6":
        return `\n\\paragraph{${childContent.trim()}}\n`;
      case "strong":
      case "b":
        return `\\textbf{${childContent.trim()}}`;
      case "em":
      case "i":
        return `\\textit{${childContent.trim()}}`;
      case "a": {
        const href = element.getAttribute("href") || "";
        const linkText = childContent.trim();
        if (href) {
          if (linkText === href || !linkText) {
            return `\\url{${href}}`;
          }
          return `\\href{${href}}{${linkText}}`;
        }
        return linkText;
      }
      case "li":
        return `  \\item ${childContent.trim()}\n`;
      case "ul":
        return `\n\\begin{itemize}\n${childContent.trim()}\n\\end{itemize}\n`;
      case "ol":
        return `\n\\begin{enumerate}\n${childContent.trim()}\n\\end{enumerate}\n`;
      case "blockquote":
        return `\n\\begin{quote}\n${childContent.trim()}\n\\end{quote}\n`;
      case "code":
        return `\\texttt{${childContent.trim()}}`;
      case "pre":
        return `\n\\begin{verbatim}\n${element.textContent?.trim()}\n\\end{verbatim}\n`;
      default:
        return childContent;
    }
  };

  const generateOverleafDocument = (bodyLaTeX: string): string => {
    const cleanedBody = bodyLaTeX.trim().replace(/\n{3,}/g, "\n\n");
    return `\\documentclass[12pt, a4paper]{article}

% =========================================================================
% CẤU HÌNH TIẾNG VIỆT & PHÔNG CHỮ CHUẨN OVERLEAF (pdfLaTeX)
% =========================================================================
\\usepackage[T5]{fontenc}      % BẮT BUỘC: Encode ký tự tiếng Việt cho pdfLaTeX
\\usepackage[utf8]{inputenc}   % Đọc file nguồn UTF-8
\\usepackage[vietnamese]{babel} % Đảm bảo hiển thị đúng dấu tiếng Việt

% =========================================================================
% CÁC GÓI TOÁN HỌC KHÔNG THỂ THIẾU
% =========================================================================
\\usepackage{amsmath, amssymb, amsfonts} % Hỗ trợ định dạng và ký hiệu toán cao cấp

% =========================================================================
% CẤU HÌNH TRÌNH BÀY & TRANG TRÍ LỀ HỌC THUẬT
% =========================================================================
\\usepackage{geometry}
\\geometry{a4paper, margin=2.5cm} % Thiết lập khoảng cách lề chuẩn học thuật

\\usepackage{hyperref}
\\hypersetup{
    colorlinks=true,
    linkcolor=blue,
    filecolor=magenta,      
    urlcolor=cyan,
}

\\begin{document}

${cleanedBody}

\\end{document}`;
  };

  // Perform processing whenever inputs or settings change
  useEffect(() => {
    // Bước 1: Normalize input (NFC, loại bỏ BOM, chuẩn hoá smart quotes) - Dựa theo thuật toán từ tài liệu
    let normalizedInput = inputText;
    if (normalizedInput) {
      normalizedInput = normalizedInput
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
    }

    // Protect URLs from being mangled or broken by applySmartFormatting or KaTeX parsing
    const { protectedText, urls } = protectUrls(normalizedInput);
    let input = protectedText;

    if (!inputText.trim()) {
      setProcessedHtml(
        '<p class="text-slate-400 italic font-medium">Kết quả học thuật sẽ hiển thị trực quan tại đây...</p>',
      );
      setOverleafCode("");
      return;
    }

    // Bước 2: Loại bỏ LaTeX trong code blocks
    const codeRanges: [number, number][] = [];
    const CODE_BLOCK_REGEX = /```[\s\S]*?```|`[^`\n]+`/g;
    let codeMatch;
    // We must reset lastIndex in case it was used elsewhere
    CODE_BLOCK_REGEX.lastIndex = 0;
    while ((codeMatch = CODE_BLOCK_REGEX.exec(input)) !== null) {
      codeRanges.push([codeMatch.index, codeMatch.index + codeMatch[0].length]);
    }

    // Bước 3: Thuật toán nhận diện LaTeX tiên tiến (hỗ trợ nested environments và tránh greedy fail)
    const DISPLAY_MATH_REGEX =
       "\\$\\$([\\s\\S]*?)\\$\\$|\\\\\\[([\\s\\S]*?)\\\\\\]|\\\\begin\\{(equation|align|gather|multline|eqnarray|alignat|flalign|split|cases|aligned|alignedat|pmatrix|bmatrix|vmatrix|Bmatrix|Vmatrix|matrix|array)(\\*?)\\}([\\s\\S]*?)\\\\end\\{(?:equation|align|gather|multline|eqnarray|alignat|flalign|split|cases|aligned|alignedat|pmatrix|bmatrix|vmatrix|Bmatrix|Vmatrix|matrix|array)\\*?\\}";
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
        let normalized = normalizeLaTeX(latex.trim(), !isDisplay);
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
        mathHtml = `<span style="color:#f43f5e" title="${escHtml(e.message || "Error")}">${escHtml(raw)}</span>`;
      }

      const blockIdx = mathBlocks.length;
      mathBlocks.push(mathHtml);
        if (isDisplay) {
        mdText += `\n\n@@@MATH_BLOCK_${blockIdx}@@@\n\n`;
      } else {
        mdText += `@@@MATH_BLOCK_${blockIdx}@@@`;
      }
      lastIdx = m.index + raw.length;
    }

    if (lastIdx < input.length) {
      mdText += input.slice(lastIdx);
    }

    if (smartNewline) {
      mdText = applySmartFormatting(mdText);
    }

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

  // Khôi phục công thức khối và loại bỏ thẻ <p> bao ngoài nếu đứng riêng lẻ
    htmlContent = htmlContent.replace(
      /<p>(?:\s|<br\s*\/?>)*@@@MATH_BLOCK_(\d+)@@@(?:\s|<br\s*\/?>)*<\/p>/g,
      (match, idStr) => {
        const block = mathBlocks[+idStr] || "";
        const isDisplay = block.includes('data-display="true"');
        return isDisplay ? block : match;
      }
    );

    // Replace equations back an toàn không tiêu thụ ký tự kế tiếp
    htmlContent = htmlContent.replace(
      /@@@MATH_BLOCK_(\d+)@@@/g,
      (match, idStr, offset, fullStr) => {
        const block = mathBlocks[+idStr] || "";
        if (!block) return "";
        const isDisplay = block.includes('data-display="true"');
        if (isDisplay) return block;
        const nextSlice = fullStr.slice(offset + match.length);
        const nextWordMatch = nextSlice.match(/^(?:[\s\u00a0\u200b]|&nbsp;)*([^.,;:!?\)\}\]”’"`\s<@])/);
        if (nextWordMatch && !nextSlice.startsWith(" ")) {
          return block + " ";
        }
        return block;
      },
    );

    setProcessedHtml(htmlContent);

    // Make temporary element to calculate Overleaf output
    const tempContainer = document.createElement("div");
    tempContainer.innerHTML = htmlContent;
    const generatedLaTeXBody = nodeToLaTeX(tempContainer);
    setOverleafCode(generateOverleafDocument(generatedLaTeXBody));
  }, [inputText, smartNewline]);

  const triggerToast = (msg: string, success: boolean = true) => {
    setToast({ show: true, msg, success });
  };

  const handleManualAutoFix = async () => {
    if (!inputText.trim()) {
      triggerToast("Vui lòng nhập văn bản trước để sửa dính chữ!", false);
      return;
    }
    const currentLatexCount = userDoc?.latexCount || 0;
    if (!isApproved && currentLatexCount >= 30) {
      triggerToast(
        "Bạn đã đạt giới hạn tính năng chuyển đổi LaTeX trong ngày (tối đa 30 lượt/ngày). Hãy liên hệ Admin qua email giathieu110406@gmail.com để được cấp quyền không giới hạn!",
        false,
      );
      return;
    }
    const fixedText = applySmartFormatting(inputText);
    if (fixedText === inputText) {
      triggerToast("Văn bản đã chuẩn, không phát hiện lỗi dính chữ!", true);
    } else {
      setInputText(fixedText);
      triggerToast(
        "Đã tự động sửa lỗi dính chữ triệt để cho cả khung nhập và khung hiển thị đầu ra!",
        true,
      );
      await incrementLatexCount();
    }
  };

  const insertTextAroundSelection = (prefix: string, suffix: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const text = el.value;
    const selected = text.substring(start, end);
    const replacement = prefix + selected + suffix;
    const newText =
      text.substring(0, start) + replacement + text.substring(end);
    setInputText(newText);

    setTimeout(() => {
      el.focus();
      el.setSelectionRange(
        start + prefix.length,
        start + prefix.length + selected.length,
      );
    }, 0);
  };

  const handleBold = () => {
    insertTextAroundSelection("**", "**");
  };

  const handleItalic = () => {
    insertTextAroundSelection("*", "*");
  };

  const handlePasteGeneric = (
    e: React.ClipboardEvent<HTMLTextAreaElement>,
    setter: (val: string) => void,
    bypassAutoProcess?: boolean,
  ) => {
    const htmlData = e.clipboardData.getData("text/html");
    let markdown = "";

    if (htmlData) {
      e.preventDefault();
      markdown = convertHtmlToMarkdown(htmlData);
    } else {
      const plainText = e.clipboardData.getData("text/plain");
      if (plainText) {
        e.preventDefault();
        markdown = plainText;
      } else {
        return;
      }
    }

    // Bước 1: Normalize input (NFC, loại bỏ BOM, chuẩn hoá smart quotes)
    markdown = markdown
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

    markdown = markdown.replace(/\n{3,}/g, "\n\n");

    // Auto convert tab-separated values pasted from Word/Excel to markdown tables
    markdown = convertTabTableToMarkdown(markdown);

    // Collapse consecutive word whitespaces (spaces/mso tabs) on non-table lines
    markdown = markdown
      .split("\n")
      .map((line) => {
        if (line.trim().startsWith("|")) return line;
        return line.replace(
          /[ \t\u00a0\u2000-\u200a\u202f\u205f\u3000]{2,}/g,
          " ",
        );
      })
      .join("\n");

    // Auto-apply smart formatting on paste to fix stuck words/numbers/delimiters instantly
    markdown = applySmartFormatting(markdown);

    // Xử lý thông minh: Nếu người dùng dán nhiều câu hỏi cùng lúc, tự động phân tách và nạp vào đề!
    const lines = markdown.split('\n');
    let cauCount = 0;
    for (const line of lines) {
      if (/^(?:Câu|Bài)\s*(?:hỏi)?\s*(?:\d+)?\s*(?:[:.\-|\*]|$)/i.test(line.trim())) {
        cauCount++;
      }
    }
    
    // Nếu có từ 2 câu trở lên, chạy tính năng "Dán thông minh" ẩn danh (nếu không bypass)
    if (!bypassAutoProcess && cauCount >= 2) {
      const currentPromptCount = userDoc?.promptCount || 0;
      if (!isApproved && currentPromptCount >= 10) {
        triggerToast(
          "Bạn đã đạt giới hạn tính năng dán thông minh (AI) trong ngày (tối đa 10 lượt/ngày). Hãy liên hệ Admin qua email giathieu110406@gmail.com để được cấp quyền không giới hạn!",
          false,
        );
        return;
      }
      processMultipleQuestionsText(markdown);
      incrementPromptCount();
      // Xóa nội dung trong khung nhập hiện tại để tránh lưu trùng lặp
      setter("");
      return;
    }

    const textEl = e.currentTarget;
    const start = textEl.selectionStart;
    const end = textEl.selectionEnd;
    const originalVal = textEl.value;

    const updatedVal =
      originalVal.slice(0, start) + markdown + originalVal.slice(end);
    setter(updatedVal);

    // Delay selection setting to wait for React state update
    setTimeout(() => {
      textEl.selectionStart = textEl.selectionEnd = start + markdown.length;
    }, 0);

    triggerToast(
      "Đã tự động chuyển đổi và tối ưu hóa nội dung dán từ Word/AI!",
      true,
    );
  };

  const handlePasteChange = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    handlePasteGeneric(e, setInputText);
  };

  // Copy code handler
  const handleCopyAction = async () => {
    if (activeTab === "word") {
      await copyToWord();
    } else {
      await copyRawLaTeX();
    }
  };

  const copyRawLaTeX = async () => {
    const rawText = overleafCode.trim();
    if (!rawText) {
      triggerToast("Chưa có nội dung để sao chép!", false);
      return;
    }

    const currentLatexCount = userDoc?.latexCount || 0;
    if (!isApproved && currentLatexCount >= 30) {
      triggerToast(
        "Bạn đã đạt giới hạn tính năng chuyển đổi LaTeX trong ngày (tối đa 30 lượt/ngày). Hãy liên hệ Admin qua email giathieu110406@gmail.com để được cấp quyền không giới hạn!",
        false,
      );
      return;
    }

    const tempTextArea = document.createElement("textarea");
    tempTextArea.value = rawText;
    tempTextArea.style.position = "absolute";
    tempTextArea.style.left = "-9999px";
    document.body.appendChild(tempTextArea);
    tempTextArea.select();

    let success = false;
    try {
      success = document.execCommand("copy");
    } catch (e) {
      console.error(e);
    }
    document.body.removeChild(tempTextArea);

    if (success) {
      triggerToast("Đã sao chép tài liệu LaTeX hoàn chỉnh!");
      await incrementLatexCount();
    } else {
      triggerToast("Sao chép thất bại. Vui lòng tự bôi đen và copy.", false);
    }
  };

  const downloadAsPdf = async () => {
    const rawText = overleafCode.trim();
    if (!rawText) {
      triggerToast("Chưa có nội dung để tải về!", false);
      return;
    }

    const currentLatexCount = userDoc?.latexCount || 0;
    if (!isApproved && currentLatexCount >= 30) {
      triggerToast(
        "Bạn đã đạt giới hạn tính năng tải tài liệu trong ngày (tối đa 30 lượt/ngày). Hãy liên hệ Admin qua email giathieu110406@gmail.com để được cấp quyền không giới hạn!",
        false,
      );
      return;
    }

    triggerToast("Đang chuẩn bị xuất PDF...", true);

    try {
      // === PHƯƠNG PHÁP: Print-to-PDF qua iframe ẩn ===
      // Hoạt động ổn định trên mọi môi trường (GitHub Pages, tên miền thực)
      // Không cần mở tab mới, không bị popup blocker chặn, không phụ thuộc dịch vụ ngoài.

      // Lấy nội dung HTML đã được render (giống hàm downloadAsWord)
      if (!previewRef.current) {
        triggerToast("Không tìm thấy nội dung để xuất PDF!", false);
        return;
      }

      const clone = previewRef.current.cloneNode(true) as HTMLDivElement;
      injectMathML(clone);
      injectInlineStyles(clone);
      const bodyHtml = clone.innerHTML;

      // Tạo HTML đầy đủ cho trang in PDF
      const printHtml = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tài liệu - PDF</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
  <style>
    @page {
      size: A4;
      margin: 2cm;
    }
    * { box-sizing: border-box; }
    body {
      font-family: ${wordFont};
      font-size: 13pt;
      line-height: 1.15;
      color: #000;
      margin: 0;
      padding: 0;
      background: white;
    }
    h1, h2, h3, h4, h5, h6, p, li, span, select, tr, td, th {
      font-family: ${wordFont} !important;
      font-size: 13pt !important;
      line-height: 1.15 !important;
      margin-top: 0 !important;
      margin-bottom: 0 !important;
    }
    div, table {
      font-family: ${wordFont} !important;
      font-size: 13pt !important;
      line-height: 1.15 !important;
    }
    div.doc-display-math {
      margin-top: 6pt !important;
      margin-bottom: 6pt !important;
      text-align: center !important;
    }
    table.doc-answer-table {
      margin-top: 16pt !important;
      margin-bottom: 12pt !important;
      border: 1px solid #475569 !important;
      background-color: transparent !important;
    }
    table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
    table th, table td { border: 1px solid #000; padding: 4pt 6pt; font-size: 13pt; }
    table th { font-weight: bold; background: #f5f5f5; }
    .katex { font-size: 1em; }
    .katex-display { margin: 8pt 0; text-align: center; overflow-x: auto; }
    img { max-width: 100%; }
    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;

      // Tạo iframe ẩn để in
      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";
      iframe.style.visibility = "hidden";
      document.body.appendChild(iframe);

      const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!iframeDoc) {
        document.body.removeChild(iframe);
        triggerToast("Trình duyệt không hỗ trợ xuất PDF. Hãy thử cách khác!", false);
        return;
      }

      iframeDoc.open();
      iframeDoc.write(printHtml);
      iframeDoc.close();

      // Đợi tài nguyên (fonts, katex CSS) được tải xong
      await new Promise<void>((resolve) => {
        if (iframe.contentWindow) {
          iframe.contentWindow.onload = () => resolve();
          // Fallback timeout nếu onload không fire
          setTimeout(resolve, 1200);
        } else {
          setTimeout(resolve, 1200);
        }
      });

      triggerToast("Đang mở hộp thoại in — chọn 'Save as PDF' để lưu file!", true);

      // Gọi print dialog của trình duyệt (Ctrl+P)
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();

      // Cleanup iframe sau khi in xong
      setTimeout(() => {
        if (document.body.contains(iframe)) {
          document.body.removeChild(iframe);
        }
      }, 3000);

      await incrementLatexCount();
    } catch (error) {
      console.error("Lỗi khi xuất PDF:", error);
      triggerToast("Có lỗi xảy ra khi xuất PDF. Vui lòng thử lại!", false);
    }
  };

  const injectInlineStyles = (root: HTMLDivElement) => {
    root.querySelectorAll("h1").forEach((el) => {
      const element = el as HTMLElement;
      element.style.margin = "0";
      element.style.fontFamily = wordFont;
      element.style.fontSize = "18pt";
      element.style.fontWeight = "bold";
      element.style.lineHeight = "1.2";
    });
    root.querySelectorAll("h2").forEach((el) => {
      const element = el as HTMLElement;
      element.style.margin = "0";
      element.style.fontFamily = wordFont;
      element.style.fontSize = "16pt";
      element.style.fontWeight = "bold";
      element.style.lineHeight = "1.2";
    });
    root.querySelectorAll("h3").forEach((el) => {
      const element = el as HTMLElement;
      element.style.margin = "0";
      element.style.fontFamily = wordFont;
      element.style.fontSize = "14pt";
      element.style.fontWeight = "bold";
      element.style.lineHeight = "1.2";
    });
    root.querySelectorAll("h4, h5, h6").forEach((el) => {
      const element = el as HTMLElement;
      element.style.margin = "0";
      element.style.fontFamily = wordFont;
      element.style.fontSize = "13pt";
      element.style.fontWeight = "bold";
      element.style.lineHeight = "1.2";
    });
    root.querySelectorAll("p").forEach((el) => {
      const element = el as HTMLElement;
      element.style.margin = "0";
      element.style.fontFamily = wordFont;
      element.style.fontSize = "13pt";
      element.style.lineHeight = "1.15";
    });
    root.querySelectorAll("strong, b").forEach((el) => {
      const element = el as HTMLElement;
      element.style.fontWeight = "bold";
      element.style.fontFamily = wordFont;
    });
    root.querySelectorAll("em, i").forEach((el) => {
      const element = el as HTMLElement;
      element.style.fontStyle = "italic";
      element.style.fontFamily = wordFont;
    });
    // Chuyển đổi toàn bộ danh sách có thứ tự (ol) thành các đoạn văn thường có thụt lề treo (hanging indent)
    // để tránh hiện tượng Word tự động đánh số (automatic numbered list) gây lỗi nhảy số thứ tự đề mục
    const olist = Array.from(root.querySelectorAll("ol"));
    olist.reverse().forEach((ol) => {
      const paragraphs: HTMLElement[] = [];
      const children = Array.from(ol.children);
      children.forEach((li, index) => {
        const liClone = li.cloneNode(true) as HTMLElement;
        liClone.querySelectorAll("p").forEach((pEl) => {
          const span = document.createElement("span");
          span.innerHTML = pEl.innerHTML;
          pEl.parentNode?.replaceChild(span, pEl);
        });

        const p = document.createElement("p");
        p.style.margin = "0 0 0 20pt";
        p.style.paddingLeft = "20pt";
        p.style.textIndent = "-20pt";
        p.style.fontFamily = wordFont;
        p.style.fontSize = "13pt";
        p.style.lineHeight = "1.15";

        p.innerHTML = `<span style="font-family: ${wordFont}; font-size: 13pt; font-weight: bold; color: #111827;">${index + 1}.</span>&#9;&#8203;${liClone.innerHTML}`;
        paragraphs.push(p);
      });

      paragraphs.forEach((p) => {
        ol.parentNode?.insertBefore(p, ol);
      });
      ol.remove();
    });

    // Chuyển đổi danh sách không thứ tự (ul) thành các đoạn văn thường có ký hiệu bullet tĩnh
    const ulist = Array.from(root.querySelectorAll("ul"));
    ulist.reverse().forEach((ul) => {
      const paragraphs: HTMLElement[] = [];
      const children = Array.from(ul.children);
      children.forEach((li) => {
        const liClone = li.cloneNode(true) as HTMLElement;
        liClone.querySelectorAll("p").forEach((pEl) => {
          const span = document.createElement("span");
          span.innerHTML = pEl.innerHTML;
          pEl.parentNode?.replaceChild(span, pEl);
        });

        const p = document.createElement("p");
        p.style.margin = "0 0 0 15pt";
        p.style.paddingLeft = "15pt";
        p.style.textIndent = "-15pt";
        p.style.fontFamily = wordFont;
        p.style.fontSize = "13pt";
        p.style.lineHeight = "1.15";

        p.innerHTML = `<span style="font-family: ${wordFont}; font-size: 13pt; font-weight: bold; color: #111827;">•</span>&#9;&#8203;${liClone.innerHTML}`;
        paragraphs.push(p);
      });

      paragraphs.forEach((p) => {
        ul.parentNode?.insertBefore(p, ul);
      });
      ul.remove();
    });
    root.querySelectorAll("br").forEach((el) => {
      el.setAttribute("style", "mso-special-character:line-break");
    });

    // Custom document segments to match preview design exactly when exported to MS Word
    root.querySelectorAll(".doc-header-block").forEach((el) => {
      const element = el as HTMLElement;
      if (!element.querySelector("table")) {
        element.style.textAlign = "center";
      }
      element.style.borderBottom = "3px double #1e293b";
      element.style.paddingBottom = "12pt";
      element.style.marginBottom = "0";
      element.style.marginTop = "0";
    });
    root.querySelectorAll(".doc-title-text").forEach((el) => {
      const element = el as HTMLElement;
      element.style.fontSize = "16pt";
      element.style.fontWeight = "800";
      element.style.textAlign = "center";
      element.style.color = "#111827";
      element.style.margin = "0";
      element.style.display = "block";
    });
    root.querySelectorAll(".doc-subtitle-text").forEach((el) => {
      const element = el as HTMLElement;
      element.style.fontSize = "13pt"; // Minimum 13pt
      element.style.fontStyle = "italic";
      element.style.fontWeight = "600";
      element.style.color = "#4b5563";
      element.style.textAlign = "center";
      element.style.margin = "0";
      element.style.display = "block";
    });
    root.querySelectorAll(".doc-section-header").forEach((el) => {
      const element = el as HTMLElement;
      element.style.fontWeight = "bold";
      element.style.color = "#111827";
      element.style.fontSize = "14pt";
      element.style.borderBottom = "2px solid #111827";
      element.style.paddingBottom = "4pt";
      element.style.marginTop = "0";
      element.style.marginBottom = "0";
      element.style.display = "block";
    });

    root.querySelectorAll(".doc-question-item").forEach((el) => {
      const element = el as HTMLElement;
      element.style.paddingBottom = "8pt";
      element.style.borderBottom = "none";
      element.style.marginBottom = "0";
      element.style.marginTop = "0";

      // Tối ưu hóa hiển thị cho Word: Chuyển đổi bố cục flex sang p có thụt lề treo (hanging indent)
      // Giúp Câu 1, Câu 2... và nội dung câu hỏi thẳng hàng đẹp mắt và không bị vỡ dòng trong MS Word
      const flexDiv = element.querySelector(".flex.items-start");
      if (flexDiv) {
        const badge = flexDiv.querySelector(".doc-type-badge");
        const contentDiv = flexDiv.querySelector("div:not(.doc-type-badge)");
        if (badge && contentDiv) {
          const badgeText = badge.textContent || "";

          const p = document.createElement("p");
          p.style.margin = "0";
          p.style.paddingLeft = "45pt";
          p.style.textIndent = "-45pt";
          p.style.display = "block";
          p.style.fontFamily = wordFont;
          p.style.fontSize = "13pt";
          p.style.lineHeight = "1.15";
          p.style.color = "#111827";

          contentDiv.querySelectorAll("p").forEach((childP) => {
            (childP as HTMLElement).style.paddingLeft = "45pt";
            (childP as HTMLElement).style.margin = "0";
          });

          p.innerHTML = `<span class="doc-type-badge" style="font-family: ${wordFont}; font-size: 13pt; font-weight: bold; color: #111827; margin-right: 6px; display: inline-block;">${badgeText}</span> ${contentDiv.innerHTML}`;

          flexDiv.parentNode?.replaceChild(p, flexDiv);
        }
      }
    });
    root.querySelectorAll(".doc-type-badge").forEach((el) => {
      const element = el as HTMLElement;
      element.style.fontWeight = "bold";
      element.style.color = "#111827";
      element.style.marginRight = "6px";
    });

    // Convert .doc-options-container into Word-compatible HTML table based on selected columns count
    root.querySelectorAll(".doc-options-container").forEach((el) => {
      const container = el as HTMLElement;
      const columns = parseInt(
        container.getAttribute("data-columns") || "4",
        10,
      );

      const optionItems = container.querySelectorAll(".doc-option-item");
      const optionsArray: { label: string; textHtml: string }[] = [];
      optionItems.forEach((item) => {
        const labelEl = item.querySelector(".doc-option-label");
        const textEl = item.querySelector(".doc-option-text");
        if (labelEl && textEl) {
          optionsArray.push({
            label: labelEl.textContent?.trim().replace(/\.$/, "") || "",
            textHtml: textEl.innerHTML,
          });
        }
      });

      if (optionsArray.length > 0) {
        const rows: { label: string; textHtml: string }[][] = [];
        let currentRow: { label: string; textHtml: string }[] = [];
        for (let i = 0; i < optionsArray.length; i++) {
          currentRow.push(optionsArray[i]);
          if (currentRow.length === columns) {
            rows.push(currentRow);
            currentRow = [];
          }
        }
        if (currentRow.length > 0) {
          rows.push(currentRow);
        }

        const tdWidth = Math.floor(100 / columns) + "%";
        let tableHtml = `<table class="doc-options-table" border="0" cellspacing="0" cellpadding="0" style="width: 100%; border-collapse: collapse; margin-top: 0; margin-bottom: 0; border: none !important;">`;
        for (const row of rows) {
          tableHtml += `<tr>`;
          for (let c = 0; c < columns; c++) {
            if (c < row.length) {
              const opt = row[c];

              // Clean any wrapping paragraph/block tags inside option text to prevent jumping to a new line inside Word cell
              let cleanTextHtml = opt.textHtml.trim();
              if (
                cleanTextHtml.startsWith("<p>") &&
                cleanTextHtml.endsWith("</p>")
              ) {
                cleanTextHtml = cleanTextHtml.slice(3, -4);
              } else if (
                cleanTextHtml.startsWith("<p ") &&
                cleanTextHtml.endsWith("</p>")
              ) {
                const closeIdx = cleanTextHtml.indexOf(">");
                if (closeIdx !== -1) {
                  cleanTextHtml = cleanTextHtml.slice(closeIdx + 1, -4);
                }
              }

              // Convert inner p or div blocks to inline span elements so they do not start a new paragraph in Word
              cleanTextHtml = cleanTextHtml
                .replace(
                  /<p\b[^>]*>/gi,
                  '<span style="display:inline; margin:0; padding:0;">',
                )
                .replace(/<\/p>/gi, "</span>")
                .replace(
                  /<div\b[^>]*>/gi,
                  '<span style="display:inline; margin:0; padding:0;">',
                )
                .replace(/<\/div>/gi, "</span>");

              tableHtml += `<td valign="top" style="width: ${tdWidth}; padding: 3pt 6pt 3pt 0; font-family: ${wordFont}; font-size: 13pt; line-height: 1.15; margin: 0; border: none !important;">`;
              tableHtml += `<strong style="color: #4f46e5; margin-right: 4pt; font-size: 13pt;">${opt.label}.</strong> ${cleanTextHtml}`;
              tableHtml += `</td>`;
            } else {
              tableHtml += `<td style="width: ${tdWidth}; padding: 3pt 6pt 3pt 0; margin: 0; border: none !important;"></td>`;
            }
          }
          tableHtml += `</tr>`;
        }
        tableHtml += `</table>`;

        const tempTableDiv = document.createElement("div");
        tempTableDiv.innerHTML = tableHtml.trim();
        const newTable = tempTableDiv.firstElementChild;
        if (newTable) {
          container.parentNode?.replaceChild(newTable, container);
        }
      }
    });

    // Convert .doc-answer-block into single-cell tables inside exported Word document
    // to strictly limit the background coloring within the frame and prevent background spill issues in MS Word
    root.querySelectorAll(".doc-answer-block").forEach((el) => {
      const originalBlock = el as HTMLElement;
      const titleEl = originalBlock.querySelector(".doc-answer-title");
      const bodyEl = originalBlock.querySelector(".doc-answer-body");

      const titleText = titleEl
        ? titleEl.textContent?.trim() || ""
        : "ĐÁP ÁN / HƯỚNG DẪN GIẢI CHI TIẾT:";
      const bodyHtml = bodyEl ? bodyEl.innerHTML : "";

      const tableHtml = `
        <table class="doc-answer-table" border="1" cellspacing="0" cellpadding="0" style="width: 100%; border-collapse: collapse; border: 1px solid #10b981; margin-top: 16pt; margin-bottom: 12pt; background-color: #ecfdf5; margin-left: 20pt;">
          <tr>
            <td style="padding: 10pt; border: none !important; font-family: ${wordFont}; margin: 0; background-color: #ecfdf5;">
              <span style="font-family: ${wordFont}; font-size: 13pt; font-weight: bold; color: #047857; margin-bottom: 4pt; letter-spacing: 0.05em; text-transform: uppercase; display: block; line-height: 1.15;">
                ${titleText}
              </span>
              <div style="font-family: ${wordFont}; font-size: 13pt; color: #065f46; margin: 0; line-height: 1.15;">
                ${bodyHtml}
              </div>
            </td>
          </tr>
        </table>
      `;

      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = tableHtml.trim();
      const newTable = tempDiv.firstElementChild;
      if (newTable) {
        originalBlock.parentNode?.replaceChild(newTable, originalBlock);
      }
    });

    root.querySelectorAll(".doc-footer").forEach((el) => {
      const element = el as HTMLElement;
      element.style.textAlign = "center";
      element.style.borderTop = "1px solid #cbd5e1";
      element.style.paddingTop = "12pt";
      element.style.marginTop = "18pt";
    });
    root.querySelectorAll(".doc-footer p").forEach((el) => {
      const element = el as HTMLElement;
      element.style.fontSize = "9pt";
      element.style.color = "#94a3b8";
      element.style.fontWeight = "bold";
      element.style.letterSpacing = "0.1em";
      element.style.textAlign = "center";
      element.style.margin = "0";
    });
  };

  const injectMathML = (root: HTMLDivElement) => {
    root.querySelectorAll(".katex-custom-wrapper").forEach((wrapper) => {
      const latex = wrapper.getAttribute("data-latex");
      const isDisplay = wrapper.getAttribute("data-display") === "true";
      if (!latex) return;

      const cacheKey = `${isDisplay ? "block" : "inline"}:${latex}`;
      let mml = mathmlCache.get(cacheKey);

      if (!mml) {
        try {
          mml = katex.renderToString(latex, {
            displayMode: isDisplay,
            output: "mathml",
            throwOnError: false,
            strict: "ignore",
            trust: true,
          });
          mathmlCache.set(cacheKey, mml);
        } catch (e) {
          console.error(e);
          return;
        }
      }

      const temp = document.createElement("div");
      temp.innerHTML = mml.trim();
      const mathEl = temp.querySelector("math");

      if (mathEl) {
        mathEl.setAttribute("xmlns", "http://www.w3.org/1998/Math/MathML");
        mathEl.querySelectorAll("annotation").forEach((ann) => ann.remove());

        mathEl.querySelectorAll("mo").forEach((mo) => {
          const op = mo.textContent?.trim() || "";
          if (/^[=<>\u2248\u2261\u2264\u2265]/.test(op)) {
            mo.setAttribute("lspace", "0.278em");
            mo.setAttribute("rspace", "0.278em");
          } else if (/^[+\u2212\u00b1\u2213\u22c5\u00d7\u00f7]/.test(op)) {
            mo.setAttribute("lspace", "0.222em");
            mo.setAttribute("rspace", "0.222em");
          }
        });

        mathEl.querySelectorAll("[href]").forEach((node) => {
          const href = node.getAttribute("href");
          node.removeAttribute("href");
          if (href) {
            const a = document.createElement("a");
            a.setAttribute("href", href);
            a.style.textDecoration = "none";
            node.parentNode?.insertBefore(a, node);
            a.appendChild(node);
          }
        });

        // Smart spaces (Word requires non-breaking space '\u00a0' strictly to avoid compacting formulas!)
        const prevNode = wrapper.previousSibling;
           if (!isDisplay) {
          if (prevNode) {
            if (prevNode.nodeType === Node.TEXT_NODE) {
              let text = prevNode.nodeValue || "";
              if (/\s$/.test(text)) {
                prevNode.nodeValue = text.trimEnd() + "\u00a0";
              } else {
                const lastNonSpaceChar = text.trim()[text.trim().length - 1];
                const endsWithNoSpaceChar = /^[\(\{\[“‘]/.test(lastNonSpaceChar);
                if (!endsWithNoSpaceChar && lastNonSpaceChar) {
                  prevNode.nodeValue = text + "\u00a0";
                }
              }
            } else if (prevNode.nodeType === Node.ELEMENT_NODE) {
              const htmEl = prevNode as HTMLElement;
              const text = htmEl.textContent || "";
              const lastNonSpaceChar = text.trim()[text.trim().length - 1];
              const endsWithNoSpaceChar = /^[\(\{\[“‘]/.test(lastNonSpaceChar);
                   if (
                !endsWithNoSpaceChar &&
                lastNonSpaceChar &&
                htmEl.tagName.toLowerCase() !== "br"
              ) {
                const spaceNode = document.createTextNode("\u00a0");
                wrapper.parentNode?.insertBefore(spaceNode, wrapper);
              }
            }
          } else {
            // If the inline math is the first element of its block (e.g. start of a paragraph or list item),
            // insert a zero-width space (\u200b) to prevent Word from importing it as a block/display equation.
            const zeroWidthSpaceNode = document.createTextNode("\u200b");
            wrapper.parentNode?.insertBefore(zeroWidthSpaceNode, wrapper);
          }
        }

        const nextNode = wrapper.nextSibling;
        if (nextNode && !isDisplay) {
          if (nextNode.nodeType === Node.TEXT_NODE) {
            let text = nextNode.nodeValue || "";
            if (/^\s/.test(text)) {
              nextNode.nodeValue = "\u00a0" + text.trimStart();
            } else {
              const firstNonSpaceChar = text.trim()[0];
              const startsWithPunctuation = /^[.,;:!?]/.test(firstNonSpaceChar);
              if (!startsWithPunctuation && firstNonSpaceChar) {
                nextNode.nodeValue = "\u00a0" + text;
              }
            }
          } else if (nextNode.nodeType === Node.ELEMENT_NODE) {
            const htmEl = nextNode as HTMLElement;
            const text = htmEl.textContent || "";
            const firstNonSpaceChar = text.trim()[0];
            const startsWithPunctuation = /^[.,;:!?]/.test(firstNonSpaceChar);
            if (
              !startsWithPunctuation &&
              firstNonSpaceChar &&
              htmEl.tagName.toLowerCase() !== "br"
            ) {
              const spaceNode = document.createTextNode("\u00a0");
              wrapper.parentNode?.insertBefore(spaceNode, wrapper.nextSibling);
            }
          }
        }

        if (isDisplay) {
          const container = document.createElement("div");
          container.className = "doc-display-math";
          container.style.textAlign = "center";
          container.style.margin = "6pt 0";
          container.appendChild(mathEl);
          wrapper.replaceWith(container);
        } else {
          wrapper.replaceWith(mathEl);
        }
      }
    });
  };

  const copyToWord = async () => {
    if (!inputText.trim()) {
      triggerToast("Không có nội dung để sao chép cho Word!", false);
      return;
    }

    const currentLatexCount = userDoc?.latexCount || 0;
    if (!isApproved && currentLatexCount >= 30) {
      triggerToast(
        "Bạn đã đạt giới hạn tính năng chuyển đổi LaTeX trong ngày (tối đa 30 lượt/ngày). Hãy liên hệ Admin qua email giathieu110406@gmail.com để được cấp quyền không giới hạn!",
        false,
      );
      return;
    }

    if (!previewRef.current) return;

    // Create an isolated copy to parse and prepare Word specific namespaces
    const clone = previewRef.current.cloneNode(true) as HTMLDivElement;
    injectMathML(clone);
    injectInlineStyles(clone);

    const bodyHtml = clone.innerHTML;

    const wordDoc = `<html>
    <head>
    <meta charset="UTF-8">
    <meta name="ProgId" content="Word.Document">
    <style>
        @page {
            size: A4;
            margin: 2cm;
        }
        body {
            font-family: ${wordFont};
            font-size: 13pt;
            line-height: 1.15;
            color: #000000;
            margin: 0;
        }
        p, li, span, select, tr, td, th {
            font-family: ${wordFont} !important;
            font-size: 13pt !important;
            line-height: 1.15 !important;
            margin-top: 0 !important;
            margin-bottom: 0 !important;
        }
        div, table {
            font-family: ${wordFont} !important;
            font-size: 13pt !important;
            line-height: 1.15 !important;
        }
        div.doc-display-math {
            margin-top: 6pt !important;
            margin-bottom: 6pt !important;
            text-align: center !important;
        }
        table.doc-answer-table {
            margin-top: 16pt !important;
            margin-bottom: 12pt !important;
            border: 1px solid #10b981 !important;
            background-color: #ecfdf5 !important;
        }
        table.doc-answer-table th, table.doc-answer-table td {
            border: none !important;
            padding: 10pt !important;
        }
        table.doc-options-table, table.doc-options-table th, table.doc-options-table td {
            border: none !important;
        }
        table.doc-header-table, table.doc-header-table th, table.doc-header-table td {
            border: none !important;
        }
        table {
            border-collapse: collapse;
            width: 100%;
            margin-top: 12pt !important;
            margin-bottom: 12pt !important;
        }
        table th, table td {
                  border: 1px solid #cbd5e1 !important;
            padding: 6px !important;
        }
        table th {
            font-weight: bold !important;
            background-color: #f3f4f6 !important;
        }
    </style>
    </head>
    <body>
    ${bodyHtml}
    </body>
    </html>`;

    const tempDiv = document.createElement("div");
    tempDiv.contentEditable = "true";
    tempDiv.style.position = "absolute";
    tempDiv.style.left = "-9999px";
    tempDiv.innerHTML = bodyHtml;
    document.body.appendChild(tempDiv);

    const selection = window.getSelection();
    if (!selection) return;

    const range = document.createRange();
    range.selectNodeContents(tempDiv);
    selection.removeAllRanges();
    selection.addRange(range);

    const copyListener = (e: ClipboardEvent) => {
      e.preventDefault();
      if (e.clipboardData) {
        e.clipboardData.setData("text/html", wordDoc);
        e.clipboardData.setData(
          "text/plain",
          previewRef.current?.innerText || "",
        );
      }
    };

    document.addEventListener("copy", copyListener);
    let success = false;
    try {
      success = document.execCommand("copy");
    } catch (err) {
      console.error(err);
    }
    document.removeEventListener("copy", copyListener);

    selection.removeAllRanges();
    document.body.removeChild(tempDiv);

    if (success) {
      triggerToast(
        "Đã sao chép! Hãy mở Word và nhấn Ctrl+V (hoặc dán giữ nguyên định dạng gốc).",
      );
      await incrementLatexCount();
    } else {
      triggerToast(
        "Sao chép lỗi. Vui lòng tự bôi đen ở khung xem trước và copy.",
        false,
      );
    }
  };

  const downloadAsWord = async () => {
    if (!inputText.trim()) {
      triggerToast("Không có nội dung để tải về!", false);
      return;
    }

    const currentLatexCount = userDoc?.latexCount || 0;
    if (!isApproved && currentLatexCount >= 30) {
      triggerToast(
        "Bạn đã đạt giới hạn tính năng chuyển đổi LaTeX trong ngày (tối đa 30 lượt/ngày). Hãy liên hệ Admin qua email giathieu110406@gmail.com để được cấp quyền không giới hạn!",
        false,
      );
      return;
    }

    if (!previewRef.current) return;

    // Create an isolated copy to parse and prepare Word specific namespaces
    const clone = previewRef.current.cloneNode(true) as HTMLDivElement;
    injectMathML(clone);
    injectInlineStyles(clone);

    const bodyHtml = clone.innerHTML;

    const wordDoc = `<html>
    <head>
    <meta charset="UTF-8">
    <meta name="ProgId" content="Word.Document">
    <style>
        @page {
            size: A4;
            margin: 2cm;
        }
        body {
            font-family: ${wordFont};
            font-size: 13pt;
            line-height: 1.15;
            color: #000000;
            margin: 0;
        }
        p, li, span, select, tr, td, th {
            font-family: ${wordFont} !important;
            font-size: 13pt !important;
            line-height: 1.15 !important;
            margin-top: 0 !important;
            margin-bottom: 0 !important;
        }
        div, table {
            font-family: ${wordFont} !important;
            font-size: 13pt !important;
            line-height: 1.15 !important;
        }
        div.doc-display-math {
            margin-top: 6pt !important;
            margin-bottom: 6pt !important;
            text-align: center !important;
        }
        table.doc-answer-table {
            margin-top: 16pt !important;
            margin-bottom: 12pt !important;
            border: 1px solid #10b981 !important;
            background-color: #ecfdf5 !important;
        }
        table.doc-answer-table th, table.doc-answer-table td {
            border: none !important;
            padding: 10pt !important;
        }
        table.doc-options-table, table.doc-options-table th, table.doc-options-table td {
            border: none !important;
        }
        table.doc-header-table, table.doc-header-table th, table.doc-header-table td {
            border: none !important;
        }
        table {
            border-collapse: collapse;
            width: 100%;
            margin-top: 12pt !important;
            margin-bottom: 12pt !important;
        }
        table th, table td {
                    border: 1px solid #cbd5e1 !important;
            padding: 6px !important;
        }
        table th {
            font-weight: bold !important;
            background-color: #f3f4f6 !important;
        }
    </style>
    </head>
    <body>
    ${bodyHtml}
    </body>
    </html>`;

    // Add Byte Order Mark (BOM) for proper UTF-8 decoding in Microsoft Word
    const blob = new Blob(["\ufeff" + wordDoc], {
      type: "application/msword;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "LaTeX_Sang_Word_Equation.doc";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    triggerToast("Đã tạo và tải file Word (.doc) thành công!");
    await incrementLatexCount();
  };

  const handleCallAiCanvas = async (customPrompt?: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    if (isProcessingCanvas) return;

    const promptToSend = customPrompt || aiCanvasPrompt;
    if (!promptToSend.trim()) {
      triggerToast("Vui lòng nhập hoặc chọn yêu cầu cho Trợ lý AI Canvas!", false);
      return;
    }

    const currentPromptCount = userDoc?.promptCount || 0;
    if (!isApproved && currentPromptCount >= 10) {
      triggerToast(
        "Bạn đã đạt giới hạn tính năng Trợ lý AI Canvas trong ngày (tối đa 10 lượt/ngày). Hãy liên hệ Admin qua email giathieu110406@gmail.com để được cấp quyền không giới hạn!",
        false,
      );
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const isSelected = start !== end;
    
    const textToProcess = isSelected ? inputText.substring(start, end) : inputText;

    triggerToast("Trợ lý AI Canvas đang thực hiện yêu cầu của bạn...", true);
    setIsProcessingCanvas(true);

    try {
      const res = await fetch("/api/gemini-canvas", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: textToProcess,
          prompt: promptToSend,
        }),
      });

      if (!res.ok) {
        throw new Error("Không thể kết nối đến Trợ lý AI Canvas");
      }

      const data = await res.json();
      if (data.success && data.fixedText) {
        const resultText = data.fixedText;
        if (isSelected) {
          const newText = inputText.substring(0, start) + resultText + inputText.substring(end);
          setInputText(newText);
          setTimeout(() => {
            textarea.setSelectionRange(start, start + resultText.length);
            textarea.focus();
          }, 0);
          triggerToast("Trợ lý AI đã cập nhật vùng chọn trên Canvas!", true);
        } else {
          setInputText(resultText);
          triggerToast("Trợ lý AI đã cập nhật toàn bộ Canvas!", true);
        }
        
        // Clear the prompt input if it was submitted manually
        if (!customPrompt) {
          setAiCanvasPrompt("");
        }
        
        await incrementPromptCount();
      } else {
        throw new Error(data.error || "Lỗi phản hồi từ AI Canvas");
      }
    } catch (err: any) {
      console.error("Lỗi trợ lý AI Canvas:", err);
      triggerToast(err.message || "Gặp sự cố kết nối Trợ lý AI Canvas. Vui lòng thử lại!", false);
    } finally {
      setIsProcessingCanvas(false);
    }
  };

  const handleClear = () => {
    setInputText("");
    triggerToast("Đã xóa trắng trình soạn thảo.");
  };

  // --- CONDITIONAL STATE SCREENS ---
  if (authLoading) {
    return (
      <div
        className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center font-sans"
        id="auth-loading-screen"
      >
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-slate-400 font-medium text-sm animate-pulse">
            Đang kết nối hệ thống bảo mật & dữ liệu...
          </p>
        </div>
      </div>
    );
  }

  if (user && !userDoc) {
    return (
      <div
        className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center font-sans"
        id="userdoc-loading-screen"
      >
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-slate-400 font-medium text-sm animate-pulse">
            Đang đồng bộ cấu hình bảo mật tài khoản...
          </p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-linear-to-tr from-slate-900 via-slate-950 to-blue-950 text-slate-100 flex items-center justify-center p-4 antialiased font-sans">
        <div
          className="max-w-md w-full bg-slate-900/80 backdrop-blur-md rounded-xl border border-slate-800 p-6 md:p-8 shadow-2xl relative overflow-hidden"
          id="login-container"
        >
          <div className="absolute top-0 left-0 w-full h-1.5 bg-linear-to-r from-blue-500 via-indigo-500 to-emerald-500"></div>

          <div className="text-center mb-6">
            <div className="flex justify-center mb-4">
              <img
                src="/logo.svg"
                alt="Late2Word Converter Logo"
                className="w-20 h-20 rounded-2xl shadow-xl border border-slate-700/50 object-contain hover:scale-105 transition-transform duration-300"
                referrerPolicy="no-referrer"
              />
            </div>
            <h2 className="text-2xl font-bold tracking-tight text-white mb-1.5 font-display">
              Late2Word Converter
            </h2>
            <p className="text-xs text-slate-400">
              Hệ thống chuyển đổi định dạng và kiểm soát chất lượng dữ liệu
            </p>
            <p className="text-[10px] text-slate-500 mt-1 font-semibold select-none">
              Tác giả: Trần Gia Thiều - Giathieu110406@gmail.com
            </p>
          </div>

          {/* Extremely Prominent Official Website Callout Banner */}
          <div className="mb-6 relative overflow-hidden bg-gradient-to-r from-blue-600/20 via-indigo-600/20 to-purple-600/20 border border-indigo-500/40 rounded-xl p-4 text-center group transition-all hover:border-indigo-500/60 shadow-lg shadow-indigo-500/5">
            <div className="absolute inset-0 bg-gradient-to-r from-blue-500/10 via-indigo-500/10 to-purple-500/10 animate-pulse"></div>
            <div className="relative z-10 flex flex-col items-center gap-1.5">
              <span className="text-[10px] font-black text-indigo-300 tracking-widest uppercase flex items-center gap-1">
                ⚡ TRANG WEB CHÍNH THỨC ⚡
              </span>
              <a
                href="https://word2latex.io.vn"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xl md:text-2xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-sky-400 to-indigo-400 hover:scale-105 hover:brightness-110 active:scale-95 transition-all tracking-wide select-all"
              >
                word2latex.io.vn
              </a>
              <p className="text-[10px] text-slate-300 max-w-xs mt-0.5 font-medium">
                Truy cập trực tiếp tại đây để có trải nghiệm mượt mà và đầy đủ nhất!
              </p>
            </div>
          </div>

          <div className="space-y-4">
            {authError && (
              <div
                id="auth-error-block"
                className="p-3 bg-rose-950/30 border border-rose-800/50 rounded-lg text-rose-400 text-xs font-semibold flex items-center gap-2"
              >
                <span>{authError}</span>
              </div>
            )}

            <div className="space-y-4">
              <p className="text-xs text-center text-slate-400 leading-relaxed px-2">
                Hệ thống yêu cầu xác thực bằng dịch vụ Google bảo mật cao. Bạn
                sẽ được tự động đưa vào danh sách xem xét cấp quyền sau khi xác
                thực thành công.
              </p>

              <button
                type="button"
                onClick={handleGoogleLogin}
                className="w-full py-3.5 bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs rounded-lg tracking-wider shadow-lg shadow-blue-650/15 transition-all outline-none cursor-pointer flex items-center justify-center gap-2.5 hover:scale-[1.01]"
                title="Đăng ký hoặc đăng nhập siêu nhanh qua tài khoản Google"
              >
                <svg className="w-4.5 h-4.5 shrink-0" viewBox="0 0 24 24">
                  <path
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    fill="currentColor"
                  />
                  <path
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    fill="currentColor"
                    fillOpacity="0.9"
                  />
                  <path
                    d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.08H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.92l2.85-2.22.81-.6z"
                    fill="currentColor"
                    fillOpacity="0.8"
                  />
                  <path
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.08l3.66 2.84c.87-2.6 3.3-4.54 6.16-4.54z"
                    fill="currentColor"
                    fillOpacity="0.95"
                  />
                </svg>
                TIẾP TỤC VỚI GOOGLE
              </button>
            </div>

            <div className="bg-slate-950/40 border border-slate-800/80 p-3.5 rounded-lg text-[11px] text-slate-400 space-y-1.5">
              <span className="font-bold text-slate-200 block">
                Lưu ý thiết yếu:
              </span>
              <p className="leading-relaxed">
                • Trang web chính thức:{" "}
                <a
                  href="https://word2latex.io.vn"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:underline font-bold"
                >
                  word2latex.io.vn
                </a>
              </p>
              <p className="leading-relaxed">
                • Nếu nút đăng nhập Google bị chặn do chế độ iFrame của AI
                Studio, vui lòng dùng tab{" "}
                <strong className="text-blue-400">"Tài khoản Email"</strong> để
                đăng ký/đăng nhập trực tiếp không cần popup.
              </p>
              <p className="leading-relaxed">
                • Tài khoản của bạn sẽ được hệ thống tự động kích hoạt chế độ
                đăng ký chờ duyệt ngay lập tức và gửi yêu cầu đến quản trị viên.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Determine user constraints
  const isOwner = checkIsOwnerEmail(user);
  const isApproved = isOwner || userDoc?.status === "approved";
  const isRejected = !isApproved && userDoc?.status === "rejected";

  const getUserAvatar = () => {
    if (user?.photoURL) {
      return user.photoURL;
    }
    const name =
      userDoc?.displayName ||
      user?.displayName ||
      user?.email?.split("@")[0] ||
      "User";
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=f1f5f9&color=4f46e5&bold=true&size=128`;
  };

  if (isRejected) {
    return (
      <div className="min-h-screen bg-linear-to-tr from-slate-900 via-slate-950 to-blue-950 text-slate-100 flex items-center justify-center p-4 antialiased font-sans">
        <div
          className="max-w-md w-full bg-slate-900/80 backdrop-blur-md rounded-xl border border-slate-800 p-6 md:p-8 shadow-2xl text-center relative overflow-hidden"
          id="rejected-container"
        >
          <div className="absolute top-0 left-0 w-full h-1.5 bg-rose-500"></div>

          <h2 className="text-2xl font-bold tracking-tight text-white mb-2 font-display">
            Tài Khoản Bị Từ Chối
          </h2>
          <p className="text-sm text-slate-400 leading-relaxed mb-6">
            Yêu cầu truy cập hệ thống của bạn đã bị người quản trị từ chối. Vui
            lòng liên hệ Admin qua email{" "}
            <strong className="text-blue-400">giathieu110406@gmail.com</strong>{" "}
            để biết thêm chi tiết.
          </p>

          <button
            onClick={handleLogout}
            className="flex items-center font-bold text-xs text-slate-400 hover:text-slate-200 transition-colors mx-auto px-4 py-2 border border-slate-800 hover:border-slate-700 bg-slate-950/25 rounded-lg cursor-pointer"
          >
            QUAY LẠI HỆ THỐNG
          </button>
        </div>
      </div>
    );
  }

  // --- APPROVED USERS WORKSPACE ---
  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 antialiased font-sans flex flex-col">
      {/* Toast message wrapper with exit animations */}
      <AnimatePresence>
        {toast.show && (
          <motion.div
            initial={{ opacity: 0, y: 30, x: "-50%" }}
            animate={{ opacity: 1, y: 0, x: "-50%" }}
            exit={{ opacity: 0, y: 20, x: "-50%" }}
            onAnimationComplete={() => {
              // Hide toast after 4s
              setTimeout(() => {
                setToast((prev) => ({ ...prev, show: false }));
              }, 4000);
            }}
            className={`fixed bottom-6 left-1/2 -translate-x-1/2 px-6 py-3.5 rounded-full shadow-xl text-white font-medium text-xs md:text-sm flex items-center gap-2.5 z-50 ${
              toast.success
                ? "bg-slate-900 border border-slate-800"
                : "bg-red-600 border border-red-500"
            }`}
          >
            <span>{toast.msg}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top Premium Navigation Bar - sậm màu (trừ màu đen), sang trọng */}
      <nav className="w-full bg-gradient-to-r from-violet-100 via-sky-50 to-indigo-100 border-b border-indigo-200/50 text-slate-800 shadow-xs sticky top-0 z-40 select-none">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 md:px-10 lg:px-12 py-3 md:py-4 flex flex-row items-center justify-between gap-3">
          {/* TRÁI: Logo thương hiệu & Avatar người dùng */}
          <div className="flex items-center gap-4 select-none">
            {/* Logo thương hiệu */}
            <div className="flex items-center gap-2">
              <img
                src="/logo.svg"
                alt="Word2LaTeX Logo"
                className="w-8 h-8 rounded-lg shadow-sm border border-slate-200/60 object-contain hover:scale-105 transition-transform duration-200"
                referrerPolicy="no-referrer"
              />
              <span className="font-black text-sm tracking-tight bg-gradient-to-r from-indigo-700 via-blue-700 to-indigo-800 bg-clip-text text-transparent hidden sm:inline-block">
                Word2LaTeX.io.vn
              </span>
            </div>

            {/* Divider dọc */}
            <span className="text-slate-300 hidden sm:inline">|</span>

            {/* Phần tên tài khoản và hình ảnh */}
            <div className="flex items-center gap-2.5 select-none">
            <div className="relative w-7 h-7 rounded-full border border-slate-300 overflow-hidden bg-slate-200 shrink-0 flex items-center justify-center">
              <img
                src={getUserAvatar()}
                alt="Avatar"
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
                onError={(e) => {
                  const target = e.currentTarget;
                  const name =
                    userDoc?.displayName ||
                    user?.displayName ||
                    user?.email?.split("@")[0] ||
                    "User";
                  target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=f1f5f9&color=475569&bold=true&size=128`;
                }}
              />
            </div>
            <span
              className="font-extrabold text-slate-800 text-xs md:text-sm truncate max-w-[150px] md:max-w-[200px]"
              title={user.email || ""}
            >
              {userDoc?.displayName ||
                user?.displayName ||
                user?.email?.split("@")[0]}
            </span>

            {isAdminUser(user, userDoc) || isApproved ? (
              <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full text-[10px] font-black bg-slate-800 text-white shadow-xs uppercase tracking-wider">
                Pro
              </span>
            ) : (
              <button
                onClick={() => triggerToast("Vui lòng liên hệ Admin để được nâng cấp tài khoản Pro!", true)}
                className="inline-flex items-center justify-center px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-500 hover:bg-emerald-600 transition-colors text-white shadow-xs uppercase tracking-wider cursor-pointer"
              >
                Get Pro
              </button>
            )}
          </div>
          </div>

          {/* PHẢI: các phần góp ý, thông báo, và nút thoát */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            {/* Quản trị */}
            {isAdminUser(user, userDoc) && (
              <button
                onClick={() => {
                  setAdminTab(adminTab === "tool" ? "admin" : "tool");
                }}
                className={`flex items-center justify-center font-bold text-xs p-1.5 sm:px-3 sm:py-1.5 rounded-lg border transition-all cursor-pointer ${
                  adminTab === "admin"
                    ? "bg-gradient-to-r from-amber-200 via-orange-100 to-amber-200 text-amber-950 border-amber-300 shadow-2xs"
                    : "bg-gradient-to-r from-violet-100 via-sky-50 to-indigo-100 border-indigo-200/60 text-slate-800 hover:from-violet-200 hover:to-indigo-200"
                }`}
                title={adminTab === "admin" ? "Công cụ" : "Quản trị"}
              >
                <Settings className="w-4 h-4 sm:hidden" />
                <span className="hidden sm:inline">{adminTab === "admin" ? "Công cụ" : "Quản trị"}</span>
              </button>
            )}

            <button
              onClick={() => {
                if (isAdminUser(user, userDoc)) {
                  setAdminTab("admin");
                  setAdminSubTab("feedbacks");
                } else {
                  setIsFeedbackOpen(true);
                }
              }}
              className="flex items-center justify-center bg-gradient-to-r from-violet-100 via-sky-50 to-indigo-100 border-indigo-200/60 text-slate-800 hover:from-violet-200 hover:to-indigo-200 p-1.5 sm:px-3 sm:py-1.5 rounded-lg transition-all cursor-pointer font-bold text-xs border"
              title={isAdminUser(user, userDoc) ? "Xem danh sách phản hồi" : "Gửi phản hồi đóng góp ý kiến hoặc báo lỗi"}
            >
              <MessageSquare className="w-4 h-4 sm:hidden" />
              <span className="hidden sm:inline">{isAdminUser(user, userDoc) ? "Xem góp ý" : "Góp ý"}</span>
            </button>

            {/* Thông báo */}
            <button
              onClick={() => setIsNotificationsOpen(true)}
              className={`relative text-slate-800 border p-1.5 sm:px-3 sm:py-1.5 rounded-lg transition-all cursor-pointer font-bold text-xs flex items-center justify-center shrink-0 ${
                isNotificationsOpen
                  ? "bg-gradient-to-r from-violet-200 to-indigo-200 border-indigo-300 shadow-inner"
                  : "bg-gradient-to-r from-violet-100 via-sky-50 to-indigo-100 border-indigo-200/60 hover:from-violet-200 hover:to-indigo-200"
              }`}
              title="Thông báo hệ thống và phản hồi"
            >
              <Bell className="w-4 h-4 sm:hidden" />
              <span className="hidden sm:inline">Thông báo</span>
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 sm:static sm:ml-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[8px] font-black leading-none text-white ring-2 ring-slate-100 animate-bounce">
                  {unreadCount}
                </span>
              )}
            </button>

            {/* Thoát */}
            <button
              onClick={handleLogout}
              className="flex items-center justify-center bg-gradient-to-r from-rose-100 via-pink-50 to-rose-150/80 hover:bg-gradient-to-r hover:from-rose-500 hover:to-rose-600 hover:text-white text-slate-800 border border-rose-200/60 p-1.5 sm:px-3 sm:py-1.5 rounded-lg transition-all cursor-pointer font-bold text-xs shadow-2xs"
              title="Đăng xuất khỏi hệ thống"
            >
              <LogOut className="w-4 h-4 sm:hidden" />
              <span className="hidden sm:inline">Thoát</span>
            </button>
          </div>
        </div>
      </nav>

      <div className="max-w-[1600px] mx-auto w-full px-4 sm:px-6 md:px-10 lg:px-12 py-4 md:py-8 flex-1 flex flex-col gap-4 md:gap-6 overflow-x-hidden">
        {adminTab === "admin" && isAdminUser(user, userDoc) ? (
          <div className="space-y-6 flex-1 flex flex-col" id="admin-panel-viewport">
            {/* Elegant Sub-navigation Tabs */}
            <div className="flex bg-slate-100 p-1 rounded-xl self-start gap-1 font-semibold text-xs md:text-sm border border-slate-200/60 shadow-2xs">
              <button
                onClick={() => setAdminSubTab("members")}
                className={`px-4 py-2 rounded-lg transition-all cursor-pointer ${
                  adminSubTab === "members"
                    ? "bg-white text-indigo-700 shadow-xs font-bold"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                👥 Quản lý thành viên ({allUsers.length})
              </button>
              <button
                onClick={() => setAdminSubTab("feedbacks")}
                className={`px-4 py-2 rounded-lg transition-all cursor-pointer ${
                  adminSubTab === "feedbacks"
                    ? "bg-white text-indigo-700 shadow-xs font-bold"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                💬 Xem góp ý ({allFeedbacks.length})
              </button>
              <button
                onClick={() => setAdminSubTab("notify")}
                className={`px-4 py-2 rounded-lg transition-all cursor-pointer ${
                  adminSubTab === "notify"
                    ? "bg-white text-indigo-700 shadow-xs font-bold"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                📢 Phát thông báo
              </button>
            </div>

            {/* Sub-tab 1: Members Management */}
            {adminSubTab === "members" && (
              <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden p-4 md:p-6 flex-1 flex flex-col">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mb-6">
                  <div>
                    <h2 className="text-lg font-bold text-slate-800">Danh Sách Thành Viên</h2>
                    <p className="text-xs text-slate-500">Cấp quyền, quản lý trạng thái, reset và điều chỉnh số lượt sử dụng của các tài khoản.</p>
                  </div>
                  <input
                    type="text"
                    placeholder="Tìm kiếm theo Tên hoặc Email..."
                    value={userSearchQuery}
                    onChange={(e) => setUserSearchQuery(e.target.value)}
                    className="w-full sm:w-72 bg-slate-50 hover:bg-slate-100/50 border border-slate-300 rounded-xl px-3.5 py-2 text-xs md:text-sm outline-none transition-all focus:border-indigo-400 focus:bg-white"
                  />
                </div>

                <div className="overflow-x-auto border border-slate-100 rounded-xl">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-xs font-bold uppercase tracking-wider">
                        <th className="py-3 px-4">Thành viên</th>
                        <th className="py-3 px-4">Thông tin</th>
                        <th className="py-3 px-4">Trạng thái / Vai trò</th>
                        <th className="py-3 px-4">Thống kê sử dụng</th>
                        <th className="py-3 px-4 text-right">Hành động</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs md:text-sm text-slate-700">
                      {allUsers
                        .filter((u) => {
                          const name = (u.displayName || "").toLowerCase();
                          const email = (u.email || u.providerData?.[0]?.email || "").toLowerCase();
                          const query = userSearchQuery.toLowerCase();
                          return name.includes(query) || email.includes(query);
                        })
                        .map((u) => {
                          const isSelf = u.uid === user.uid;
                          return (
                            <tr key={u.uid} className="hover:bg-slate-50/50 transition-colors">
                              <td className="py-3.5 px-4">
                                <div className="font-bold text-slate-800 flex items-center gap-1.5">
                                  {u.displayName || "Thành viên mới"}
                                  {isSelf && <span className="bg-blue-100 text-blue-700 px-1.5 py-0.2 rounded text-[10px]">Tôi</span>}
                                </div>
                                <div className="text-slate-400 font-mono text-[10px] select-all mt-0.5">{u.uid}</div>
                              </td>
                              <td className="py-3.5 px-4 font-medium select-all">
                                <div>{u.email || "Không có email"}</div>
                                <div className="text-slate-400 text-[10px] mt-0.5">Ngày tạo: {u.createdAt ? new Date(u.createdAt).toLocaleDateString("vi-VN") : "N/A"}</div>
                              </td>
                              <td className="py-3.5 px-4 space-y-1">
                                <div className="flex items-center gap-1.5">
                                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-black uppercase ${
                                    u.status === "approved"
                                      ? "bg-emerald-100 text-emerald-700"
                                      : u.status === "pending"
                                        ? "bg-amber-100 text-amber-700"
                                        : "bg-rose-100 text-rose-700"
                                  }`}>
                                    {u.status === "approved" ? "Duyệt" : u.status === "pending" ? "Chờ duyệt" : "Đã khóa"}
                                  </span>
                                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                                    u.role === "admin"
                                      ? "bg-purple-100 text-purple-700"
                                      : "bg-slate-100 text-slate-700"
                                  }`}>
                                    {u.role === "admin" ? "Admin" : "Thành viên"}
                                  </span>
                                </div>
                              </td>
                              <td className="py-3.5 px-4 text-xs font-semibold space-y-1">
                                {(u.status === "approved" || u.role === "admin") ? (
                                  <div className="flex flex-col gap-0.5">
                                    <span className="text-emerald-600 font-bold">Không giới hạn</span>
                                    <div className="text-slate-400 font-normal">Tổng yêu cầu: {u.queryCount || 0}</div>
                                  </div>
                                ) : (
                                  <>
                                    <div className="flex flex-col gap-1">
                                      <span>Mã LaTeX: <strong>{u.latexCount || 0} / 30</strong></span>
                                      <span>Đề thi: <strong>{u.examCount || 0} / 5</strong></span>
                                      <span>Dán AI: <strong>{u.promptCount || 0} / 10</strong></span>
                                    </div>
                                    <div className="text-slate-400 font-normal mt-1">Tổng yêu cầu: {u.queryCount || 0}</div>
                                  </>
                                )}
                              </td>
                              <td className="py-3.5 px-4 text-right">
                                <div className="flex items-center justify-end flex-wrap gap-1.5">
                                  {!isSelf && (
                                    <>
                                      <button
                                        onClick={() => handleUpdateUserStatus(u.uid, u.status === "approved" ? "pending" : "approved")}
                                        className={`px-3 py-1.5 rounded-lg font-bold text-xs transition-all shadow-2xs cursor-pointer ${
                                          u.status === "approved"
                                            ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                                            : "bg-emerald-500 hover:bg-emerald-600 text-white"
                                        }`}
                                      >
                                        {u.status === "approved" ? "Hủy phê duyệt" : "Phê duyệt"}
                                      </button>
                                      <button
                                        onClick={() => handleUpdateUserStatus(u.uid, u.status === "rejected" ? "pending" : "rejected")}
                                        className={`px-3 py-1.5 rounded-lg font-bold text-xs transition-all shadow-2xs cursor-pointer ${
                                          u.status === "rejected"
                                            ? "bg-rose-100 text-rose-800 hover:bg-rose-200"
                                            : "bg-rose-500 hover:bg-rose-600 text-white"
                                        }`}
                                      >
                                        {u.status === "rejected" ? "Mở khóa" : "Tạm dừng"}
                                      </button>
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}

                      {allUsers.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-slate-400 italic">
                            Không tìm thấy dữ liệu thành viên
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Sub-tab 2: Feedback Management */}
            {adminSubTab === "feedbacks" && (
              <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden p-4 md:p-6 flex-1 flex flex-col">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mb-6">
                  <div>
                    <h2 className="text-lg font-bold text-slate-800">Danh Sách Ý Kiến Góp Ý</h2>
                    <p className="text-xs text-slate-500">Đọc đánh giá, phản hồi trực tiếp và tương tác hỗ trợ thành viên.</p>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-3 w-full sm:w-auto">
                    <select
                      value={feedbackTypeFilter}
                      onChange={(e) => setFeedbackTypeFilter(e.target.value)}
                      className="bg-slate-50 hover:bg-slate-100 border border-slate-300 text-slate-800 text-xs rounded-xl py-2 px-3 cursor-pointer outline-none transition-all"
                    >
                      <option value="all">Tất cả phân loại</option>
                      <option value="bug">Bug / Lỗi hệ thống</option>
                      <option value="request">Đề xuất tính năng</option>
                      <option value="suggestion">Góp ý trải nghiệm</option>
                      <option value="other">Khác</option>
                    </select>

                    <input
                      type="text"
                      placeholder="Tìm kiếm người gửi..."
                      value={feedbackSearchQuery}
                      onChange={(e) => setFeedbackSearchQuery(e.target.value)}
                      className="w-full sm:w-60 bg-slate-50 hover:bg-slate-100/50 border border-slate-300 rounded-xl px-3.5 py-2 text-xs outline-none transition-all focus:border-indigo-400 focus:bg-white"
                    />
                  </div>
                </div>

                <div className="space-y-4 flex-1 overflow-y-auto max-h-[600px] pr-2">
                  {allFeedbacks
                    .filter((fb) => {
                      const emailMatch = (fb.email || "").toLowerCase().includes(feedbackSearchQuery.toLowerCase());
                      const nameMatch = (fb.displayName || "").toLowerCase().includes(feedbackSearchQuery.toLowerCase());
                      const typeMatch = feedbackTypeFilter === "all" || fb.type === feedbackTypeFilter;
                      return (emailMatch || nameMatch) && typeMatch;
                    })
                    .map((fb) => {
                      const ratingStars = Array(5).fill(0).map((_, i) => i < (fb.rating || 5));
                      return (
                        <div key={fb.id} className="bg-slate-50 border border-slate-200/70 rounded-2xl p-5 relative transition-all hover:bg-slate-100/30">
                          <div className="flex flex-wrap items-start md:items-center justify-between gap-3 mb-3 pr-24 sm:pr-28">
                            <div className="flex flex-wrap items-center gap-2 break-all">
                              <span className="font-extrabold text-slate-800 text-sm">{fb.displayName || "Người dùng ẩn danh"}</span>
                              <span className="text-xs text-slate-400 break-all w-full sm:w-auto">• {fb.email}</span>
                              <span className="text-[10px] font-mono bg-slate-200 px-1.5 py-0.5 rounded text-slate-600">{fb.version || "v1.0"}</span>
                            </div>
                            <span className="text-xs text-slate-400">
                              {fb.createdAt ? new Date(fb.createdAt).toLocaleString("vi-VN") : "Mới đây"}
                            </span>
                          </div>

                          <div className="flex items-center gap-1.5 mb-2.5">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                              fb.type === "bug"
                                ? "bg-rose-100 text-rose-700"
                                : fb.type === "request"
                                  ? "bg-sky-100 text-sky-700"
                                  : "bg-emerald-100 text-emerald-700"
                            }`}>
                              {fb.type === "bug" ? "Lỗi (Bug)" : fb.type === "request" ? "Đề xuất" : "Góp ý / Khác"}
                            </span>

                            <div className="flex items-center text-amber-400 ml-1.5">
                              {ratingStars.map((isFilled, idx) => (
                                <span key={idx} className="text-xs">{isFilled ? "★" : "☆"}</span>
                              ))}
                            </div>
                          </div>

                          <div className="text-slate-700 text-sm leading-relaxed whitespace-pre-wrap bg-white border border-slate-100 rounded-xl p-4 shadow-2xs mb-4">
                            {fb.feedbackText}
                          </div>

                          {fb.feedbackImage && (
                            <div className="mb-4">
                              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">
                                🖼️ Hình ảnh đính kèm:
                              </span>
                              <div className="relative group max-w-xs rounded-xl overflow-hidden border border-slate-200 bg-slate-100 shadow-2xs">
                                <img
                                  src={fb.feedbackImage}
                                  alt="Hình ảnh đính kèm"
                                  className="w-full h-auto max-h-60 object-cover cursor-zoom-in group-hover:scale-[1.02] transition-transform duration-300"
                                  onClick={() => setPreviewImageSrc(fb.feedbackImage)}
                                />
                                <div className="absolute inset-0 bg-slate-900/0 group-hover:bg-slate-900/10 transition-colors pointer-events-none flex items-center justify-center">
                                  <ZoomIn className="w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-sm" />
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Admin Reply area */}
                          {fb.replyText ? (
                            <div className="bg-indigo-50/60 border border-indigo-100 rounded-xl p-4 text-xs md:text-sm text-indigo-900 leading-relaxed mb-4">
                              <div className="font-bold flex items-center gap-1 text-indigo-950 mb-1">
                                <span>💬 Phản hồi của bạn (Admin):</span>
                                <span className="text-[10px] text-indigo-400 font-normal">
                                  ({fb.replyAt ? new Date(fb.replyAt).toLocaleString("vi-VN") : "N/A"})
                                </span>
                              </div>
                              <p className="whitespace-pre-wrap">{fb.replyText}</p>
                            </div>
                          ) : (
                            activeReplyFeedbackId !== fb.id && (
                              <button
                                onClick={() => setActiveReplyFeedbackId(fb.id)}
                                className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold text-xs cursor-pointer transition-all"
                              >
                                Phản hồi ý kiến này
                              </button>
                            )
                          )}

                          {activeReplyFeedbackId === fb.id && (
                            <div className="space-y-2 mt-3 bg-indigo-50/40 border border-indigo-200/50 rounded-xl p-4">
                              <textarea
                                value={feedbackReplyText}
                                onChange={(e) => setFeedbackReplyText(e.target.value)}
                                className="w-full bg-white border border-indigo-200/60 rounded-xl p-3 text-xs md:text-sm outline-none focus:ring-2 focus:ring-indigo-100 placeholder:text-indigo-300"
                                placeholder="Nhập câu trả lời hoặc nội dung xử lý của bạn gửi tới người dùng..."
                                rows={3}
                              />
                              <div className="flex justify-end gap-2">
                                <button
                                  onClick={() => setActiveReplyFeedbackId(null)}
                                  className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg text-xs font-bold transition-all cursor-pointer"
                                >
                                  Hủy
                                </button>
                                <button
                                  onClick={() => handleSendFeedbackReply(fb.id, fb.uid, fb.email)}
                                  disabled={isSendingReply}
                                  className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 shadow-xs"
                                >
                                  {isSendingReply && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                  Gửi Phản Hồi
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Delete Feedback Option */}
                          <div className="absolute top-4 right-4 flex items-center gap-1.5 bg-white/90 rounded-xl p-1 shadow-xs border border-slate-200">
                            {deletingFeedbackId === fb.id ? (
                              <>
                                <button
                                  onClick={async () => {
                                    try {
                                      await deleteDoc(doc(db, "feedbacks", fb.id));
                                      triggerToast("Xóa phản hồi thành công.");
                                    } catch (e) {
                                      triggerToast("Lỗi khi xóa phản hồi.", false);
                                    } finally {
                                      setDeletingFeedbackId(null);
                                    }
                                  }}
                                  className="text-[10px] bg-rose-650 hover:bg-rose-700 text-white font-bold px-2 py-1 rounded-lg transition-colors cursor-pointer"
                                >
                                  Xác nhận
                                </button>
                                <button
                                  onClick={() => setDeletingFeedbackId(null)}
                                  className="text-[10px] bg-slate-100 hover:bg-slate-200 text-slate-600 font-semibold px-2 py-1 rounded-lg transition-colors cursor-pointer"
                                >
                                  Hủy
                                </button>
                              </>
                            ) : (
                              <button
                                onClick={() => setDeletingFeedbackId(fb.id)}
                                className="text-xs text-rose-500 hover:text-rose-700 hover:bg-rose-50 font-semibold cursor-pointer p-1.5 rounded-lg transition-colors"
                                title="Xóa góp ý này"
                              >
                                Xóa Góp Ý
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}

                  {allFeedbacks.length === 0 && (
                    <div className="py-12 text-center text-slate-400 italic">
                      Chưa có đóng góp ý kiến nào từ người dùng.
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Sub-tab 3: Notification Broadcaster */}
            {adminSubTab === "notify" && (
              <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 md:p-6 flex-1 flex flex-col">
                <div className="max-w-2xl w-full mx-auto space-y-6 py-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-800">📢 Phát Thông Báo Hệ Thống</h2>
                    <p className="text-xs text-slate-500 mt-0.5">Soạn tin nhắn thông báo gửi trực tiếp tới hòm thư của một thành viên hoặc toàn bộ hệ thống.</p>
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-xs md:text-sm font-bold text-slate-700">Đối tượng nhận thông báo:</label>
                      <select
                        value={generalNoticeTarget}
                        onChange={(e) => setGeneralNoticeTarget(e.target.value)}
                        className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-xs md:text-sm outline-none transition-all cursor-pointer"
                      >
                        <option value="all">📢 Phát sóng tới tất cả thành viên</option>
                        {allUsers.map((u) => (
                          <option key={u.uid} value={u.uid}>
                            👤 Gửi riêng tới: {u.displayName || "Thành viên"} ({u.email})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs md:text-sm font-bold text-slate-700">Tiêu đề thông báo:</label>
                      <input
                        type="text"
                        value={generalNoticeTitle}
                        onChange={(e) => setGeneralNoticeTitle(e.target.value)}
                        placeholder="Ví dụ: Cập nhật hệ thống v2.0 hoặc Hướng dẫn sử dụng..."
                        className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-xs md:text-sm outline-none transition-all focus:border-indigo-400 focus:bg-white"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs md:text-sm font-bold text-slate-700">Nội dung chi tiết thông báo:</label>
                      <textarea
                        value={generalNoticeContent}
                        onChange={(e) => setGeneralNoticeContent(e.target.value)}
                        placeholder="Nhập nội dung đầy đủ của thông báo..."
                        rows={6}
                        className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-xs md:text-sm outline-none transition-all focus:border-indigo-400 focus:bg-white"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={handleSendGeneralNotification}
                      disabled={isSendingGeneralNotice}
                      className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white py-2.5 rounded-xl font-bold text-xs md:text-sm shadow-xs transition-all cursor-pointer flex items-center justify-center gap-1.5"
                    >
                      {isSendingGeneralNotice && <Loader2 className="h-4 w-4 animate-spin" />}
                      Phát Thông Báo Ngay
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden flex flex-col flex-1">
            {/* Top Control Settings Panel */}
            <div className="bg-gradient-to-r from-violet-100 via-sky-50 to-indigo-100 p-3.5 md:p-4.5 border-b border-indigo-200/50 flex flex-col sm:flex-row items-center justify-between gap-4 select-none">
                <div className="flex flex-wrap items-center gap-3 md:gap-4 w-full sm:w-auto">
                  {/* Title */}
                  <span className="font-extrabold text-sm text-slate-800 tracking-tight flex items-center gap-2">
                    <img
                      src="/logo.svg"
                      alt="Logo"
                      className="w-5 h-5 rounded-md object-contain"
                      referrerPolicy="no-referrer"
                    />
                    Latex2Word Converter
                  </span>

                  {/* Divider */}
                  <span className="text-slate-300 hidden md:inline">|</span>

                  {/* Bold Button */}
                  <button
                    type="button"
                    onClick={handleBold}
                    className="w-8 h-8 flex items-center justify-center font-extrabold bg-white hover:bg-slate-50 border border-slate-300 rounded-xl text-slate-800 transition-all cursor-pointer text-xs shadow-2xs active:scale-95"
                    title="In đậm văn bản đang chọn (**)"
                  >
                    B
                  </button>

                  {/* Italic Button */}
                  <button
                    type="button"
                    onClick={handleItalic}
                    className="w-8 h-8 flex items-center justify-center italic font-bold bg-white hover:bg-slate-50 border border-slate-300 rounded-xl text-slate-800 transition-all cursor-pointer text-xs shadow-2xs active:scale-95"
                    title="In nghiêng văn bản đang chọn (*)"
                  >
                    I
                  </button>
                </div>

                {/* Font selector */}
                <div className="flex items-center gap-2.5 w-full sm:w-auto justify-between sm:justify-end">
                  <span className="text-xs md:text-sm font-semibold text-slate-600 shrink-0">
                    Phông chữ Word:
                  </span>
                  <select
                    value={wordFont}
                    onChange={(e) => setWordFont(e.target.value)}
                    className="bg-white hover:bg-slate-50 border border-slate-300 text-slate-800 text-xs font-bold rounded-xl focus:ring-2 focus:ring-slate-200 py-1.5 px-3 cursor-pointer outline-none transition-all"
                  >
                    <option
                      value="'Times New Roman', Times, serif"
                      className="text-slate-900 bg-white"
                    >
                      Times New Roman (Chuẩn Quốc gia)
                    </option>
                    <option
                      value="'Inter', 'Segoe UI', Arial, sans-serif"
                      className="text-slate-900 bg-white"
                    >
                      Inter (Phông mặc định Gemini)
                    </option>
                    <option
                      value="'Arial', sans-serif"
                      className="text-slate-900 bg-white"
                    >
                      Arial
                    </option>
                    <option
                      value="'Calibri', sans-serif"
                      className="text-slate-900 bg-white"
                    >
                      Calibri
                    </option>
                  </select>
                </div>
              </div>

              {/* Workspace with inner padding and subtle background */}
              <div className="p-4 md:p-6 bg-slate-50/30 flex-1 flex flex-col">
                {/* Main Workspaces Layout */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6 flex-1">
                  {/* Left panel: Input Area */}
                    <div className="flex flex-col bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden h-[500px] lg:h-[600px] w-full">
                    <div className="bg-gradient-to-r from-violet-100/60 via-sky-50/40 to-indigo-100/60 px-4 py-2.5 md:px-5 md:py-3.5 border-b border-indigo-200/40 flex justify-between items-center">
                      <span className="text-xs md:text-sm font-bold text-slate-700">
                        1. Nhập hoặc dán văn bản từ AI
                      </span>
                      <div className="flex gap-1 md:gap-2">
                        <button
                          type="button"
                          onClick={() => setShowAiCanvas(!showAiCanvas)}
                          className={`text-xs font-bold flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all cursor-pointer shadow-2xs group relative overflow-hidden ${
                            showAiCanvas
                              ? "bg-indigo-600 text-white border border-indigo-700 hover:bg-indigo-700"
                              : "text-indigo-700 bg-indigo-50 border border-indigo-200/60 hover:bg-indigo-100 hover:border-indigo-300"
                          }`}
                          title="Gọi Trợ lý AI Canvas để sửa đổi, giải chi tiết, dịch thuật hoặc tạo câu hỏi tương tự"
                        >
                          <Sparkles className={`h-3.5 w-3.5 ${showAiCanvas ? "text-white animate-pulse" : "text-indigo-500 group-hover:text-indigo-600 group-hover:animate-pulse"}`} />
                          <span className="relative z-10">Trợ lý AI Canvas</span>
                        </button>
                        <button
                          onClick={handleClear}
                          className="text-xs text-rose-600 bg-transparent border border-transparent hover:border-rose-200 font-bold flex items-center px-3 py-1.5 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                        >
                          Xóa tất cả
                        </button>
                      </div>
                    </div>

                    {hasUnclosedDollar(inputText) && (
                      <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5 text-xs text-amber-800 flex items-center justify-between gap-2 font-medium">
                        <div className="flex items-center gap-1.5 text-[11px] md:text-xs">
                          <span className="text-base shrink-0">⚠️</span>
                          <span>
                            Hệ thống phát hiện số lượng ký tự Đô-la ($) bị lẻ
                            (chưa đóng công thức), có thể dẫn đến lỗi hiển thị.
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setInputText((prev) => prev.trim() + " $");
                            triggerToast(
                              "Đã tự động thêm ký tự $ ở cuối để hoàn tất đóng công thức!",
                              true,
                            );
                          }}
                          className="bg-amber-600 hover:bg-amber-700 text-white rounded-lg px-2.5 py-1 text-[10px] font-bold transition-all cursor-pointer whitespace-nowrap active:scale-95"
                        >
                          Bổ sung đóng $
                        </button>
                      </div>
                    )}

                    <textarea
                      ref={textareaRef}
                      id="input-text"
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      onPaste={handlePasteChange}
                      disabled={isProcessingCanvas}
                      className={`flex-1 w-full p-4 md:p-5 resize-none overflow-y-auto border-0 focus:ring-0 focus:outline-none text-slate-700 leading-relaxed text-sm md:text-base font-normal placeholder:text-slate-400 bg-linear-to-b from-white to-slate-50/20 ${isProcessingCanvas ? 'opacity-50 cursor-not-allowed' : 'opacity-100'} transition-opacity duration-300`}
                      placeholder="Nhập hoặc bôi đen copy cuộc trò chuyện chứa công thức toán ($x^2$ hoặc $$y = mx+b$$) từ ChatGPT, Gemini rồi dán trực tiếp vào đây..."
                    />

                    {/* AI Canvas Panel */}
                    {showAiCanvas && (
                      <div className="border-t border-slate-100 bg-slate-50/50 p-4 shrink-0 flex flex-col gap-3">
                        <div className="flex items-center gap-1.5 text-indigo-900 font-semibold text-xs md:text-sm">
                          <Sparkles className="h-4 w-4 text-indigo-500 animate-pulse" />
                          <span>Trợ lý AI Canvas</span>
                        </div>
                        
                        {/* Preset quick action tags */}
                        <div className="flex flex-wrap gap-2">
                          {[
                            { label: "Dịch sang tiếng Anh", prompt: "Dịch toàn bộ văn bản sang tiếng Anh, giữ nguyên các công thức LaTeX dạng $...$ hoặc $$...$$." },
                            { label: "Thêm lời giải chi tiết", prompt: "Hãy bổ sung lời giải thích chi tiết từng bước cho các công thức, các bài tập trong văn bản này." },
                            { label: "In đậm từ khóa", prompt: "Hãy tìm các thuật ngữ chuyên ngành, định lý, định luật hoặc từ khóa chính trong văn bản và in đậm chúng bằng dấu **." },
                            { label: "Tạo câu hỏi tương tự", prompt: "Dựa trên nội dung hiện tại, hãy tạo thêm một câu hỏi toán học/bài tập tương tự đi kèm đáp án và lời giải chi tiết." }
                          ].map((tag) => (
                            <button
                              key={tag.label}
                              type="button"
                              onClick={() => handleCallAiCanvas(tag.prompt)}
                              disabled={isProcessingCanvas}
                              className="text-xs font-medium text-slate-600 bg-white border border-slate-200 hover:border-indigo-300 hover:text-indigo-600 px-3 py-1.5 rounded-lg transition-all cursor-pointer whitespace-nowrap shadow-2xs hover:shadow-xs active:scale-95 disabled:opacity-50"
                            >
                              {tag.label}
                            </button>
                          ))}
                        </div>

                        {/* Prompt Input Box */}
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            handleCallAiCanvas();
                          }}
                          className="relative flex items-center bg-white border border-slate-200 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100 rounded-xl transition-all shadow-2xs"
                        >
                          <input
                            type="text"
                            value={aiCanvasPrompt}
                            onChange={(e) => setAiCanvasPrompt(e.target.value)}
                            disabled={isProcessingCanvas}
                            placeholder="Yêu cầu AI sửa Canvas (ví dụ: 'Thêm lời giải', 'Sửa câu 1'...)"
                            className="w-full pl-4 pr-12 py-3 text-xs md:text-sm bg-transparent outline-none border-none text-slate-700 placeholder:text-slate-400 focus:ring-0 focus:outline-none"
                          />
                          <button
                            type="submit"
                            disabled={isProcessingCanvas || !aiCanvasPrompt.trim()}
                            className="absolute right-2 p-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 text-white disabled:text-slate-400 rounded-lg transition-all cursor-pointer flex items-center justify-center shadow-xs active:scale-95"
                          >
                            {isProcessingCanvas ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <ArrowRight className="h-4 w-4" />
                            )}
                          </button>
                        </form>
                      </div>
                    )}

                    <div className="px-4 py-2 md:px-5 md:py-2.5 bg-slate-50/70 border-t border-slate-100 text-[10px] md:text-xs text-slate-500 font-medium flex justify-between items-center">
                      <span>
                        Độ dài ký tự: <strong>{inputText.length}</strong>
                      </span>
                      <span className="italic text-slate-400 font-normal">
                        Canvas đồng bộ trực tiếp khi sửa đổi
                      </span>
                    </div>
                  </div>

                  {/* Right panel: Preview & Advanced Copy Area */}
                  <div className="flex flex-col bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden h-[500px] lg:h-[600px] w-full">
                    {/* Header with Switch output tabs */}
                    <div className="bg-gradient-to-r from-violet-100/60 via-sky-50/40 to-indigo-100/60 px-3 py-2 md:px-4 md:py-2.5 border-b border-indigo-200/40 flex flex-wrap justify-between items-center gap-2">
                      <div className="flex bg-slate-200/60 p-0.5 rounded-lg text-[11px] md:text-xs font-semibold gap-0.5">
                        <button
                          onClick={() => setActiveTab("word")}
                          className={`px-2.5 py-1.5 md:px-3.5 md:py-1.5 rounded-md transition-all cursor-pointer ${
                            activeTab === "word"
                              ? "bg-white text-slate-900 shadow-xs font-bold"
                              : "text-slate-600 hover:text-slate-900 font-medium"
                          }`}
                        >
                          Xem trước Word
                        </button>
                        <button
                          onClick={() => setActiveTab("latex")}
                          className={`px-2.5 py-1.5 md:px-3.5 md:py-1.5 rounded-md transition-all cursor-pointer ${
                            activeTab === "latex"
                              ? "bg-white text-slate-900 shadow-xs font-bold"
                              : "text-slate-600 hover:text-slate-900 font-medium"
                          }`}
                        >
                          Tải file PDF
                        </button>
                      </div>

                      {/* Dynamic copy and download actions with responsive texts */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {activeTab === "word" ? (
                          <>
                            <button
                              onClick={copyToWord}
                              className="bg-slate-700 hover:bg-slate-800 text-white px-3 py-1.5 rounded-lg text-[11px] md:text-xs font-bold transition-all shadow-xs cursor-pointer"
                            >
                              <span>Sao chép cho Word</span>
                            </button>
                            <button
                              onClick={downloadAsWord}
                              className="bg-slate-800 hover:bg-slate-900 text-white px-3 py-1.5 rounded-lg text-[11px] md:text-xs font-bold transition-all shadow-xs cursor-pointer"
                              title="Tải file Word (.doc) trực tiếp về máy hỗ trợ đầy đủ MathML"
                            >
                              <span>Tải file Word</span>
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={copyRawLaTeX}
                              className="bg-slate-700 hover:bg-slate-800 text-white px-3 py-1.5 rounded-lg text-[11px] md:text-xs font-bold transition-all shadow-xs cursor-pointer"
                            >
                              <span>Sao chép mã LaTeX</span>
                            </button>
                            <button
                              onClick={downloadAsPdf}
                              disabled={!overleafCode}
                              className="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg text-[11px] md:text-xs font-bold transition-all shadow-xs cursor-pointer flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                              title="Tải PDF trực tiếp về máy"
                            >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path>
                                </svg>
                              <span>Tải file PDF</span>
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Display Viewports */}
                    <div className="flex-1 flex flex-col relative overflow-hidden">
                      {/* Word preview editor body */}
                      <div
                        ref={previewRef}
                        style={{
                          fontFamily: wordFont,
                        }}
                        onCopy={(e) => {
                          e.preventDefault();
                        }}
                        onCut={(e) => {
                          e.preventDefault();
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          // Âm thầm chặn menu chuột phải, không hiện toast
                        }}
                        onKeyDown={(e) => {
                          if (
                            (e.ctrlKey || e.metaKey) &&
                            (e.key === "c" ||
                              e.key === "x" ||
                              e.key === "C" ||
                              e.key === "X")
                          ) {
                            e.preventDefault();
                          }
                        }}
                        onDragStart={(e) => {
                          e.preventDefault();
                        }}
                        className={`preview-content flex-1 w-full p-4 md:p-5 overflow-auto leading-relaxed text-sm md:text-base text-slate-800 select-none ${
                          activeTab === "word" ? "block" : "hidden"
                        }`}
                        dangerouslySetInnerHTML={{ __html: processedHtml }}
                      />

                      {/* Download LaTeX File view block */}
                      <div
                        className={`flex-1 w-full p-4 md:p-6 bg-slate-50 border-t border-slate-100 overflow-auto ${
                          activeTab === "latex" ? "block" : "hidden"
                        }`}
                      >
                        <div className="max-w-md mx-auto w-full bg-white rounded-2xl border border-slate-200/80 p-5 md:p-6 shadow-xs flex flex-col items-center text-center gap-4 md:gap-5 mt-4 md:mt-8">
                            <div className="w-14 h-14 rounded-full bg-emerald-50 flex items-center justify-center text-emerald-600 shadow-2xs">
                              <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"></path>
                              </svg>
                            </div>
                            <div className="space-y-1">
                              <h3 className="text-sm md:text-base font-extrabold text-slate-800">Tài liệu PDF & LaTeX</h3>
                              <p className="text-[10px] md:text-xs text-emerald-600 font-mono select-all font-bold">tai_lieu.pdf</p>
                            </div>

                            <div className="w-full flex flex-col gap-2">
                              {/* Nút Tải PDF */}
                              <button
                                onClick={downloadAsPdf}
                                disabled={!overleafCode}
                                className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-bold text-xs md:text-sm transition-all shadow-md cursor-pointer ${
                                  overleafCode
                                    ? "bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-500/20 active:scale-[0.98]"
                                    : "bg-slate-100 text-slate-400 cursor-not-allowed"
                                }`}
                                title="Tải PDF trực tiếp về máy"
                              >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path>
                                  </svg>
                                <span>Tải file PDF</span>
                              </button>

                              <button
                                onClick={copyRawLaTeX}
                                disabled={!overleafCode}
                                className={`w-full flex items-center justify-center gap-1.5 py-2 rounded-xl font-bold text-[11px] md:text-xs transition-all border cursor-pointer ${
                                  overleafCode
                                    ? "bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900 active:scale-[0.98]"
                                    : "bg-slate-50 text-slate-300 border-slate-100 cursor-not-allowed"
                                }`}
                              >
                                <span>Sao chép mã nguồn LaTeX</span>
                              </button>
                          </div>

                          {/* Ghi chú hướng dẫn */}
                          <p className="text-[10px] text-slate-400 text-center leading-relaxed mt-2">
                            💡 <strong>Ghi chú</strong>: Mã nguồn LaTeX hỗ trợ đầy đủ tiếng Việt.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* DOCUMENT BUILDER / TRÌNH BIÊN SOẠN TÀI LIỆU VÀ ĐỀ THI (v3.3 beta) */}
            <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden flex flex-col mt-6 md:mt-8">
              {/* Top Control Settings Panel */}
              <div className="bg-gradient-to-r from-violet-100 via-sky-50 to-indigo-100 p-3.5 md:p-4.5 border-b border-indigo-200/50 flex flex-col sm:flex-row items-center justify-between gap-4 select-none">
                <div className="flex flex-wrap items-center gap-3 md:gap-4 w-full sm:w-auto">
                  <span className="font-extrabold text-sm text-slate-800 tracking-tight flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                    Q-Builder - CÔNG CỤ BIÊN SOẠN ĐỀ THI
                  </span>
                </div>
              </div>

              {/* Workspace with inner padding and subtle background */}
              <div className="p-4 md:p-6 bg-slate-50/30 flex-1 flex flex-col">
                {/* Main Document Layout Grid: 2 boxes similarly structured like the main app */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
                  {/* Panel 1: EDITOR / COMPILER FORM (Trái) */}
                  <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden flex flex-col min-h-[500px]">
                    {/* Sub-Header: Settings */}
                    <div className="bg-gradient-to-r from-violet-100/60 via-sky-50/40 to-indigo-100/60 p-4 border-b border-indigo-200/40 space-y-4">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <span className="text-xs font-bold text-slate-700 uppercase tracking-wide">
                          Cấu hình tiêu đề tài liệu
                        </span>
                        {/* Style toggle */}
                        <div className="flex bg-slate-200/60 p-0.5 rounded-lg text-[10px] font-bold gap-0.5 self-start sm:self-auto select-none">
                          <button
                            type="button"
                            onClick={() => setDocHeaderStyle("centered")}
                            className={`px-2 py-1 rounded-md transition-all cursor-pointer ${docHeaderStyle === "centered" ? "bg-white text-indigo-750 shadow-2xs" : "text-slate-600 hover:text-slate-800"}`}
                          >
                            Căn giữa (Đơn)
                          </button>
                          <button
                            type="button"
                            onClick={() => setDocHeaderStyle("split")}
                            className={`px-2 py-1 rounded-md transition-all cursor-pointer ${docHeaderStyle === "split" ? "bg-white text-indigo-750 shadow-2xs" : "text-slate-600 hover:text-slate-800"}`}
                          >
                            Khung đôi Bộ GD
                          </button>
                        </div>
                      </div>

                      {docHeaderStyle === "centered" ? (
                        <div className="space-y-2 animate-fade-in">
                          <input
                            type="text"
                            value={docTitle}
                            onChange={(e) => setDocTitle(e.target.value)}
                            placeholder="VD: ĐỀ THI THỬ THPT QUỐC GIA MÔN TOÁN"
                            className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-bold text-slate-800 focus:ring-2 focus:ring-blue-500/10 outline-none"
                          />
                          <input
                            type="text"
                            value={docSubtitle}
                            onChange={(e) => setDocSubtitle(e.target.value)}
                            placeholder="VD: Thời gian làm bài: 90 phút"
                            className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-650 focus:ring-2 focus:ring-blue-500/10 outline-none"
                          />
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-left animate-fade-in border-t border-indigo-150/30 pt-3">
                          {/* Cột trái */}
                          <div className="space-y-3.5 pr-0 sm:pr-3 sm:border-r border-indigo-150/30">
                            <span className="text-[10px] font-bold text-indigo-850 uppercase tracking-wider block border-b border-indigo-100 pb-1">
                              BÊN TRÁI (HỌ TÊN, THỜI GIAN)
                            </span>
                            <div className="space-y-1">
                              <label className="text-[9px] font-bold text-slate-500 block uppercase">
                                Họ tên, Lớp, STT:
                              </label>
                              <textarea
                                rows={2}
                                value={docStudentInfoFormat}
                                onChange={(e) =>
                                  setDocStudentInfoFormat(e.target.value)
                                }
                                placeholder="Họ và tên: ....................................................\nLớp: ................... STT: ........."
                                className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-slate-800 focus:ring-2 focus:ring-blue-500/10 outline-none resize-none leading-relaxed"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[9px] font-bold text-slate-500 block uppercase">
                                Thời gian làm bài:
                              </label>
                              <input
                                type="text"
                                value={docTimeLimit}
                                onChange={(e) =>
                                  setDocTimeLimit(e.target.value)
                                }
                                placeholder="90 phút (Không kể thời gian phát đề)"
                                className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-slate-800 focus:ring-2 focus:ring-blue-500/10 outline-none"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[9px] font-bold text-slate-500 block uppercase">
                                Đề số / Mã đề:
                              </label>
                              <input
                                type="text"
                                value={docExamCode}
                                onChange={(e) => setDocExamCode(e.target.value)}
                                placeholder="101"
                                className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-slate-800 focus:ring-2 focus:ring-blue-500/10 outline-none"
                              />
                            </div>
                          </div>

                          {/* Cột phải */}
                          <div className="space-y-3.5">
                            <span className="text-[10px] font-bold text-indigo-850 uppercase tracking-wider block border-b border-indigo-100 pb-1">
                              BÊN PHẢI (TRƯỜNG, KỲ THI, MÔN)
                            </span>
                            <div className="space-y-1">
                              <label className="text-[9px] font-bold text-slate-500 block uppercase">
                                Tên Trường / Sở GD:
                              </label>
                              <input
                                type="text"
                                value={docSchoolName}
                                onChange={(e) =>
                                  setDocSchoolName(e.target.value)
                                }
                                placeholder="TRƯỜNG THPT CHUYÊN QUỐC GIA"
                                className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-slate-800 focus:ring-2 focus:ring-blue-500/10 outline-none"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[9px] font-bold text-slate-500 block uppercase">
                                Kỳ thi:
                              </label>
                              <input
                                type="text"
                                value={docExamName}
                                onChange={(e) => setDocExamName(e.target.value)}
                                placeholder="KỲ THI THỬ TỐT NGHIỆP THPT"
                                className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-slate-800 focus:ring-2 focus:ring-blue-500/10 outline-none"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[9px] font-bold text-slate-500 block uppercase">
                                Môn thi:
                              </label>
                              <input
                                type="text"
                                value={docSubjectName}
                                onChange={(e) =>
                                  setDocSubjectName(e.target.value)
                                }
                                placeholder="Môn thi: TOÁN HỌC"
                                className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-slate-800 focus:ring-2 focus:ring-blue-500/10 outline-none"
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Form input elements */}
                    <div
                      id="question-input-section"
                      className="p-4 space-y-4 flex-1"
                    >
                      {editingQuestionId &&
                        (() => {
                          const idx = docQuestions.findIndex(
                            (q) => q.id === editingQuestionId,
                          );
                          if (idx === -1) return null;
                          const q = docQuestions[idx];
                          const sameTypeQuestions = docQuestions.filter(
                            (item) => item.type === q.type,
                          );
                          const displayNum =
                            sameTypeQuestions.findIndex(
                              (item) => item.id === q.id,
                            ) + 1;
                          const typeLabel =
                            q.type === "trac_nghiem"
                              ? "Trắc nghiệm"
                              : "Tự luận";
                          return (
                            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center justify-between text-xs text-amber-800 font-medium">
                              <div className="flex items-center gap-2">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                                <span>
                                  Bạn đang chỉnh sửa{" "}
                                  <strong>Câu {displayNum}</strong> ({typeLabel}
                                  )
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingQuestionId(null);
                                  setTracNghiemText("");
                                  setTracNghiemAnswerText("");
                                  setDungSaiText("");
                                  setDungSaiAnswerText("");
                                  setTraLoiNganText("");
                                  setTraLoiNganAnswerText("");
                                  setTuLuanQuestionText("");
                                  setTuLuanAnswerText("");
                                  triggerToast("Đã hủy bỏ chỉnh sửa.", true);
                                }}
                                className="text-[10px] font-bold text-amber-600 hover:text-amber-800 bg-amber-100 hover:bg-amber-250 px-2 py-1 rounded-md transition-all cursor-pointer"
                              >
                                Hủy bỏ
                              </button>
                            </div>
                          );
                        })()}

                      {/* Selector */}
                      <div className="space-y-1.5">
                        <div className="flex justify-between items-center gap-2">
                          <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                            Phân loại câu hỏi mới
                          </label>
                          <button
                            type="button"
                            onClick={() => setShowSmartPasteModal(true)}
                            className="bg-emerald-100 hover:bg-emerald-200 text-emerald-700 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 shadow-2xs"
                            title="Dán câu hỏi và đáp án từ AI để tự động phân tách"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                            </svg>
                            Dán thông minh (AI)
                          </button>
                        </div>
                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 bg-slate-100/80 p-1 rounded-xl">
                          <button
                            type="button"
                            onClick={() => setNewQuestionType("trac_nghiem")}
                            className={`py-2 px-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                              newQuestionType === "trac_nghiem"
                                ? "bg-gradient-to-r from-violet-200 via-sky-100 to-indigo-200 text-slate-800 shadow-xs border border-indigo-200/30 font-extrabold"
                                : "text-slate-650 hover:text-slate-800"
                            }`}
                          >
                            TN 4 Lựa chọn
                          </button>
                          <button
                            type="button"
                            onClick={() => setNewQuestionType("trac_nghiem_dung_sai")}
                            className={`py-2 px-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                              newQuestionType === "trac_nghiem_dung_sai"
                                ? "bg-gradient-to-r from-violet-200 via-sky-100 to-indigo-200 text-slate-800 shadow-xs border border-indigo-200/30 font-extrabold"
                                : "text-slate-650 hover:text-slate-800"
                            }`}
                          >
                            TN Đúng/Sai
                          </button>
                          <button
                            type="button"
                            onClick={() => setNewQuestionType("trac_nghiem_tra_loi_ngan")}
                            className={`py-2 px-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                              newQuestionType === "trac_nghiem_tra_loi_ngan"
                                ? "bg-gradient-to-r from-violet-200 via-sky-100 to-indigo-200 text-slate-800 shadow-xs border border-indigo-200/30 font-extrabold"
                                : "text-slate-650 hover:text-slate-800"
                            }`}
                          >
                            TN Trả lời ngắn
                          </button>
                          <button
                            type="button"
                            onClick={() => setNewQuestionType("tu_luan")}
                            className={`py-2 px-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                              newQuestionType === "tu_luan"
                                ? "bg-gradient-to-r from-violet-200 via-sky-100 to-indigo-200 text-slate-800 shadow-xs border border-indigo-200/30 font-extrabold"
                                : "text-slate-650 hover:text-slate-800"
                            }`}
                          >
                            Tự luận
                          </button>
                        </div>
                      </div>

                      {/* Inputs based on type */}
                      {newQuestionType === "trac_nghiem" ? (
                        /* TWO SIDE-BY-SIDE INPUT FRAMES for multiple choice queries */
                        <div className="space-y-3">
                          <div className="mb-1">
                            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1">
                              Khung nhập câu hỏi trắc nghiệm
                              <span className="text-rose-500 font-bold">*</span>
                            </label>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {/* Left Frame: Question and Options */}
                            <div className="space-y-1">
                              <span className="text-[11px] font-bold text-slate-600 flex items-center gap-0.5">
                                1. Đề bài & các tùy chọn A, B, C, D{" "}
                                <span className="text-rose-500">*</span>
                              </span>
                              <textarea
                                value={tracNghiemText}
                                onChange={(e) =>
                                  setTracNghiemText(e.target.value)
                                }
                                onPaste={(e) =>
                                  handlePasteGeneric(e, setTracNghiemText)
                                }
                                rows={6}
                                placeholder="VD: Cho hàm số $y=x+1$, tìm điểm giao với trục hoành.\nA. $(1;0)$\nB. $(-1;0)$\nC. $(0;1)$\nD. $(0;-1)$"
                                className="w-full bg-slate-50/40 border border-slate-200 rounded-xl p-3 text-xs md:text-sm text-slate-800 focus:ring-2 focus:ring-blue-500/10 focus:border-blue-500 focus:bg-white outline-none font-normal leading-relaxed overflow-y-auto"
                              />
                            </div>

                            {/* Right Frame: Answer and Solution */}
                            <div className="space-y-1">
                              <span className="text-[11px] font-bold text-slate-500">
                                2. Đáp án giải chi tiết (Có thể bỏ trống)
                              </span>
                              <textarea
                                value={tracNghiemAnswerText}
                                onChange={(e) =>
                                  setTracNghiemAnswerText(e.target.value)
                                }
                                onPaste={(e) =>
                                  handlePasteGeneric(e, setTracNghiemAnswerText)
                                }
                                rows={6}
                                placeholder="VD: Chọn B. Giao điểm với trục hoành có $y = 0 \implies x + 1 = 0 \implies x = -1$."
                                className="w-full bg-slate-50/40 border border-slate-200 rounded-xl p-3 text-xs md:text-sm text-slate-800 focus:ring-2 focus:ring-blue-500/10 focus:border-blue-500 focus:bg-white outline-none font-normal leading-relaxed overflow-y-auto"
                              />
                            </div>
                          </div>

                          {/* Column pickers */}
                          <div className="flex items-center gap-3 bg-slate-50/70 p-2.5 rounded-xl border border-slate-200/50">
                            <span className="text-xs font-bold text-slate-650">
                              Bố cục đáp án trắc nghiệm:
                            </span>
                            <div className="flex gap-1.5">
                              {[1, 2, 4].map((cols) => (
                                <button
                                  key={cols}
                                  type="button"
                                  onClick={() => setNewTracNghiemColumns(cols)}
                                  className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                                    newTracNghiemColumns === cols
                                      ? "bg-slate-700 text-white shadow-xs"
                                      : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
                                  }`}
                                >
                                  {cols} cột
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      ) : (
                        /* Generic TWO SIDE-BY-SIDE INPUT FRAMES for other query types */
                        <div className="space-y-1.5">
                          <div className="mb-1">
                            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                              {newQuestionType === "trac_nghiem_dung_sai" ? "Khung nhập câu hỏi Trắc nghiệm Đúng/Sai" : newQuestionType === "trac_nghiem_tra_loi_ngan" ? "Khung nhập câu hỏi Trắc nghiệm Trả lời ngắn" : "Khung nhập câu hỏi tự luận"}
                            </label>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {/* Left Frame: Question Text - REQUIRED */}
                            <div className="space-y-1">
                              <span className="text-[11px] font-bold text-slate-600 flex items-center gap-0.5">
                                1. Nội dung câu hỏi{" "}
                                <span className="text-rose-500">*</span>
                              </span>
                              <textarea
                                value={newQuestionType === "trac_nghiem_dung_sai" ? dungSaiText : newQuestionType === "trac_nghiem_tra_loi_ngan" ? traLoiNganText : tuLuanQuestionText}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  if (newQuestionType === "trac_nghiem_dung_sai") setDungSaiText(val);
                                  else if (newQuestionType === "trac_nghiem_tra_loi_ngan") setTraLoiNganText(val);
                                  else setTuLuanQuestionText(val);
                                }}
                                onPaste={(e) => {
                                  if (newQuestionType === "trac_nghiem_dung_sai") handlePasteGeneric(e, setDungSaiText);
                                  else if (newQuestionType === "trac_nghiem_tra_loi_ngan") handlePasteGeneric(e, setTraLoiNganText);
                                  else handlePasteGeneric(e, setTuLuanQuestionText);
                                }}
                                rows={5}
                                placeholder={
                                  newQuestionType === "trac_nghiem_dung_sai" ? "VD: Cho hàm số y = ... Các mệnh đề sau đúng hay sai:\na) Hàm số nghịch biến...\nb) Đồ thị cắt trục tung...\nc) Đạo hàm...\nd) Hàm số đạt cực đại..." :
                                  newQuestionType === "trac_nghiem_tra_loi_ngan" ? "VD: Tính thể tích khối chóp..." :
                                  "VD: Viết giả thuyết Goldbach bằng công thức toán học và chứng minh với trường hợp số 10."
                                }
                                className="w-full bg-slate-50/40 border border-slate-200 rounded-xl p-3 text-xs md:text-sm text-slate-800 focus:ring-2 focus:ring-blue-500/10 focus:border-blue-500 focus:bg-white outline-none font-normal leading-relaxed"
                              />
                            </div>

                            {/* Right Frame: Answer Text - OPTIONAL */}
                            <div className="space-y-1">
                              <span className="text-[11px] font-bold text-slate-500">
                                2. Đáp án giải chi tiết (Có thể bỏ trống)
                              </span>
                              <textarea
                                value={newQuestionType === "trac_nghiem_dung_sai" ? dungSaiAnswerText : newQuestionType === "trac_nghiem_tra_loi_ngan" ? traLoiNganAnswerText : tuLuanAnswerText}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  if (newQuestionType === "trac_nghiem_dung_sai") setDungSaiAnswerText(val);
                                  else if (newQuestionType === "trac_nghiem_tra_loi_ngan") setTraLoiNganAnswerText(val);
                                  else setTuLuanAnswerText(val);
                                }}
                                onPaste={(e) => {
                                  if (newQuestionType === "trac_nghiem_dung_sai") handlePasteGeneric(e, setDungSaiAnswerText);
                                  else if (newQuestionType === "trac_nghiem_tra_loi_ngan") handlePasteGeneric(e, setTraLoiNganAnswerText);
                                  else handlePasteGeneric(e, setTuLuanAnswerText);
                                }}
                                rows={5}
                                placeholder={
                                  newQuestionType === "trac_nghiem_dung_sai" ? "VD: a) Đúng\nb) Sai\nc) Đúng\nd) Sai" :
                                  newQuestionType === "trac_nghiem_tra_loi_ngan" ? "VD: Đáp án: 12" :
                                  "VD: Nhập nội dung hướng dẫn giải chi tiết..."
                                }
                                className="w-full bg-slate-50/40 border border-slate-200 rounded-xl p-3 text-xs md:text-sm text-slate-800 focus:ring-2 focus:ring-blue-500/10 focus:border-blue-500 focus:bg-white outline-none font-normal leading-relaxed"
                              />
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Submit Add Button */}
                      <div className="flex justify-end items-center gap-2 pt-1">
                        {editingQuestionId && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingQuestionId(null);
                              setTracNghiemText("");
                              setTracNghiemAnswerText("");
                              setDungSaiText("");
                              setDungSaiAnswerText("");
                              setTraLoiNganText("");
                              setTraLoiNganAnswerText("");
                              setTuLuanQuestionText("");
                              setTuLuanAnswerText("");
                              triggerToast("Đã hủy bỏ chỉnh sửa.", true);
                            }}
                            className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl text-xs flex items-center transition-all cursor-pointer"
                          >
                            Hủy bỏ
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={handleAddQuestion}
                          className={`px-5 py-2.5 text-white font-bold rounded-xl text-xs flex items-center gap-1.5 transition-all shadow-md active:scale-95 cursor-pointer ${
                            editingQuestionId
                              ? "bg-amber-600 hover:bg-amber-500"
                              : "bg-slate-700 hover:bg-slate-800"
                          }`}
                        >
                          {editingQuestionId ? (
                            <>CẬP NHẬT CÂU HỎI</>
                          ) : (
                            <>THÊM CÂU HỎI VÀO TÀI LIỆU</>
                          )}
                        </button>
                      </div>

                      <div className="border-t border-slate-100 pt-4 space-y-3">
                        <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:justify-between">
                          <span className="text-xs font-extrabold text-slate-700 tracking-wide uppercase flex items-center gap-1.5">
                            <span className="inline-block w-2 h-2 rounded-full bg-slate-400" />
                            Danh sách câu hỏi đã lưu ({docQuestions.length})
                          </span>
                        </div>

                        {docQuestions.length > 0 && (
                          <div className="flex flex-wrap gap-1 bg-slate-100/60 p-1 rounded-xl text-[10px] font-bold">
                            <button
                              type="button"
                              onClick={() => setSavedQuestionTab("all")}
                              className={`px-2.5 py-1.5 rounded-lg cursor-pointer transition-all ${
                                savedQuestionTab === "all"
                                  ? "bg-white text-slate-800 shadow-xs border border-slate-200/50"
                                  : "text-slate-500 hover:text-slate-800"
                              }`}
                            >
                              Tất cả ({docQuestions.length})
                            </button>
                            <button
                              type="button"
                              onClick={() => setSavedQuestionTab("trac_nghiem")}
                              className={`px-2.5 py-1.5 rounded-lg cursor-pointer transition-all flex items-center gap-1 ${
                                savedQuestionTab === "trac_nghiem"
                                  ? "bg-white text-blue-700 shadow-xs border border-blue-100"
                                  : "text-slate-500 hover:text-blue-600"
                              }`}
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                              TN 4 Lựa chọn ({tracNghiemList.length})
                            </button>
                            <button
                              type="button"
                              onClick={() => setSavedQuestionTab("trac_nghiem_dung_sai")}
                              className={`px-2.5 py-1.5 rounded-lg cursor-pointer transition-all flex items-center gap-1 ${
                                savedQuestionTab === "trac_nghiem_dung_sai"
                                  ? "bg-white text-purple-700 shadow-xs border border-purple-100"
                                  : "text-slate-500 hover:text-purple-600"
                              }`}
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
                              TN Đúng/Sai ({dungSaiList.length})
                            </button>
                            <button
                              type="button"
                              onClick={() => setSavedQuestionTab("trac_nghiem_tra_loi_ngan")}
                              className={`px-2.5 py-1.5 rounded-lg cursor-pointer transition-all flex items-center gap-1 ${
                                savedQuestionTab === "trac_nghiem_tra_loi_ngan"
                                  ? "bg-white text-teal-700 shadow-xs border border-teal-100"
                                  : "text-slate-500 hover:text-teal-600"
                              }`}
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-teal-500" />
                              TN Trả lời ngắn ({traLoiNganList.length})
                            </button>
                            <button
                              type="button"
                              onClick={() => setSavedQuestionTab("tu_luan")}
                              className={`px-2.5 py-1.5 rounded-lg cursor-pointer transition-all flex items-center gap-1 ${
                                savedQuestionTab === "tu_luan"
                                  ? "bg-white text-rose-700 shadow-xs border border-rose-100"
                                  : "text-slate-500 hover:text-rose-600"
                              }`}
                            >
                              <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                              Tự luận ({tuLuanList.length})
                            </button>
                          </div>
                        )}

                        {docQuestions.length === 0 ? (
                          <p className="text-xs text-slate-400 italic">
                            Chưa có câu hỏi nào được lưu. Hãy thêm câu đầu tiên
                            ở trên!
                          </p>
                        ) : (
                          (() => {
                            const filteredQuestions = docQuestions.filter((q) => {
                              if (savedQuestionTab === "all") return true;
                              return q.type === savedQuestionTab;
                            });

                            if (filteredQuestions.length === 0) {
                              return (
                                <p className="text-xs text-slate-400 italic p-4 text-center border border-dashed border-slate-200 rounded-xl bg-slate-50/30">
                                  Không có câu hỏi nào thuộc phân loại này.
                                </p>
                              );
                            }

                            const borderColors: Record<string, string> = {
                              trac_nghiem: "border-l-[3px] border-l-blue-500",
                              trac_nghiem_dung_sai: "border-l-[3px] border-l-purple-500",
                              trac_nghiem_tra_loi_ngan: "border-l-[3px] border-l-teal-500",
                              tu_luan: "border-l-[3px] border-l-rose-500",
                            };

                            return (
                              <div className="max-h-[225px] overflow-y-auto overflow-x-auto border border-slate-200/60 rounded-xl">
                                <table className="w-full text-left text-xs border-collapse">
                                  <thead>
                                    <tr className="bg-slate-50 text-slate-500 border-b border-slate-200/80 sticky top-0 z-10 shadow-3xs">
                                      <th className="p-2.5">Thứ tự</th>
                                      <th className="p-2.5">Phân loại</th>
                                      <th className="p-2.5">Cột đáp án</th>
                                      <th className="p-2.5">Nội dung tóm tắt</th>
                                      <th className="p-2.5 text-center">
                                        Thao tác
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {filteredQuestions.map((q) => {
                                      const isEditing = editingQuestionId === q.id;
                                      const origIdx = docQuestions.findIndex((item) => item.id === q.id);
                                      return (
                                        <tr
                                          key={q.id}
                                          className={`border-b border-slate-100 last:border-0 transition-colors ${
                                            isEditing
                                              ? "bg-amber-50/60 hover:bg-amber-100/50 border-l-[4px] border-l-amber-500"
                                              : `hover:bg-slate-50/50 ${borderColors[q.type] || ""}`
                                          }`}
                                        >
                                          <td
                                            onClick={() =>
                                              handleStartEditQuestion(q)
                                            }
                                            className={`p-2.5 font-bold cursor-pointer hover:text-indigo-600 transition-colors ${
                                              isEditing
                                                ? "text-amber-700"
                                                : "text-slate-600"
                                            }`}
                                            title="Bấm để chỉnh sửa câu hỏi này"
                                          >
                                            {(() => {
                                              const sameTypeQuestions =
                                                docQuestions.filter(
                                                  (item) => item.type === q.type,
                                                );
                                              const displayNum =
                                                sameTypeQuestions.findIndex(
                                                  (item) => item.id === q.id,
                                                ) + 1;
                                              const typeSuffix =
                                                q.type === "trac_nghiem"
                                                  ? "TN"
                                                  : q.type === "trac_nghiem_dung_sai"
                                                  ? "Đ/S"
                                                  : q.type === "trac_nghiem_tra_loi_ngan"
                                                  ? "TLN"
                                                  : "TL";
                                              return `Câu ${displayNum} (${typeSuffix})`;
                                            })()}
                                          </td>
                                          <td
                                            onClick={() =>
                                              handleStartEditQuestion(q)
                                            }
                                            className="p-2.5 cursor-pointer"
                                            title="Bấm để chỉnh sửa câu hỏi này"
                                          >
                                            <span
                                              className={`px-2 py-0.5 rounded text-[10px] font-extrabold border ${
                                                q.type === "trac_nghiem"
                                                  ? "bg-blue-50 text-blue-700 border-blue-150"
                                                  : q.type === "trac_nghiem_dung_sai"
                                                  ? "bg-purple-50 text-purple-700 border-purple-150"
                                                  : q.type === "trac_nghiem_tra_loi_ngan"
                                                  ? "bg-teal-50 text-teal-700 border-teal-150"
                                                  : "bg-rose-50 text-rose-700 border-rose-150"
                                              }`}
                                            >
                                              {q.type === "trac_nghiem"
                                                ? "TN 4 Lựa chọn"
                                                : q.type === "trac_nghiem_dung_sai"
                                                ? "TN Đúng/Sai"
                                                : q.type === "trac_nghiem_tra_loi_ngan"
                                                ? "TN Trả lời ngắn"
                                                : "Tự luận"}
                                            </span>
                                          </td>
                                          <td className="p-2.5">
                                            {q.type === "trac_nghiem" ? (
                                              <div className="inline-flex gap-0.5 bg-slate-100 p-0.5 rounded-lg border border-slate-200">
                                                {[1, 2, 4].map((c) => (
                                                  <button
                                                    key={c}
                                                    onClick={() =>
                                                      handleUpdateQuestionColumns(
                                                        q.id,
                                                        c,
                                                      )
                                                    }
                                                    className={`px-1.5 py-0.5 rounded text-[9px] font-extrabold cursor-pointer transition-all ${
                                                      (q.columns || 4) === c
                                                        ? "bg-slate-700 text-white shadow-xs"
                                                        : "text-slate-500 hover:text-slate-800"
                                                    }`}
                                                  >
                                                    {c}C
                                                  </button>
                                                ))}
                                              </div>
                                            ) : (
                                              <span className="text-slate-400 font-medium italic">
                                                -
                                              </span>
                                            )}
                                          </td>
                                          <td
                                            onClick={() =>
                                              handleStartEditQuestion(q)
                                            }
                                            className="p-2.5 text-slate-500 truncate max-w-[130px] cursor-pointer hover:text-slate-850 transition-colors"
                                            title="Bấm để chỉnh sửa câu hỏi này"
                                          >
                                            {getCleanQuestionBody(q.questionText)}
                                          </td>
                                          <td className="p-2.5 text-center">
                                            <div className="inline-flex items-center gap-1.5">
                                              <button
                                                onClick={() =>
                                                  handleMoveQuestion(origIdx, "up")
                                                }
                                                disabled={savedQuestionTab !== "all" || origIdx === 0}
                                                className="p-1 text-slate-400 hover:text-slate-650 disabled:opacity-30 cursor-pointer text-xs"
                                                title={savedQuestionTab !== "all" ? "Chỉ di chuyển được ở tab Tất cả" : "Di chuyển lên"}
                                              >
                                                ▲
                                              </button>
                                              <button
                                                onClick={() =>
                                                  handleMoveQuestion(origIdx, "down")
                                                }
                                                disabled={
                                                  savedQuestionTab !== "all" || origIdx === docQuestions.length - 1
                                                }
                                                className="p-1 text-slate-400 hover:text-slate-650 disabled:opacity-30 cursor-pointer text-xs"
                                                title={savedQuestionTab !== "all" ? "Chỉ di chuyển được ở tab Tất cả" : "Di chuyển xuống"}
                                              >
                                                ▼
                                              </button>
                                              <button
                                                onClick={() =>
                                                  handleStartEditQuestion(q)
                                                }
                                                className={`p-1 rounded cursor-pointer transition-colors ${
                                                  isEditing
                                                    ? "text-amber-600 bg-amber-100 hover:bg-amber-200"
                                                    : "text-blue-500 hover:text-blue-700 hover:bg-blue-50"
                                                }`}
                                                title="Chỉnh sửa câu hỏi này"
                                              >
                                                Sửa
                                              </button>
                                              <button
                                                onClick={() =>
                                                  handleDeleteQuestion(q.id)
                                                }
                                                className="p-1 text-rose-500 hover:text-rose-700 rounded hover:bg-rose-50 cursor-pointer text-xs font-bold"
                                                title="Xóa"
                                              >
                                                Xóa
                                              </button>
                                            </div>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            );
                          })()
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Panel 2: EXPORT PREVIEW (Phải) */}
                  <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden flex flex-col min-h-[500px]">
                    {/* Actions Area */}
                    <div className="bg-gradient-to-r from-violet-100/60 via-sky-50/40 to-indigo-100/60 p-4 border-b border-indigo-200/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs font-bold">
                      <span className="text-slate-700 uppercase">
                        XEM TRƯỚC VÀ XUẤT ĐỀ THI HOÀN CHỈNH
                      </span>
                      <div className="flex gap-2">
                        <button
                          onClick={copyDocToWord}
                          disabled={docQuestions.length === 0}
                          className="bg-slate-700 hover:bg-slate-800 text-white px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer disabled:opacity-50"
                        >
                          Sao chép cho Word
                        </button>
                        <button
                          onClick={downloadDocAsWord}
                          disabled={docQuestions.length === 0}
                          className="bg-slate-800 hover:bg-slate-900 text-white px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer disabled:opacity-50"
                        >
                          Tải đề thi (.doc)
                        </button>
                      </div>
                    </div>

                    {/* Document preview container */}
                    <div className="p-5 md:p-6 flex-1 overflow-y-auto max-h-[560px] bg-slate-50/20 border-b border-slate-100">
                      {docQuestions.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400 space-y-2">
                          <p className="text-xs font-medium">
                            Bản xem trước tài liệu trống. Hãy nhập câu hỏi trên
                            bảng chỉnh sửa bên trái để tự động đồng hóa ở đây.
                          </p>
                        </div>
                      ) : (
                        /* Real live paper style rendering target */
                        <div
                          ref={docPreviewRef}
                          style={{ fontFamily: wordFont }}
                          className="preview-content bg-white p-6 md:p-8 rounded-xl shadow-xs border border-slate-200 max-w-full overflow-hidden leading-relaxed text-sm md:text-base text-slate-800 space-y-6"
                        >
                          {/* Title header block */}
                          {docHeaderStyle === "centered" ? (
                            <div className="doc-header-block text-center space-y-1.5 border-b-2 border-double border-slate-850 pb-4">
                              <h3 className="doc-title-text font-extrabold text-slate-900 tracking-tight uppercase text-center text-sm md:text-base leading-tight">
                                {docTitle || "TIÊU ĐỀ TÀI LIỆU"}
                              </h3>
                              <p className="doc-subtitle-text text-xs font-semibold text-slate-600 italic">
                                {docSubtitle ||
                                  "Thông tin chi tiết thời gian, phân ban"}
                              </p>
                            </div>
                          ) : (
                            <div className="doc-header-block border-b-2 border-double border-slate-850 pb-4 select-text overflow-x-auto">
                              <table
                                style={{
                                  width: "100%",
                                  borderCollapse: "collapse",
                                  border: "none",
                                }}
                                className="doc-header-table w-full border-none text-xs md:text-sm"
                              >
                                <tbody>
                                  <tr style={{ border: "none" }}>
                                    <td
                                      style={{
                                        width: "50%",
                                        verticalAlign: "top",
                                        textAlign: "left",
                                        padding: "4px",
                                        border: "none",
                                      }}
                                      className="w-1/2 align-top text-left p-1"
                                    >
                                      <div className="font-bold text-slate-800 space-y-1 text-xs md:text-[13px] leading-relaxed">
                                        <div className="whitespace-pre-wrap">
                                          {docStudentInfoFormat ||
                                            `Họ và tên: ....................................................\nLớp: ................... STT: .........`}
                                        </div>
                                        <div className="text-slate-600 font-medium text-[11px] md:text-xs mt-2">
                                          Thời gian làm bài:{" "}
                                          {docTimeLimit || "90 phút"}
                                        </div>
                                        {docExamCode && (
                                          <div className="text-slate-800 font-bold text-xs md:text-[13px] mt-1">
                                            Mã đề: {docExamCode}
                                          </div>
                                        )}
                                      </div>
                                    </td>
                                    <td
                                      style={{
                                        width: "50%",
                                        verticalAlign: "top",
                                        textAlign: "center",
                                        padding: "4px",
                                        border: "none",
                                      }}
                                      className="w-1/2 align-top text-center p-1 border-l border-slate-300"
                                    >
                                      <div className="space-y-1 text-xs md:text-[13px] font-bold text-slate-800 leading-tight">
                                        <div className="uppercase">
                                          {docSchoolName ||
                                            "SỞ GIÁO DỤC VÀ ĐÀO TẠO"}
                                        </div>
                                        <div className="uppercase">
                                          {docExamName ||
                                            "KỲ THI THỬ TỐT NGHIỆP"}
                                        </div>
                                        <div className="text-slate-700 font-extrabold">
                                          {docSubjectName || "MÔN THI"}
                                        </div>
                                      </div>
                                    </td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                          )}

                          {/* List of Questions inside document */}
                          <div className="space-y-6 select-all select-text text-left">
                            {tracNghiemList.length > 0 && (
                              <div className="space-y-4">
                                <div className="doc-section-header font-extrabold text-slate-900 border-b-2 border-slate-800 pb-1.5 text-left text-sm md:text-base uppercase flex items-center justify-between">
                                  <span className="doc-section-title">
                                    {labelTracNghiem}
                                  </span>
                                </div>
                                <div className="space-y-4">
                                  {tracNghiemList.map((q, idx) => {
                                    const displayNum = idx + 1;
                                    const parsed = parseMultipleChoice(
                                      q.questionText,
                                    );
                                    const cleanBody = getCleanQuestionBody(
                                      parsed.questionBody,
                                    );
                                    return (
                                      <div
                                        key={q.id}
                                        className="doc-question-item space-y-2"
                                      >
                                        <div className="flex items-start gap-1">
                                          {!hasQuestionPrefix(cleanBody) && (
                                            <span className="doc-type-badge font-bold text-slate-900 select-none shrink-0">
                                              Câu {displayNum}.
                                            </span>
                                          )}
                                          <div
                                            className="text-slate-850 font-normal leading-relaxed overflow-x-auto select-all w-full text-left"
                                            dangerouslySetInnerHTML={{
                                              __html:
                                                renderContentWithMath(
                                                  cleanBody,
                                                ),
                                            }}
                                          />
                                        </div>

                                        {parsed.options.length > 0 && (
                                          <div
                                            className={`doc-options-container grid gap-2 mt-2 ${
                                              (q.columns || 4) === 4
                                                ? "grid-cols-1 sm:grid-cols-2 md:grid-cols-4"
                                                : (q.columns || 4) === 2
                                                ? "grid-cols-1 sm:grid-cols-2"
                                                : "grid-cols-1"
                                            }`}
                                            data-columns={q.columns || 4}
                                          >
                                            {parsed.options.map((opt, oIdx) => (
                                              <div
                                                key={oIdx}
                                                className="doc-option-item flex items-start gap-1.5 py-0.5"
                                              >
                                                <span className="doc-option-label font-bold text-slate-900 shrink-0">
                                                  {opt.label}.
                                                </span>
                                                <div
                                                  className="doc-option-text text-slate-800 text-left w-full whitespace-normal break-words overflow-x-auto"
                                                  dangerouslySetInnerHTML={{
                                                    __html:
                                                      renderContentWithMath(
                                                        opt.text,
                                                      ),
                                                  }}
                                                />
                                              </div>
                                            ))}
                                          </div>
                                        )}

                                        {/* Fallback multiple choice answer key / detailed solution */}
                                        {q.answerText && (
                                          <div className="doc-answer-block ml-5 p-3 rounded-lg bg-emerald-50/40 border border-emerald-100/60 text-slate-700 space-y-1 mt-2">
                                            <span className="doc-answer-title text-[10px] font-bold text-emerald-700 uppercase tracking-widest block select-none mb-1">
                                              ĐÁP ÁN / HƯỚNG DẪN GIẢI CHI TIẾT:
                                            </span>
                                            <div
                                              className="doc-answer-body text-xs md:text-sm font-normal text-slate-600 space-y-1 leading-relaxed overflow-x-auto select-all w-full text-left"
                                              dangerouslySetInnerHTML={{
                                                __html: renderContentWithMath(
                                                  q.answerText,
                                                ),
                                              }}
                                            />
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}

                            {dungSaiList.length > 0 && (
                              <div className="space-y-4">
                                <div className="doc-section-header font-extrabold text-slate-900 border-b-2 border-slate-800 pb-1.5 text-left text-sm md:text-base uppercase flex items-center justify-between">
                                  <span className="doc-section-title">
                                    {labelDungSai}
                                  </span>
                                </div>
                                <div className="space-y-4">
                                  {dungSaiList.map((q, idx) => {
                                    const displayNum = idx + 1;
                                    const cleanText = getCleanQuestionBody(
                                      q.questionText,
                                    );
                                    return (
                                      <div
                                        key={q.id}
                                        className="doc-question-item space-y-3"
                                      >
                                        <div className="flex items-start gap-1">
                                          {!hasQuestionPrefix(cleanText) && (
                                            <span className="doc-type-badge font-bold text-slate-900 select-none shrink-0">
                                              Câu {displayNum}.
                                            </span>
                                          )}
                                          <div
                                            className="text-slate-850 font-normal leading-relaxed overflow-x-auto select-all w-full text-left"
                                            dangerouslySetInnerHTML={{
                                              __html:
                                                renderContentWithMath(
                                                  cleanText,
                                                ),
                                            }}
                                          />
                                        </div>
                                        {q.answerText && (
                                          <div className="doc-answer-block ml-5 p-3 rounded-lg bg-emerald-50/40 border border-emerald-100/60 text-slate-700 space-y-1">
                                            <span className="doc-answer-title text-[10px] font-bold text-emerald-700 uppercase tracking-widest block select-none mb-1">
                                              ĐÁP ÁN / HƯỚNG DẪN GIẢI CHI TIẾT:
                                            </span>
                                            <div
                                              className="doc-answer-body text-xs md:text-sm font-normal text-slate-600 space-y-1 leading-relaxed overflow-x-auto select-all w-full text-left"
                                              dangerouslySetInnerHTML={{
                                                __html: renderContentWithMath(
                                                  q.answerText,
                                                ),
                                              }}
                                            />
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}

                            {traLoiNganList.length > 0 && (
                              <div className="space-y-4">
                                <div className="doc-section-header font-extrabold text-slate-900 border-b-2 border-slate-800 pb-1.5 text-left text-sm md:text-base uppercase flex items-center justify-between">
                                  <span className="doc-section-title">
                                    {labelTraLoiNgan}
                                  </span>
                                </div>
                                <div className="space-y-4">
                                  {traLoiNganList.map((q, idx) => {
                                    const displayNum = idx + 1;
                                    const cleanText = getCleanQuestionBody(
                                      q.questionText,
                                    );
                                    return (
                                      <div
                                        key={q.id}
                                        className="doc-question-item space-y-3"
                                      >
                                        <div className="flex items-start gap-1">
                                          {!hasQuestionPrefix(cleanText) && (
                                            <span className="doc-type-badge font-bold text-slate-900 select-none shrink-0">
                                              Câu {displayNum}.
                                            </span>
                                          )}
                                          <div
                                            className="text-slate-850 font-normal leading-relaxed overflow-x-auto select-all w-full text-left"
                                            dangerouslySetInnerHTML={{
                                              __html:
                                                renderContentWithMath(
                                                  cleanText,
                                                ),
                                            }}
                                          />
                                        </div>
                                        {q.answerText && (
                                          <div className="doc-answer-block ml-5 p-3 rounded-lg bg-emerald-50/40 border border-emerald-100/60 text-slate-700 space-y-1">
                                            <span className="doc-answer-title text-[10px] font-bold text-emerald-700 uppercase tracking-widest block select-none mb-1">
                                              ĐÁP ÁN / HƯỚNG DẪN GIẢI CHI TIẾT:
                                            </span>
                                            <div
                                              className="doc-answer-body text-xs md:text-sm font-normal text-slate-600 space-y-1 leading-relaxed overflow-x-auto select-all w-full text-left"
                                              dangerouslySetInnerHTML={{
                                                __html: renderContentWithMath(
                                                  q.answerText,
                                                ),
                                              }}
                                            />
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}

                            {tuLuanList.length > 0 && (
                              <div className="space-y-4">
                                <div className="doc-section-header font-extrabold text-slate-900 border-b-2 border-slate-800 pb-1.5 text-left text-sm md:text-base uppercase flex items-center justify-between">
                                  <span className="doc-section-title">
                                    {labelTuLuan}
                                  </span>
                                </div>
                                <div className="space-y-4">
                                  {tuLuanList.map((q, idx) => {
                                    const displayNum = idx + 1;
                                    const cleanText = getCleanQuestionBody(
                                      q.questionText,
                                    );
                                    return (
                                      <div
                                        key={q.id}
                                        className="doc-question-item space-y-3"
                                      >
                                        <div className="flex items-start gap-1">
                                          {!hasQuestionPrefix(cleanText) && (
                                            <span className="doc-type-badge font-bold text-indigo-600 select-none shrink-0">
                                              Câu {displayNum}.
                                            </span>
                                          )}
                                          <div
                                            className="text-slate-850 font-normal leading-relaxed overflow-x-auto select-all w-full text-left"
                                            dangerouslySetInnerHTML={{
                                              __html:
                                                renderContentWithMath(
                                                  cleanText,
                                                ),
                                            }}
                                          />
                                        </div>

                                        {/* If essay / written type, show answer/solution area if it has text */}
                                        {q.answerText && (
                                          <div className="doc-answer-block ml-5 p-3 rounded-lg bg-emerald-50/40 border border-emerald-100/60 text-slate-700 space-y-1">
                                            <span className="doc-answer-title text-[10px] font-bold text-emerald-700 uppercase tracking-widest block select-none mb-1">
                                              ĐÁP ÁN / HƯỚNG DẪN GIẢI CHI TIẾT:
                                            </span>
                                            <div
                                              className="doc-answer-body text-xs md:text-sm font-normal text-slate-600 space-y-1 leading-relaxed overflow-x-auto select-all w-full text-left"
                                              dangerouslySetInnerHTML={{
                                                __html: renderContentWithMath(
                                                  q.answerText,
                                                ),
                                              }}
                                            />
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>

                          {/* Paper footer mark */}
                          <div className="doc-footer text-center pt-4 border-t border-slate-200 select-none">
                            <p className="text-[10px] text-slate-400 font-bold tracking-widest uppercase">
                              --- HẾT ---
                            </p>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Guide tip inside preview tab */}
                    <div className="px-4 py-2.5 md:px-5 md:py-3 bg-slate-50/50 flex items-center gap-2">
                      <span className="p-1 bg-indigo-50 text-indigo-600 rounded-md shrink-0">
                        <HelpCircle className="w-3.5 h-3.5" />
                      </span>
                      <p className="text-[10px] text-slate-600 font-medium">
                        Xem trước chuẩn hóa Unicode & Ký hiệu LaTeX. Khi dán
                        sang MS Word, mọi công thức sẽ tự động đồng hóa thành
                        các đối tượng Math Equation có thể tương tác trực tiếp!
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Smart Paste Modal */}
        <AnimatePresence>
          {showSmartPasteModal && (
            <div
              className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto"
              style={{ padding: "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)" }}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="bg-white rounded-2xl shadow-xl w-full max-w-3xl overflow-hidden flex flex-col"
              >
                <div className="bg-slate-50 border-b border-slate-200 px-5 py-4 flex justify-between items-center relative">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                    <h3 className="font-bold text-slate-800 text-sm md:text-base tracking-tight">
                      Dán thông minh từ AI (Bước {smartPasteStep}/2)
                    </h3>
                  </div>
                  <button
                    onClick={closeSmartPasteModal}
                    className="text-slate-400 hover:text-slate-600 hover:bg-slate-200/50 p-1.5 rounded-lg transition-colors cursor-pointer"
                  >
                    ✕
                  </button>
                </div>
                <div className="p-5 md:p-6 flex-1 flex flex-col gap-4">
                  {smartPasteStep === 1 ? (
                    <>
                      <p className="text-sm text-slate-600 font-medium leading-relaxed">
                        Hãy dán nguyên bản toàn bộ phản hồi từ AI (bao gồm cả đề bài, các đáp án và lời giải). Hệ thống sẽ tự động phân tách và sắp xếp chúng vào đúng các ô nhập liệu cho bạn. Các định dạng in đậm, in nghiêng và LaTeX sẽ được giữ nguyên.
                      </p>
                      <textarea
                        value={smartPasteText}
                        onChange={(e) => setSmartPasteText(e.target.value)}
                        onPaste={(e) => handlePasteGeneric(e, setSmartPasteText, true)}
                        placeholder="Dán (Ctrl+V) toàn bộ nội dung câu hỏi và đáp án từ ChatGPT/Gemini vào đây..."
                        className="w-full h-64 p-4 text-sm rounded-xl border border-slate-200 resize-none focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 bg-slate-50"
                      />
                      <div className="flex justify-end gap-3 mt-2">
                        <button
                          onClick={closeSmartPasteModal}
                          className="px-4 py-2 text-slate-600 font-semibold bg-slate-100 hover:bg-slate-200 rounded-lg text-sm transition-colors cursor-pointer"
                        >
                          Hủy bỏ
                        </button>
                        <button
                          onClick={handleSmartPasteProcess}
                          className="px-5 py-2 text-white font-bold bg-emerald-600 hover:bg-emerald-700 rounded-lg text-sm shadow-md transition-colors cursor-pointer"
                        >
                          Phân tách & Xem trước
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-slate-600 font-medium leading-relaxed">
                        Kết quả phân tách tự động dưới đây. Vui lòng xem trước các định dạng. Nếu đã chính xác, hãy bấm nút <strong>"Xác nhận nạp vào đề"</strong> để tiến hành nhập vào đề thi chính thức.
                      </p>
                      
                      <div className="space-y-4 max-h-[400px] overflow-y-auto pr-1 border border-slate-100 rounded-xl p-3 bg-slate-50/50">
                        {parsedPreviewQuestions.map((q, index) => (
                          <div key={q.id || index} className="p-4 bg-white rounded-xl border border-slate-250 shadow-2xs text-left relative overflow-hidden">
                            <div className="flex justify-between items-center mb-2.5">
                              <span className="font-bold text-[10px] text-emerald-800 bg-emerald-50 border border-emerald-100 px-2.5 py-1 rounded-lg uppercase tracking-wider">
                                Câu hỏi {index + 1} ({q.type === 'trac_nghiem' ? 'Trắc nghiệm' : q.type === 'trac_nghiem_dung_sai' ? 'Đúng/Sai' : q.type === 'trac_nghiem_tra_loi_ngan' ? 'Trả lời ngắn' : 'Tự luận'})
                              </span>
                            </div>
                            <div className="space-y-3">
                              <div>
                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">📝 Nội dung câu hỏi:</span>
                                <div 
                                  className="text-xs md:text-sm text-slate-800 leading-relaxed font-normal whitespace-pre-wrap select-all bg-slate-50/50 p-2.5 rounded-lg border border-slate-100"
                                  dangerouslySetInnerHTML={{ __html: renderContentWithMath(q.questionText) }}
                                />
                              </div>
                              {q.answerText && (
                                <div className="pt-2 border-t border-slate-100">
                                  <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider block mb-1">🔑 Đáp án / Lời giải:</span>
                                  <div 
                                    className="text-xs text-slate-750 leading-relaxed font-normal whitespace-pre-wrap select-all bg-indigo-50/20 p-2.5 rounded-lg border border-indigo-50/50"
                                    dangerouslySetInnerHTML={{ __html: renderContentWithMath(q.answerText) }}
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="flex justify-between gap-3 mt-2">
                        <button
                          onClick={() => setSmartPasteStep(1)}
                          className="px-4 py-2 text-slate-700 font-bold bg-slate-100 hover:bg-slate-200 border border-slate-250 rounded-lg text-sm transition-colors cursor-pointer"
                        >
                          ← Quay lại chỉnh sửa
                        </button>
                        <div className="flex gap-3">
                          <button
                            onClick={closeSmartPasteModal}
                            className="px-4 py-2 text-slate-600 font-semibold bg-slate-50 hover:bg-slate-100 rounded-lg text-sm transition-colors cursor-pointer"
                          >
                            Hủy bỏ
                          </button>
                          <button
                            onClick={handleSmartPasteProcess}
                            className="px-5 py-2 text-white font-bold bg-emerald-600 hover:bg-emerald-700 rounded-lg text-sm shadow-md transition-colors cursor-pointer"
                          >
                            Xác nhận nạp vào đề
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Feedback Modal Popup */}
        <AnimatePresence>
          {isFeedbackOpen && (
            <div
              className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto"
              id="feedback-rating-overlay"
            >
              <motion.div
                initial={{ scale: 0.95, opacity: 0, y: 15 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.95, opacity: 0, y: 15 }}
                className="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-lg w-full overflow-hidden flex flex-col my-8 max-h-[90vh]"
              >
                {/* Header */}
                <div className="bg-gradient-to-r from-blue-600 to-indigo-700 px-6 py-4 text-white flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <div>
                      <h3 className="font-bold text-sm md:text-base">
                        Gửi Phản Hồi & Ý Kiến Đóng Góp
                      </h3>
                      <p className="text-[10px] text-blue-100 font-medium">
                        Bảo mật & Giúp cải tiến sản phẩm tốt hơn
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsFeedbackOpen(false)}
                    className="p-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-colors cursor-pointer text-xs font-bold font-mono"
                  >
                    ✕
                  </button>
                </div>

                {/* Form container */}
                <form onSubmit={handleSubmitFeedback} className="p-6 space-y-5 overflow-y-auto max-h-[calc(90vh-80px)] flex-1">
                  {/* Email */}
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wide block">
                      Người gửi
                    </label>
                    <p className="text-sm font-semibold text-slate-850 bg-slate-50 p-2.5 rounded-xl border border-slate-200/60 flex items-center gap-2">
                      <span>{user?.email}</span>
                    </p>
                  </div>

                  {/* Rating selection (Interactive stars) */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wide block">
                      Đánh giá hệ thống
                    </label>
                    <div className="flex items-center gap-1">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <button
                          type="button"
                          key={star}
                          onClick={() => setFeedbackRating(star)}
                          className={`p-1 text-2xl hover:scale-110 transition-transform cursor-pointer ${
                            star <= feedbackRating
                              ? "text-amber-500"
                              : "text-slate-300"
                          }`}
                        >
                          ★
                        </button>
                      ))}
                      <span className="text-xs font-extrabold text-amber-600 bg-amber-50 px-2.5 py-1 rounded-full border border-amber-200/50 block ml-2">
                        {feedbackRating === 5
                          ? "Tuyệt vời, 5 sao"
                          : feedbackRating === 4
                            ? "Tốt, 4 sao"
                            : feedbackRating === 3
                              ? "Bình thường, 3 sao"
                              : feedbackRating === 2
                                ? "Kém, 2 sao"
                                : "Rất tệ, 1 sao"}
                      </span>
                    </div>
                  </div>

                  {/* Feedback Type Tabs */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wide block">
                      Phân loại ý kiến
                    </label>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {(["suggestion", "bug", "request", "other"] as const).map(
                        (type) => (
                          <button
                            type="button"
                            key={type}
                            onClick={() => setFeedbackType(type)}
                            className={`py-2 px-1 text-[11px] font-bold rounded-xl border text-center transition-all cursor-pointer ${
                              feedbackType === type
                                ? "bg-blue-50 border-blue-600 text-blue-700 shadow-xs"
                                : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                            }`}
                          >
                            {type === "suggestion" && "Đóng góp"}
                            {type === "bug" && "Báo lỗi"}
                            {type === "request" && "Yêu cầu"}
                            {type === "other" && "Khác"}
                          </button>
                        ),
                      )}
                    </div>
                  </div>

                  {/* Feedback Textarea Input */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wide block">
                      Nội dung góp ý
                    </label>
                    <textarea
                      value={feedbackText}
                      onChange={(e) => setFeedbackText(e.target.value)}
                      rows={4}
                      className="w-full p-4 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none focus:border-blue-600 text-sm placeholder:text-slate-400 text-slate-700 leading-relaxed font-normal bg-linear-to-b from-slate-50/40 to-white"
                      placeholder="Hãy ghi chi tiết trải nghiệm của bạn, các tính năng mong muốn, góp ý giao diện hoặc mô tả lỗi nếu có..."
                    />
                  </div>

                  {/* Image Attachment (Góp ý bằng hình) */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wide block">
                      Đính kèm hình ảnh minh họa (nếu có)
                    </label>
                    
                    {!feedbackImage ? (
                      <div className="relative group border-2 border-dashed border-slate-200 hover:border-blue-400 rounded-xl p-4 transition-all bg-slate-50/50 hover:bg-blue-50/10 flex flex-col items-center justify-center cursor-pointer min-h-[90px]">
                        <input
                          type="file"
                          accept="image/*"
                          className="absolute inset-0 opacity-0 cursor-pointer"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              if (file.size > 2 * 1024 * 1024) {
                                triggerToast("Kích thước ảnh tối đa 2MB", false);
                                return;
                              }
                              const reader = new FileReader();
                              reader.onload = (event) => {
                                if (event.target?.result) {
                                  setFeedbackImage(event.target.result as string);
                                }
                              };
                              reader.readAsDataURL(file);
                            }
                          }}
                        />
                        <Image className="w-6 h-6 text-slate-400 group-hover:text-blue-500 mb-1 transition-colors" />
                        <span className="text-xs font-semibold text-slate-600 group-hover:text-blue-600 transition-colors">
                          Kéo thả hoặc nhấp để chọn ảnh
                        </span>
                        <span className="text-[10px] text-slate-400">
                          Hỗ trợ PNG, JPG, JPEG (tối đa 2MB)
                        </span>
                      </div>
                    ) : (
                      <div className="relative rounded-xl border border-slate-200 overflow-hidden bg-slate-50 flex items-center justify-between p-3">
                        <div className="flex items-center gap-3">
                          <img
                            src={feedbackImage}
                            alt="Ảnh đính kèm"
                            className="w-14 h-14 object-cover rounded-lg border border-slate-150"
                          />
                          <div>
                            <span className="text-xs font-bold text-slate-700 block">
                              Hình ảnh đã chọn
                            </span>
                            <span className="text-[10px] text-emerald-600 font-semibold flex items-center gap-1">
                              <Check className="w-3 h-3" /> Đã đính kèm thành công
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setFeedbackImage("")}
                          className="p-2 text-rose-500 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                          title="Gỡ ảnh này"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Submit button */}
                  <div className="pt-2 flex justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => setIsFeedbackOpen(false)}
                      className="px-5 py-2.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-600 text-xs font-bold transition-all cursor-pointer"
                    >
                      Hủy bỏ
                    </button>
                    <button
                      type="submit"
                      disabled={isSubmittingFeedback || !feedbackText.trim()}
                      className="px-6 py-2.5 bg-slate-700 hover:bg-slate-800 disabled:bg-slate-300 disabled:opacity-60 text-white rounded-xl text-xs font-extrabold shadow-md shadow-slate-700/10 hover:shadow-lg hover:shadow-slate-700/15 transition-all flex items-center gap-1.5 cursor-pointer"
                    >
                      {isSubmittingFeedback ? (
                        <>
                          <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin shrink-0"></span>
                          Đang gửi...
                        </>
                      ) : (
                        <>
                          <span>Gửi ý kiến đóng góp</span>
                        </>
                      )}
                    </button>
                  </div>
                </form>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Notifications Modal Popup */}
        <AnimatePresence>
          {isNotificationsOpen && (
            <div
              className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 overflow-y-auto"
              id="notifications-list-overlay"
            >
              <motion.div
                initial={{ scale: 0.95, opacity: 0, y: 15 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.95, opacity: 0, y: 15 }}
                className="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-xl w-full overflow-hidden flex flex-col my-8"
              >
                {/* Header */}
                <div className="bg-gradient-to-r from-violet-100 via-sky-50 to-indigo-100 px-6 py-4 border-b border-indigo-200/50 text-slate-850 flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <div>
                      <h3 className="font-extrabold text-sm md:text-base text-slate-800">
                        Thông Báo Hệ Thống & Phản Hồi
                      </h3>
                      <p className="text-[10px] text-indigo-950/60 font-bold">
                        Cập nhật mới từ Nhà phát triển & Ban Quản trị
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsNotificationsOpen(false)}
                    className="p-1.5 bg-slate-200/50 hover:bg-slate-300/60 rounded-lg text-slate-700 transition-colors cursor-pointer text-xs font-bold font-mono"
                  >
                    ✕
                  </button>
                </div>

                {unreadCount > 0 && (
                  <div className="bg-amber-50 border-b border-amber-200/60 px-6 py-2 flex justify-between items-center text-xs">
                    <span className="text-amber-800 font-semibold flex items-center gap-1">
                      Bạn có {unreadCount} thông báo chưa đọc
                    </span>
                    <button
                      type="button"
                      onClick={markAllNotificationsAsRead}
                      className="text-amber-800 hover:text-amber-950 font-extrabold underline cursor-pointer"
                    >
                      Đã đọc tất cả
                    </button>
                  </div>
                )}

                <div className="p-6 overflow-y-auto max-h-[450px] space-y-4">
                  {visibleNotifications.length === 0 ? (
                    <div className="py-12 text-center text-slate-400 italic text-xs">
                      Hộp thư trống. Không có thông báo hoặc phản hồi nào dành
                      cho bạn.
                    </div>
                  ) : (
                    visibleNotifications.map((notif) => (
                      <div
                        key={notif.id}
                        className="bg-slate-50 hover:bg-slate-100/60 border border-slate-200/60 rounded-xl p-4 flex flex-col justify-between transition-all"
                      >
                        <div>
                          <div className="flex justify-between items-start gap-1.5">
                            <div>
                              <h4 className="font-bold text-slate-850 text-xs md:text-sm flex items-center gap-1.5">
                                <span
                                  className={`h-2.5 w-2.5 rounded-full shrink-0 ${!readNotificationIds.includes(notif.id) ? "bg-rose-500 animate-pulse" : "bg-slate-300"}`}
                                />
                                {notif.title}
                              </h4>
                              <span className="text-[10px] text-slate-400 font-semibold block mt-1">
                                Người gửi: {notif.senderName || "Admin"} •{" "}
                                {notif.createdAt
                                  ? new Date(notif.createdAt).toLocaleString(
                                      "vi-VN",
                                      {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                        day: "2-digit",
                                        month: "2-digit",
                                      },
                                    )
                                  : "Mới đây"}
                              </span>
                            </div>
                            <div className="shrink-0 flex flex-col items-end gap-1.5">
                              <span
                                className={`inline-flex px-2 py-0.5 rounded-full text-[9px] font-extrabold border ${
                                  notif.type === "system"
                                    ? "bg-emerald-50 text-emerald-700 border-emerald-200/60"
                                    : notif.type === "user"
                                      ? "bg-amber-50 text-amber-700 border-amber-250/50"
                                      : "bg-indigo-50 text-indigo-750 border-indigo-200/50"
                                }`}
                              >
                                {notif.type === "system"
                                  ? "Toàn hệ thống"
                                  : notif.type === "user"
                                    ? "Cá nhân"
                                    : "Trả lời góp ý"}
                              </span>
                            </div>
                          </div>

                          <p className="text-xs text-slate-700 bg-white p-3 rounded-xl border border-slate-200/55 leading-relaxed font-normal whitespace-pre-wrap mt-3 shadow-2xs">
                            {notif.content}
                          </p>
                        </div>

                        {/* User Action Footer */}
                        <div className="mt-3 pt-2.5 border-t border-slate-250/40 flex items-center justify-between text-[11px]">
                          <div className="flex items-center gap-2">
                            {!readNotificationIds.includes(notif.id) && (
                              <span className="px-1.5 py-0.5 bg-rose-50 border border-rose-200 text-rose-700 text-[8px] font-black rounded tracking-wide shrink-0">
                                MỚI
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                if (readNotificationIds.includes(notif.id)) {
                                  setReadNotificationIds((prev) =>
                                    prev.filter((id) => id !== notif.id),
                                  );
                                } else {
                                  markNotificationAsRead(notif.id);
                                }
                              }}
                              className="text-indigo-600 hover:text-indigo-800 font-bold cursor-pointer"
                            >
                              {readNotificationIds.includes(notif.id)
                                ? "Đánh dấu chưa đọc"
                                : "Đánh dấu đã đọc"}
                            </button>
                          </div>

                          <button
                            type="button"
                            onClick={() => archiveNotification(notif.id)}
                            className="text-slate-400 hover:text-rose-600 font-bold cursor-pointer transition-colors"
                            title="Ẩn thông báo khỏi hộp thư cá nhân của bạn"
                          >
                            Ẩn thông báo ✕
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div className="bg-slate-50/85 px-6 py-4 border-t border-slate-100 flex justify-end">
                  <button
                    type="button"
                    onClick={() => setIsNotificationsOpen(false)}
                    className="px-5 py-2 rounded-xl bg-slate-800 text-white hover:bg-slate-750 text-xs font-bold transition-all cursor-pointer shadow-xs active:scale-95"
                  >
                    Đóng lại
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Image Preview Lightbox Overlay */}
        <AnimatePresence>
          {previewImageSrc && (
            <div
              className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-4 z-50 select-none cursor-zoom-out"
              onClick={() => setPreviewImageSrc(null)}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="relative max-w-4xl max-h-[85vh] overflow-hidden rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={() => setPreviewImageSrc(null)}
                  className="absolute top-4 right-4 z-50 p-2 bg-slate-950/80 hover:bg-slate-900 text-white rounded-full transition-colors cursor-pointer border border-slate-800 font-bold text-sm w-9 h-9 flex items-center justify-center"
                  title="Đóng xem ảnh"
                >
                  ✕
                </button>
                <img
                  src={previewImageSrc}
                  alt="Xem thử hình ảnh"
                  className="max-w-full max-h-[85vh] object-contain select-text"
                />
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>

      {/* Footer */}
      <footer className="w-full text-center py-4 bg-white/50 border-t border-slate-200/60 mt-auto select-none px-4">
        <div className="max-w-[1600px] mx-auto space-y-1">
          <p className="text-xs text-slate-500 font-medium">
            Bản quyền thuộc về{" "}
            <strong className="text-slate-800 font-semibold">
              Trần Gia Thiều - Giathieu110406@gmail.com
            </strong>{" "}
            · Phiên bản v3.6
          </p>
          <p className="text-[11px] text-slate-400 font-medium">
            © Q-Builder · Số hóa công thức LaTeX · Tự động hóa xây dựng đề thi ·
            Chính xác & Tốc độ.
          </p>
        </div>
      </footer>
    </div>
  );
}
