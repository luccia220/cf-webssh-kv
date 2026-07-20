import { connect } from "cloudflare:sockets";

interface Env {
  WEBSSH_KV: KVNamespace;
  ASSETS: Fetcher;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  CREDENTIALS_KEY: string;
}

interface MachineRecord {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "privateKey";
  secretCipher: string;
  secretIv: string;
  createdAt: number;
  updatedAt: number;
}

type MachineMetadata = Omit<MachineRecord, "secretCipher" | "secretIv">;

interface SessionClaims {
  type: "session";
  exp: number;
  nonce: string;
}

interface WsTokenRecord {
  machineId: string;
  createdAt: number;
}

interface MachineInput {
  name?: unknown;
  host?: unknown;
  port?: unknown;
  username?: unknown;
  authType?: unknown;
  secret?: unknown;
}

const SESSION_COOKIE = "cf_webssh_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const WS_TOKEN_TTL_SECONDS = 90;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_BLOCK_SECONDS = 15 * 60;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_JSON_BYTES = 150_000;
const MACHINE_PREFIX = "machine:";
const LOGIN_ATTEMPT_PREFIX = "login-attempt:";
const LOGIN_BLOCK_PREFIX = "login-block:";
const WS_TOKEN_PREFIX = "ws-token:";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (url.pathname.startsWith("/api/")) {
        assertConfiguration(env);
        const response = await handleApi(request, env, ctx, url);
        return response.status === 101 ? response : secureResponse(response, true);
      }

      const assetResponse = await env.ASSETS.fetch(request);
      return secureResponse(assetResponse, false);
    } catch (error) {
      if (error instanceof HttpError) {
        return secureResponse(json({ error: error.message.trim() }, error.status), true);
      }
      console.error("Unhandled Worker error", error);
      return secureResponse(
        json({ error: "服务暂时不可用，请检查 Worker 日志和环境配置。" }, 500),
        true
      );
    }
  }
} satisfies ExportedHandler<Env>;

async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({ ok: true, service: "cf-webssh-kv" });
  }

  if (url.pathname === "/api/auth/status" && request.method === "GET") {
    const authenticated = await isAuthenticated(request, env);
    return json({ authenticated });
  }

  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    requireSameOrigin(request);
    return login(request, env);
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    requireSameOrigin(request);
    return logout();
  }

  await requireAuthentication(request, env);

  if (url.pathname === "/api/machines" && request.method === "GET") {
    return listMachines(env);
  }

  if (url.pathname === "/api/machines" && request.method === "POST") {
    requireSameOrigin(request);
    return createMachine(request, env);
  }

  const machineMatch = url.pathname.match(/^\/api\/machines\/([^/]+)$/);
  if (machineMatch) {
    const machineId = decodeURIComponent(machineMatch[1]);
    if (request.method === "PUT") {
      requireSameOrigin(request);
      return updateMachine(request, env, machineId);
    }
    if (request.method === "DELETE") {
      requireSameOrigin(request);
      return deleteMachine(env, machineId);
    }
  }

  const connectMatch = url.pathname.match(/^\/api\/machines\/([^/]+)\/connect$/);
  if (connectMatch && request.method === "POST") {
    requireSameOrigin(request);
    return prepareConnection(env, decodeURIComponent(connectMatch[1]));
  }

  if (url.pathname === "/api/ssh" && request.method === "GET") {
    requireSameOrigin(request);
    return openSshTunnel(request, env, ctx, url);
  }

  return json({ error: "接口不存在。" }, 404);
}

function assertConfiguration(env: Env): void {
  if (!env.WEBSSH_KV || !env.ASSETS) {
    throw new Error("Missing WEBSSH_KV or ASSETS binding");
  }
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 8) {
    throw new Error("ADMIN_PASSWORD must contain at least 8 characters");
  }
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  }
  const encryptionKey = decodeBase64(env.CREDENTIALS_KEY || "");
  if (encryptionKey.byteLength !== 32) {
    throw new Error("CREDENTIALS_KEY must be a base64 encoded 32-byte value");
  }
}

