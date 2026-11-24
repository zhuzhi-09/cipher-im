# 加密兼容测试数据

`crypto-v1.json` 由现有 TypeScript 加密实现（`src/shared/crypto/`）生成，用来保证其他语言的实现（Flutter 客户端的 Dart 代码）和 Web 端**逐字节兼容**。

```bash
bash scripts/vectors.sh export   # 重新生成（改了 TS 加密代码之后）
bash scripts/vectors.sh verify   # 用 TS 实现回放校验，必须全部通过
```

重复导出结果完全一样；文件一变，说明加密行为变了，所有客户端都要跟着核对。

## 确定性随机数

所有用到随机数的地方（生成密钥、临时密钥、群密钥、随机 nonce、盐）都改用一个可复现的字节流：

```
block(i) = SHA-256( utf8("CipherIM-test-rng-v1|" + label) || u32be(i) )      i = 0, 1, 2, …
字节流   = block(0) || block(1) || block(2) || …
```

- 每段数据都注明它用的 `label`（字段名 `rng`），开始前先切到这个 label，计数器归零
- 取随机数是**流式**的：每次按需从流里往后拿，上一块没用完的字节留给下次

所以要逐字节对上，实现必须按**和 TS 完全相同的顺序和长度**取随机数，例如：

| 操作 | 随机数调用顺序 |
|---|---|
| `createDeviceKeys(n)` | 身份种子 32 → SPK 私钥 32 → SPK id 6 → 每枚 OPK：私钥 32、id 6 |
| `x3dhInitiate` | 临时密钥私钥 32 |
| 发起方建会话 `establish` | X3DH 临时私钥 32 → 首个棘轮私钥 32 |
| 收到对方新棘轮公钥（DH 棘轮） | 新棘轮私钥 32 |
| `createSenderKey` | keyId 8 → chainKey 32 |
| `aeadSealRandom` | nonce 12 |
| `sealForRoam` | 临时私钥 32 |
| `wrapRoamPriv` | 盐 32 → nonce 12 |

id 类字段（SPK id、OPK id、keyId）是随机字节的标准 base64。

## 编码

- `primitives` 段：hex
- 其余所有字节：标准 base64（`A-Za-z0-9+/`，带 `=` 填充），和线协议一致
- 明文载荷用 `payloadJson` 给出原样 JSON 字符串。加密时对**这串字符**做 UTF-8 编码，不要先解析再自己序列化（键顺序、转义可能不同）
- 解密结果的比对口径是 `JSON.stringify(解析后的载荷)`；Dart 端用 `jsonEncode` 得到的结果和它一样（键顺序保持插入顺序，非 ASCII 字符不转义）

## 各段内容

| 段 | 内容 |
|---|---|
| `primitives` | SHA-256、HKDF-SHA256、HMAC-SHA256、X25519、Ed25519、AES-256-GCM（确定性 nonce）、AES-256-GCM（随机 nonce）、PBKDF2-SHA256、base64 |
| `identity` | 用指定 label 生成整套设备密钥，以及「Ed25519 种子 → X25519 私钥」派生 |
| `fingerprint` | 60 位安全码（交换双方顺序结果不变）和短指纹 |
| `parties` | 会话脚本里各角色的用户名、设备名和完整密钥（用 `keys-<角色名>` 生成，可以重新生成核对） |
| `x3dh` | 有 OPK、无 OPK、签名被篡改（必须拒绝）三种情况 |
| `transcript` | 会话脚本，见下 |
| `roam` | 漫游密钥对、历史副本的封装与解封、用口令封装漫游私钥（PBKDF2 20 万次） |
| `blob` | 文件密文：随机文件密钥 + AES-256-GCM，AAD 为 `"blob"` |

## 会话脚本（transcript）

按顺序执行每一步，**状态在步骤之间延续**（每个角色一个加密客户端，初始状态来自 `parties`）。每一步先切到它的 `rng` label，再执行，然后把结果和 `expect` 比对。

| op | 输入 | 期望输出 |
|---|---|---|
| `encrypt` | `actor` 给 `targets` 里每台设备加密 `payloadJson`。没有会话的设备用 `bundles`（键为 `user/device`）新建；没有包的跳过；目标是自己时直接略过 | `bodies`（每台设备一个线格式信封）、`skipped` |
| `decrypt` | `actor` 解 `from` 发来的 `body` | `payloadJson`、`created`（是否新建了会话）、`usedOpk` |
| `distributeSenderKey` | `actor` 把自己在 `groupId` 的群密钥（没有就新建）作为 `skdm` 载荷加密给 `targets` | 同 `encrypt` |
| `encryptGroup` | `actor` 用自己的群密钥加密 `payloadJson`（没有就新建） | `body`（群信封） |
| `decryptGroup` | `actor` 解群信封 | `payloadJson` |
| `rotateSenderKey` | `actor` 丢掉自己在 `groupId` 的群密钥 | 无 |

期望输出是 `{ "error": true }` 的步骤必须失败，而且失败不能改变任何状态（解密失败要回滚）。

几个容易写错的地方，脚本里都有对应的步骤：

- 收到对方任何消息之前，发出的每一条都要用预密钥信封
- 预密钥消息乱序到达：后到的那条要在已有链路上用暂存的跳过密钥解开
- 双方同时发起：同一对端最多保留 3 条链路，解密时按最近使用的顺序逐条尝试，成功的那条变成当前发送链路
- 收到 `skdm` 载荷时要存下对方的群密钥；同一把密钥被重复分发时，已经推进过的链不能倒回去
- 分发群密钥时发的是这把密钥**创建时的初始状态**，不是当前状态
- 群消息不支持乱序：比当前位置更早的消息直接失败
