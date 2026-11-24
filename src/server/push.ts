/**
 * Web Push：设备不在前台时，通过浏览器厂商的推送服务把它叫醒
 *
 * 推送内容只有「哪个会话有新消息」，不带任何明文——服务端本来就解不开消息，
 * 而且推送要经过 Apple / Google / 微软的服务器，不该让它们看到发送者或内容。
 */
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

export interface PushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** 只允许向已知的浏览器推送服务发请求，避免订阅接口被当成 SSRF 跳板 */
const PUSH_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/, // Chrome / 安卓
  /(^|\.)android\.googleapis\.com$/,
  /(^|\.)push\.apple\.com$/, // Safari / iOS 主屏应用
  /(^|\.)notify\.windows\.com$/, // Edge
  /(^|\.)push\.services\.mozilla\.com$/, // Firefox
];

export function validEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port) return false;
  return PUSH_HOSTS.some((re) => re.test(u.hostname));
}

/** VAPID 密钥对：首次启动生成并存进数据目录，之后一直复用（换了密钥，已有订阅全部作废） */
export function loadVapid(dataDir: string): VapidKeys {
  const file = path.join(dataDir, 'vapid.json');
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (k.publicKey && k.privateKey) return { publicKey: k.publicKey, privateKey: k.privateKey };
  } catch {
    /* 还没有，下面生成 */
  }
  const k = webpush.generateVAPIDKeys();
  fs.writeFileSync(file, JSON.stringify(k), { mode: 0o600 });
  console.log('[推送] 已生成 VAPID 密钥：', file);
  return k;
}

export type SendResult = 'ok' | 'gone' | 'error';

export async function sendPush(
  vapid: VapidKeys,
  subject: string,
  sub: PushSub,
  data: unknown,
): Promise<SendResult> {
  // 测试用：只打日志不真发（scripts/push-check.mjs 靠这个验证「什么时候该推」）
  if (process.env.PUSH_DRY_RUN === '1') {
    console.log(`[推送] dry-run ${sub.endpoint} ${JSON.stringify(data)}`);
    return 'ok';
  }
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(data),
      {
        vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: 24 * 60 * 60,
        urgency: 'high',
        timeout: 10_000,
      },
    );
    return 'ok';
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    // 404 / 410：订阅已失效（用户关了通知、卸载了主屏应用、浏览器换了订阅），删掉
    if (code === 404 || code === 410) return 'gone';
    console.error('[推送] 发送失败：', code || '', (e as Error).message);
    return 'error';
  }
}