async function login(request: Request, env: Env): Promise<Response> {
  const ipHash = await getClientHash(request, env);
  const now = unixNow();
  const blockedUntil = await getBlockedUntil(env, ipHash);

  if (blockedUntil > now) {
    const retryAfter = blockedUntil - now;
    return new Response(
      JSON.stringify({ error: `尝试次数过多，请在 ${retryAfter} 秒后重试。` }),
      {
        status: 429,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "retry-after": String(retryAfter)
        }
      }
    );
  }

  const body = await readJson<{ password?: unknown }>(request);
  const password = typeof body.password === "string" ? body.password : "";
  const passwordValid = await securePasswordCompare(password, env.ADMIN_PASSWORD, env.SESSION_SECRET);

  if (!passwordValid) {
    const attemptCount = await countLoginAttempts(env, ipHash);
    await recordFailedLogin(env, ipHash, attemptCount, now);
    return json({ error: "后台密码错误。" }, 401);
  }

  await clearLoginRateLimit(env, ipHash);
  const token = await signSessionClaims(
    {
      type: "session",
      exp: now + SESSION_TTL_SECONDS,
      nonce: crypto.randomUUID()
    },
    env.SESSION_SECRET
  );

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": serializeSessionCookie(token, SESSION_TTL_SECONDS)
    }
  });
}

function logout(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": serializeSessionCookie("", 0)
    }
  });
}

async function listMachines(env: Env): Promise<Response> {
  const keys = await listAllKvKeys<MachineMetadata>(env.WEBSSH_KV, MACHINE_PREFIX);
  const machines = keys
    .map((key) => key.metadata)
    .filter((metadata): metadata is MachineMetadata => isMachineMetadata(metadata))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return json({ machines });
}

async function createMachine(request: Request, env: Env): Promise<Response> {
  const body = await readJson<MachineInput>(request);
  const input = validateMachineInput(body, true);
  const encrypted = await encryptSecret(input.secret, env.CREDENTIALS_KEY);
  const id = crypto.randomUUID();
  const now = unixNow();
  const machine: MachineRecord = {
    id,
    name: input.name,
    host: input.host,
    port: input.port,
    username: input.username,
    authType: input.authType,
    secretCipher: encrypted.cipher,
    secretIv: encrypted.iv,
    createdAt: now,
    updatedAt: now
  };

  await saveMachine(env, machine);
  return json({ ok: true, id }, 201);
}

async function updateMachine(request: Request, env: Env, machineId: string): Promise<Response> {
  const existing = await getMachine(env, machineId);
  if (!existing) {
    return json({ error: "机器不存在。" }, 404);
  }

  const body = await readJson<MachineInput>(request);
  const input = validateMachineInput(body, body.authType !== existing.authType);
  let secretCipher = existing.secretCipher;
  let secretIv = existing.secretIv;

  if (input.secret) {
    const encrypted = await encryptSecret(input.secret, env.CREDENTIALS_KEY);
    secretCipher = encrypted.cipher;
    secretIv = encrypted.iv;
  }

  const machine: MachineRecord = {
    ...existing,
    name: input.name,
    host: input.host,
    port: input.port,
    username: input.username,
    authType: input.authType,
    secretCipher,
    secretIv,
    updatedAt: unixNow()
  };

  await saveMachine(env, machine);
  return json({ ok: true });
}

async function deleteMachine(env: Env, machineId: string): Promise<Response> {
  const machine = await getMachine(env, machineId);
  if (!machine) {
    return json({ error: "机器不存在。" }, 404);
  }
  await env.WEBSSH_KV.delete(machineKey(machineId));
  return json({ ok: true });
}

async function prepareConnection(env: Env, machineId: string): Promise<Response> {
  const machine = await getMachine(env, machineId);
  if (!machine) {
    return json({ error: "机器不存在。" }, 404);
  }

  const secret = await decryptSecret(machine.secretCipher, machine.secretIv, env.CREDENTIALS_KEY);
  const wsToken = randomToken(32);
  const tokenKey = await wsTokenKey(wsToken);
  const tokenRecord: WsTokenRecord = { machineId, createdAt: unixNow() };

  await env.WEBSSH_KV.put(tokenKey, JSON.stringify(tokenRecord), {
    expirationTtl: WS_TOKEN_TTL_SECONDS
  });

  return json({
    machine: {
      id: machine.id,
      name: machine.name,
      host: machine.host,
      port: machine.port,
      username: machine.username,
      authType: machine.authType
    },
    credential: secret,
    wsToken,
    expiresIn: WS_TOKEN_TTL_SECONDS
  });
}

