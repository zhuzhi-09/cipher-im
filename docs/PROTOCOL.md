# 协议与数据流

## 1. 角色

```
 浏览器/桌面/手机（同一份 Web 代码）
        │  HTTPS（账号、文件密文）
        │  WSS（实时路由、离线队列）
        ▼
   Node 服务端（SQLite）
        │  只存：账号/设备公钥/会话成员/每个设备一份密文/回执/文件密文
```

服务端**不知道**任何明文，也无法代任何设备解密。

## 2. 注册与设备

```
客户端：生成 IK_sig(Ed25519) + IK_dh(X25519) + SPK(签名预密钥) + 24 个 OPK
        ↓ POST /api/register {username, password, bundle(公钥包)}
服务端：建账号（scrypt 存口令）、存设备公钥与 OPK 池、发 token（绑定设备）
客户端：把私钥串 + 口令 → PBKDF2 → AES-GCM → 存进 IndexedDB
```

同一账号在新设备登录：`/api/login` → 生成新密钥 → `/api/device` 登记 → 拿绑定该设备的新 token。

## 3. 直聊

```
A 取 B 每台设备的预密钥包（服务端原子消耗一枚 OPK）
A: X3DH → 双棘轮初始化 → 对 B 每台设备各加密一份
     ┌─ 信封 prekey：IK_A/IK_B、EK_A、spkId/opkId、棘轮头、密文
     └─ 之后（收到 B 任何消息前）继续带 prekey 头
服务端: 存一条 message + 每台目标设备一条 delivery，在线直推、离线排队
B: 用自己 SPK/OPK 私钥跑 X3DH 响应 → 建链 → 解密
```

**多链路**：同一对端最多 3 条状态（例：双方同时发起）。解密按「最近使用」逐条试，失败即回滚，成功则设为当前发送链。

## 4. 群聊

```
建群：服务端建 conv + 成员
每个成员的上行：senderKey(groupId) = {keyId, chainKey, iteration}
分发（SKDM）：通过各自的直聊会话，把 senderKey 逐设备加密发出（在群会话里记为 control 消息）
群消息：senderKey 链推进一步 → AES-GCM 加密一次 → 服务端按成员设备扇出
成员变动：所有客户端轮换自己的 senderKey 并重新分发 → 退群者解不开新消息
```

## 5. 线格式

```ts
// 密文信封（服务端只见这一层）
type WireBody =
  | { kind:'prekey'; ikSigPub; ikDhPub; ekPub; spkId; opkId|null; header:{dh,pn,n}; ct }
  | { kind:'msg';      header:{dh,pn,n}; ct }
  | { kind:'group';    groupId; ownerUser; ownerDevice; keyId; iteration; ct };

// 解密后的载荷（只在设备上存在）
type Payload =
  | { t:'text'; text }
  | { t:'file'; blobId; name; size; mime; key }   // 文件密钥随消息加密传输
  | { t:'skdm'; dist }                             // 群密钥分发
  | { t:'system'; text };
```

客户端 → 服务端（WebSocket）：

```
hello{device}                      → ready{self, convs}
send{conv, bodies[{user,device,body}], clientId}   → sent{conv,id,createdAt,clientId}
sendGroup{conv, body, clientId}    → sent{...}
auth{token}                        → authOk（首帧必须是它，否则 8 秒内断开）
hello{device}                      → ready{self, convs[]}
history{conv, beforeId?, limit}    → history{msgs[]}
convs{}                            → convs[]
createDirect{peer} / createGroup{name,members} / addMembers{conv,members}
bundle{user}                       → bundles{user, bundles[{device, bundle}]}
receipt{conv, upto}                → 广播 receipt{conv,user,upto}
typing{conv}                       → 广播 typing{conv,user}
roamHistory{conv, beforeId?, limit} → roamHistory{conv, msgs[{id,conv,from,createdAt,eph,ct}]}
```

`send` / `sendGroup` 可带 `hist: [{user, eph, ct}]`：每个相关账号（自己 + 对端 / 群全体成员）一份
「明文载荷用该账号漫游公钥封起来」的历史副本，服务端只按 `(msg_id,user)` 存密文，14 天后随消息一起删。

## 6. 存储模型（服务端）

| 表 | 内容 | 保留策略 |
|---|---|---|
| `users` / `devices` | 账号、口令哈希、设备公钥 | 长期 |
| `opks` | 一次性预密钥公钥（`used` 标记消耗） | 长期（耗尽后客户端补货） |
| `convs` / `conv_members` | 会话与成员 | 长期 |
| `messages` | 消息元信息（发送者/会话/时间/类型） | **14 天** |
| `deliveries` | 每台目标设备一份密文 + 投递时间 | **14 天**（随消息一起清） |
| `receipts` | 每台设备读到哪个消息 id | 长期（极小） |
| `blobs` + 磁盘文件 | 文件密文（单文件 ≤30MB） | **14 天** |
| `roam_keys` | 账号漫游公钥 + 口令封存的私钥 | 长期（账号级） |
| `roam_devices` | 允许拉取漫游历史的设备白名单 | 长期 |
| `hist` | 每账号一份历史副本（漫游公钥封的密文） | **14 天**（随消息一起清） |
| `tokens` | 登录令牌 → 用户/设备 | 长期 |

清理在启动时与每小时各跑一次（`db.prune`）。

## 7. 关键不变量

1. 任何时刻，服务端持有的消息字段里都不含明文；索引里只有 id、时间、发送者、目标设备。
2. 私钥与 KEK 从不离开设备；`/api/opk` 只接收公钥。
3. 每条消息密钥只用于一次加密（AES-GCM nonce 由密钥确定派生，故必须一次性）。
4. token 必须绑定设备，否则不能接收该设备的排队密文。
5. 群成员变更后旧 senderKey 立即失效（新 keyId）。
6. 漫游副本只对「白名单里的账号设备」可拉；`hist` 的密文只有持对应漫游私钥的设备能解，
   服务端持有 `roam_keys` 但拿不到口令（PBKDF2 200k 派生的 KEK 只在客户端）。
7. 漫游封包每次用新的临时 X25519 密钥，HKDF salt 取临时公钥（封与解两端一致），AAD 绑定临时公钥。
