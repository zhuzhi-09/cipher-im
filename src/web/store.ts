/**
 * 本地密钥库（IndexedDB）
 *
 * 存什么：身份证密钥、签名预密钥、一次性预密钥、所有会话状态、群密钥、已读位置
 * 怎么存：整体 JSON → 用「登录口令 → PBKDF2(200k, 随机盐) → AES-256-GCM(随机 nonce)」加密
 * 关键点：密文只在设备上，服务端既收不到私钥也收不到这把 KEK；
 *        所以即使服务器数据库被拖走，也解不开任何历史消息。
 */
import {
  Bytes,
  toB64,
  fromB64,
  randomBytes,
  pbkdf2,
  aeadSealRandom,
  aeadOpenRandom,
  utf8,
  fromUtf8,
} from '../shared/crypto/primitives';
import {
  DeviceKeys,
  Identity,
  SerializedIdentity,
  serializeIdentity,
  deserializeIdentity,
  createDeviceKeys,
  publicBundleOf,
} from '../shared/crypto/identity';
import { CryptoClient } from '../shared/crypto/client';
import type { SessionRecord } from '../shared/crypto/session';
import type { SenderKeyState } from '../shared/crypto/senderkey';
import type { Payload } from '../shared/protocol';

/** 本地明文日志（只在本机、被口令加密后落盘；不回传服务器） */
export interface LocalMsg {
  id: number;
  from: { user: string; device: string };
  createdAt: number;
  payload: Payload;
  mine: boolean;
  /** 自己账号在另一台设备上发的（漫游副本回填时标一下，避免误认成对方消息） */
  otherDevice?: boolean;
}

const DB_NAME = 'cipher-im';
const STORE = 'vault';
const RECORD_ID = 'device';
const AAD = utf8('CipherIM-vault-v1');

interface EncRecord {
  id: string;
  salt: string; // b64
  data: string; // b64( nonce||ct )
  username: string; // 明文，仅用于解锁界面展示
  displayName: string;
  deviceId: string;
  updatedAt: number;
}

/** 安全码信任状态：key = `${user}/${device}` */
export interface TrustEntry {
  safety: string; // 上次核对/记录到的安全码
  state: 'verified' | 'changed'; // 已核对 / 已变化（需要重新核对）
  at: number;
}

/** 漫游密钥（b64）：pub 可以给出去，priv 只在设备和本机密钥库里 */
export interface RoamKey {
  pub: string;
  priv: string;
}

