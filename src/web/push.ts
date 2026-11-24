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
export async function enablePush(token: string): Promise<PushState> {
  const st = await pushState();
  if (st === 'unsupported' || st === 'ios-needs-install') return st;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  await subscribe(token, await registration());
  return 'on';
}

export async function disablePush(token: string): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await http.pushUnsubscribe(token, sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  return pushState();
}

/** 每次进入主界面时悄悄同步一次：浏览器可能换了订阅，或者这台设备换了账号 */
export async function syncPush(token: string): Promise<void> {
  try {
    if ((await pushState()) !== 'on') return;
    await subscribe(token, await registration());
  } catch {
    /* 同步失败不影响聊天，下次打开再试 */
  }
}
