import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Suppress KaTeX missing character metrics warnings (especially for Vietnamese text in math mode)
const originalWarn = console.warn;
console.warn = (...args) => {
  if (
    typeof args[0] === "string" &&
    args[0].includes("No character metrics for") &&
    args[0].includes("KaTeX") || args[0].includes("style 'Main-Regular'")
  ) {
    return;
  }
  originalWarn(...args);
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
