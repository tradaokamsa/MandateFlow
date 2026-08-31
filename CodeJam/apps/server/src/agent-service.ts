import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isGroqConfigured, writeCodexConfig } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { containerName } from "./container-codex-runner.js";
import {
  MANDATE_PERMISSIONS,
  type MandateFlowControl,
} from "./mandateflow-client.js";
import { JsonStore } from "./store.js";
import { createRuntimeSessionEvent, sanitizeSafeMetadata } from "./runtime-session.js";
import { redactRuntimeText } from "./trace.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  MandateEvidence,
  MandateSummary,
  MandatePrepareRequest,
  Message,
  RunnerProgressEvent,
  UpdateAgentInput,
} from "./types.js";
import {
  CODEX_HOME_VERSION,
  ensureAgentCodexHome,
  WorkspaceManager,
} from "./workspace.js";

const now = () => new Date().toISOString();

const RETRY_PROMPT =
  "Retry only the previously denied crm.resolve_customer call using the exact prior " +
  "Payment-derived Case reference already present in this thread. Do not call " +
  "payments.list_failures or cases.lookup_subject again. If denied, stop and report " +
  "the receipt ID.";

class SecurityFinalizationError extends Error {}

const MAX_RUN_PROGRESS_EVENTS = 80;
const CANCELLATION_WAIT_MS = 8_000;

function addRunProgress(run: AgentRun, event: RunnerProgressEvent): void {
  const previousSequence = run.progress.reduce(
    (maximum, current) => Math.max(maximum, current.sequence),
    0,
  );
  const safeMetadata = sanitizeSafeMetadata(event.safeMetadata);
  const normalizedEvent = createRuntimeSessionEvent(
    run.id,
    previousSequence + 1,
    randomUUID(),
    now(),
    safeMetadata
      ? { ...event, safeMetadata }
      : event,
  );
  run.progress.push(normalizedEvent);
  if (run.progress.length > MAX_RUN_PROGRESS_EVENTS) {
    run.progress.splice(0, run.progress.length - MAX_RUN_PROGRESS_EVENTS);
  }
}

function fixtureSupportsPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return (
    normalized.includes("mandateflow verification workflow") ||
    normalized.includes("retry only the previously denied")
  );
}