export interface VaultState {
  username: string;
  displayName: string;
  deviceId: string;
  keys: DeviceKeys;
  client: CryptoClient;
  token: string;
  reads: Record<string, number>; // convId -> 已读到的 msgId
  contacts: Record<string, string>; // username -> displayName 缓存
  log: Record<string, LocalMsg[]>; // convId -> 本地明文日志（加密落盘）
  roam: RoamKey | null; // 账号级漫游密钥；null 表示本设备还没解封
  trust: Record<string, TrustEntry>; // 安全码信任状态
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readRecord(): Promise<EncRecord | null> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(RECORD_ID);
    req.onsuccess = () => resolve((req.result as EncRecord) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function writeRecord(rec: EncRecord): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------------- 序列化 ---------------- */

interface PlainVault {
  username: string;
  displayName: string;
  deviceId: string;
  token: string;
  identity: SerializedIdentity;
  spk: { id: string; priv: string; pub: string; sig: string };
  opks: { id: string; priv: string; pub: string }[];
  sessions: [string, { records: SessionRecord[]; current: string | null; lastUsed: Record<string, number> }][];
  ownSenderKeys: [string, SenderKeyState][];
  peerSenderKeys: [string, SenderKeyState][];
  reads: Record<string, number>;
  contacts: Record<string, string>;
  log: Record<string, LocalMsg[]>;
  roam?: RoamKey | null;
  trust?: Record<string, TrustEntry>;
}

function toPlain(v: VaultState): PlainVault {
  return {
    username: v.username,
    displayName: v.displayName,
    deviceId: v.deviceId,
    token: v.token,
    identity: serializeIdentity(v.keys.identity),
    spk: { ...v.keys.spk, priv: toB64(v.keys.spk.priv), pub: toB64(v.keys.spk.pub), sig: toB64(v.keys.spk.sig) },
    opks: v.keys.opks.map((o) => ({ id: o.id, priv: toB64(o.priv), pub: toB64(o.pub) })),
    sessions: [...v.client.sessions.peers.entries()],
    ownSenderKeys: [...v.client.ownSenderKeys.entries()],
    peerSenderKeys: [...v.client.peerSenderKeys.entries()],
    reads: v.reads,
    contacts: v.contacts,
    log: v.log,
    roam: v.roam,
    trust: v.trust,
  };
}

function fromPlain(p: PlainVault): { state: Omit<VaultState, 'client'>; client: CryptoClient } {
  const identity: Identity = deserializeIdentity(p.identity);
  const keys: DeviceKeys = {
    identity,
    spk: { id: p.spk.id, priv: fromB64(p.spk.priv), pub: fromB64(p.spk.pub), sig: fromB64(p.spk.sig) },
    opks: p.opks.map((o) => ({ id: o.id, priv: fromB64(o.priv), pub: fromB64(o.pub) })),
  };
  const client = new CryptoClient(p.username, p.deviceId, keys);
  for (const [k, v] of p.sessions) client.sessions.peers.set(k, v);
  for (const [k, v] of p.ownSenderKeys) client.ownSenderKeys.set(k, v);
  for (const [k, v] of p.peerSenderKeys) client.peerSenderKeys.set(k, v);
  return {
    state: {
      username: p.username,
      displayName: p.displayName,
      deviceId: p.deviceId,
      keys,
      token: p.token,
      reads: p.reads || {},
      contacts: p.contacts || {},
      log: p.log || {},
      roam: p.roam || null,
      trust: p.trust || {},
    },
    client,
  };
}

/* ---------------- 对外接口 ---------------- */

/** 纯函数：把运行中的 VaultState 变成可加密的 JSON 文本（供测试与持久化共用） */
export function serializeVault(v: VaultState): string {
  return JSON.stringify(toPlain(v));
}

export function deserializeVault(json: string): VaultState {
  const { state, client } = fromPlain(JSON.parse(json) as PlainVault);
  return { ...state, client };
}

export async function sealVaultText(kek: Bytes, text: string): Promise<string> {
  return toB64(await aeadSealRandom(kek, utf8(text), AAD));
}

export async function openVaultText(kek: Bytes, data: string): Promise<string> {
  return fromUtf8(await aeadOpenRandom(kek, fromB64(data), AAD));
}

export class LocalStore {
  kek: Bytes | null = null;
  salt: Bytes | null = null;
  meta: EncRecord | null = null;

  async load(): Promise<EncRecord | null> {
    this.meta = await readRecord();
    return this.meta;
  }

  get exists(): boolean {
    return !!this.meta;
  }

  /** 用口令解锁，口令错误时 GCM 校验会失败 */
  async unlock(password: string): Promise<VaultState> {
    if (!this.meta) throw new Error('本机还没有密钥库');
    const salt = fromB64(this.meta.salt);
    const kek = await pbkdf2(password, salt, 200000);
    let plain: PlainVault;
    try {
      plain = JSON.parse(await openVaultText(kek, this.meta.data)) as PlainVault;
    } catch {
      throw new Error('口令不正确');
    }
    this.kek = kek;
    this.salt = salt;
    const { state, client } = fromPlain(plain);
    return { ...state, client };
  }

  /** 新建密钥库（注册后调用） */
  async create(password: string, username: string, displayName: string, deviceId: string, token: string): Promise<VaultState> {
    const keys = createDeviceKeys();
    const client = new CryptoClient(username, deviceId, keys);
    const state: VaultState = {
      username,
      displayName,
      deviceId,
      keys,
      client,
      token,
      reads: {},
      contacts: {},
      log: {},
      roam: null,
      trust: {},
    };
    const salt = randomBytes(16);
    this.kek = await pbkdf2(password, salt, 200000);
    this.salt = salt;
    await this.persist(state);
    return state;
  }

  /** 已有账号、本机新设备：用口令重新加密本机新生成的密钥 */
  async adopt(password: string, username: string, displayName: string, deviceId: string, token: string): Promise<VaultState> {
    return this.create(password, username, displayName, deviceId, token);
  }

  async persist(v: VaultState): Promise<void> {
    if (!this.kek || !this.salt) throw new Error('密钥库未解锁');
    const data = await sealVaultText(this.kek, serializeVault(v));
    const rec: EncRecord = {
      id: RECORD_ID,
      salt: toB64(this.salt),
      data, // sealVaultText 已返回 base64 文本
      username: v.username,
      displayName: v.displayName,
      deviceId: v.deviceId,
      updatedAt: Date.now(),
    };
    this.meta = rec;
    await writeRecord(rec);
  }

  /** 补货：一次性预密钥用掉一些后补充新的一批 */
  async topUpOpks(v: VaultState, count = 20): Promise<void> {
    const { createOpks } = await import('../shared/crypto/identity');
    v.keys.opks = [...v.keys.opks, ...createOpks(count)];
    await this.persist(v);
  }
}

export function generateDeviceId(): string {
  const b = randomBytes(6);
  return `d-${toB64(b).replace(/[+/=]/g, '').slice(0, 10).toLowerCase()}`;
}

export function bundleForRegistration(keys: DeviceKeys, deviceId: string) {
  return { ...publicBundleOf(keys), device: deviceId };
}
