import type { ConnectionPayload, Machine, MachineDraft } from "./types";

interface ApiErrorBody {
  error?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers
    }
  });

  const body = (await response.json().catch(() => ({}))) as T & ApiErrorBody;
  if (!response.ok) {
    throw new Error(body.error || `请求失败（HTTP ${response.status}）`);
  }
  return body;
}

export const api = {
  async authStatus(): Promise<boolean> {
    const data = await request<{ authenticated: boolean }>("/api/auth/status");
    return data.authenticated;
  },

  async login(password: string): Promise<void> {
    await request<{ ok: true }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password })
    });
  },

  async logout(): Promise<void> {
    await request<{ ok: true }>("/api/auth/logout", { method: "POST" });
  },

  async listMachines(): Promise<Machine[]> {
    const data = await request<{ machines: Machine[] }>("/api/machines");
    return data.machines;
  },

  async createMachine(machine: MachineDraft): Promise<void> {
    await request<{ ok: true }>("/api/machines", {
      method: "POST",
      body: JSON.stringify(machine)
    });
  },

  async updateMachine(id: string, machine: MachineDraft): Promise<void> {
    await request<{ ok: true }>(`/api/machines/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(machine)
    });
  },

  async deleteMachine(id: string): Promise<void> {
    await request<{ ok: true }>(`/api/machines/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
  },

  async prepareConnection(id: string): Promise<ConnectionPayload> {
    return request<ConnectionPayload>(`/api/machines/${encodeURIComponent(id)}/connect`, {
      method: "POST"
    });
  }
};
