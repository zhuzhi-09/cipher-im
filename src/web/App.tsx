/**
 * Web 客户端主界面
 * 三种形态共用这一份代码：浏览器直接访问 / Tauri 外壳 / Capacitor 外壳
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, http, ConnStatus } from './api';
import { LocalStore, VaultState, LocalMsg, generateDeviceId, bundleForRegistration } from './store';
import { publicBundleOf } from '../shared/crypto/identity';
import { safetyNumber, formatSafetyNumber, shortFingerprint } from '../shared/crypto/fingerprint';
import { aeadSeal, aeadOpen, randomBytes, toB64, fromB64, utf8, fromUtf8 } from '../shared/crypto/primitives';
import type { PublicBundle } from '../shared/crypto/identity';
import type { ConvSummary, HistBody, Payload, S2C, WireBody, WireMessage } from '../shared/protocol';
import { createRoamKeys, sealForRoam, openRoam, wrapRoamPriv, unwrapRoamPriv } from '../shared/crypto/roam';
import { trustState as evaluateTrust, markVerified } from '../shared/crypto/trust';
import {
  IconBrand,
  IconFile,
  IconClose,
  IconGear,
  IconLock,
  IconMenu,
  IconMonitor,
  IconMoon,
  IconPaperclip,
  IconSun,
  IconUsers,
} from './icons';
import { applyTheme, getThemePref, onSystemThemeChange, setThemePref, ThemePref } from './theme';
import { disablePush, enablePush, pushState, PushState, syncPush } from './push';
import { LICENSE_NAME, SOURCE_URL } from './about';

interface ChatMsg extends LocalMsg {
  conv: number;
  sending?: boolean;
  failed?: string;
}

const fmtTime = (t: number) =>
  new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (t: number) => {
  const d = new Date(t);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? '今天' : `${d.getMonth() + 1}月${d.getDate()}日`;
};

export function App() {
  const [phase, setPhase] = useState<'boot' | 'auth' | 'unlock' | 'main'>('boot');
  const [metaName, setMetaName] = useState('');
  const [vault, setVault] = useState<VaultState | null>(null);
  const [link, setLink] = useState<Link | null>(null);
  const [status, setStatus] = useState<ConnStatus>('offline');
  const [convs, setConvs] = useState<ConvSummary[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [msgs, setMsgs] = useState<Record<number, ChatMsg[]>>({});
  const [receipts, setReceipts] = useState<Record<number, Record<string, number>>>({});
  const [typing, setTyping] = useState<Record<number, { user: string; at: number }>>({});
  const typingTimers = useRef<Record<number, number>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [modal, setModal] = useState<null | 'newChat' | 'newGroup' | 'safety' | 'settings'>(null);
  const [draft, setDraft] = useState('');
  const [showSidebar, setShowSidebar] = useState(true);
  const [trustTick, setTrustTick] = useState(0);
  const [themePref, setPref] = useState<ThemePref>(getThemePref);
  const [mode, setMode] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  );

  // 主题：偏好（system/light/dark）→ 解析成 data-theme；跟随系统时监听系统变化
  useEffect(() => {
    setMode(applyTheme(themePref));
    return onSystemThemeChange(() => {
      if (themePref === 'system') setMode(applyTheme('system'));
    });
  }, [themePref]);

  const changeTheme = (p: ThemePref) => {
    setThemePref(p);
    setPref(p);
  };
  const cycleTheme = () => changeTheme(mode === 'dark' ? 'light' : 'dark');
  const themeTitle = `当前：${themePref === 'system' ? '跟随系统' : themePref === 'dark' ? '深色' : '浅色'} · 点击切换`;

  // 输入框随内容长高：高度先归零再取 scrollHeight，CSS 的 max-height 负责封顶
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const autoGrow = () => {
    const el = taRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    // scrollHeight 不含边框，但 height 是 border-box，补上上下边框才不会多出 2px 滚动条
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + border}px`;
    // toast 需要知道输入区现在多高，才能始终浮在它上方
    const comp = composerRef.current;
    if (comp) {
      document.documentElement.style.setProperty('--composer-h', `${Math.round(comp.getBoundingClientRect().height)}px`);
    }
  };

  useEffect(() => {
    autoGrow();
  }, [draft]);

  useEffect(() => {
    autoGrow();
  }, [activeId]);

  useEffect(() => {
    window.addEventListener('resize', autoGrow);
    return () => window.removeEventListener('resize', autoGrow);
  }, []);


  const store = useRef(new LocalStore());
  const bundles = useRef(new Map<string, PublicBundle>());
  const bundleWaiters = useRef(new Map<string, (b: Map<string, PublicBundle>) => void>());
  const pendingSends = useRef(new Map<string, { conv: number; tempId: number; payload: Payload }>());
  const saveTimer = useRef<number | null>(null);
  const activeIdRef = useRef<number | null>(null);
  activeIdRef.current = activeId;

  const vaultRef = useRef<VaultState | null>(null);
  vaultRef.current = vault;

  const msgsRef = useRef<Record<number, ChatMsg[]>>({});
  msgsRef.current = msgs;
  const roamPubs = useRef(new Map<string, string>()); // user -> 漫游公钥
  const roamPaging = useRef(new Map<number, { round: number; limit: number; max: number }>());

  /* ---------------- 启动 ---------------- */

  useEffect(() => {
    (async () => {
      const rec = await store.current.load();
      if (rec) {
        setMetaName(rec.displayName || rec.username);
        setPhase('unlock');
      } else {
        setPhase('auth');
      }
    })();
  }, []);

  /** 立即落盘。加密只是几 KB 的 AES，代价可忽略；宁可多写也不能丢会话状态 */
  const persistNow = async () => {
    const v = vaultRef.current;
    if (!v || !store.current.kek) return;
    try {
      await store.current.persist(v);
    } catch {
      /* 磁盘满等极端情况不阻塞界面 */
    }
  };

  const schedulePersist = () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void persistNow();
    }, 60);
  };

  // 页面隐藏 / 刷新 / 关闭前强制写一次，避免丢失最后的状态
  useEffect(() => {
    const flush = () => {
      const v = vaultRef.current;
      if (v && store.current.kek) void store.current.persist(v).catch(() => {});
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  const flash = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(null), 3000);
  };

  /* ---------------- 连接与事件 ---------------- */

  const attachLink = (v: VaultState) => {
    const l = new Link(v.token, v.deviceId);
    l.onStatus(setStatus);
    l.onMessage((m) => handleEvent(m, l));
    l.connect();
    setLink(l);
    void syncPush(v.token);
    return l;
  };

  const handleEvent = async (m: S2C, l: Link) => {
    const v = vaultRef.current;
    if (!v) return;

    switch (m.t) {
      case 'ready':
        setConvs(m.convs);
        {
          const active = activeIdRef.current;
          if (active) loadHistory(active);
        }
        break;

      case 'convs':
        setConvs(m.convs);
        break;

      case 'msg': {
        await ingestWireMessage(m.msg, false);
        setConvs((cs) => cs.map((c) => (c.id === m.msg.conv && c.id !== activeIdRef.current ? { ...c, unread: c.unread + 1 } : c)));
        if (m.msg.conv === activeIdRef.current) {
          markRead(m.msg.conv, m.msg.id);
        }
        break;
      }

      case 'sent': {
        // 用 clientId 精确定位自己的那条乐观消息（并发发送时也不会错位）
        const pending = m.clientId ? pendingSends.current.get(m.clientId) : undefined;
        if (pending) {
          pendingSends.current.delete(m.clientId!);
          const final: ChatMsg = {
            id: m.id,
            conv: m.conv,
            from: { user: v.username, device: v.deviceId },
            createdAt: m.createdAt,
            payload: pending.payload,
            mine: true,
          };
          setMsgs((prev) => {
            const list = (prev[m.conv] || []).map((x) => (x.id === pending.tempId ? final : x));
            return { ...prev, [m.conv]: list };
          });
          appendLocal(final);
          await persistNow();
        }
        break;
      }

      case 'history': {
        const decrypted: ChatMsg[] = [];
        for (const wm of m.msgs) {
          const cm = await decryptWire(wm);
          if (cm) decrypted.push(cm);
        }
        setMsgs((prev) => {
          const existing = prev[m.conv] || [];
          const byId = new Map<number, ChatMsg>();
          for (const x of existing) byId.set(x.id, x);
          for (const x of decrypted) byId.set(x.id, x);
          const merged = [...byId.values()].sort((a, b) => a.id - b.id);
          return { ...prev, [m.conv]: merged };
        });
        schedulePersist();
        break;
      }

      case 'roamHistory': {
        const rk = v.roam;
        if (!rk) break;
        const decrypted: ChatMsg[] = [];
        for (const it of m.msgs) {
          try {
            const pt = JSON.parse(fromUtf8(await openRoam(fromB64(rk.priv), it.eph, it.ct))) as Payload;
            decrypted.push({
              id: it.id,
              conv: it.conv,
              from: it.from,
              createdAt: it.createdAt,
              payload: pt,
              mine: it.from.user === v.username,
              otherDevice: it.from.user === v.username && it.from.device !== v.deviceId,
            });
          } catch {
            /* 这条副本解不开（比如不是发给本账号的），跳过 */
          }
        }
        if (decrypted.length) {
          for (const cm of decrypted) appendLocal(cm);
          setMsgs((prev) => {
            const byId = new Map<number, ChatMsg>();
            for (const x of prev[m.conv] || []) byId.set(x.id, x);
            for (const x of decrypted) byId.set(x.id, x);
            const merged = [...byId.values()].sort((a, b) => a.id - b.id);
            return { ...prev, [m.conv]: merged };
          });
          await persistNow();
        }
        // 还差更早的？继续往前翻（有轮数上限，避免无限拉）
        const page = roamPaging.current.get(m.conv);
        if (page && page.round + 1 < page.max && m.msgs.length >= page.limit) {
          page.round += 1;
          const minId = Math.min(...m.msgs.map((x) => x.id));
          link?.send({ t: 'roamHistory', conv: m.conv, beforeId: minId, limit: page.limit });
        }
        break;
      }

      case 'bundles': {
        const map = new Map<string, PublicBundle>();
        for (const b of m.bundles) map.set(`${m.user}/${b.device}`, b.bundle);
        for (const [k, val] of map) bundles.current.set(k, val);
        refreshTrust();
        bundleWaiters.current.get(m.user)?.(map);
        bundleWaiters.current.delete(m.user);
        break;
      }

      case 'receipt': {
        setReceipts((prev) => {
          const conv = prev[m.conv] || {};
          return { ...prev, [m.conv]: { ...conv, [m.user]: Math.max(conv[m.user] || 0, m.upto) } };
        });
        break;
      }

      case 'typing':
        setTyping((prev) => ({ ...prev, [m.conv]: { user: m.user, at: Date.now() } }));
        // React 不会因为时间流逝自发重渲染，这里排一个定时器把状态真正清掉，
        // 否则“正在输入…”会一直挂到下一次任何状态变化为止
        {
          const convId = m.conv;
          if (typingTimers.current[convId]) clearTimeout(typingTimers.current[convId]);
          typingTimers.current[convId] = window.setTimeout(() => {
            setTyping((prev) => {
              const cur = prev[convId];
              if (!cur || Date.now() - cur.at < 4000) return prev;
              const next = { ...prev };
              delete next[convId];
              return next;
            });
          }, 4200);
        }
        break;

      case 'memberChange': {
        // 群成员变动：轮换自己的群密钥并重新分发（退群者从此解不开新消息）
        l.send({ t: 'convs' });
        const conv = convs.find((c) => c.id === m.conv);
        if (conv && conv.kind === 'group') {
          v.client.rotateOwnSenderKey(String(m.conv));
          distributeOwnKey(String(m.conv)).catch(() => {});
        }
        break;
      }

      case 'error':
        flash(m.message);
        break;
    }
  };

  const hydrateFromLog = (v: VaultState) => {
    const map: Record<number, ChatMsg[]> = {};
    for (const [k, list] of Object.entries(v.log || {})) {
      map[Number(k)] = (list as LocalMsg[]).map((x) => ({ ...x, conv: Number(k) }));
    }
    setMsgs(map);
  };

  /** 把已解密的消息写进本地明文日志（随密钥库一起被口令加密落盘） */
  const appendLocal = (cm: ChatMsg) => {
    const v = vaultRef.current;
    if (!v || !cm.payload) return;
    const key = String(cm.conv);
    const list = v.log[key] || [];
    if (list.some((x) => x.id === cm.id)) return;
    v.log[key] = [...list, { id: cm.id, from: cm.from, createdAt: cm.createdAt, payload: cm.payload, mine: cm.mine }].slice(-300);
  };

  const decryptWire = async (wm: WireMessage): Promise<ChatMsg | null> => {
    const v = vaultRef.current;
    if (!v) return null;
    const base = {
      id: wm.id,
      conv: wm.conv,
      from: wm.from,
      createdAt: wm.createdAt,
      mine: wm.from.user === v.username && wm.from.device === v.deviceId,
    };
    try {
      const body = wm.body as WireBody;
      const payload = body.kind === 'group' ? await v.client.decryptGroup(body) : (await v.client.decryptFrom(wm.from.user, wm.from.device, body)).payload;
      if (payload.t === 'skdm') return null; // 群密钥分发不显示
      return { ...base, payload };
    } catch (e) {
      return { ...base, payload: { t: 'system', text: `无法解密：${(e as Error).message}` } };
    }
  };

  const ingestWireMessage = async (wm: WireMessage, fromHistory: boolean) => {
    const cm = await decryptWire(wm);
    if (!cm) return;
    setMsgs((prev) => {
      const list = prev[wm.conv] || [];
      if (list.some((x) => x.id === cm.id)) return prev;
      return { ...prev, [wm.conv]: [...list, cm].sort((a, b) => a.id - b.id) };
    });
    appendLocal(cm);
    await persistNow();
  };

  const ensureBundles = (user: string): Promise<Map<string, PublicBundle>> => {
    return new Promise((resolve) => {
      if (!link) return resolve(new Map());
      bundleWaiters.current.set(user, resolve);
      link.send({ t: 'bundle', user });
      window.setTimeout(() => {
        if (bundleWaiters.current.has(user)) {
          bundleWaiters.current.delete(user);
          resolve(bundles.current);
        }
      }, 4000);
    });
  };

  /** 信任状态机：已核对过的安全码一旦和当前公钥算出的不一致，就置为「已变更」并告警 */
  const refreshTrust = () => {
    const v = vaultRef.current;
    if (!v) return;
    let dirty = false;
    for (const [key, entry] of Object.entries(v.trust || {})) {
      const b = bundles.current.get(key);
      if (!b) continue;
      const sn = safetyNumber(v.keys.identity.ikSigPub, fromB64(b.ikSigPub));
      if (entry.safety !== sn && entry.state === 'verified') {
        v.trust[key] = { ...entry, state: 'changed' };
        dirty = true;
      }
    }
    if (dirty) void persistNow();
    setTrustTick((t) => t + 1);
  };

  const loadHistory = (convId: number) => {
    if (!link) return;
    link.send({ t: 'history', conv: convId, limit: 80 });
  };

  const markRead = (convId: number, upto: number) => {
    const v = vaultRef.current;
    if (!v || !link) return;
    const cur = v.reads[String(convId)] || 0;
    if (upto <= cur) return;
    v.reads[String(convId)] = upto;
    link.send({ t: 'receipt', conv: convId, upto });
    setConvs((cs) => cs.map((c) => (c.id === convId ? { ...c, unread: 0 } : c)));
    schedulePersist();
  };

  /* ---------------- 登录 / 注册 ---------------- */

  const doRegister = async (username: string, displayName: string, password: string, invite: string) => {
    const deviceId = generateDeviceId();
    // 先生成密钥再注册：服务端只收到公钥包
    const tmpStore = new LocalStore();
    const v = await tmpStore.create(password, username, displayName, deviceId, '');
    const bundle = bundleForRegistration(v.keys, deviceId);
    const res = await http.register(username, displayName, password, bundle, invite);
    v.token = res.token;
    // 账号级漫游密钥：本机生成，私钥用口令封起来上传（服务端没有口令解不开）
    const roam = createRoamKeys();
    const wrapped = await wrapRoamPriv(password, roam.priv);
    v.roam = { pub: toB64(roam.pub), priv: toB64(roam.priv) };
    await http.roamInit(v.token, v.roam.pub, wrapped.salt, wrapped.sealed).catch(() => {});
    store.current = tmpStore;
    await tmpStore.persist(v);
    setVault(v);
    hydrateFromLog(v);
    setPhase('main');
    attachLink(v);
  };

  const doLoginNewDevice = async (username: string, password: string) => {
    const login = await http.login(username, password);
    const deviceId = generateDeviceId();
    const tmpStore = new LocalStore();
    const v = await tmpStore.create(password, username, login.user?.displayName || username, deviceId, login.token);
    const bundle = bundleForRegistration(v.keys, deviceId);
    const dev = await http.addDevice(login.token, bundle);
    v.token = dev.token;
    // 新设备用账号口令解封漫游私钥：之后就能拉本账号 14 天内的历史副本
    try {
      const k = await http.roamKey(v.token);
      const priv = await unwrapRoamPriv(password, k.salt, k.sealed);
      v.roam = { pub: k.pub, priv: toB64(priv) };
    } catch {
      v.roam = null; // 账号还没启用漫游，或本机没有权限
    }
    store.current = tmpStore;
    await tmpStore.persist(v);
    setVault(v);
    hydrateFromLog(v);
    setPhase('main');
    attachLink(v);
  };

  const doUnlock = async (password: string) => {
    const v = await store.current.unlock(password);
    setVault(v);
    hydrateFromLog(v);
    setPhase('main');
    attachLink(v);
  };

  /* ---------------- 发消息 ---------------- */

  const activeConv = convs.find((c) => c.id === activeId) || null;
  const trustMap = vault?.trust || {};
  const trustAlerts = (activeConv?.members || [])
    .filter((m) => m.user !== (vault?.username ?? ''))
    .filter((m) =>
      Object.entries(trustMap).some(([k, e]) => k.startsWith(`${m.user}/`) && e.state === 'changed'),
    );
  void trustTick; // 依赖一下：信任状态变化时强制重渲染

  /* ---------------- 跨设备漫游 ---------------- */

  const ensureRoamPubs = async (users: string[]) => {
    const v = vaultRef.current;
    if (!v) return;
    if (v.roam?.pub) roamPubs.current.set(v.username, v.roam.pub);
    const missing = users.filter((u) => !roamPubs.current.has(u));
    await Promise.all(
      missing.map(async (u) => {
        try {
          const r = await http.roamPub(v.token, u);
          if (r.pub) roamPubs.current.set(u, r.pub);
        } catch {
          /* 对方没启用漫游：只是少一份副本，不影响正常收发 */
        }
      }),
    );
  };

  /** 给每个相关账号封一份历史副本（自己 + 对端/群成员），只有对应账号的设备能解 */
  const buildHist = async (payload: Payload, users: string[]): Promise<HistBody[]> => {
    const v = vaultRef.current;
    if (!v || !v.roam) return [];
    const plain = utf8(JSON.stringify(payload));
    const out: HistBody[] = [];
    for (const u of users) {
      const pub = roamPubs.current.get(u);
      if (!pub) continue;
      try {
        const { eph, ct } = await sealForRoam(fromB64(pub), plain);
        out.push({ user: u, eph, ct });
      } catch {
        /* 单个账号失败不影响消息本身 */
      }
    }
    return out;
  };

  /** 拉一页（或多页）历史副本，回到 handleEvent 的 roamHistory 分支合并 */
  const pullRoam = (convId: number, maxRounds = 3) => {
    const v = vaultRef.current;
    if (!v?.roam || !link) return;
    const list = msgsRef.current[convId] || [];
    const ids = list.filter((x) => x.id > 0).map((x) => x.id);
    const oldest = ids.length ? Math.min(...ids) : undefined;
    const limit = 80;
    roamPaging.current.set(convId, { round: 0, limit, max: maxRounds });
    link.send({ t: 'roamHistory', conv: convId, beforeId: oldest, limit });
  };

  const sendPayload = async (payload: Payload) => {
    const v = vaultRef.current;
    if (!v || !link || !activeConv) return;
    const convId = activeConv.id;
    const tempId = -Date.now();
    const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    pendingSends.current.set(clientId, { conv: convId, tempId, payload });
    setMsgs((prev) => ({
      ...prev,
      [convId]: [
        ...(prev[convId] || []),
        { id: tempId, conv: convId, from: { user: v.username, device: v.deviceId }, createdAt: Date.now(), payload, mine: true, sending: true },
      ],
    }));

    try {
      if (activeConv.kind === 'direct') {
        const other = activeConv.members.find((x) => x.user !== v.username);
        if (!other) throw new Error('会话缺少对端');
        const map = await ensureBundles(other.user);
        // 把已知的自有公钥也塞进去，保证自己设备的会话可用（不会发给自己）
        const targets = other.devices.map((d) => ({ user: other.user, device: d }));
        const { bodies } = await v.client.encryptToDevices(targets, map, payload);
        if (!bodies.length) throw new Error('对方没有可用设备（预密钥包获取失败）');
        await ensureRoamPubs([v.username, other.user]);
        const hist = await buildHist(payload, [v.username, other.user]);
        link.send({ t: 'send', conv: convId, bodies, hist, clientId });
      } else {
        const body = await v.client.encryptGroup(String(convId), payload);
        const users = activeConv.members.map((m) => m.user);
        await ensureRoamPubs(users);
        const hist = await buildHist(payload, users);
        link.send({ t: 'sendGroup', conv: convId, body, hist, clientId });
      }
      await persistNow();
    } catch (e) {
      pendingSends.current.delete(clientId);
      setMsgs((prev) => {
        const list = (prev[convId] || []).map((x) => (x.id === tempId ? { ...x, sending: false, failed: (e as Error).message } : x));
        return { ...prev, [convId]: list };
      });
      flash((e as Error).message);
    }
  };

  const sendText = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    sendPayload({ t: 'text', text });
  };

  const sendFile = async (file: File) => {
    const v = vaultRef.current;
    if (!v) return;
    if (file.size > 30 * 1024 * 1024) {
      flash('单个文件上限 30MB，请压缩或分卷后再发');
      return;
    }
    const raw = new Uint8Array(await file.arrayBuffer());
    const key = randomBytes(32);
    const ct = await aeadSeal(key, raw, utf8('blob'));
    const { id } = await http.putBlob(v.token, ct, file.type);
    await sendPayload({ t: 'file', blobId: id, name: file.name, size: file.size, mime: file.type, key: toB64(key) });
  };

  const downloadFile = async (p: Extract<Payload, { t: 'file' }>) => {
    const v = vaultRef.current;
    if (!v) return;
    try {
      const buf = await http.getBlob(v.token, p.blobId);
      const pt = await aeadOpen(fromB64(p.key), new Uint8Array(buf), utf8('blob'));
      const url = URL.createObjectURL(new Blob([pt as unknown as BlobPart], { type: p.mime || 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = p.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      flash('文件解密失败或已被删除');
    }
  };

  /* ---------------- 群密钥分发 ---------------- */

  const distributeOwnKey = async (groupId: string) => {
    const v = vaultRef.current;
    const conv = convs.find((c) => c.id === Number(groupId));
    if (!v || !link || !conv) return;
    const targets: { user: string; device: string }[] = [];
    const map = new Map<string, PublicBundle>();
    for (const mem of conv.members) {
      if (mem.user === v.username) continue;
      const bmap = await ensureBundles(mem.user);
      for (const [k, val] of bmap) map.set(k, val);
      for (const d of mem.devices) targets.push({ user: mem.user, device: d });
    }
    const { bodies } = await v.client.buildSenderKeyDistribution(groupId, targets, map);
    if (bodies.length) link.send({ t: 'send', conv: Number(groupId), bodies });
    schedulePersist();
  };

  /* ---------------- 打开会话 ---------------- */

  const openConv = async (id: number) => {
    setActiveId(id);
    // 打开会话时顺手拉一次漫游历史（新设备靠这个把 14 天内的历史补回来）
    window.setTimeout(() => pullRoam(id, 3), 80);
    // 只有窄屏（手机）才折叠侧边栏，桌面端保持两栏
    if (typeof window !== 'undefined' && window.innerWidth <= 760) setShowSidebar(false);
    if (!msgs[id] || msgs[id].length === 0) loadHistory(id);
    const last = msgs[id]?.[msgs[id].length - 1];
    if (last) markRead(id, last.id);
    const conv = convs.find((c) => c.id === id);
    // 直聊：进会话就取一次对端公钥包，安全码弹窗才有东西可显示
    const peerUser = conv?.members.find((m) => m.user !== vaultRef.current?.username)?.user;
    if (peerUser && !bundles.current.has(`${peerUser}/`) ) void ensureBundles(peerUser);
    // 进群时若还没分发过自己的密钥，补一次
    if (conv?.kind === 'group' && vaultRef.current) {
      const need = conv.members.some((m) => m.user !== vaultRef.current!.username) && !vaultRef.current.client.ownSenderKeys.get(String(id));
      if (need) distributeOwnKey(String(id)).catch(() => {});
    }
  };

  /* ---------------- 通知：点通知跳到对应会话、标题显示未读数 ---------------- */

  const openConvRef = useRef(openConv);
  openConvRef.current = openConv;
  // 从通知冷启动时 URL 带 ?conv=，热启动时 Service Worker 发 openConv 消息过来
  const pendingOpen = useRef<number | null>(Number(new URLSearchParams(location.search).get('conv')) || null);
  const [openTick, setOpenTick] = useState(0);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      if (e.data?.t === 'openConv' && Number(e.data.conv)) {
        pendingOpen.current = Number(e.data.conv);
        setOpenTick((t) => t + 1);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, []);

  useEffect(() => {
    const id = pendingOpen.current;
    if (!id || phase !== 'main' || !link || !convs.some((c) => c.id === id)) return;
    pendingOpen.current = null;
    if (location.search) history.replaceState(null, '', '/');
    if (id !== activeIdRef.current) void openConvRef.current(id);
  }, [phase, link, convs, openTick]);

  const totalUnread = convs.reduce((n, c) => n + (c.id === activeId ? 0 : c.unread), 0);
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread > 99 ? '99+' : totalUnread}) Cipher IM` : 'Cipher IM';
    // 主屏应用图标上的角标（支持的平台才有：iOS 16.4+ 主屏应用、桌面 Chrome/Edge 安装版）
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (totalUnread > 0) nav.setAppBadge?.(totalUnread).catch(() => {});
    else nav.clearAppBadge?.().catch(() => {});
  }, [totalUnread]);

  /* ---------------- 交互 ---------------- */

  const typingSent = useRef(0);
  const onDraftChange = (text: string) => {
    setDraft(text);
    const now = Date.now();
    if (link && activeConv && now - typingSent.current > 1800 && text) {
      typingSent.current = now;
      link.send({ t: 'typing', conv: activeConv.id });
    }
  };

  if (phase === 'boot') {
    return <div className="center muted">正在加载本地密钥库…</div>;
  }

  if (phase === 'auth') {
    return <AuthScreen onRegister={doRegister} onLogin={doLoginNewDevice} />;
  }

  if (phase === 'unlock') {
    return <UnlockScreen name={metaName} onUnlock={doUnlock} />;
  }

  if (phase === 'main' && vault) {
    return (
      <div className="app">
        {showSidebar && (
          <aside className="sidebar">
            <header className="side-head">
              <div className="avatar">{vault.displayName.slice(0, 1).toUpperCase()}</div>
              <div className="who">
                <div className="name">{vault.displayName}</div>
                <div className="sub">
                  <span className={`dot ${status}`} /> {status === 'online' ? '在线' : status === 'connecting' ? '连接中' : '离线'}
                  <span className="sep">·</span>
                  <span title={vault.deviceId}>本机 {shortFingerprint(utf8(vault.deviceId))}</span>
                </div>
              </div>
              {activeConv && (
                <button className="ghost only-mobile" onClick={() => setShowSidebar(false)} aria-label="关闭会话列表">
                  <IconClose size={18} />
                </button>
              )}
              <button className="ghost" onClick={() => cycleTheme()} title={themeTitle} aria-label="切换深浅色">
                {mode === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
              </button>
              <button className="ghost" onClick={() => setModal('settings')} title="设置" aria-label="设置">
                <IconGear size={18} />
              </button>
            </header>

            <div className="side-actions">
              <button className="primary" onClick={() => setModal('newChat')}>
                新会话
              </button>
              <button className="secondary" onClick={() => setModal('newGroup')}>
                新建群聊
              </button>
            </div>

            <div className="conv-list">
              {convs.length === 0 && <div className="empty-hint">还没有会话，点「新会话」输入对方用户名开始</div>}
              {convs.map((c) => {
                const list = msgs[c.id] || [];
                const last = list[list.length - 1];
                const preview = last ? previewOf(last.payload) : c.kind === 'group' ? '群聊' : '开始聊天';
                return (
                  <button key={c.id} className={`conv-item ${c.id === activeId ? 'active' : ''}`} onClick={() => openConv(c.id)}>
                    <div className={`avatar ${c.kind === 'group' ? 'group' : ''}`}>
                      {c.kind === 'group' ? <IconUsers size={16} /> : c.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="conv-main">
                      <div className="conv-top">
                        <span className="conv-name">{c.name}</span>
                        {last && <span className="conv-time">{fmtTime(last.createdAt)}</span>}
                      </div>
                      <div className="conv-sub">
                        {c.unread > 0 && <span className="badge">{c.unread}</span>}
                        <span className="preview">{preview}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>
        )}

        <main className="main">
          {!activeConv ? (
            <div className="center muted">
              <div>
                <p>选择左侧会话开始聊天</p>
                <p className="tiny">消息在离开你的设备前就已加密，服务器只转发密文。</p>
              </div>
            </div>
          ) : (
            <>
              <header className="chat-head">
                <button className="ghost only-mobile" onClick={() => setShowSidebar(true)} aria-label="会话列表">
                  <IconMenu size={18} />
                </button>
                <div>
                  <div className="chat-title">{activeConv.name}</div>
                  <div className="chat-sub">
                    {activeConv.kind === 'group' ? `${activeConv.members.length} 人` : '端到端加密'}
                    {typing[activeConv.id] && Date.now() - typing[activeConv.id].at < 4000 && (
                      <span className="typing">
                        · {activeConv.members.find((m) => m.user === typing[activeConv.id].user)?.displayName || typing[activeConv.id].user} 正在输入…
                      </span>
                    )}
                  </div>
                </div>
                {activeConv.kind === 'direct' && (
                  <button className="ghost" onClick={() => setModal('safety')} title="核对安全码" aria-label="核对安全码">
                    <IconLock size={18} />
                  </button>
                )}
              </header>

              {trustAlerts.length > 0 && (
                <button className="trust-alert" onClick={() => setModal('safety')} title="重新核对安全码">
                  <IconLock size={14} />
                  <span>{trustAlerts.map((m) => m.displayName).join('、')} 的安全码已变化 · 点此重新核对</span>
                </button>
              )}

              <div className="messages">
                {(msgs[activeConv.id] || []).map((m, i, arr) => {
                  const prev = arr[i - 1];
                  const showDay = !prev || fmtDay(prev.createdAt) !== fmtDay(m.createdAt);
                  return (
                    <React.Fragment key={m.id}>
                      {showDay && <div className="day-sep">{fmtDay(m.createdAt)}</div>}
                      <Bubble msg={m} conv={activeConv} receipts={receipts[activeConv.id] || {}} me={vault.username} onDownload={downloadFile} />
                    </React.Fragment>
                  );
                })}
                {(msgs[activeConv.id] || []).length === 0 && <div className="empty-hint">还没有消息</div>}
              </div>

              <div className="composer" ref={composerRef}>
                <label className="attach" title="发送加密文件">
                  <IconPaperclip size={18} />
                  <input
                    type="file"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) sendFile(f);
                      e.target.value = '';
                    }}
                  />
                </label>
                <textarea
                  ref={taRef}
                  rows={1}
                  value={draft}
                  placeholder="输入消息…"
                  onChange={(e) => onDraftChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendText();
                    }
                  }}
                />
                <button className="primary send" onClick={sendText} disabled={!draft.trim()}>
                  发送
                </button>
              </div>
            </>
          )}
        </main>

        {toast && <div className="toast">{toast}</div>}

        {modal === 'newChat' && (
          <NewChatModal
            onClose={() => { setModal(null); setShowSidebar(true); }}
            onPick={(peer) => {
              link?.send({ t: 'createDirect', peer });
              setModal(null);
              setShowSidebar(true);
              flash(`正在与 ${peer} 建立会话…`);
            }}
            onSearch={(q) => link?.send({ t: 'searchUsers', q })}
          />
        )}

        {modal === 'newGroup' && (
          <NewGroupModal
            onClose={() => setModal(null)}
            onCreate={(name, members) => {
              link?.send({ t: 'createGroup', name, members });
              setModal(null);
              flash('群聊已创建');
            }}
          />
        )}

        {modal === 'safety' && activeConv && (
          <SafetyModal
            conv={activeConv}
            vault={vault}
            bundles={bundles.current}
            onChanged={() => {
              void persistNow();
              setTrustTick((t) => t + 1);
            }}
            onClose={() => setModal(null)}
          />
        )}

        {modal === 'settings' && (
          <SettingsModal
            vault={vault}
            themePref={themePref}
            onChangeTheme={changeTheme}
            onSyncRoam={() => {
              for (const c of convs) pullRoam(c.id, 20);
              flash('正在同步漫游历史…');
            }}
            onClose={() => setModal(null)}
            onLogout={() => {
              link?.close();
              setVault(null);
              setPhase('unlock');
              setModal(null);
            }}
          />
        )}
      </div>
    );
  }

  return <div className="center muted">状态异常</div>;
}

function previewOf(p: Payload | null): string {
  if (!p) return '…';
  if (p.t === 'text') return p.text;
  if (p.t === 'file') return `[文件] ${p.name}`;
  if (p.t === 'system') return p.text;
  return '…';
}

/* ---------------- 子组件 ---------------- */

function AuthScreen({
  onRegister,
  onLogin,
}: {
  onRegister: (u: string, d: string, p: string, invite: string) => Promise<void>;
  onLogin: (u: string, p: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    setErr('');
    setBusy(true);
    try {
      if (mode === 'register') await onRegister(username.trim(), displayName.trim() || username.trim(), password, invite.trim());
      else await onLogin(username.trim(), password);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand">
          <div className="brand-mark"><IconBrand size={22} /></div>
          <div>
            <h1>Cipher IM</h1>
            <p className="muted tiny">端到端加密 · 一台设备一套密钥 · 服务器只见密文</p>
          </div>
        </div>

        <div className="tabs">
          <button className={mode === 'login' ? 'tab active' : 'tab'} onClick={() => setMode('login')}>
            登录
          </button>
          <button className={mode === 'register' ? 'tab active' : 'tab'} onClick={() => setMode('register')}>
            注册
          </button>
        </div>

        <label className="field">
          <span>用户名</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="3-24 位字母数字下划线" autoCapitalize="off" />
        </label>

        {mode === 'register' && (
          <label className="field">
            <span>昵称</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="别人看到的名字" />
          </label>
        )}

        <label className="field">
          <span>口令</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 6 位，用于加密本机密钥"
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </label>

        {mode === 'register' && (
          <label className="field">
            <span>邀请码</span>
            <input value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="找管理员要一个" autoCapitalize="off" />
          </label>
        )}

        {err && <div className="err">{err}</div>}

        <button className="primary wide" onClick={submit} disabled={busy || !username || password.length < 6 || (mode === 'register' && !invite.trim())}>
          {busy ? '处理中…' : mode === 'register' ? '注册并生成密钥' : '登录（本机新建密钥）'}
        </button>

        <p className="tiny muted">
          登录时若本机没有密钥，会为你生成一套新设备密钥；服务端只保存公钥。口令同时用来加密本机密钥库，忘了只能重新注册。
          本实例不开放公开注册，需要邀请码。
        </p>
      </div>
    </div>
  );
}

function UnlockScreen({ name, onUnlock }: { name: string; onUnlock: (p: string) => Promise<void> }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    setErr('');
    try {
      await onUnlock(pw);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand">
          <div className="brand-mark"><IconBrand size={22} /></div>
          <div>
            <h1>解锁本地密钥库</h1>
            <p className="muted tiny">欢迎回来，{name}</p>
          </div>
        </div>
        <label className="field">
          <span>口令</span>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} autoFocus />
        </label>
        {err && <div className="err">{err}</div>}
        <button className="primary wide" onClick={go} disabled={busy || !pw}>
          {busy ? '解锁中…' : '解锁'}
        </button>
        <p className="tiny muted">密钥库保存在本机浏览器里，口令错误将无法解开——这是设计使然。</p>
      </div>
    </div>
  );
}

function Bubble({
  msg,
  conv,
  receipts,
  me,
  onDownload,
}: {
  msg: ChatMsg;
  conv: ConvSummary;
  receipts: Record<string, number>;
  me: string;
  onDownload: (p: Extract<Payload, { t: 'file' }>) => void;
}) {
  const p = msg.payload;
  const readByOthers =
    msg.mine &&
    conv.members.filter((m) => m.user !== me).every((m) => (receipts[m.user] || 0) >= msg.id) &&
    conv.members.filter((m) => m.user !== me).length > 0;

  return (
    <div className={`row ${msg.mine ? 'mine' : ''}`}>
      {!msg.mine && (
        <div className="bubble-avatar">
          {(conv.members.find((m) => m.user === msg.from.user)?.displayName || msg.from.user).slice(0, 1).toUpperCase()}
        </div>
      )}
      <div className="bubble-wrap">
        {conv.kind === 'group' && !msg.mine && (
          <div className="bubble-name">{conv.members.find((m) => m.user === msg.from.user)?.displayName || msg.from.user}</div>
        )}
        <div className={`bubble ${msg.failed ? 'failed' : ''}`}>
          {p?.t === 'text' && <span className="text">{p.text}</span>}
          {p?.t === 'file' && (
            <button className="file" onClick={() => onDownload(p)}>
              <span className="file-ico"><IconFile size={18} /></span>
              <span>
                <span className="file-name">{p.name}</span>
                <span className="file-meta">{formatSize(p.size)} · 点击解密下载</span>
              </span>
            </button>
          )}
          {p?.t === 'system' && <span className="sys">{p.text}</span>}
          {!p && <span className="sys">（空）</span>}
        </div>
        <div className="meta">
          {fmtTime(msg.createdAt)}
          {msg.sending && ' · 发送中'}
          {msg.failed && ` · 失败：${msg.failed}`}
          {msg.otherDevice && ' · 另一台设备'}
          {readByOthers && ' · 已读'}
        </div>
      </div>
    </div>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function NewChatModal({
  onClose,
  onPick,
  onSearch,
}: {
  onClose: () => void;
  onPick: (peer: string) => void;
  onSearch: (q: string) => void;
}) {
  const [q, setQ] = useState('');
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>开始新会话</h3>
        <p className="tiny muted">输入对方用户名（需已注册）；系统会先取对方公钥包，再加密第一条消息。</p>
        <label className="field">
          <span>用户名</span>
          <input value={q} onChange={(e) => { setQ(e.target.value); if (e.target.value.length >= 2) onSearch(e.target.value); }} autoFocus />
        </label>
        <div className="dialog-actions">
          <button className="secondary" onClick={onClose}>取消</button>
          <button className="primary" onClick={() => q.trim() && onPick(q.trim())}>建立会话</button>
        </div>
      </div>
    </div>
  );
}

function NewGroupModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, members: string[]) => void }) {
  const [name, setName] = useState('');
  const [members, setMembers] = useState('');
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>新建群聊</h3>
        <label className="field">
          <span>群名称</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 项目讨论" autoFocus />
        </label>
        <label className="field">
          <span>成员用户名（逗号分隔）</span>
          <input value={members} onChange={(e) => setMembers(e.target.value)} placeholder="alice, bob" />
        </label>
        <p className="tiny muted">群消息用「发送者密钥」加密：每人一条对称链，成员变动会自动轮换。</p>
        <div className="dialog-actions">
          <button className="secondary" onClick={onClose}>取消</button>
          <button
            className="primary"
            onClick={() =>
              onCreate(
                name.trim() || '未命名群聊',
                members.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
              )
            }
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}

function SafetyModal({
  conv,
  vault,
  bundles,
  onChanged,
  onClose,
}: {
  conv: ConvSummary;
  vault: VaultState;
  bundles: Map<string, PublicBundle>;
  onChanged: () => void;
  onClose: () => void;
}) {
  const peer = conv.members.find((m) => m.user !== vault.username);
  const rows = peer
    ? [...bundles.entries()]
        .filter(([k]) => k.startsWith(`${peer.user}/`))
        .map(([key, b]) => {
          const sn = safetyNumber(vault.keys.identity.ikSigPub, fromB64(b.ikSigPub));
          const entry = vault.trust?.[key];
          return { key, device: key.split('/')[1], sn, entry, status: evaluateTrust(sn, entry) };
        })
    : [];

  const trust = (key: string, sn: string) => {
    if (!vault.trust) vault.trust = {};
    vault.trust[key] = markVerified(sn);
    onChanged();
  };
  const untrust = (key: string) => {
    if (vault.trust) delete vault.trust[key];
    onChanged();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>安全码 · {peer?.displayName}</h3>
        {rows.length ? (
          <>
            <p className="tiny muted">
              和对方当面或通过可信渠道逐组念一遍。核对之后标为「已验证」；对端换了设备或密钥，这里会自动变成「已变更」。
            </p>
            {rows.map((r) => (
              <div className="safety-device" key={r.key}>
                <div className="safety-device-head">
                  <span className="mono">{r.device}</span>
                  <span className={`pill ${r.status}`}>
                    {r.status === 'verified' ? '已验证' : r.status === 'changed' ? '已变更' : '未核对'}
                  </span>
                </div>
                <div className="safety-grid">
                  {formatSafetyNumber(r.sn).map((g, i) => (
                    <span key={i}>{g}</span>
                  ))}
                </div>
                <div className="safety-actions">
                  {r.status === 'verified' ? (
                    <button className="secondary tiny-btn" onClick={() => untrust(r.key)}>
                      取消信任
                    </button>
                  ) : (
                    <button className="primary tiny-btn" onClick={() => trust(r.key, r.sn)}>
                      标记已验证
                    </button>
                  )}
                </div>
              </div>
            ))}
          </>
        ) : (
          <p className="muted">尚未取得对方公钥包，先发一条消息即可获得。</p>
        )}
        <div className="dialog-actions">
          <button className="primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

function SettingsModal({
  vault,
  themePref,
  onChangeTheme,
  onSyncRoam,
  onClose,
  onLogout,
}: {
  vault: VaultState;
  themePref: ThemePref;
  onChangeTheme: (p: ThemePref) => void;
  onSyncRoam: () => void;
  onClose: () => void;
  onLogout: () => void;
}) {
  const [devices, setDevices] = useState<{ device: string; added_at: number }[] | null>(null);
  const [msg, setMsg] = useState('');

  const load = () => {
    http
      .roamDevices(vault.token)
      .then((r) => setDevices(r.devices))
      .catch(() => setDevices([]));
  };
  useEffect(load, [vault.token]);

  const revoke = async (device: string) => {
    try {
      const r = await http.roamRevoke(vault.token, device);
      setMsg(`已撤销 ${r.revoked} 台设备`);
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '撤销失败');
    }
  };
  const modes: { key: ThemePref; label: string; icon: React.ReactNode }[] = [
    { key: 'system', label: '跟随系统', icon: <IconMonitor size={15} /> },
    { key: 'light', label: '浅色', icon: <IconSun size={15} /> },
    { key: 'dark', label: '深色', icon: <IconMoon size={15} /> },
  ];
  return (
    <div className="overlay sheet" onClick={onClose}>
      <div className="dialog settings" role="dialog" aria-label="设置" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h3>设置</h3>
          <button className="ghost" onClick={onClose} aria-label="关闭">
            <IconClose size={18} />
          </button>
        </div>

        <div className="dialog-body">
          <section className="set-sec">
            <div className="set-title">外观</div>
            <div className="seg">
              {modes.map((m) => (
                <button
                  key={m.key}
                  className={themePref === m.key ? 'active' : ''}
                  onClick={() => onChangeTheme(m.key)}
                  aria-pressed={themePref === m.key}
                >
                  {m.icon}
                  {m.label}
                </button>
              ))}
            </div>
          </section>

          <NotifySection token={vault.token} />

          <section className="set-sec">
            <div className="set-title">账号</div>
            <div className="set-group">
              <div className="set-row">
                <span>账号</span>
                <span className="set-val">{vault.username}</span>
              </div>
              <div className="set-row">
                <span>昵称</span>
                <span className="set-val">{vault.displayName}</span>
              </div>
              <div className="set-row">
                <span>本机设备</span>
                <span className="set-val mono">{vault.deviceId}</span>
              </div>
              <div className="set-row">
                <span>身份指纹</span>
                <span className="set-val mono">{shortFingerprint(vault.keys.identity.ikSigPub)}</span>
              </div>
              <div className="set-row">
                <span>预密钥余量</span>
                <span className="set-val">{vault.keys.opks.length} 枚</span>
              </div>
            </div>
          </section>

          <section className="set-sec">
            <div className="set-title">
              <span>漫游设备</span>
              <span className="set-sub">{vault.roam ? '本机已解封漫游密钥' : '本机未解封漫游密钥'}</span>
            </div>
            {devices === null ? null : devices.length ? (
              <div className="set-group">
                {devices.map((d) => (
                  <div className="set-row" key={d.device}>
                    <span className="mono">{d.device}</span>
                    {d.device === vault.deviceId ? (
                      <span className="set-val">本机</span>
                    ) : (
                      <button className="secondary tiny-btn" onClick={() => revoke(d.device)}>
                        撤销
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="set-hint">还没有登记过漫游设备。</p>
            )}
            {msg ? <p className="set-hint">{msg}</p> : null}
            <div className="set-btns">
              <button className="secondary tiny-btn" onClick={onSyncRoam}>同步漫游历史</button>
              <button className="secondary tiny-btn" onClick={load}>刷新列表</button>
            </div>
            <details className="set-note">
              <summary>漫游和撤销是怎么回事</summary>
              <p>
                每台设备有自己的身份密钥，换设备登录会生成新身份；最近 14 天的历史靠账号漫游密钥补回来，服务端更早的密文会被删除，本机加密日志可以长期保留。
              </p>
              <p>撤销会把该设备移出白名单并踢下线，但它已经下载的内容收不回来；要彻底失效需要换口令（后续版本支持）。</p>
            </details>
          </section>

          <section className="set-sec">
            <div className="set-title">关于</div>
            <div className="set-group">
              <div className="set-row">
                <span>源代码</span>
                <a className="set-val" href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
                  {SOURCE_URL.replace(/^https:\/\//, '')}
                </a>
              </div>
              <div className="set-row">
                <span>许可证</span>
                <span className="set-val">{LICENSE_NAME}</span>
              </div>
            </div>
          </section>
        </div>

        <div className="dialog-actions">
          <button className="secondary danger" onClick={onLogout}>锁屏</button>
          <button className="primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}

const PUSH_LABEL: Record<PushState, string> = {
  on: '已开启',
  off: '未开启',
  denied: '已被拒绝',
  'ios-needs-install': '需先添加到主屏幕',
  unsupported: '此浏览器不支持',
};

const PUSH_HINT: Record<PushState, string> = {
  on: '页面不在前台时弹系统通知，通知里只写「你有新消息」。',
  off: '开启后，关掉页面或切到后台也能收到提醒。',
  denied: '到浏览器或系统设置里，把本站的通知改回「允许」。',
  'ios-needs-install': '在 Safari 点「分享 → 添加到主屏幕」，之后从主屏图标打开再来开启（iOS 16.4+）。',
  unsupported: '电脑上建议用 Edge。',
};

function NotifySection({ token }: { token: string }) {
  const [st, setSt] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    pushState().then(setSt).catch(() => setSt('unsupported'));
  }, []);

  const toggle = async () => {
    setBusy(true);
    setErr('');
    try {
      setSt(st === 'on' ? await disablePush(token) : await enablePush(token));
    } catch (e) {
      // 最常见：浏览器连不上自家的推送服务（例如电脑版 Chrome 连不上 Google）
      setErr(`开启失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!st) return null;
  return (
    <section className="set-sec">
      <div className="set-title">新消息通知</div>
      <div className="set-group">
        <div className="set-row">
          <span>{PUSH_LABEL[st]}</span>
          {st === 'on' || st === 'off' ? (
            <button className={`${st === 'on' ? 'secondary' : 'primary'} tiny-btn`} onClick={toggle} disabled={busy}>
              {busy ? '处理中…' : st === 'on' ? '关闭' : '开启'}
            </button>
          ) : null}
        </div>
      </div>
      <p className="set-hint">{err || PUSH_HINT[st]}</p>
    </section>
  );
}
