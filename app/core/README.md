# cipher_core

Cipher IM 原生客户端的核心库（纯 Dart，不依赖 Flutter）：

- `src/crypto/`：端到端加密协议，和 Web 端（`src/shared/crypto/`）逐字节兼容
- `src/net/`：服务器地址校验（不内置任何服务器）、HTTP 接口、WebSocket 长连接（首帧认证、心跳、断线重连、离线排队）

```bash
dart pub get
dart test        # vectors_test：用 ../../spec/vectors/crypto-v1.json 逐项核对
                 # server_test：起一个真实的本地服务端联测（需要先在仓库根目录 bash scripts/build.sh）
```

兼容性由测试数据保证，格式见 [`spec/vectors/README.md`](../../spec/vectors/README.md)。改了 Web 端的加密代码，先 `bash scripts/vectors.sh export` 重新导出，再回来跑这里的测试。

> 仓库放在网络共享路径上时，`dart analyze` 会因为探测不存在的 UNC 路径而崩溃（工具本身的问题）；把这个目录复制到本地盘再分析即可。
