#!/usr/bin/env bash
# 导出一份可以公开的仓库：只有当前提交的文件，没有任何历史
# 用法：bash scripts/export-public.sh <目标目录>
#   目标目录必须不存在或为空；导出后在里面 git init 并做一个初始提交，再自己推到 GitHub
set -euo pipefail
cd "$(dirname "$0")/.."

DEST="${1:?用法：bash scripts/export-public.sh <目标目录>}"
if [ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
  echo "目标目录不是空的：$DEST" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交的改动，先提交再导出（导出的是当前提交，不含未提交内容）" >&2
  exit 1
fi

# 公开前最后一道检查：这些字样出现在任何被跟踪的文件里就拒绝导出
# 用 PRIVATE_PATTERNS 传入你自己的域名、IP 等，用 | 分隔，例如：
#   PRIVATE_PATTERNS='im\.mydomain\.com|203\.0\.113\.10' bash scripts/export-public.sh ../cipher-im-public
if [ -n "${PRIVATE_PATTERNS:-}" ]; then
  if git grep -nE "$PRIVATE_PATTERNS" -- . ':!package-lock.json'; then
    echo "上面这些行含有私有信息，清理后再导出" >&2
    exit 1
  fi
fi

mkdir -p "$DEST"
git archive --format=tar HEAD | tar -x -C "$DEST"
SRC_COMMIT="$(git rev-parse --short HEAD)"
cd "$DEST"
git init -q -b main
git add -A
git commit -q -m "Initial public release"
echo "已导出到 $DEST（来自私有仓库 ${SRC_COMMIT}，不含历史）"
git log --oneline
