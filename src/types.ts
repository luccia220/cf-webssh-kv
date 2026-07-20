export type AuthType = "password" | "privateKey";

export interface Machine {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  createdAt: number;
  updatedAt: number;
}

export interface MachineDraft {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  secret: string;
}

export interface ConnectionPayload {
  machine: Pick<Machine, "id" | "name" | "host" | "port" | "username" | "authType">;
  credential: string;
  wsToken: string;
  expiresIn: number;
}
