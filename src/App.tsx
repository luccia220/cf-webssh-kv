import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Login } from "./components/Login";
import { MachineForm } from "./components/MachineForm";
import { TerminalView } from "./components/TerminalView";
import type { Machine, MachineDraft } from "./types";

interface ConnectionTarget {
  machine: Machine;
  nonce: number;
}

export default function App() {
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loadingMachines, setLoadingMachines] = useState(false);
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingMachine, setEditingMachine] = useState<Machine | null>(null);
  const [connectionTarget, setConnectionTarget] = useState<ConnectionTarget | null>(null);
  const [pageError, setPageError] = useState("");

  useEffect(() => {
    void bootstrap();
  }, []);

  const filteredMachines = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return machines;
    return machines.filter((machine) =>
      [machine.name, machine.host, machine.username, String(machine.port)]
        .join(" ")
        .toLowerCase()
        .includes(query)
    );
  }, [machines, search]);

  async function bootstrap() {
    try {
      const isAuthenticated = await api.authStatus();
      setAuthenticated(isAuthenticated);
      if (isAuthenticated) await loadMachines();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "无法加载应用");
    } finally {
      setCheckingAuth(false);
    }
  }

  async function login(password: string) {
    await api.login(password);
    setAuthenticated(true);
    await loadMachines();
  }

  async function logout() {
    await api.logout();
    setAuthenticated(false);
    setMachines([]);
    setConnectionTarget(null);
  }

  async function loadMachines() {
    setLoadingMachines(true);
    setPageError("");
    try {
      setMachines(await api.listMachines());
    } catch (error) {
      if (error instanceof Error && error.message.includes("登录已过期")) {
        setAuthenticated(false);
      } else {
        setPageError(error instanceof Error ? error.message : "读取机器列表失败");
      }
    } finally {
      setLoadingMachines(false);
    }
  }

  function openCreateForm() {
    setEditingMachine(null);
    setFormOpen(true);
  }

  function openEditForm(machine: Machine) {
    setEditingMachine(machine);
    setFormOpen(true);
  }

  async function saveMachine(draft: MachineDraft) {
    if (editingMachine) {
      await api.updateMachine(editingMachine.id, draft);
    } else {
      await api.createMachine(draft);
    }
    await loadMachines();
  }

  async function removeMachine(machine: Machine) {
    const confirmed = window.confirm(`确定删除“${machine.name}”吗？保存的 SSH 凭据也会一并删除。`);
    if (!confirmed) return;
    try {
      await api.deleteMachine(machine.id);
      if (connectionTarget?.machine.id === machine.id) setConnectionTarget(null);
      await loadMachines();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "删除失败");
    }
  }

  function connectMachine(machine: Machine) {
    setConnectionTarget({ machine, nonce: Date.now() });
  }

  if (checkingAuth) {
    return (
      <main className="loading-screen">
        <div className="spinner" />
        <span>正在初始化 WebSSH…</span>
      </main>
    );
  }

  if (!authenticated) {
    return <Login onLogin={login} />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark small" aria-hidden="true">&gt;_</div>
          <div>
            <strong>Cloudflare WebSSH</strong>
            <span>Workers · KV · Browser WASM</span>
          </div>
        </div>
        <div className="topbar-actions">
          <span className="secure-badge"><i />后台已登录</span>
          <button className="button ghost small" onClick={logout}>退出登录</button>
        </div>
      </header>

      <main className="workspace">
        <aside className="machine-sidebar">
          <div className="sidebar-heading">
            <div>
              <p className="eyebrow">HOST INVENTORY</p>
              <h1>机器列表</h1>
            </div>
            <button className="button primary compact" onClick={openCreateForm}>＋ 添加</button>
          </div>

          <div className="search-box">
            <span aria-hidden="true">⌕</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索名称、IP 或用户"
              aria-label="搜索机器"
            />
          </div>

          {pageError && <div className="alert error sidebar-alert">{pageError}</div>}

          <div className="machine-count">
            <span>{filteredMachines.length} 台机器</span>
            <button onClick={loadMachines} disabled={loadingMachines}>
              {loadingMachines ? "刷新中" : "刷新"}
            </button>
          </div>

          <div className="machine-list">
            {!loadingMachines && filteredMachines.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">⌁</div>
                <strong>{machines.length ? "没有匹配结果" : "还没有保存机器"}</strong>
                <p>{machines.length ? "尝试其他关键词。" : "添加第一台 SSH 服务器后即可在线连接。"}</p>
                {!machines.length && <button className="button primary" onClick={openCreateForm}>添加机器</button>}
              </div>
            ) : (
              filteredMachines.map((machine) => {
                const active = connectionTarget?.machine.id === machine.id;
                return (
                  <article className={`machine-card ${active ? "active" : ""}`} key={machine.id}>
                    <div className="machine-card-head">
                      <div className="server-icon">▣</div>
                      <div className="machine-info">
                        <strong>{machine.name}</strong>
                        <span>{machine.username}@{machine.host}:{machine.port}</span>
                      </div>
                      <span className="auth-chip">{machine.authType === "password" ? "密码" : "私钥"}</span>
                    </div>
                    <div className="machine-card-actions">
                      <button className="button connect" onClick={() => connectMachine(machine)}>连接</button>
                      <button className="text-button" onClick={() => openEditForm(machine)}>编辑</button>
                      <button className="text-button danger" onClick={() => removeMachine(machine)}>删除</button>
                    </div>
                  </article>
                );
              })
            )}
          </div>

          <div className="sidebar-note">
            <strong>安全提示</strong>
            <p>建议仅个人使用，并为 Worker 绑定自己的域名或额外启用 Cloudflare Access。</p>
          </div>
        </aside>

        <TerminalView target={connectionTarget} />
      </main>

      {formOpen && (
        <MachineForm
          machine={editingMachine}
          onClose={() => setFormOpen(false)}
          onSave={saveMachine}
        />
      )}
    </div>
  );
}
