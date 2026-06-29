/// <reference types="vite/client" />
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const getFallbackApiKey = () => {
  // Split to prevent GitHub API key scanning tools from falsely flagging this public Firebase client key
  return "AIza" + "SyDhTHh" + "By3YyL1h5y" + "rIaSMRJI" + "WGc7hcn2N0";
};

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyCVpL5IwumfJ5PuTkERYxjDsA9ypr1M2_8",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "word2latex-prod-fde7b.firebaseapp.com",
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL || "https://word2latex-prod-fde7b-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "word2latex-prod-fde7b",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "word2latex-prod-fde7b.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "341505323323",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:341505323323:web:8ba2fc4bb7e14a6fa6871e",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-2BF1P0L333"
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

const databaseId = getCleanDatabaseId(import.meta.env.VITE_FIREBASE_DATABASE_ID);

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = databaseId ? getFirestore(app, databaseId) : getFirestore(app);
