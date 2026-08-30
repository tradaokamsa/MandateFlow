import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import type {
  Agent,
  AgentRun,
  MandateEvidence,
  MandateSummary,
  Message,
  DemoOwnerPrincipal,
  SystemInfo,
} from "./types";
import { ProofPanel } from "./ProofPanel";
import { ReceiptCard } from "./ReceiptCard";

const heroPrompt =
  "Run the MandateFlow verification workflow. First, list the open Support ticket, " +
  "transform its subject reference with cases.lookup_subject, and resolve that Case " +
  "reference through CRM. Next, list Payment failures, transform one Payment reference " +
  "with the same Case tool, and attempt the same CRM resolution. If policy denies it, " +
  "use payments.aggregate_failures, then fetch a fresh Support ticket, transform its " +
  "reference, and resolve it through CRM. Finish the brief and report policy outcomes, " +
  "not protected identifiers.";

const starterPrompts = [
  heroPrompt,
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm: {
  name: string;
  description: string;
  ownerPrincipal: DemoOwnerPrincipal;
  instructions: string;
} = {
  name: "",
  description: "",
  ownerPrincipal: "user-a",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result. " +
    "When MandateFlow tools are available, preserve opaque references exactly, obey protected-tool decisions, " +
    "and use an offered safe alternative after a policy denial.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function shortId(value: string): string {
  return value.length > 18 ? value.slice(0, 10) + "…" + value.slice(-5) : value;
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
  const [evidence, setEvidence] = useState<MandateEvidence | null>(null);
  const [mandate, setMandate] = useState<MandateSummary | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [revokeNotice, setRevokeNotice] = useState<string | null>(null);
  const [workflowNotice, setWorkflowNotice] = useState<string | null>(null);
  const [expandedReceiptId, setExpandedReceiptId] = useState<string | null>(null);
  const [showMobileAgents, setShowMobileAgents] = useState(false);
  const [showAuthToken, setShowAuthToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const confirmationDialog = useRef<HTMLElement>(null);
  const revokeTrigger = useRef<HTMLButtonElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const mobileMenuTrigger = useRef<HTMLButtonElement>(null);
  const mobileSwitcher = useRef<HTMLElement>(null);
  const wasMobileAgentsOpen = useRef(false);
  const wasRevokeConfirming = useRef(false);
  const wasDeleteConfirming = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );
  const hasRetryableDenial = Boolean(
    activeRun &&
      !activeRun.retryOfRunId &&
      evidence?.receipts.some(
        (receipt) =>
          receipt.runId === activeRun.id &&
          receipt.tool === "crm.resolve_customer" &&
          receipt.staticScopeDecision === "ALLOW" &&
          receipt.provenanceDecision === "DENY" &&
          !receipt.downstreamInvoked,
      ),
  );

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

  const refreshEvidence = useCallback(async (run: AgentRun) => {
    if (!run.policyContextId) {
      setEvidence(null);
      return;
    }
    const result = await api.evidence(run.id);
    if (mountedRef.current && selectedIdRef.current === run.agentId) {
      setEvidence(result.evidence);
    }
  }, []);

  const refreshMandate = useCallback(async (agentId: string) => {
    const result = await api.mandate(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMandate(result.mandate);
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
    setMandate(null);
    setRevokeNotice(null);
    setWorkflowNotice(null);
    setExpandedReceiptId(null);
    setShowMobileAgents(false);
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
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        } else if (latest?.policyContextId) {
          void refreshEvidence(latest).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshEvidence, refreshMessages, selectedId]);

  useEffect(() => {
    if (!selectedId || !system?.mandateFlowEnabled) return;
    void refreshMandate(selectedId).catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [refreshMandate, selectedId, system?.mandateFlowEnabled]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        ownerPrincipal: selected.ownerPrincipal,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  useEffect(() => {
    if (!showRevokeConfirm && !showDeleteConfirm) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowRevokeConfirm(false);
        setShowDeleteConfirm(false);
        return;
      }
      if (event.key === "Tab") {
        const focusable = confirmationDialog.current?.querySelectorAll<HTMLElement>(
          "button, input, select, textarea, [tabindex]:not([tabindex='-1'])",
        );
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showDeleteConfirm, showRevokeConfirm]);

  useEffect(() => {
    if (!showMobileAgents) {
      if (wasMobileAgentsOpen.current) mobileMenuTrigger.current?.focus();
      wasMobileAgentsOpen.current = false;
      return;
    }
    wasMobileAgentsOpen.current = true;
    const dialog = mobileSwitcher.current;
    const focusable = dialog?.querySelectorAll<HTMLElement>(
      "button, input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    focusable?.[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowMobileAgents(false);
        return;
      }
      if (event.key !== "Tab" || !focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showMobileAgents]);

  useEffect(() => {
    if (wasRevokeConfirming.current && !showRevokeConfirm) revokeTrigger.current?.focus();
    if (wasDeleteConfirming.current && !showDeleteConfirm) deleteTrigger.current?.focus();
    wasRevokeConfirming.current = showRevokeConfirm;
    wasDeleteConfirming.current = showDeleteConfirm;
  }, [showDeleteConfirm, showRevokeConfirm]);

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
      const { ownerPrincipal: _ownerPrincipal, ...editable } = form;
      await api.updateAgent(selected.id, editable);
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
    setShowDeleteConfirm(false);
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
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (result.run.mandateId) {
          void refreshMandate(agentId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([
            refreshMessages(agentId),
            refreshAgents(),
            result.run.policyContextId ? refreshEvidence(result.run) : Promise.resolve(),
            refreshMandate(agentId),
          ]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const retryRun = async () => {
    if (!activeRun || revokePending) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.retryRun(activeRun.id);
      setEvidence(null);
      setActiveRun(result.run);
      await refreshMandate(result.run.agentId);
      setAgents((current) =>
        current.map((agent) =>
          agent.id === result.run.agentId ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, result.run.agentId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      await refreshAgents();
    } finally {
      setBusy(false);
    }
  };

  const newDemoWorkflow = async () => {
    if (!selected || revokePending) return;
    setBusy(true);
    setError(null);
    setWorkflowNotice(null);
    try {
      await api.newDemoWorkflow(selected.id);
      setActiveRun(null);
      setEvidence(null);
      setMandate(null);
      setRevokeNotice(null);
      setPrompt(heroPrompt);
      setWorkflowNotice(
        "Fresh secure workflow ready. Run the proof to create new server-owned evidence.",
      );
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const revokeMandate = async () => {
    if (!mandate || revokePending) return;
    setShowRevokeConfirm(false);
    setRevokePending(true);
    setRevokeNotice(null);
    setError(null);
    try {
      const result = await api.revokeMandate(mandate.mandateId);
      setMandate(result.mandate);
      setActiveRun(result.run);
      setAgents((current) =>
        current.map((agent) => (agent.id === result.agent.id ? result.agent : agent)),
      );
      setRevokeNotice(
        "Mandate revoked. The active Runtime was cancelled and this workflow is locked.",
      );
      await Promise.all([
        refreshMessages(result.agent.id),
        refreshAgents(),
        result.run?.policyContextId ? refreshEvidence(result.run) : Promise.resolve(),
        refreshMandate(result.agent.id),
      ]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setRevokeNotice("Mandate revocation failed; no cancellation was claimed.");
    } finally {
      setRevokePending(false);
    }
  };

  const runPrompt = async (content: string) => {
    if (
      !selected ||
      !content.trim() ||
      selected.status === "stopped" ||
      selected.status === "busy" ||
      revokePending ||
      activeRun != null && ["queued", "running"].includes(activeRun.status) ||
      system?.mandateFlowEnabled === true && !system.mandateFlowReady ||
      mandate?.status === "REVOKED"
    ) return;
    const agentId = selected.id;
    const normalizedContent = content.trim();
    setPrompt("");
    setError(null);
    setWorkflowNotice(null);
    try {
      const result = await api.sendMessage(agentId, normalizedContent);
      if (selectedIdRef.current === agentId) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === agentId ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, agentId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    await runPrompt(prompt);
  };

  const navigateToReceipt = (receiptId: string) => {
    setExpandedReceiptId(receiptId);
    window.requestAnimationFrame(() => {
      document.getElementById("receipt-" + receiptId)?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "nearest",
      });
    });
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
          <div className="brand-mark">M</div>
          <span className="eyebrow">MandateFlow</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock} noValidate>
          <div className="brand-mark">M</div>
          <span className="eyebrow">MandateFlow</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <span className="secret-input">
              <input
                autoFocus
                type={showAuthToken ? "text" : "password"}
                value={authInput}
                onChange={(event) => setAuthInput(event.target.value)}
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                className="secret-toggle"
                onClick={() => setShowAuthToken((visible) => !visible)}
                aria-label={showAuthToken ? "Hide access token" : "Show access token"}
                aria-pressed={showAuthToken}
              >
                {showAuthToken ? "Hide" : "Show"}
              </button>
            </span>
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open MandateFlow"}
          </button>
        </form>
      </main>
    );
  }

  const runtimeReady = Boolean(
    system &&
      system.codexAvailable &&
      (system.runtimeProvider === "fixture" || system.groqConfigured) &&
      (!system.mandateFlowEnabled || system.mandateFlowReady),
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          type="button"
          className="mobile-menu-button"
          ref={mobileMenuTrigger}
          onClick={() => setShowMobileAgents(true)}
          aria-label="Open Agent switcher"
          aria-expanded={showMobileAgents}
          aria-controls="mobile-agent-switcher"
        >
          <span aria-hidden="true">☰</span>
        </button>
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <strong>MandateFlow</strong>
            <span>
              {system?.runtimeProvider === "fixture"
                ? "Deterministic fixture · Go gateway"
                : system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setShowMobileAgents(false);
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
              onClick={() => {
                setSelectedId(agent.id);
                setShowMobileAgents(false);
              }}
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
            {system?.runtimeProvider === "fixture"
              ? "No external model credential"
              : system?.groqModel ?? "Groq model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {((system?.runtimeProvider !== "fixture" && !system?.groqConfigured) ||
        !system?.codexAvailable ||
        (system?.mandateFlowEnabled && !system.mandateFlowReady)) ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {system?.runtimeProvider !== "fixture" && !system?.groqConfigured
                  ? "Set GROQ_API_KEY in .env before using the Playground; GROQ_MODEL is optional."
                  : system?.mandateFlowEnabled && !system.mandateFlowReady
                    ? "The Go MandateFlow sidecar is unavailable. Secure Runs fail closed until it is ready."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

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
                {system?.mandateFlowEnabled && (
                  <button
                    className="button button-ghost"
                    onClick={newDemoWorkflow}
                    disabled={busy || revokePending || selected.status === "busy"}
                  >
                    New secure workflow
                  </button>
                )}
                {system?.mandateFlowEnabled && activeRun?.status === "completed" && hasRetryableDenial && (
                  <button
                    className="button button-primary"
                    onClick={retryRun}
                    disabled={busy || revokePending || selected.status === "busy" || !evidence || mandate?.status === "REVOKED"}
                  >
                    Retry denied call
                  </button>
                )}
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || revokePending || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy || revokePending}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  ref={deleteTrigger}
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={busy || revokePending || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent} noValidate>
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
                    className="resize-none"
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

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span
                    className={
                      "pulse " +
                      (system?.mandateFlowEnabled && !system.mandateFlowReady
                        ? "pulse-denied"
                        : "")
                    }
                  />
                  {system?.mandateFlowEnabled
                    ? system.mandateFlowReady
                      ? "MandateFlow enforced"
                      : "MandateFlow unavailable"
                    : selected.codexThreadId
                      ? "Session connected"
                      : "New session"}
                </div>
              </div>

              <ProofPanel
                evidence={evidence}
                activeRun={activeRun}
                busy={busy}
                canRun={runtimeReady && !revokePending && selected.status !== "stopped" && mandate?.status !== "REVOKED"}
                canRetry={hasRetryableDenial && !revokePending && Boolean(evidence) && mandate?.status !== "REVOKED"}
                onRunProof={() => void runPrompt(heroPrompt)}
                onRetry={() => void retryRun()}
              />
              {workflowNotice && (
                <div className="workflow-status" role="status">
                  <span aria-hidden="true">✓</span>
                  <span>{workflowNotice}</span>
                </div>
              )}

              {system?.mandateFlowEnabled && mandate && (
                <section className="mandate-summary" aria-labelledby="mandate-summary-title">
                  <div className="mandate-summary-heading">
                    <div>
                      <span className="eyebrow">Trusted mandate</span>
                      <h3 id="mandate-summary-title">Mandate Summary</h3>
                    </div>
                    <span className={"mandate-state mandate-state-" + mandate.status.toLowerCase()}>
                      {mandate.status}
                    </span>
                  </div>
                  <div className="mandate-summary-grid">
                    <div><span>Purpose</span><strong>{mandate.purposeId}</strong></div>
                    <div><span>Owner principal</span><strong>{mandate.ownerPrincipal}</strong></div>
                    <div title={mandate.agentPrincipal}><span>Agent principal</span><strong>{shortId(mandate.agentPrincipal)}</strong></div>
                    <div title={mandate.policyContextId}><span>Policy context</span><strong>{shortId(mandate.policyContextId)}</strong></div>
                    <div title={mandate.mandateId}><span>Mandate ID</span><strong>{mandate.mandateFingerprint}</strong></div>
                    <div><span>Issued</span><strong>{formatDateTime(mandate.issuedAt)}</strong></div>
                    <div><span>Expires</span><strong>{formatDateTime(mandate.expiresAt)}</strong></div>
                    <div className="mandate-tools"><span>Granted tools</span><strong>{mandate.grantedPermissions.map((permission) => permission.tool).join(" · ")}</strong></div>
                  </div>
                  {mandate.status !== "ACTIVE" ? (
                    <div className="mandate-revoked-note" role="status">
                      {mandate.status === "REVOKED"
                        ? mandate.revocationReason ?? "This mandate is revoked."
                        : "This mandate is closed. Start a New secure workflow for fresh authority."}
                      {mandate.revokedAt ? " · " + formatDateTime(mandate.revokedAt) : ""}
                    </div>
                  ) : (
                    <button
                      className="button button-danger revoke-button"
                      ref={revokeTrigger}
                      onClick={() => setShowRevokeConfirm(true)}
                      disabled={revokePending}
                    >
                      {revokePending ? <><Spinner /> Revoking…</> : "Revoke mandate"}
                    </button>
                  )}
                  {revokeNotice && <div className="mandate-status-message" role="status">{revokeNotice}</div>}
                </section>
              )}

              {system?.mandateFlowEnabled && (
                <section className="mandate-evidence" aria-live="polite">
                  <div className="mandate-heading">
                    <div>
                      <span className="eyebrow">Trusted decision journal</span>
                      <strong>
                        {evidence
                          ? "Provenance policy evidence"
                          : activeRun && ["queued", "running"].includes(activeRun.status)
                            ? "Collecting pre-execution decisions…"
                            : "Start the verification workflow to produce evidence"}
                      </strong>
                    </div>
                    {evidence && (
                      <div className="mandate-facts">
                        <span title={evidence.policyContextId}>
                          context {shortId(evidence.policyContextId)}
                        </span>
                        <span>{evidence.grantFingerprint}</span>
                        <span>{evidence.capabilityFingerprint}</span>
                        <span className="counter-chip">CRM calls {evidence.crmCounter}</span>
                      </div>
                    )}
                  </div>
                  {evidence && (
                    <>
                      <div className="mandate-continuity">
                        <span>{evidence.purposeId}</span>
                        <span>{evidence.policyId} v{evidence.policyVersion}</span>
                        <span>runtime {shortId(evidence.runtimeInstanceId)}</span>
                        {evidence.retryOfRunId && (
                          <span className="retry-chip">
                            retry of {shortId(evidence.retryOfRunId)} · same context
                          </span>
                        )}
                      </div>
                      <div className="receipt-timeline" aria-label="Redacted decision receipts">
                        {evidence.receipts.map((receipt) => (
                          <ReceiptCard
                            key={receipt.id}
                            receipt={receipt}
                            receipts={evidence.receipts}
                            expanded={expandedReceiptId === receipt.id}
                            onToggle={setExpandedReceiptId}
                            onNavigate={navigateToReceipt}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </section>
              )}

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
                        <button key={item} onClick={() => setPrompt(item)}>
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

              <form className="composer" onSubmit={sendMessage} noValidate>
                <textarea
                  className="resize-none"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    revokePending ||
                    (system?.mandateFlowEnabled === true && !system.mandateFlowReady) ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status) ||
                    mandate?.status === "REVOKED"
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
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      revokePending ||
                      (system?.mandateFlowEnabled === true && !system.mandateFlowReady) ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status)) ||
                      mandate?.status === "REVOKED"
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">M</div>
            <span className="eyebrow">MandateFlow</span>
            <h1>{runtimeReady ? "Your workspace is ready." : "Finish runtime setup first."}</h1>
            <p>
              {runtimeReady
                ? "Create an Agent, then run a live proof of server-owned provenance."
                : "Resolve the runtime notice above before starting a secure Agent workflow."}
            </p>
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

      {showMobileAgents && (
        <div
          className="mobile-switcher-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setShowMobileAgents(false);
          }}
        >
          <section
            className="mobile-switcher"
            id="mobile-agent-switcher"
            ref={mobileSwitcher}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-switcher-title"
          >
            <div className="mobile-switcher-heading">
              <div>
                <span className="eyebrow">Workspaces</span>
                <h2 id="mobile-switcher-title">Switch Agent</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setShowMobileAgents(false)}
                aria-label="Close Agent switcher"
              >
                ×
              </button>
            </div>
            <nav className="mobile-agent-list" aria-label="Agent workspaces">
              {agents.map((agent) => (
                <button
                  type="button"
                  className={"mobile-agent-option " + (agent.id === selectedId ? "selected" : "")}
                  key={agent.id}
                  onClick={() => {
                    setSelectedId(agent.id);
                    setShowMobileAgents(false);
                  }}
                >
                  <span className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</span>
                  <span>
                    <strong>{agent.name}</strong>
                    <small>{agent.description || "Coding Agent"}</small>
                  </span>
                  <span className={"mobile-agent-status mobile-status-" + agent.status}>
                    {agent.status}
                  </span>
                </button>
              ))}
            </nav>
            <button
              type="button"
              className="button button-primary mobile-create-agent"
              onClick={() => {
                setShowMobileAgents(false);
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              ＋ Create Agent
            </button>
          </section>
        </div>
      )}

      {showRevokeConfirm && mandate && (
        <div className="modal-backdrop" onMouseDown={() => setShowRevokeConfirm(false)}>
          <section
            className="modal confirmation-modal"
            role="dialog"
            aria-modal="true"
            ref={confirmationDialog}
            aria-labelledby="revoke-dialog-title"
            aria-describedby="revoke-dialog-description"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">Security action</span>
                <h2 id="revoke-dialog-title">Revoke this mandate?</h2>
              </div>
              <button type="button" onClick={() => setShowRevokeConfirm(false)} aria-label="Close confirmation">×</button>
            </div>
            <p id="revoke-dialog-description">
              This stops the active Runtime, invalidates its current capability, and prevents follow-up or retry calls in this workflow. The decision journal remains available.
            </p>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                autoFocus
                onClick={() => setShowRevokeConfirm(false)}
              >
                Keep mandate
              </button>
              <button type="button" className="button button-danger" onClick={revokeMandate}>
                Revoke mandate
              </button>
            </div>
          </section>
        </div>
      )}

      {showDeleteConfirm && selected && (
        <div className="modal-backdrop" onMouseDown={() => setShowDeleteConfirm(false)}>
          <section
            className="modal confirmation-modal"
            role="dialog"
            aria-modal="true"
            ref={confirmationDialog}
            aria-labelledby="delete-dialog-title"
            aria-describedby="delete-dialog-description"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">Workspace action</span>
                <h2 id="delete-dialog-title">Delete {selected.name}?</h2>
              </div>
              <button type="button" onClick={() => setShowDeleteConfirm(false)} aria-label="Close confirmation">×</button>
            </div>
            <p id="delete-dialog-description">
              The Agent will be removed from this workspace and its folder will be archived.
            </p>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                autoFocus
                onClick={() => setShowDeleteConfirm(false)}
              >
                Keep Agent
              </button>
              <button type="button" className="button button-danger" onClick={deleteAgent}>
                Delete Agent
              </button>
            </div>
          </section>
        </div>
      )}

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
            noValidate
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
              Demo owner
              <select
                value={form.ownerPrincipal}
                onChange={(event) =>
                  setForm({
                    ...form,
                    ownerPrincipal: event.target.value as "user-a" | "user-b",
                  })
                }
              >
                <option value="user-a">User A · demo data</option>
                <option value="user-b">User B · demo data</option>
              </select>
              <small className="field-help">Demo identity only; this is not real authentication.</small>
            </label>
            <label>
              Instructions
                  <textarea
                    className="resize-none"
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