async function openSshTunnel(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL
): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "此接口仅接受 WebSocket。" }, 426);
  }

  const token = url.searchParams.get("token") || "";
  if (token.length < 32 || token.length > 256) {
    return json({ error: "连接令牌无效或已过期。" }, 401);
  }

  const tokenKey = await wsTokenKey(token);
  const tokenRecord = await env.WEBSSH_KV.get<WsTokenRecord>(tokenKey, "json");
  if (!tokenRecord || !isUuid(tokenRecord.machineId)) {
    return json({ error: "连接令牌无效或已过期。" }, 401);
  }

  await env.WEBSSH_KV.delete(tokenKey);
  const machine = await getMachine(env, tokenRecord.machineId);
  if (!machine) {
    return json({ error: "机器不存在。" }, 404);
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  ctx.waitUntil(bridgeTcp(server, machine.host, machine.port));

  return new Response(null, {
    status: 101,
    webSocket: client
  });
}

async function bridgeTcp(webSocket: WebSocket, host: string, port: number): Promise<void> {
  const socket = connect({ hostname: host, port }, { secureTransport: "off", allowHalfOpen: false });
  const writer = socket.writable.getWriter();
  let closed = false;
  let writeQueue: Promise<void> = Promise.resolve();

  const closeAll = (code = 1000, reason = "Connection closed") => {
    if (closed) return;
    closed = true;
    try {
      webSocket.close(code, reason.slice(0, 120));
    } catch {
      // Ignore close races.
    }
    try {
      socket.close();
    } catch {
      // Ignore close races.
    }
  };

  webSocket.addEventListener("message", (event) => {
    if (closed) return;
    const bytes = webSocketDataToBytes(event.data);
    if (!bytes) {
      closeAll(1003, "Binary WebSocket frames required");
      return;
    }
    writeQueue = writeQueue
      .then(() => writer.write(bytes))
      .catch((error) => {
        console.error("TCP write failed", error);
        closeAll(1011, "TCP write failed");
      });
  });

  webSocket.addEventListener("close", () => closeAll());
  webSocket.addEventListener("error", () => closeAll(1011, "WebSocket error"));

  try {
    await socket.opened;
    const reader = socket.readable.getReader();
    try {
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          webSocket.send(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    await socket.closed.catch(() => undefined);
    closeAll(1000, "SSH server closed the connection");
  } catch (error) {
    console.error(`TCP connection failed for ${host}:${port}`, error);
    closeAll(1011, "Unable to reach SSH server");
  } finally {
    await writeQueue.catch(() => undefined);
    try {
      writer.releaseLock();
    } catch {
      // Ignore release races.
    }
  }
}

function webSocketDataToBytes(data: string | ArrayBuffer): Uint8Array | null {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  return null;
}

async function getMachine(env: Env, id: string): Promise<MachineRecord | null> {
  if (!isUuid(id)) return null;
  const machine = await env.WEBSSH_KV.get<MachineRecord>(machineKey(id), "json");
  return machine && isMachineRecord(machine) ? machine : null;
}

async function saveMachine(env: Env, machine: MachineRecord): Promise<void> {
  const metadata: MachineMetadata = {
    id: machine.id,
    name: machine.name,
    host: machine.host,
    port: machine.port,
    username: machine.username,
    authType: machine.authType,
    createdAt: machine.createdAt,
    updatedAt: machine.updatedAt
  };

  await env.WEBSSH_KV.put(machineKey(machine.id), JSON.stringify(machine), { metadata });
}

function machineKey(id: string): string {
  return `${MACHINE_PREFIX}${id}`;
}

function isMachineMetadata(value: unknown): value is MachineMetadata {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<MachineMetadata>;
  return (
    typeof item.id === "string" &&
    isUuid(item.id) &&
    typeof item.name === "string" &&
    typeof item.host === "string" &&
    typeof item.port === "number" &&
    typeof item.username === "string" &&
    (item.authType === "password" || item.authType === "privateKey") &&
    typeof item.createdAt === "number" &&
    typeof item.updatedAt === "number"
  );
}

function isMachineRecord(value: unknown): value is MachineRecord {
  if (!isMachineMetadata(value)) return false;
  const item = value as Partial<MachineRecord>;
  return typeof item.secretCipher === "string" && typeof item.secretIv === "string";
}

async function listAllKvKeys<Metadata>(
  namespace: KVNamespace,
  prefix: string
): Promise<KVNamespaceListKey<Metadata>[]> {
  const keys: KVNamespaceListKey<Metadata>[] = [];
  let cursor: string | undefined;

  do {
    const page = await namespace.list<Metadata>({ prefix, cursor, limit: 1000 });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return keys;
}

function validateMachineInput(body: MachineInput, requireSecret: boolean): {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "privateKey";
  secret: string;
} {
  const name = cleanString(body.name, "机器名称", 1, 80);
  const host = cleanString(body.host, "主机地址", 1, 255);
  const username = cleanString(body.username, "SSH 用户名", 1, 128);
  const authType = body.authType;
  const secret = typeof body.secret === "string" ? body.secret : "";
  const port = typeof body.port === "number" ? body.port : Number(body.port);

  if (authType !== "password" && authType !== "privateKey") {
    throw new HttpError(400, "认证类型无效。请选择密码或私钥。 ");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 25) {
    throw new HttpError(400, "SSH 端口必须为 1–65535，且 Cloudflare 不允许连接 25 端口。 ");
  }
  if (/\s/.test(host) || /[\/@?#]/.test(host)) {
    throw new HttpError(400, "主机地址只能填写域名或 IP，不要包含协议、路径或空格。 ");
  }
  if (secret.length > 100_000) {
    throw new HttpError(400, "密码或私钥内容过长。 ");
  }
  if (requireSecret && !secret) {
    throw new HttpError(400, authType === "password" ? "请输入 SSH 密码。" : "请输入 SSH 私钥。 ");
  }
  if (authType === "privateKey" && secret && !secret.includes("PRIVATE KEY")) {
    throw new HttpError(400, "私钥格式不正确，应包含 PRIVATE KEY 标头。 ");
  }

  return { name, host, port, username, authType, secret };
}

function cleanString(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string") {
    throw new HttpError(400, `${label}格式错误。`);
  }
  const result = value.trim();
  if (result.length < min || result.length > max) {
    throw new HttpError(400, `${label}长度必须在 ${min}–${max} 个字符之间。`);
  }
  return result;
}

async function readJson<T>(request: Request): Promise<T> {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_JSON_BYTES) {
    throw new HttpError(413, "请求内容过大。 ");
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    throw new HttpError(413, "请求内容过大。 ");
  }

  try {
    return JSON.parse(text || "{}") as T;
  } catch {
    throw new HttpError(400, "JSON 格式错误。 ");
  }
}

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return false;
  const claims = await verifySessionClaims(token, env.SESSION_SECRET);
  return Boolean(claims);
}

async function requireAuthentication(request: Request, env: Env): Promise<SessionClaims> {
  const token = getCookie(request, SESSION_COOKIE);
  const claims = token ? await verifySessionClaims(token, env.SESSION_SECRET) : null;
  if (!claims) {
    throw new HttpError(401, "登录已过期，请重新登录。 ");
  }
  return claims;
}

function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  if (origin !== new URL(request.url).origin) {
    throw new HttpError(403, "跨站请求已被拒绝。 ");
  }
}

