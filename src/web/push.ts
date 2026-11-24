/**
 * Web Push 客户端：申请通知权限、向浏览器推送服务订阅、把订阅交给我们的服务端
 *
 * iPhone / iPad 只有「添加到主屏幕」后从主屏图标打开，Safari 才提供推送（iOS 16.4+）。
 */
import { http } from './api';

export type PushState = 'unsupported' | 'ios-needs-install' | 'denied' | 'off' | 'on';

const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg || navigator.serviceWorker.register('/sw.js');
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return isIOS() && !isStandalone() ? 'ios-needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

async function subscribe(token: string, reg: ServiceWorkerRegistration): Promise<void> {
  const { publicKey } = await http.pushKey();
  const key = b64urlToBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  // 服务端换过 VAPID 密钥的话，旧订阅收不到，得重新订阅
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
  await http.pushSubscribe(token, sub.toJSON());
}

/** 必须在用户点击里调用：iOS 和 Safari 不允许在没有用户手势时申请通知权限 */
/** 用户主动点过「关闭」就记下来：之后即使浏览器权限是允许，也不自动重新订阅 */
const OPT_OUT_KEY = 'cipherim.pushOptOut';
const optedOut = () => {
  try {
    return localStorage.getItem(OPT_OUT_KEY) === '1';
  } catch {
    return false;
  }
};
const setOptOut = (v: boolean) => {
  try {
    if (v) localStorage.setItem(OPT_OUT_KEY, '1');
    else localStorage.removeItem(OPT_OUT_KEY);
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
};

export async function enablePush(token: string): Promise<PushState> {
  setOptOut(false);
  const st = await pushState();
  if (st === 'unsupported' || st === 'ios-needs-install') return st;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  await subscribe(token, await registration());
  return 'on';
}

export async function disablePush(token: string): Promise<PushState> {
  setOptOut(true);
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await http.pushUnsubscribe(token, sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  return pushState();
}

/**
 * 每次进入主界面、以及浏览器通知权限变化时悄悄同步一次：
 *  - 浏览器可能换了订阅，或者这台设备换了账号
 *  - 用户可能是在浏览器设置里手动把通知改成了「允许」（比如 Edge 默认静默拦截权限请求），
 *    这时网页没机会走「开启」按钮，要在这里补上订阅
 * 用户自己点过「关闭」的不自动开。返回同步后的状态。
 */
export async function syncPush(token: string): Promise<PushState> {
  try {
    const st = await pushState();
    if (st !== 'on' && st !== 'off') return st;
    if (Notification.permission !== 'granted' || optedOut()) return st;
    await subscribe(token, await registration());
    return 'on';
  } catch {
    /* 同步失败不影响聊天，下次打开再试 */
    return pushState().catch(() => 'unsupported' as const);
  }
}

/** 浏览器通知权限变化时回调（在浏览器设置里改了权限，页面不刷新也能知道） */
export function onPermissionChange(cb: () => void): () => void {
  let status: PermissionStatus | null = null;
  let stopped = false;
  navigator.permissions
    ?.query({ name: 'notifications' })
    .then((s) => {
      if (stopped) return;
      status = s;
      s.onchange = cb;
    })
    .catch(() => {});
  return () => {
    stopped = true;
    if (status) status.onchange = null;
  };
}
