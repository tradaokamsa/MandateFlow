import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import type {
  Agent,
  AgentRun,
  MandateFlowEvidence,
  Message,
  SystemInfo,
} from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function MandateFlowPanel({
  run,
  evidence,
  loading,
  evidenceError,
  ready,
  retrying,
  retryDisabled,
  onRetry,
}: {
  run: AgentRun | null;
  evidence: MandateFlowEvidence | null;
  loading: boolean;
  evidenceError: string | null;
  ready: boolean;
  retrying: boolean;
  retryDisabled: boolean;
  onRetry: () => void;
}) {
  const currentEvidence = evidence?.runId === run?.id ? evidence : null;
  const receipts = currentEvidence
    ? [...currentEvidence.receipts].sort(
        (left, right) => left.sequence - right.sequence,
      )
    : [];
  const latestCounter = [...receipts]
    .reverse()
    .find(
      (receipt) =>
        receipt.tool === "crm.resolve_customer" &&
        (receipt.counterAfter !== null || receipt.counterBefore !== null),
    );
  const crmCount = latestCounter?.counterAfter ?? latestCounter?.counterBefore ?? 0;
  const hasRetryableDenial =
    currentEvidence?.retryOfRunId === null &&
    receipts.some(
      (receipt) =>
        receipt.tool === "crm.resolve_customer" &&
        receipt.decision === "DENY" &&
        receipt.ruleId === "NO_PAYMENT_REIDENTIFICATION",
    );
  const completedSecureRun =
    run?.status === "completed" &&
    run.policyContextId !== null &&
    hasRetryableDenial;

  return (
    <aside className="mandateflow-panel" aria-label="MandateFlow evidence">
      <div className="evidence-heading">
        <div>
          <span className="eyebrow">MandateFlow</span>
          <h2>Authority evidence</h2>
        </div>
        <span className={"gateway-state " + (ready ? "gateway-ready" : "gateway-down")}>
          <span />
          {ready ? "Gateway ready" : "Gateway unavailable"}
        </span>
      </div>

      {completedSecureRun && (
        <button
          className="button button-primary retry-button"
          type="button"
          onClick={onRetry}
          disabled={retryDisabled}
        >
          {retrying ? <Spinner /> : "Retry denied CRM step"}
        </button>
      )}

      {!run ? (
        <div className="evidence-empty">
          Evidence appears after this Agent starts a secure Run.
        </div>
      ) : run.policyContextId === null ? (
        <div className="evidence-empty">
          This Run has no MandateFlow authority.
        </div>
      ) : !currentEvidence && loading ? (
        <div className="evidence-empty evidence-loading">
          <Spinner /> Loading durable evidence…
        </div>
      ) : currentEvidence ? (
        <>
          <section className="evidence-purpose">
            <span className="eyebrow">Purpose</span>
            <strong>{currentEvidence.purposeId.replaceAll("_", " ")}</strong>
            <p>{currentEvidence.purposeSummary}</p>
          </section>

          <section className="evidence-section">
            <div className="evidence-section-title">
              <span>Authority fingerprints</span>
              <span>{currentEvidence.retryOfRunId ? "Retry" : "Root Run"}</span>
            </div>
            <dl className="fingerprint-grid">
              <div><dt>Context</dt><dd>{currentEvidence.contextFingerprint}</dd></div>
              <div><dt>Policy</dt><dd>{currentEvidence.policyFingerprint}</dd></div>
              <div><dt>Grant</dt><dd>{currentEvidence.grantFingerprint}</dd></div>
              <div><dt>Capability</dt><dd>{currentEvidence.capabilityFingerprint}</dd></div>
              <div><dt>Runtime</dt><dd>{currentEvidence.runtimeFingerprint ?? "pending"}</dd></div>
            </dl>
          </section>

          <section className="evidence-section">
            <div className="evidence-section-title">
              <span>Exact permissions</span>
              <span>{currentEvidence.permissions.length}</span>
            </div>
            <ul className="permission-list">
              {currentEvidence.permissions.map((permission) => (
                <li key={`${permission.tool}:${permission.action}:${permission.resourceKind}`}>
                  <code>{permission.tool}</code>
                  <span>{permission.action} · {permission.resourceKind}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="evidence-section">
            <div className="counter-card">
              <div>
                <span className="eyebrow">Protected fixture counter</span>
                <strong>CRM invocations</strong>
              </div>
              <b>{crmCount}</b>
            </div>
          </section>

          <section className="evidence-section evidence-receipts">
            <div className="evidence-section-title">
              <span>Ordered receipts</span>
              <span>{receipts.length}</span>
            </div>
            {receipts.length === 0 ? (
              <div className="evidence-empty compact">No protected calls yet.</div>
            ) : (
              <ol className="receipt-list">
                {receipts.map((receipt) => (
                  <li key={receipt.id}>
                    <div className="receipt-marker">{receipt.sequence}</div>
                    <article>
                      <div className="receipt-title">
                        <code>{receipt.tool}</code>
                        <span className={"decision decision-" + receipt.decision.toLowerCase()}>
                          {receipt.decision}
                        </span>
                      </div>
                      <div className="receipt-stage">
                        {receipt.enforcementStage.replace("_", " ")} · {receipt.outcome.replace("_", " ")}
                      </div>
                      <div className="receipt-detail">
                        Static {receipt.staticScopeDecision} · Provenance {receipt.provenanceDecision}
                      </div>
                      <div className="receipt-detail">
                        Downstream {receipt.downstreamInvoked ? "invoked" : "not invoked"}
                        {receipt.ruleId ? ` · ${receipt.ruleId}` : ""}
                      </div>
                      <p>{receipt.reason}</p>
                      <div className="receipt-summary">{receipt.redactedInputSummary}</div>
                      {receipt.redactedResultSummary && (
                        <div className="receipt-summary">{receipt.redactedResultSummary}</div>
                      )}
                      {(receipt.counterBefore !== null || receipt.counterAfter !== null) && (
                        <div className="receipt-detail">
                          Counter {receipt.counterBefore ?? "—"} → {receipt.counterAfter ?? "—"}
                        </div>
                      )}
                      {(receipt.inputReferenceAliases.length > 0 ||
                        receipt.producedReferenceAliases.length > 0) && (
                        <div className="receipt-detail">
                          Refs {[...receipt.inputReferenceAliases, ...receipt.producedReferenceAliases].join(" · ")}
                        </div>
                      )}
                      {receipt.causedByReceiptIds.length > 0 && (
                        <div className="receipt-detail">
                          Caused by {receipt.causedByReceiptIds.map((id) => id.slice(0, 8)).join(", ")}
                        </div>
                      )}
                      {receipt.safeAlternative && (
                        <div className="safe-alternative">Safe alternative · {receipt.safeAlternative}</div>
                      )}
                    </article>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      ) : (
        <div className="evidence-empty">
          Evidence is not available for this Run yet.
        </div>
      )}

      {evidenceError && <div className="evidence-error">{evidenceError}</div>}
    </aside>
  );
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [evidence, setEvidence] = useState<MandateFlowEvidence | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );
  const runIsActive =
    activeRun !== null && ["queued", "running"].includes(activeRun.status);
  const mandateFlowUnavailable =
    system?.mandateFlowEnabled === true && !system.mandateFlowReady;

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const refreshEvidence = useCallback(async (runId: string, agentId: string) => {
    setEvidenceLoading(true);
    setEvidenceError(null);
    try {
      const result = await api.mandateFlowEvidence(runId);
      if (mountedRef.current && selectedIdRef.current === agentId) {
        setEvidence(result.evidence);
      }
    } catch (reason) {
      if (!mountedRef.current || selectedIdRef.current !== agentId) return;
      if (reason instanceof ApiError && reason.status === 404) {
        setEvidence(null);
        return;
      }
      if (reason instanceof ApiError && reason.status === 503) {
        setSystem((current) =>
          current ? { ...current, mandateFlowReady: false } : current,
        );
      }
      setEvidenceError(
        reason instanceof Error ? reason.message : "Evidence request failed",
      );
    } finally {
      if (mountedRef.current && selectedIdRef.current === agentId) {
        setEvidenceLoading(false);
      }
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setEvidence(null);
    setEvidenceError(null);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest?.policyContextId) {
          void refreshEvidence(latest.id, selectedId);
        }
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshEvidence, refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const [result, latestSystem] = await Promise.all([
          api.run(runId),
          api.system().catch(() => null),
        ]);
        if (latestSystem && mountedRef.current) setSystem(latestSystem);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (result.run.policyContextId) {
          await refreshEvidence(runId, agentId);
        }
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      void pollRun(result.run.id, selected.id).catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      if (reason instanceof ApiError && reason.status === 503) {
        setSystem((current) =>
          current ? { ...current, mandateFlowReady: false } : current,
        );
      }
      await refreshAgents();
    }
  };

  const retryRun = async () => {
    if (!selected || !activeRun || activeRun.status !== "completed") return;
    setRetrying(true);
    setError(null);
    try {
      const result = await api.retryRun(activeRun.id);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
        setEvidence(null);
        setEvidenceError(null);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      void pollRun(result.run.id, selected.id).catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      if (reason instanceof ApiError && reason.status === 503) {
        setSystem((current) =>
          current ? { ...current, mandateFlowReady: false } : current,
        );
      }
      await refreshAgents();
    } finally {
      setRetrying(false);
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {mandateFlowUnavailable && (
          <div className="config-banner mandateflow-banner" role="status">
            <span>!</span>
            <div>
              <strong>MandateFlow Gateway unavailable</strong>
              <p>New secure messages and Retry are paused until the Gateway restarts.</p>
            </div>
          </div>
        )}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <div
              className={
                "workbench " +
                (system?.mandateFlowEnabled ? "" : "workbench-single")
              }
            >
            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button
                          key={item}
                          onClick={() => setPrompt(item)}
                          disabled={mandateFlowUnavailable}
                        >
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    mandateFlowUnavailable
                      ? "MandateFlow Gateway is unavailable…"
                      : selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    mandateFlowUnavailable ||
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    runIsActive
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      mandateFlowUnavailable ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      runIsActive
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
            {system?.mandateFlowEnabled && (
              <MandateFlowPanel
                run={activeRun}
                evidence={evidence}
                loading={evidenceLoading}
                evidenceError={evidenceError}
                ready={system.mandateFlowReady}
                retrying={retrying}
                retryDisabled={
                  retrying ||
                  mandateFlowUnavailable ||
                  busy ||
                  selected.status !== "ready" ||
                  runIsActive
                }
                onRetry={() => void retryRun()}
              />
            )}
            </div>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