async function signSessionClaims(claims: SessionClaims, secret: string): Promise<string> {
  const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await hmac(payload, secret);
  return `${payload}.${encodeBase64Url(signature)}`;
}

async function verifySessionClaims(token: string, secret: string): Promise<SessionClaims | null> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;

  try {
    const expected = await hmac(payload, secret);
    const actual = decodeBase64Url(signature);
    if (!timingSafeEqual(expected, actual)) return null;

    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as SessionClaims;
    if (!claims || claims.type !== "session") return null;
    if (typeof claims.exp !== "number" || claims.exp <= unixNow()) return null;
    if (typeof claims.nonce !== "string") return null;
    return claims;
  } catch {
    return null;
  }
}

async function hmac(message: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function securePasswordCompare(input: string, expected: string, secret: string): Promise<boolean> {
  const [actualDigest, expectedDigest] = await Promise.all([
    hmac(`admin-password:${input}`, secret),
    hmac(`admin-password:${expected}`, secret)
  ]);
  return timingSafeEqual(actualDigest, expectedDigest);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let i = 0; i < a.byteLength; i += 1) {
    difference |= a[i] ^ b[i];
  }
  return difference === 0;
}

async function encryptSecret(secret: string, encodedKey: string): Promise<{ cipher: string; iv: string }> {
  const key = await importEncryptionKey(encodedKey, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(new TextEncoder().encode(secret))
  );
  return {
    cipher: encodeBase64Url(new Uint8Array(encrypted)),
    iv: encodeBase64Url(iv)
  };
}

