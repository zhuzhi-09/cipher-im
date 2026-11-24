/** 与服务端的连接封装：HTTP 用 fetch，实时用 WebSocket，断线自动重连 */
import type { C2S, S2C } from '../shared/protocol';

export type ConnStatus = 'connecting' | 'online' | 'offline';

export class Link {
  ws: WebSocket | null = null;
  status: ConnStatus = 'offline';
  private handlers = new Set<(m: S2C) => void>();
  private statusHandlers = new Set<(s: ConnStatus) => void>();
  private queue: string[] = [];
  private retry = 0;
  private closedByUs = false;
  private timer: number | null = null;

  private lastPresence: boolean | null = null;
  private onPresence = () => this.sendPresence();

  constructor(
    public token: string,
    public deviceId: string,
  ) {
    // 前台/后台切换时告诉服务端：不在前台时它才会走 Web Push 提醒
    document.addEventListener('visibilitychange', this.onPresence);
    window.addEventListener('focus', this.onPresence);
    window.addEventListener('blur', this.onPresence);
    window.addEventListener('pagehide', this.onPresence);
  }

  private sendPresence(force = false) {
    const visible = document.visibilityState === 'visible' && document.hasFocus();
    if (!force && visible === this.lastPresence) return;
    if (this.rawSend({ t: 'presence', visible })) this.lastPresence = visible;
  }

  private setStatus(s: ConnStatus) {
    this.status = s;
    this.statusHandlers.forEach((f) => f(s));
  }

  connect() {
    this.closedByUs = false;
    this.setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // 令牌不再放 URL：反代的 access log 会把查询串原样记下来
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('online');
      // 首帧必须是 auth，之后服务端才认这个连接
      this.rawSend({ t: 'auth', token: this.token } as any);
      this.rawSend({ t: 'hello', device: this.deviceId } as any);
      this.sendPresence(true); // 新连接在服务端默认算「不在前台」，马上报一次真实状态
      // 把离线期间排队的指令补发
      while (this.queue.length && ws.readyState === WebSocket.OPEN) {
        ws.send(this.queue.shift()!);
      }
    };

    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data) as S2C;
        if (m.t === 'error') {
          // 令牌失效之类的致命错误：交给上层处理，不再重连风暴
          if (m.message.includes('令牌') || m.message.includes('绑定设备')) {
            this.closedByUs = true;
          }
        }
        this.handlers.forEach((f) => f(m));
      } catch {
        /* 忽略坏包 */
      }
    };

    ws.onclose = () => {
      this.setStatus('offline');
      if (this.closedByUs) return;
      const delay = Math.min(1000 * 2 ** this.retry++, 8000);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  private rawSend(m: C2S | any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(m));
      return true;
    }
    return false;
  }

  send(m: C2S | any) {
    if (!this.rawSend(m)) {
      if (this.queue.length < 50) this.queue.push(JSON.stringify(m));
    }
  }

  onMessage(cb: (m: S2C) => void): () => void {
    this.handlers.add(cb);
    return () => this.handlers.delete(cb);
  }

  onStatus(cb: (s: ConnStatus) => void): () => void {
    this.statusHandlers.add(cb);
    return () => this.statusHandlers.delete(cb);
  }

  close() {
    document.removeEventListener('visibilitychange', this.onPresence);
    window.removeEventListener('focus', this.onPresence);
    window.removeEventListener('blur', this.onPresence);
    window.removeEventListener('pagehide', this.onPresence);
    this.closedByUs = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.setStatus('offline');
  }
}

/* ---------------- HTTP ---------------- */

async function getJson(path: string, token?: string) {
  const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `请求失败 (${res.status})`);
  return j;
}

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `请求失败 (${res.status})`);
  return j;
}

export const http = {
  register: (username: string, displayName: string, password: string, bundle: unknown, invite = '') =>
    post('/api/register', { username, displayName, password, bundle, invite }),
  login: (username: string, password: string) => post('/api/login', { username, password }),
  addDevice: (token: string, bundle: unknown) => post('/api/device', { bundle }, token),
  topUpOpks: (token: string, bundle: unknown) => post('/api/opk', { bundle }, token),
  health: () => fetch('/api/health').then((r) => r.json()),

  /* ---- Web Push ---- */
  pushKey: (): Promise<{ publicKey: string }> => getJson('/api/push/key'),
  pushSubscribe: (token: string, sub: PushSubscriptionJSON) => post('/api/push/subscribe', sub, token),
  pushUnsubscribe: (token: string, endpoint: string) => post('/api/push/unsubscribe', { endpoint }, token),

  /* ---- 跨设备漫游 ---- */
  roamInit: (token: string, pub: string, salt: string, sealed: string) =>
    post('/api/roam/init', { pub, salt, sealed }, token),
  roamKey: (token: string) => getJson('/api/roam/key', token),
  roamDevices: (token: string) => getJson('/api/roam/devices', token),
  roamRevoke: (token: string, device: string) => post('/api/roam/revoke', { device }, token),
  roamPub: (token: string, user: string) =>
    getJson(`/api/roam/pub?user=${encodeURIComponent(user)}`, token),

  async putBlob(token: string, data: Uint8Array, mime: string): Promise<{ id: string; size: number }> {
    const res = await fetch('/api/blob', {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'x-file-mime': mime },
      body: data as unknown as BodyInit,
    });
    const j: any = await res.json();
    if (!res.ok) throw new Error(j.error || '上传失败');
    return j;
  },

  async getBlob(token: string, id: string): Promise<ArrayBuffer> {
    const res = await fetch(`/api/blob/${id}?token=${encodeURIComponent(token)}`);
    if (!res.ok) throw new Error('文件下载失败');
    return res.arrayBuffer();
  },
};
