# Cloudflare WebSSH（Workers + KV 版）

一个可直接上传到 GitHub，并通过 **Cloudflare Workers Builds** 部署的 WebSSH 管理工具。

本版本只使用：

- Cloudflare Workers
- Workers KV
- Workers Static Assets
- GitHub

**不使用 D1，不需要 SQL，不需要数据库迁移。**

## 已包含的功能

- 后台单密码登录
- `HttpOnly + Secure + SameSite=Strict` 登录 Cookie
- 登录失败限流：15 分钟内连续失败 5 次后临时锁定
- 保存、编辑、删除 SSH 机器
- 支持 SSH 密码认证
- 支持未加密的 OpenSSH / PEM 私钥认证
- SSH 密码或私钥经 AES-256-GCM 加密后保存到 Workers KV
- 90 秒自动过期的 KV WebSocket 连接令牌
- 浏览器内 WebAssembly SSH 客户端
- Cloudflare Worker WebSocket → TCP 中继
- React + xterm.js 响应式管理界面
- GitHub Actions 构建检查

## 架构

```text
浏览器
  ├─ React + xterm.js 管理界面
  ├─ sshclient-wasm 在浏览器内执行 SSH 协议
  └─ WSS 二进制数据
          ↓
Cloudflare Worker
  ├─ 后台登录与会话鉴权
  ├─ Workers KV 保存机器、限流记录及短期连接令牌
  ├─ AES-256-GCM 加密 SSH 凭据
  └─ WebSocket 转 TCP Socket
          ↓
公网 SSH 服务器:端口
```

Worker 不解析 SSH 协议。SSH 握手及会话加密由浏览器中的 WASM 客户端完成；Worker 只把经过后台鉴权的 WebSocket 字节流转发到保存的 SSH 地址。

---

## 一、上传到 GitHub

1. 解压 ZIP。
2. 在 GitHub 新建一个私有仓库。
3. 把 `cf-webssh-kv` 文件夹内的全部文件上传到仓库根目录。
4. 不要提交真实密码、Secret 或 `.dev.vars`。

命令示例：

```bash
git init
git add .
git commit -m "Initial Cloudflare WebSSH KV"
git branch -M main
git remote add origin 你的GitHub仓库地址
git push -u origin main
```


## Cloudflare 构建依赖说明

本仓库使用 `pnpm@10.11.1` 和 `pnpm-lock.yaml`，不再包含 `package-lock.json`。Cloudflare Workers Builds 会自动选择 pnpm 安装依赖，从而避开其默认 npm 10.9.2 偶发的 `Exit handler never called` 安装异常。

如果此前已经用 npm 版本构建过，上传本版本后请确认仓库根目录中不存在旧的 `package-lock.json`。建议在 Cloudflare 的构建设置中清除一次构建缓存，然后重新部署。

推荐构建设置：

```text
Build command: pnpm run build
Deploy command: pnpm exec wrangler deploy
Root directory: /
Production branch: main
```

## 二、在 Cloudflare 连接 GitHub

1. 登录 Cloudflare Dashboard。
2. 进入 **Workers & Pages**。
3. 创建 Worker，并连接现有 GitHub 仓库。
4. 选择刚上传的仓库。
5. 使用以下构建设置：

```text
Build command: pnpm run build
Deploy command: pnpm exec wrangler deploy
Root directory: /
Production branch: main
```

仓库中的 `wrangler.jsonc` 已声明：

```json
"kv_namespaces": [
  {
    "binding": "WEBSSH_KV"
  }
]
```

当前 Wrangler 支持在部署时自动配置缺少资源 ID 的 KV binding。首次部署时，Cloudflare 会为 `WEBSSH_KV` 创建并绑定 KV 空间。

### 如果自动创建失败

可在本地项目目录手工创建：

```bash
pnpm install
pnpm exec wrangler login
pnpm exec wrangler kv namespace create WEBSSH_KV
```

命令返回 KV namespace ID 后，把 `wrangler.jsonc` 改为：

```json
"kv_namespaces": [
  {
    "binding": "WEBSSH_KV",
    "id": "你的KV_NAMESPACE_ID"
  }
]
```

提交到 GitHub 后重新部署。

## 三、配置三个 Secret

进入已部署的 Worker：

```text
Settings → Variables and Secrets → Add
```

添加以下三个变量，并选择 **Secret** 类型：

| 名称 | 用途 | 要求 |
|---|---|---|
| `ADMIN_PASSWORD` | WebSSH 后台登录密码 | 至少 8 位，建议 16 位以上 |
| `SESSION_SECRET` | 登录 Cookie 签名和 IP 匿名散列 | 至少 32 个随机字符 |
| `CREDENTIALS_KEY` | 加密 SSH 密码和私钥 | 32 字节随机值的 Base64 |

### macOS / Linux