async function waitForCancellation<T>(promise: Promise<T>): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), CANCELLATION_WAIT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([
      promise.then(
        () => true as const,
        () => false as const,
      ),
      timedOut,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly progressWrites = new Map<string, Promise<void>>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    private readonly mandateFlow: MandateFlowControl | null = null,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const agent of database.agents) {
        if (agent.ownerPrincipal !== "user-a" && agent.ownerPrincipal !== "user-b") {
          agent.ownerPrincipal = "user-a";
        }
        if (!agent.agentPrincipal) agent.agentPrincipal = "agent:" + agent.id;
        if (agent.codexHomeVersion !== CODEX_HOME_VERSION) {
          agent.codexThreadId = null;
          agent.codexHomeVersion = CODEX_HOME_VERSION;
        }
      }
      for (const run of database.runs) {
        const runAgent = database.agents.find((agent) => agent.id === run.agentId);
        if (runAgent) {
          run.ownerPrincipal ??= runAgent.ownerPrincipal;
          run.agentPrincipal ??= runAgent.agentPrincipal;
        }
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
          run.mandateStatus =
            this.config.mandateFlowEnabled && run.policyContextId
              ? "security-finalization-pending"
              : "closed";
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
    await Promise.all(
      this.store.snapshot().agents.map((agent) =>
        ensureAgentCodexHome(this.config.codexHome, agent.id),
      ),
    );
    if (
      this.config.mandateFlowEnabled &&
      this.mandateFlow &&
      (await this.mandateFlow.ready())
    ) {
      await this.reconcilePendingFinalizations();
    }
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) throw new HttpError(404, "Agent not found");
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const ownerPrincipal = input.ownerPrincipal ?? "user-a";
    if (ownerPrincipal !== "user-a" && ownerPrincipal !== "user-b") {
      throw new HttpError(400, "ownerPrincipal must be user-a or user-b");
    }
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      ownerPrincipal,
      agentPrincipal: "agent:" + id,
      codexHomeVersion: CODEX_HOME_VERSION,
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      activePolicyContextId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) throw new HttpError(404, "Run not found");
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getRunEvidence(runId: string): Promise<MandateEvidence> {
    this.getRun(runId);
    if (!this.config.mandateFlowEnabled || !this.mandateFlow) {
      throw new HttpError(404, "MandateFlow evidence is not enabled");
    }
    return this.mandateFlow.evidence(runId);
  }

  async getMandateSummary(agentId: string): Promise<MandateSummary | null> {
    const agent = this.getAgent(agentId);
    const mandateId = this.store
      .snapshot()
      .runs.filter(
        (run) => run.agentId === agentId && run.policyContextId === agent.activePolicyContextId,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.mandateId;
    if (!mandateId) return null;
    if (!this.config.mandateFlowEnabled || !this.mandateFlow?.summary) {
      return null;
    }
    return this.mandateFlow.summary(mandateId);
  }

  async revokeMandate(mandateId: string): Promise<{
    mandate: MandateSummary;
    agent: Agent;
    run: AgentRun | null;
  }> {
    if (!this.config.mandateFlowEnabled || !this.mandateFlow?.revoke) {
      throw new HttpError(404, "MandateFlow revocation is not enabled");
    }
    const snapshot = this.store.snapshot();
    const associatedRun = snapshot.runs
      .filter((candidate) => candidate.mandateId === mandateId || candidate.policyContextId === mandateId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!associatedRun) throw new HttpError(404, "Mandate not found");
    const agent = this.getAgent(associatedRun.agentId);

    // The sidecar transaction is the point of authority. Do this before asking
    // a Runtime to stop so a failed sidecar cannot claim to have revoked it.
    const result = await this.mandateFlow.revoke(mandateId, agent.ownerPrincipal);
    const affectedRunIds = new Set(result.affectedRunIds);
    const activeRun = this.store
      .snapshot()
      .runs.find(
        (candidate) =>
          affectedRunIds.has(candidate.id) &&
          (candidate.status === "queued" || candidate.status === "running"),
      );
    if (activeRun) {
      await this.cancelRevokedRun(agent.id, activeRun.id);
    }
    await this.store.mutate((database) => {
      for (const candidate of database.runs) {
        if (!affectedRunIds.has(candidate.id)) continue;
        if (candidate.status === "queued" || candidate.status === "running") {
          candidate.status = "cancelled";
          candidate.error = "Mandate was revoked; the active Runtime was cancelled";
          candidate.completedAt = now();
        }
        candidate.mandateStatus = "revoked";
      }
      const storedAgent = database.agents.find((candidate) => candidate.id === agent.id);
      if (storedAgent && storedAgent.status === "busy") {
        storedAgent.status = "ready";
        storedAgent.updatedAt = now();
      }
    });
    const updatedAgent = this.getAgent(agent.id);
    const updatedRun = this.store
      .snapshot()
      .runs.filter((candidate) => candidate.agentId === agent.id && candidate.policyContextId === result.mandate.policyContextId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
    return { mandate: result.mandate, agent: updatedAgent, run: updatedRun };
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    const result = await this.createRun(agentId, prompt, null, true);
    if (!result.message) throw new Error("Playground Run did not create its user message");
    return { run: result.run, message: result.message };
  }

  async retryRun(runId: string): Promise<AgentRun> {
    const original = this.getRun(runId);
    if (original.status !== "completed" || !original.policyContextId) {
      throw new HttpError(409, "Only a completed MandateFlow Run can be retried");
    }
    const agent = this.getAgent(original.agentId);
    if (!agent.codexThreadId || agent.activePolicyContextId !== original.policyContextId) {
      throw new HttpError(409, "Retry requires the durable Codex thread and original policy context");
    }
    if (!this.mandateFlow) {
      throw new HttpError(503, "MandateFlow is unavailable");
    }
    const evidence = await this.mandateFlow.evidence(original.id);
    const hasRetryableDenial = evidence.receipts.some(
      (receipt) =>
        receipt.runId === original.id &&
        receipt.tool === "crm.resolve_customer" &&
        receipt.staticScopeDecision === "ALLOW" &&
        receipt.provenanceDecision === "DENY" &&
        !receipt.downstreamInvoked,
    );
    if (!hasRetryableDenial) {
      throw new HttpError(409, "Retry requires a completed Run with a provenance-denied CRM call");
    }
    const result = await this.createRun(agent.id, RETRY_PROMPT, original.id, false);
    return result.run;
  }

  async healthInfo(): Promise<{
    mandateFlowEnabled: boolean;
    mandateFlowReady: boolean;
  }> {
    const mandateFlowReady =
      this.config.mandateFlowEnabled && this.mandateFlow
        ? await this.mandateFlow.ready()
        : false;
    return {
      mandateFlowEnabled: this.config.mandateFlowEnabled,
      mandateFlowReady,
    };
  }

  async newDemoWorkflow(agentId: string): Promise<Agent> {
    if (this.config.mandateFlowEnabled) {
      await this.ensureMandateFlowReady();
      await this.requireFinalizedAuthority(agentId);
    }
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === agentId);
      if (!agent) throw new HttpError(404, "Agent not found");
      const hasActiveRun = database.runs.some(
        (run) =>
          run.agentId === agentId &&
          (run.status === "queued" || run.status === "running"),
      );
      if (agent.status === "busy" || hasActiveRun) {
        throw new HttpError(409, "Stop the active Run before starting a new workflow");
      }
      agent.activePolicyContextId = null;
      agent.codexThreadId = null;
      agent.lastError = null;
      if (agent.status === "error") agent.status = "ready";
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    const mandateFlowHealth = await this.healthInfo();
    return {
      groqConfigured: isGroqConfigured(this.config),
      groqBaseUrl: this.config.groqBaseUrl,
      groqModel: this.config.groqModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : this.config.runtimeProvider === "fixture"
            ? "Deterministic MandateFlow fixture Runtime"
            : "Codex CLI in application container",
      ...mandateFlowHealth,
      mandateFlowPolicy: this.config.mandateFlowEnabled
        ? "MIXED_OPERATIONS_BRIEF · mixed-operations-flow v1"
        : null,
    };
  }

  private async createRun(
    agentId: string,
    prompt: string,
    retryOfRunId: string | null,
    createUserMessage: boolean,
  ): Promise<{ run: AgentRun; message: Message | null }> {
    if (this.config.runtimeProvider !== "fixture" && !isGroqConfigured(this.config)) {
      throw new HttpError(
        503,
        "Groq is not configured. Set GROQ_API_KEY; GROQ_MODEL is optional, then restart.",
      );
    }
    if (this.config.runtimeProvider === "fixture" && !fixtureSupportsPrompt(prompt)) {
      throw new HttpError(
        409,
        "The credential-free fixture only runs the MandateFlow proof. Use a Codex Runtime for coding work.",
      );
    }
    if (this.config.mandateFlowEnabled) {
      await this.ensureMandateFlowReady();
      await this.requireFinalizedAuthority(agentId);
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      policyContextId: null,
      runGrantId: null,
      mandateId: null,
      ownerPrincipal: null,
      agentPrincipal: null,
      retryOfRunId,
      mandateStatus: "pending",
      capabilityFingerprint: null,
      grantFingerprint: null,
      runtimeInstanceId: null,
      progress: [
        {
          id: randomUUID(),
          runId: runId,
          sequence: 1,
          kind: "status",
          state: "started",
          title: "Run queued",
          stage: "queued",
          label: "Run queued",
          detail: "Waiting for the secure Agent Runtime to start.",
          createdAt: timestamp,
        },
      ],
      createdAt: timestamp,
    };
    const message: Message | null = createUserMessage
      ? {
          id: randomUUID(),
          agentId,
          runId,
          role: "user",
          content: prompt,
          createdAt: timestamp,
        }
      : null;
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) throw new HttpError(404, "Agent not found");
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      if (retryOfRunId) {
        const original = database.runs.find((item) => item.id === retryOfRunId);
        if (
          !original ||
          original.agentId !== agentId ||
          original.status !== "completed" ||
          !original.policyContextId ||
          original.policyContextId !== storedAgent.activePolicyContextId
        ) {
          throw new HttpError(409, "Retry source is no longer eligible");
        }
      }
      database.runs.push(run);
      if (message) database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    let capability = "";
    let mandatePrepared = false;
    let mandateTerminal = false;
    let securityFinalizationPending = false;
    try {
      if (this.cancellationRequests.has(run.id)) throw new RunCancelledError();
      await this.queueRunProgress(run.id, {
        stage: "phase",
        label: "Preparing secure Run",
        kind: "status",
        state: "started",
        title: "Preparing secure Run",
        detail: "MandateFlow is checking the grant and preparing the Agent workspace.",
      });
      const codexHomePath = await ensureAgentCodexHome(this.config.codexHome, agentAtStart.id);
      await writeCodexConfig(this.config, codexHomePath);

      if (this.config.mandateFlowEnabled) {
        if (!this.mandateFlow) throw new HttpError(503, "MandateFlow is unavailable");
        await this.queueRunProgress(run.id, {
          stage: "phase",
          label: "Authorizing protected tools",
          kind: "mcp",
          state: "started",
          title: "Authorizing protected tools",
          detail: "The control plane is issuing a Run-scoped capability before the Runtime starts.",
        });
        capability = createRunCapability();
        const capabilitySha256 = createHash("sha256")
          .update(capability, "utf8")
          .digest("base64url");
        const snapshot = this.store.snapshot();
        const predecessor = snapshot.runs
          .filter(
            (candidate) =>
              candidate.id !== run.id &&
              candidate.agentId === run.agentId &&
              candidate.status === "completed" &&
              candidate.policyContextId === agentAtStart.activePolicyContextId,
          )
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
        const mode: MandatePrepareRequest["mode"] = run.retryOfRunId
          ? "RETRY"
          : agentAtStart.activePolicyContextId
            ? "FOLLOW_UP"
            : "NEW";
        const prepared = await this.mandateFlow.prepare(run.id, {
          agentId: agentAtStart.id,
          ownerPrincipal: agentAtStart.ownerPrincipal,
          runtimeInstanceId:
            this.config.runtimeProvider === "container"
              ? containerName(run.id, this.config.runtimeInstanceId)
              : this.config.runtimeProvider === "fixture"
                ? "fixture-runtime-" + run.id.slice(0, 12)
                : "local-process-" + run.id.slice(0, 12),
          mode,
          policyContextId: agentAtStart.activePolicyContextId,
          predecessorRunId: predecessor?.id ?? null,
          retryOfRunId: run.retryOfRunId,
          mandateTemplateId: "morning-ops-v1",
          requestedPermissions: MANDATE_PERMISSIONS,
          capabilitySha256,
        });
        mandatePrepared = true;
        await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === run.id);
          const agent = database.agents.find((item) => item.id === run.agentId);
          if (!storedRun || !agent) return;
          storedRun.policyContextId = prepared.policyContextId;
          storedRun.runGrantId = prepared.runGrantId;
          storedRun.mandateId = prepared.mandateId ?? null;
          storedRun.ownerPrincipal = prepared.ownerPrincipal ?? agent.ownerPrincipal;
          storedRun.agentPrincipal = prepared.agentPrincipal ?? agent.agentPrincipal;
          storedRun.capabilityFingerprint = prepared.capabilityFingerprint;
          storedRun.grantFingerprint = prepared.grantFingerprint;
          agent.activePolicyContextId = prepared.policyContextId;
        });
        await this.mandateFlow.activate(run.id);
      }

      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        if (storedRun) {
          storedRun.status = "running";
          storedRun.mandateStatus = this.config.mandateFlowEnabled ? "active" : "closed";
          storedRun.startedAt = now();
        }
      });
      await this.queueRunProgress(run.id, {
        stage: "phase",
        label: "Runtime started",
        kind: "status",
        state: "started",
        title: "Runtime started",
        detail: "The Agent Runtime is ready to work in the selected workspace.",
      });

      if (this.cancellationRequests.has(run.id)) throw new RunCancelledError();
      const result = await this.runner.run({
        runId: run.id,
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        mandateFlowCapability: capability,
        codexHomePath,
        onProgress: (event) => this.queueRunProgress(run.id, event),
      });

      if (this.cancellationRequests.has(run.id)) throw new RunCancelledError();

      if (this.config.mandateFlowEnabled && this.mandateFlow) {
        await this.queueRunProgress(run.id, {
          stage: "phase",
          label: "Finalizing secure Run",
          kind: "status",
          state: "started",
          title: "Finalizing secure Run",
          detail: "The control plane is closing the capability and saving the decision evidence.",
        });
        await this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === run.id);
          if (storedRun) storedRun.mandateStatus = "finalizing";
        });
        try {
          await this.finishMandate(run.id, "COMPLETED");
          mandateTerminal = true;
        } catch {
          securityFinalizationPending = true;
          throw new SecurityFinalizationError(
            "Codex finished, but MandateFlow could not confirm capability invalidation",
          );
        }
      }

      await this.flushRunProgress(run.id);
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        const output = redactRuntimeText(result.output, this.config.groqApiKey);
        storedRun.output = output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        storedRun.runtimeInstanceId = result.runtimeInstanceId;
        storedRun.mandateStatus = "closed";
        addRunProgress(storedRun, {
          stage: "complete",
          label: "Run complete",
          kind: "status",
          state: "completed",
          title: "Run complete",
          detail: "The Agent returned a result and the secure Run was closed.",
        });
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled =
        error instanceof RunCancelledError || this.cancellationRequests.has(run.id);
      let message = redactRuntimeText(
        error instanceof Error ? error.message : String(error),
        this.config.groqApiKey,
      );
      if (mandatePrepared && !mandateTerminal && !securityFinalizationPending) {
        try {
          await this.finishMandate(run.id, cancelled ? "CANCELLED" : "FAILED");
          mandateTerminal = true;
        } catch {
          securityFinalizationPending = true;
          message += "; capability invalidation is pending";
        }
      }
      await this.flushRunProgress(run.id);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
          storedRun.mandateStatus = securityFinalizationPending
            ? "security-finalization-pending"
            : "closed";
          addRunProgress(storedRun, {
            stage: cancelled ? "cancelled" : "error",
            label: cancelled ? "Run cancelled" : "Run failed",
            kind: cancelled ? "status" : "error",
            state: cancelled ? "cancelled" : "failed",
            title: cancelled ? "Run cancelled" : "Run failed",
            detail: cancelled
              ? "The Runtime stopped before completing this request."
              : "The Runtime could not complete this request. Review the error above and try again.",
          });
        }
        if (agent) {
          if (agent.status !== "stopped") agent.status = cancelled ? "ready" : "error";
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    } finally {
      this.progressWrites.delete(run.id);
      this.cancellationRequests.delete(run.id);
      capability = "";
    }
  }

  private queueRunProgress(runId: string, event: RunnerProgressEvent): Promise<void> {
    const previous = this.progressWrites.get(runId) ?? Promise.resolve();
    const next = previous
      .then(() =>
        this.store.mutate((database) => {
          const storedRun = database.runs.find((candidate) => candidate.id === runId);
          if (storedRun && ["queued", "running"].includes(storedRun.status)) {
            addRunProgress(storedRun, event);
          }
        }),
      )
      .catch(() => undefined);
    this.progressWrites.set(runId, next);
    return next;
  }

  private async flushRunProgress(runId: string): Promise<void> {
    await this.progressWrites.get(runId);
  }

  private async finishMandate(
    runId: string,
    status: "COMPLETED" | "FAILED" | "CANCELLED" | "ABANDONED",
  ): Promise<void> {
    if (!this.mandateFlow) return;
    let lastError: unknown;
    for (const delay of [0, 100, 300]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await this.mandateFlow.finish(runId, status);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private async ensureMandateFlowReady(): Promise<void> {
    if (!this.mandateFlow || !(await this.mandateFlow.ready())) {
      throw new HttpError(503, "MandateFlow is unavailable; no secure Runtime was started");
    }
  }

  private async requireFinalizedAuthority(agentId: string): Promise<void> {
    await this.reconcilePendingFinalizations(agentId);
    const pending = this.store
      .snapshot()
      .runs.some(
        (run) =>
          run.agentId === agentId &&
          run.mandateStatus === "security-finalization-pending",
      );
    if (pending) {
      throw new HttpError(
        503,
        "A prior Run capability is still pending terminalization; no new Runtime was started",
      );
    }
  }

  private async reconcilePendingFinalizations(agentId?: string): Promise<void> {
    if (!this.mandateFlow) return;
    const pendingRuns = this.store
      .snapshot()
      .runs.filter(
        (run) =>
          run.mandateStatus === "security-finalization-pending" &&
          (!agentId || run.agentId === agentId),
      );
    for (const run of pendingRuns) {
      const intendedStatus =
        run.status === "cancelled"
          ? "CANCELLED"
          : run.error?.startsWith("Codex finished,")
            ? "COMPLETED"
            : "FAILED";
      let terminal = false;
      try {
        await this.finishMandate(run.id, intendedStatus);
        terminal = true;
      } catch {
        try {
          const evidence = await this.mandateFlow.evidence(run.id);
          terminal = !["PREPARED", "ACTIVE"].includes(evidence.runStatus);
        } catch {
          terminal = false;
        }
      }
      if (terminal) {
        await this.store.mutate((database) => {
          const storedRun = database.runs.find((candidate) => candidate.id === run.id);
          if (storedRun?.mandateStatus === "security-finalization-pending") {
            storedRun.mandateStatus = "closed";
          }
        });
      }
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelRevokedRun(agentId: string, runId: string): Promise<void> {
    this.cancellationRequests.add(runId);
    await waitForCancellation(this.runner.cancel(runId));
    const execution = this.activeExecutions.get(agentId);
    if (execution) await waitForCancellation(execution);
    else this.cancellationRequests.delete(runId);
  }

  private async cancelExecution(agentId: string): Promise<void> {
    const activeRun = this.store
      .snapshot()
      .runs.find(
        (run) =>
          run.agentId === agentId &&
          (run.status === "queued" || run.status === "running"),
      );
    if (!activeRun) return;
    this.cancellationRequests.add(activeRun.id);
    await waitForCancellation(this.runner.cancel(activeRun.id));
    const execution = this.activeExecutions.get(agentId);
    if (execution) await waitForCancellation(execution);
    else this.cancellationRequests.delete(activeRun.id);
  }
}

function createRunCapability(): string {
  return "mfr1_" + randomBytes(32).toString("base64url");
}
