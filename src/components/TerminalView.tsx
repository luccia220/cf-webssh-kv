import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { SSHClient, WebSocketTransport, type SSHSession } from "sshclient-wasm";
import { api } from "../api";
import type { Machine } from "../types";

interface ConnectionTarget {
  machine: Machine;
  nonce: number;
}

interface TerminalViewProps {
  target: ConnectionTarget | null;
}

let sshInitialization: Promise<void> | null = null;

function initializeSshClient(): Promise<void> {
  if (!sshInitialization) {
    sshInitialization = SSHClient.initialize({
      wasmPath: "/sshclient.wasm",
      wasmExecPath: "/wasm_exec.js",
      autoDetect: false,
      cacheBusting: false,
      timeout: 20_000
    }).catch((error) => {
      sshInitialization = null;
      throw error;
    });
  }
  return sshInitialization!;
}

export function TerminalView({ target }: TerminalViewProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<SSHSession | null>(null);
  const sendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const connectionRunRef = useRef(0);
  const [state, setState] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [label, setLabel] = useState("尚未连接");

  useEffect(() => {
    if (!mountRef.current) return;

    const fit = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.22,
      scrollback: 5000,
      allowTransparency: true,
      theme: {
        background: "#080c16",
        foreground: "#d7e0ee",
        cursor: "#53e3a6",
        cursorAccent: "#080c16",
        selectionBackground: "#2c405c",
        black: "#101624",
        red: "#ff6b7a",
        green: "#53e3a6",
        yellow: "#f5c86a",
        blue: "#6ea8ff",
        magenta: "#bd8cff",
        cyan: "#63d5e8",
        white: "#d7e0ee"
      }
    });

    terminal.loadAddon(fit);
    terminal.open(mountRef.current);
    fit.fit();
    terminal.writeln("\x1b[38;5;110mCloudflare WebSSH\x1b[0m");
    terminal.writeln("选择左侧机器并点击“连接”，终端将在这里打开。\r\n");

    const inputSubscription = terminal.onData((data) => {
      const session = sessionRef.current;
      if (!session) return;
      const bytes = new TextEncoder().encode(data);
      sendQueueRef.current = sendQueueRef.current
        .then(() => session.send(bytes))
        .catch((error) => {
          terminal.writeln(`\r\n\x1b[31m发送失败：${formatError(error)}\x1b[0m`);
        });
    });

    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(() => {
        try {
          fit.fit();
          const session = sessionRef.current;
          if (session) void session.resizeTerminal(terminal.cols, terminal.rows).catch(() => undefined);
        } catch {
          // The terminal may be unmounting.
        }
      });
    });
    resizeObserver.observe(mountRef.current);

    terminalRef.current = terminal;
    fitRef.current = fit;

    return () => {
      resizeObserver.disconnect();
      inputSubscription.dispose();
      void disconnectCurrent();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!target) return;
    void connectTarget(target);
    // nonce intentionally retriggers a connection to the same machine.
  }, [target?.nonce]);

  async function disconnectCurrent() {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      await session.disconnect().catch(() => undefined);
    }
  }

  async function connectTarget(nextTarget: ConnectionTarget) {
    const terminal = terminalRef.current;
    const fit = fitRef.current;
    if (!terminal || !fit) return;

    const runId = ++connectionRunRef.current;
    setState("connecting");
    setLabel(`正在连接 ${nextTarget.machine.name}`);
    await disconnectCurrent();
    terminal.clear();
    terminal.writeln(`\x1b[38;5;110m正在连接 ${nextTarget.machine.username}@${nextTarget.machine.host}:${nextTarget.machine.port}…\x1b[0m`);

    try {
      const payload = await api.prepareConnection(nextTarget.machine.id);
      await initializeSshClient();
      if (runId !== connectionRunRef.current) return;

      const wsScheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${wsScheme}//${window.location.host}/api/ssh?token=${encodeURIComponent(payload.wsToken)}`;
      const transport = new WebSocketTransport(`webssh-${crypto.randomUUID()}`, wsUrl);

      const options = {
        host: payload.machine.host,
        port: payload.machine.port,
        user: payload.machine.username,
        timeout: 20_000,
        ...(payload.machine.authType === "password"
          ? { password: payload.credential }
          : { privateKey: payload.credential })
      };

      const session = await SSHClient.connect(options, transport, {
        onPacketReceive(data, metadata) {
          if (metadata.type === "data") {
            terminal.write(data);
          }
        },
        onStateChange(nextState) {
          if (nextState === "error") {
            setState("error");
            setLabel("SSH 协议连接失败");
          } else if (nextState === "disconnected" && runId === connectionRunRef.current) {
            sessionRef.current = null;
            setState("idle");
            setLabel("远程连接已断开");
          }
        }
      });

      if (runId !== connectionRunRef.current) {
        await session.disconnect().catch(() => undefined);
        return;
      }

      sessionRef.current = session;
      fit.fit();
      await session.resizeTerminal(terminal.cols, terminal.rows).catch(() => undefined);
      setState("connected");
      setLabel(`${payload.machine.name} · ${payload.machine.host}`);

      // The WASM client creates the PTY shell when the first input is sent.
      await session.send(new TextEncoder().encode("\r"));
    } catch (error) {
      if (runId !== connectionRunRef.current) return;
      setState("error");
      setLabel("连接失败");
      terminal.writeln(`\r\n\x1b[31m连接失败：${formatError(error)}\x1b[0m`);
      terminal.writeln("\x1b[90m请检查主机、端口、防火墙、SSH 凭据以及 Cloudflare Worker 日志。\x1b[0m");
    }
  }

  async function manualDisconnect() {
    connectionRunRef.current += 1;
    await disconnectCurrent();
    setState("idle");
    setLabel("已断开");
    terminalRef.current?.writeln("\r\n\x1b[33m连接已手动断开。\x1b[0m");
  }

  return (
    <section className="terminal-panel">
      <header className="terminal-header">
        <div className="terminal-title">
          <div className="traffic-lights" aria-hidden="true"><i /><i /><i /></div>
          <div>
            <strong>终端</strong>
            <span>{label}</span>
          </div>
        </div>
        <div className="terminal-actions">
          <span className={`connection-pill ${state}`}>
            <i />{state === "connected" ? "已连接" : state === "connecting" ? "连接中" : state === "error" ? "异常" : "未连接"}
          </span>
          <button className="button small ghost" onClick={manualDisconnect} disabled={!sessionRef.current && state !== "connecting"}>
            断开
          </button>
        </div>
      </header>
      <div className="terminal-mount" ref={mountRef} />
      <footer className="terminal-footer">
        <span>浏览器 WASM SSH</span>
        <span>WebSocket → Worker TCP</span>
        <span>UTF-8</span>
      </footer>
    </section>
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