```bash
# SESSION_SECRET
openssl rand -hex 32

# CREDENTIALS_KEY
openssl rand -base64 32
```

### Windows PowerShell

```powershell
# SESSION_SECRET
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToHexString($bytes).ToLower()

# CREDENTIALS_KEY
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

也可以使用 Wrangler：

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put CREDENTIALS_KEY
```

## 四、使用

1. 打开 Worker 提供的 `workers.dev` 地址或自定义域名。
2. 输入 `ADMIN_PASSWORD`。
3. 点击 **添加机器**。
4. 填写机器名称、主机、端口、用户名和认证凭据。
5. 点击机器卡片中的 **连接**。

目标服务器必须允许 Cloudflare Worker 访问对应的 TCP SSH 端口。建议使用 SSH 密钥、普通用户、非默认端口和 Cloudflare Access 二次保护。

## 本地调试

复制本地 Secret 模板：

```bash
cp .dev.vars.example .dev.vars
```

填写三个变量后执行：

```bash
pnpm install
pnpm run dev
```

Wrangler 本地开发默认使用本地 KV 数据，不会改动线上 KV。仅调试前端：

```bash
pnpm run dev:ui
```

## KV 键结构

```text
machine:<UUID>                       加密后的机器完整记录
login-attempt:<IP_HASH>:<TIME>:<ID>  15 分钟自动过期的失败记录
login-block:<IP_HASH>                15 分钟自动过期的锁定记录
ws-token:<SHA256>                    90 秒自动过期的 SSH 连接令牌
```

机器凭据不会以明文保存在 KV；机器列表使用 KV metadata 返回，不会在列表接口中泄露加密凭据。

## 安全说明

### SSH 主机指纹

当前依赖的 `sshclient-wasm` 上游实现不会像 OpenSSH `known_hosts` 一样校验服务器主机指纹。因此本工具不能主动识别 SSH 主机指纹变化或中间人攻击。

建议：

- 只连接可信服务器。
- 在 Worker 前增加 Cloudflare Access。
- 不要公开给不受信任的多人共用。
- 高敏感服务器继续优先使用本地 OpenSSH。

### 凭据处理

- SSH 密码或私钥通过 `CREDENTIALS_KEY` 使用 AES-256-GCM 加密后写入 KV。
- 点击连接时，Worker 解密凭据，通过同源 HTTPS 返回给已登录浏览器。
- 浏览器 WASM 使用该凭据完成 SSH 认证。
- 丢失或更换 `CREDENTIALS_KEY` 后，之前保存的凭据无法解密，需要重新保存机器。
- 后台管理员本质上有权连接所有已保存机器，必须使用高强度密码并保护后台地址。

### KV 一致性

Workers KV 是最终一致性存储。保存、修改或删除机器后，在极少数跨地区访问情况下可能短时间看到旧数据。单管理员后台通常不受明显影响。

登录限流采用“每次失败写入一个独立短期键”的方式，避免对同一个 KV 键进行高频写入。

### 私钥限制

当前支持未加密私钥。带 passphrase 的私钥暂不支持。建议为本工具单独创建权限受限的 SSH Key。

## 常见问题

### 显示“服务暂时不可用”

检查：

- `WEBSSH_KV` 是否已经绑定。
- 三个 Secret 是否已添加。
- `ADMIN_PASSWORD` 是否至少 8 位。
- `SESSION_SECRET` 是否至少 32 位。
- `CREDENTIALS_KEY` 是否为真正的 32 字节 Base64。
- Worker 日志是否存在 KV binding 错误。

### SSH 一直连接失败

检查：

- 主机只填写 IP 或域名，不要填写 `ssh://`。
- SSH 端口是否可从公网访问。
- 云服务器安全组和系统防火墙是否放行。
- 用户名、密码或私钥是否正确。
- SSH 服务是否允许对应认证方式。
- Cloudflare Workers 不允许连接部分受限目标和端口；本项目也拒绝保存 TCP 25 端口。

### 修改机器但不修改凭据

编辑机器时将密码或私钥留空，原有加密凭据会保留。切换认证类型时必须填写新凭据。

## 主要文件

```text
worker/index.ts                   Worker API、KV、鉴权、加密、TCP 中继
src/components/TerminalView.tsx  浏览器 WASM SSH 与 xterm.js 终端
src/components/MachineForm.tsx   机器添加和编辑
src/components/Login.tsx         后台登录
src/App.tsx                      管理后台
scripts/copy-wasm.mjs            构建时复制 WASM 文件
wrangler.jsonc                   Worker、Static Assets 和 KV 配置
.dev.vars.example                本地 Secret 示例
.github/workflows/check.yml      GitHub 构建检查
```

## 第三方依赖

- `sshclient-wasm`：BSD-3-Clause
- React
- xterm.js
- Cloudflare Workers / Workers KV

本项目自身使用 MIT License。
