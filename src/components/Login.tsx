import { FormEvent, useState } from "react";

interface LoginProps {
  onLogin: (password: string) => Promise<void>;
}

export function Login({ onLogin }: LoginProps) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password || loading) return;
    setLoading(true);
    setError("");
    try {
      await onLogin(password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark" aria-hidden="true">&gt;_</div>
        <p className="eyebrow">CLOUDFLARE WORKERS</p>
        <h1>WebSSH 控制台</h1>
        <p className="muted login-copy">使用后台密码进入服务器管理面板。</p>

        <form onSubmit={submit} className="login-form">
          <label htmlFor="admin-password">后台密码</label>
          <input
            id="admin-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
            placeholder="输入 ADMIN_PASSWORD"
          />
          {error && <div className="alert error">{error}</div>}
          <button className="button primary full" type="submit" disabled={loading || !password}>
            {loading ? "正在验证…" : "安全登录"}
          </button>
        </form>

        <div className="login-security">
          <span className="status-dot" />
          密码由 Cloudflare Secret 保存，不写入 GitHub 仓库
        </div>
      </section>
    </main>
  );
}
