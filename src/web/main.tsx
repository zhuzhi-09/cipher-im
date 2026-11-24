import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);

// PWA：在线时缓存外壳，断网也能打开界面（消息仍需要网络）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