async function decryptSecret(cipher: string, iv: string, encodedKey: string): Promise<string> {
  const key = await importEncryptionKey(encodedKey, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(decodeBase64Url(iv)) },
    key,
    toArrayBuffer(decodeBase64Url(cipher))
  );
  return new TextDecoder().decode(decrypted);
}

async function importEncryptionKey(encodedKey: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(decodeBase64(encodedKey)),
    { name: "AES-GCM" },
    false,
    usages
  );
}

async function getClientHash(request: Request, env: Env): Promise<string> {
  const clientIp = request.headers.get("cf-connecting-ip") || "unknown";
  return encodeBase64Url(await hmac(`client-ip:${clientIp}`, env.SESSION_SECRET));
}

async function getBlockedUntil(env: Env, ipHash: string): Promise<number> {
  const value = await env.WEBSSH_KV.get(`${LOGIN_BLOCK_PREFIX}${ipHash}`);
  const blockedUntil = Number(value || "0");
  return Number.isFinite(blockedUntil) ? blockedUntil : 0;
}

async function countLoginAttempts(env: Env, ipHash: string): Promise<number> {
  const prefix = `${LOGIN_ATTEMPT_PREFIX}${ipHash}:`;
  const keys = await listAllKvKeys(env.WEBSSH_KV, prefix);
  return keys.length;
}

async function recordFailedLogin(
  env: Env,
  ipHash: string,
  existingAttempts: number,
  now: number
): Promise<void> {
  const attemptKey = `${LOGIN_ATTEMPT_PREFIX}${ipHash}:${now}:${crypto.randomUUID()}`;
  await env.WEBSSH_KV.put(attemptKey, "1", { expirationTtl: LOGIN_WINDOW_SECONDS });

  if (existingAttempts + 1 >= MAX_LOGIN_ATTEMPTS) {
    const blockedUntil = now + LOGIN_BLOCK_SECONDS;
    await env.WEBSSH_KV.put(`${LOGIN_BLOCK_PREFIX}${ipHash}`, String(blockedUntil), {
      expirationTtl: LOGIN_BLOCK_SECONDS
    });
  }
}

async function clearLoginRateLimit(env: Env, ipHash: string): Promise<void> {
  const prefix = `${LOGIN_ATTEMPT_PREFIX}${ipHash}:`;
  const keys = await listAllKvKeys(env.WEBSSH_KV, prefix);
  await Promise.all([
    env.WEBSSH_KV.delete(`${LOGIN_BLOCK_PREFIX}${ipHash}`),
    ...keys.map((key) => env.WEBSSH_KV.delete(key.name))
  ]);
}

function randomToken(byteLength: number): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function wsTokenKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return `${WS_TOKEN_PREFIX}${encodeBase64Url(new Uint8Array(digest))}`;
}

function serializeSessionCookie(token: string, maxAge: number): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${maxAge}`
  ].join("; ");
}

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (key === name) {
      return decodeURIComponent(valueParts.join("="));
    }
  }
  return null;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return decodeBase64(padded);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function secureResponse(response: Response, isApi: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ws: wss:"
  );
  if (isApi) {
    headers.set("Cache-Control", "no-store, max-age=0");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
