import { FormEvent, useEffect, useState } from "react";
import type { AuthType, Machine, MachineDraft } from "../types";

interface MachineFormProps {
  machine: Machine | null;
  onClose: () => void;
  onSave: (draft: MachineDraft) => Promise<void>;
}

const emptyDraft: MachineDraft = {
  name: "",
  host: "",
  port: 22,
  username: "root",
  authType: "password",
  secret: ""
};

export function MachineForm({ machine, onClose, onSave }: MachineFormProps) {
  const [draft, setDraft] = useState<MachineDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft(
      machine
        ? {
            name: machine.name,
            host: machine.host,
            port: machine.port,
            username: machine.username,
            authType: machine.authType,
            secret: ""
          }
        : emptyDraft
    );
    setError("");
  }, [machine]);

  function update<K extends keyof MachineDraft>(key: K, value: MachineDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(draft);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="machine-form-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <p className="eyebrow">SSH HOST</p>
            <h2 id="machine-form-title">{machine ? "编辑机器" : "添加机器"}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <form onSubmit={submit} className="machine-form">
          <div className="field-grid two">
            <label>
              <span>机器名称</span>
              <input
                value={draft.name}
                onChange={(event) => update("name", event.target.value)}
                placeholder="例如：东京生产服务器"
                required
                maxLength={80}
              />
            </label>
            <label>
              <span>SSH 用户名</span>
              <input
                value={draft.username}
                onChange={(event) => update("username", event.target.value)}
                placeholder="root"
                required
                maxLength={128}
                autoComplete="off"
              />
            </label>
          </div>

          <div className="field-grid host-port">
            <label>
              <span>主机地址</span>
              <input
                value={draft.host}
                onChange={(event) => update("host", event.target.value)}
                placeholder="1.2.3.4 或 ssh.example.com"
                required
                maxLength={255}
                autoComplete="off"
              />
            </label>
            <label>
              <span>端口</span>
              <input
                type="number"
                value={draft.port}
                onChange={(event) => update("port", Number(event.target.value))}
                min={1}
                max={65535}
                required
              />
            </label>
          </div>

          <fieldset>
            <legend>认证方式</legend>
            <div className="segmented">
              {(["password", "privateKey"] as AuthType[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  className={draft.authType === type ? "active" : ""}
                  onClick={() => update("authType", type)}
                >
                  {type === "password" ? "SSH 密码" : "SSH 私钥"}
                </button>
              ))}
            </div>
          </fieldset>

          <label>
            <span>
              {draft.authType === "password" ? "SSH 密码" : "未加密私钥"}
              {machine && <small>留空即保留原凭据</small>}
            </span>
            {draft.authType === "password" ? (
              <input
                type="password"
                value={draft.secret}
                onChange={(event) => update("secret", event.target.value)}
                required={!machine}
                autoComplete="new-password"
                placeholder={machine ? "留空不修改" : "输入服务器 SSH 密码"}
              />
            ) : (
              <textarea
                value={draft.secret}
                onChange={(event) => update("secret", event.target.value)}
                required={!machine}
                rows={8}
                spellCheck={false}
                placeholder={machine ? "留空不修改" : "-----BEGIN OPENSSH PRIVATE KEY-----"}
              />
            )}
          </label>

          <p className="form-hint">
            凭据会使用 AES-256-GCM 加密后写入 Workers KV。当前版本不支持带口令的私钥。
          </p>
          {error && <div className="alert error">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="button ghost" onClick={onClose}>取消</button>
            <button type="submit" className="button primary" disabled={saving}>
              {saving ? "保存中…" : machine ? "保存修改" : "添加机器"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
