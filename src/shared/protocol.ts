/** 客户端 / 服务端之间的线格式（两种：密文信封 WireBody、明文载荷 Payload） */
import type { PublicBundle } from './crypto/identity';
import type { SenderKeyDistribution } from './crypto/senderkey';

/** 密文信封：服务端只经手这一层，从中拿不到任何明文 */
export interface MsgBody {
  kind: 'msg';
  header: { dh: string; pn: number; n: number };
  ct: string;
}

export interface PreKeyBody {
  kind: 'prekey';
  ikSigPub: string;
  ikDhPub: string;
  ekPub: string;
  spkId: string;
  opkId: string | null;
  header: { dh: string; pn: number; n: number };
  ct: string;
}

export interface GroupBody {
  kind: 'group';
  groupId: string;
  ownerUser: string;
  ownerDevice: string;
  keyId: string;
  iteration: number;
  ct: string;
}

export type WireBody = MsgBody | PreKeyBody | GroupBody;

/** 解密后的载荷（只在设备上出现） */
export type Payload =
  | { t: 'text'; text: string }
  | { t: 'file'; blobId: string; name: string; size: number; mime: string; key: string }
  | { t: 'skdm'; dist: SenderKeyDistribution }
  | { t: 'system'; text: string };

/** 跨设备漫游的历史副本：用收件账号的漫游公钥再封一层，只有该账号的设备能解 */
export interface HistBody {
  user: string;
  eph: string;
  ct: string;
}

/** 漫游拉取回来的一条历史（服务器只经手 eph 与密文） */
export interface RoamItem {
  id: number;
  conv: number;
  from: { user: string; device: string };
  createdAt: number;
  eph: string;
  ct: string;
}

export interface WireMessage {
  id: number;
  conv: number;
  from: { user: string; device: string };
  createdAt: number;
  body: WireBody;
}

export interface ConvMember {
  user: string;
  displayName: string;
  devices: string[];
}

export interface ConvSummary {
  id: number;
  kind: 'direct' | 'group';
  name: string;
  members: ConvMember[];
  lastMsgId: number | null;
  lastAt: number | null;
  unread: number;
}

export type C2S =
  | { t: 'auth'; token: string }
  | {
      t: 'send';
      conv: number;
      bodies: { user: string; device: string; body: WireBody }[];
      /** 每账号一份的历史副本（自己 + 对端），14 天后随消息一起清掉 */
      hist?: HistBody[];
      clientId?: string;
    }
  | { t: 'sendGroup'; conv: number; body: GroupBody; hist?: HistBody[]; clientId?: string }
  | { t: 'history'; conv: number; beforeId?: number; limit?: number }
  | { t: 'convs' }
  | { t: 'createDirect'; peer: string }
  | { t: 'createGroup'; name: string; members: string[] }
  | { t: 'addMembers'; conv: number; members: string[] }
  | { t: 'bundle'; user: string }
  | { t: 'searchUsers'; q: string }
  | { t: 'receipt'; conv: number; upto: number }
  | { t: 'typing'; conv: number }
  /** 页面前台/后台切换：服务端据此决定新消息要不要走 Web Push */
  | { t: 'presence'; visible: boolean }
  | { t: 'roamHistory'; conv: number; beforeId?: number; limit?: number };

export type S2C =
  | { t: 'authOk' }
  | { t: 'ready'; self: { user: string; device: string }; convs: ConvSummary[] }
  | { t: 'msg'; msg: WireMessage }
  | { t: 'sent'; conv: number; id: number; createdAt: number; clientId?: string }
  | { t: 'history'; conv: number; msgs: WireMessage[] }
  | { t: 'convs'; convs: ConvSummary[] }
  | { t: 'bundles'; user: string; bundles: { device: string; bundle: PublicBundle }[] }
  | { t: 'users'; users: { username: string; displayName: string }[] }
  | { t: 'receipt'; conv: number; user: string; upto: number }
  | { t: 'typing'; conv: number; user: string }
  | { t: 'memberChange'; conv: number }
  | { t: 'roamHistory'; conv: number; msgs: RoamItem[] }
  | { t: 'error'; message: string };
