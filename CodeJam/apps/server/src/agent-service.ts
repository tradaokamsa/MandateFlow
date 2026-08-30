import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import {
  fingerprint,
  generateCapabilityToken,
  redactPersistedText,
} from "./mandateflow/crypto.js";
import {
  MandateFlowKernel,
  PLATFORM_PERMISSION_CEILING,
} from "./mandateflow/kernel.js";
import type { SafeRunEvidence } from "./mandateflow/types.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export const RETRY_PROMPT =
  "Retry only the previously denied crm.resolve_customer call using the exact prior Payment-derived Case reference already present in this thread. Do not call payments.list_failures or cases.lookup_subject again. If denied, stop and report the receipt ID.";

interface ActiveExecution {
  runId: string;
  execution: Promise<void>;
}

export interface MandateFlowReadinessState {
  isReady(): boolean;
}

const ALWAYS_READY: MandateFlowReadinessState = { isReady: () => true };

export class AgentService {
  private readonly activeExecutions = new Map<string, ActiveExecution>();
  private readonly cancellationRequests = new Set<string>();
  private readonly cancellations = new Map<string, Promise<void>>();
  private readonly closingAgents = new Set<string>();
  private readonly pendingIssuances = new Map<string, Set<Promise<void>>>();
  private readonly kernel: MandateFlowKernel | null;
  private rejectNewRuns = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    kernel: MandateFlowKernel | null = null,
    private readonly readiness: MandateFlowReadinessState = ALWAYS_READY,
  ) {
    this.kernel = config.mandateFlowEnabled
      ? (kernel ??
        new MandateFlowKernel({
          capabilityTtlMs: config.mandateFlowCapabilityTtlMs,
        }))
      : null;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    const timestamp = now();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status !== "queued" && run.status !== "running") continue;
        const grant = run.runGrantId
          ? database.runGrants.find((candidate) => candidate.id === run.runGrantId)
          : undefined;
        if (
          this.kernel &&
          grant &&
          (grant.status === "queued" || grant.status === "active")
        ) {
          this.kernel.terminalizeRun(
            database,
            run.id,
            "restart_interrupted",
            timestamp,
          );
        } else {
          run.status = "cancelled";
          run.completedAt = timestamp;
        }
        run.error = "Server restarted while this run was active";
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = timestamp;
        }
      }
    });
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
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      activePolicyContextId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    return this.store.mutate((database) => {
      database.agents.push(agent);
      return agent;
    });
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy" || this.closingAgents.has(id)) {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (agent.status === "busy" || this.closingAgents.has(id)) {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) {
        agent.description = input.description.trim();
      }
      if (input.instructions !== undefined) {
        agent.instructions = input.instructions.trim();
      }
      agent.lastError = null;
      agent.updatedAt = now();
      return agent;
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    if (this.closingAgents.has(id)) {
      throw new HttpError(409, "Agent deletion is already in progress");
    }
    this.closingAgents.add(id);
    try {
      await this.awaitPendingIssuances(id);
      await this.cancelActiveExecution(id);
      const archivedWorkspace = await this.workspaces.archive(agent);
      try {
        await this.store.mutate((database) => {
          const contextIds = new Set(
            database.policyContexts
              .filter((context) => context.agentId === id)
              .map((context) => context.id),
          );
          const runIds = new Set(
            database.runs.filter((run) => run.agentId === id).map((run) => run.id),
          );
          database.agents = database.agents.filter((item) => item.id !== id);
          database.messages = database.messages.filter((item) => item.agentId !== id);
          database.runs = database.runs.filter((item) => item.agentId !== id);
          database.policyContexts = database.policyContexts.filter(
            (context) => !contextIds.has(context.id),
          );
          database.runGrants = database.runGrants.filter(
            (grant) =>
              grant.agentId !== id &&
              !runIds.has(grant.runId) &&
              !contextIds.has(grant.policyContextId),
          );
          database.protectedReferences = database.protectedReferences.filter(
            (reference) => !contextIds.has(reference.policyContextId),
          );
          database.policyReceipts = database.policyReceipts.filter(
            (receipt) =>
              !runIds.has(receipt.runId) &&
              !contextIds.has(receipt.policyContextId),
          );
          database.fixtureCounters = database.fixtureCounters.filter(
            (counter) => !contextIds.has(counter.policyContextId),
          );
        });
      } catch (persistenceError) {
        try {
          await this.workspaces.restoreArchive(agent, archivedWorkspace);
        } catch (restoreError) {
          throw new AggregateError(
            [persistenceError, restoreError],
            "Agent deletion failed and its workspace could not be restored",
          );
        }
        throw persistenceError;
      }
      return { archivedWorkspace };
    } finally {
      this.closingAgents.delete(id);
    }
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    if (this.closingAgents.has(id)) {
      throw new HttpError(409, "Agent is already stopping");
    }
    this.closingAgents.add(id);
    try {
      await this.awaitPendingIssuances(id);
      await this.cancelActiveExecution(id);
      return await this.setStatus(id, "stopped");
    } finally {
      this.closingAgents.delete(id);
    }
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

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    return this.issueExecution(agentId, prompt, null);
  }

  async retryRun(
    predecessorRunId: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!this.config.mandateFlowEnabled) {
      throw new HttpError(404, "MandateFlow Retry is not enabled");
    }
    const predecessor = this.getRun(predecessorRunId);
    return this.issueExecution(
      predecessor.agentId,
      RETRY_PROMPT,
      predecessorRunId,
    );
  }

  mandateFlowEvidence(runId: string): SafeRunEvidence {
    if (!this.kernel || !this.config.mandateFlowEnabled) {
      throw new HttpError(404, "MandateFlow evidence is not enabled");
    }
    try {
      return this.kernel.evidenceForRun(this.store.snapshot(), runId);
    } catch {
      throw new HttpError(404, "MandateFlow evidence not found");
    }
  }

  async cancelRun(runId: string): Promise<boolean> {
    const run = this.store.snapshot().runs.find((candidate) => candidate.id === runId);
    const active = run
      ? this.activeExecutions.get(run.agentId)?.runId === runId
      : false;
    if (!run || (!active && run.status !== "queued" && run.status !== "running")) {
      return false;
    }
    await this.requestCancellation(runId);
    return true;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.rejectNewRuns = true;
    this.shutdownPromise = (async () => {
      await Promise.all(
        Array.from(this.pendingIssuances.values()).flatMap((pending) =>
          Array.from(pending),
        ),
      );
      await Promise.all(
        Array.from(this.activeExecutions.values(), ({ runId }) =>
          this.requestCancellation(runId),
        ),
      );
    })();
    return this.shutdownPromise;
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
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
          : "Codex CLI in application container",
      mandateFlowEnabled: this.config.mandateFlowEnabled,
      mandateFlowReady:
        !this.config.mandateFlowEnabled || this.readiness.isReady(),
      mandateFlowMcpUrl: this.config.mandateFlowRuntimeMcpUrl,
    };
  }

  private assertAccepting(agentId: string): void {
    if (this.rejectNewRuns) {
      throw new HttpError(503, "The service is shutting down");
    }
    if (this.closingAgents.has(agentId)) {
      throw new HttpError(409, "This Agent is stopping or being deleted");
    }
    if (this.config.mandateFlowEnabled && !this.readiness.isReady()) {
      throw new HttpError(503, "MandateFlow Gateway is unavailable");
    }
  }

  private async issueExecution(
    agentId: string,
    prompt: string,
    retryOfRunId: string | null,
  ): Promise<{ run: AgentRun; message: Message }> {
    this.assertAccepting(agentId);
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const capability = this.config.mandateFlowEnabled
      ? generateCapabilityToken()
      : null;
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
      retryOfRunId,
      capabilityFingerprint: null,
      runtimeFingerprint: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };

    let resolvePending!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    const pendingForAgent = this.pendingIssuances.get(agentId) ?? new Set();
    pendingForAgent.add(pending);
    this.pendingIssuances.set(agentId, pendingForAgent);
    try {
      const issued = await this.store.mutate((database) => {
        this.assertAccepting(agentId);
        const agent = database.agents.find((item) => item.id === agentId);
        if (!agent) throw new HttpError(404, "Agent not found");
        if (agent.status === "stopped") {
          throw new HttpError(409, "Start the Agent before sending a message");
        }
        if (agent.status === "busy") {
          throw new HttpError(409, "This Agent is already running");
        }
        if (this.config.mandateFlowEnabled && agent.status !== "ready") {
          throw new HttpError(409, "The Agent must be ready for a secure Run");
        }

        let policyContextId: string | null = null;
        if (retryOfRunId) {
          const predecessor = database.runs.find(
            (candidate) => candidate.id === retryOfRunId,
          );
          if (!predecessor || predecessor.agentId !== agentId) {
            throw new HttpError(409, "Retry predecessor is not available");
          }
          policyContextId = predecessor.policyContextId;
        }

        database.runs.push(run);
        database.messages.push(message);
        if (this.kernel && capability) {
          try {
            this.kernel.issueRun(database, {
              agentId,
              runId,
              capability,
              requestedPermissions: PLATFORM_PERMISSION_CEILING,
              retryOfRunId,
              policyContextId,
              now: timestamp,
            });
          } catch (error) {
            if (retryOfRunId && error instanceof Error) {
              throw new HttpError(409, error.message);
            }
            throw error;
          }
        } else {
          agent.status = "busy";
          agent.lastError = null;
          agent.updatedAt = timestamp;
        }
        return { agent, run, message };
      });

      const execution = this.executeRun(issued.agent, issued.run, capability);
      const active: ActiveExecution = { runId, execution };
      this.activeExecutions.set(agentId, active);
      void execution
        .finally(() => {
          if (this.activeExecutions.get(agentId) === active) {
            this.activeExecutions.delete(agentId);
          }
        })
        .catch(() => undefined);
      return { run: issued.run, message: issued.message };
    } finally {
      pendingForAgent.delete(pending);
      if (pendingForAgent.size === 0) this.pendingIssuances.delete(agentId);
      resolvePending();
    }
  }

  private async executeRun(
    agentAtStart: Agent,
    runAtStart: AgentRun,
    capability: string | null,
  ): Promise<void> {
    try {
      const activated = await this.store.mutate((database) => {
        const run = database.runs.find((item) => item.id === runAtStart.id);
        if (!run) return false;
        if (this.cancellationRequests.has(run.id)) return false;
        if (this.kernel && run.runGrantId) {
          const grant = database.runGrants.find(
            (candidate) => candidate.id === run.runGrantId,
          );
          if (!grant || grant.status !== "queued" || run.status !== "queued") {
            return false;
          }
          this.kernel.activateRun(database, run.id, now());
        } else {
          if (run.status !== "queued") return false;
          run.status = "running";
          run.startedAt = now();
        }
        return true;
      });
      if (!activated || this.cancellationRequests.has(runAtStart.id)) {
        throw new RunCancelledError();
      }

      const result = await this.runner.run({
        runId: runAtStart.id,
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: runAtStart.prompt,
        threadId: agentAtStart.codexThreadId,
        mandateFlowCapability: capability,
      });
      const completedAt = now();
      const safeOutput = redactPersistedText(result.output, capability);
      await this.store.mutate((database) => {
        const run = database.runs.find((item) => item.id === runAtStart.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!run || !agent) return;
        if (
          this.cancellationRequests.has(run.id) ||
          (this.config.mandateFlowEnabled && !this.readiness.isReady())
        ) {
          throw new RunCancelledError();
        }

        if (this.kernel && run.runGrantId) {
          const grant = database.runGrants.find(
            (candidate) => candidate.id === run.runGrantId,
          );
          if (!grant || grant.status !== "active" || run.status !== "running") {
            if (agent.status === "busy") {
              agent.status = "ready";
              agent.updatedAt = completedAt;
            }
            return;
          }
          if (!result.threadId) {
            throw new Error("Secure Codex Run completed without a thread ID");
          }
          this.kernel.bindThread(database, grant.policyContextId, result.threadId);
          this.kernel.terminalizeRun(database, run.id, "completed", completedAt);
        } else {
          if (run.status !== "running") return;
          run.status = "completed";
          run.completedAt = completedAt;
        }

        run.output = safeOutput;
        run.usage = result.usage;
        run.runtimeFingerprint = fingerprint("runtime", result.runtimeId);
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: safeOutput,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const explicitlyCancelled = this.cancellationRequests.has(runAtStart.id);
      const cancelled = error instanceof RunCancelledError || explicitlyCancelled;
      const message = redactPersistedText(
        error instanceof Error ? error.message : String(error),
        capability,
      );
      try {
        await this.store.mutate((database) => {
          const run = database.runs.find((item) => item.id === runAtStart.id);
          const agent = database.agents.find((item) => item.id === agentAtStart.id);
          if (!run) return;
          let terminalizedHere = false;
          if (this.kernel && run.runGrantId) {
            const grant = database.runGrants.find(
              (candidate) => candidate.id === run.runGrantId,
            );
            if (grant?.status === "queued" || grant?.status === "active") {
              this.kernel.terminalizeRun(
                database,
                run.id,
                cancelled ? "cancelled" : "failed",
                completedAt,
              );
              terminalizedHere = true;
            }
          } else if (run.status === "queued" || run.status === "running") {
            run.status = cancelled ? "cancelled" : "failed";
            run.completedAt = completedAt;
            terminalizedHere = true;
          }
          if (terminalizedHere) run.error = cancelled ? null : message;
          if (agent && !explicitlyCancelled && agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
            agent.lastError = cancelled ? null : message;
            agent.updatedAt = completedAt;
          }
        });
      } catch {
        // The store's fatal hook owns readiness. There is no safe fallback write.
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
      return agent;
    });
  }

  private async cancelActiveExecution(agentId: string): Promise<void> {
    const active = this.activeExecutions.get(agentId);
    if (active) await this.requestCancellation(active.runId);
  }

  private async awaitPendingIssuances(agentId: string): Promise<void> {
    const pending = this.pendingIssuances.get(agentId);
    if (pending) await Promise.all(Array.from(pending));
  }

  private requestCancellation(runId: string): Promise<void> {
    const existing = this.cancellations.get(runId);
    if (existing) return existing;
    const cancellation = this.performCancellation(runId);
    this.cancellations.set(runId, cancellation);
    void cancellation
      .finally(() => {
        if (this.cancellations.get(runId) === cancellation) {
          this.cancellations.delete(runId);
        }
      })
      .catch(() => undefined);
    return cancellation;
  }

  private async performCancellation(runId: string): Promise<void> {
    this.cancellationRequests.add(runId);
    let transitionError: unknown = null;
    let agentId: string | null = null;
    try {
      try {
        await this.store.mutate((database) => {
          const run = database.runs.find((candidate) => candidate.id === runId);
          if (!run) return;
          agentId = run.agentId;
          if (this.kernel && run.runGrantId) {
            const grant = database.runGrants.find(
              (candidate) => candidate.id === run.runGrantId,
            );
            if (grant?.status === "queued" || grant?.status === "active") {
              this.kernel.terminalizeRun(database, run.id, "cancelled", now());
            }
          } else if (run.status === "queued" || run.status === "running") {
            run.status = "cancelled";
            run.completedAt = now();
          }
        });
      } catch (error) {
        transitionError = error;
      }

      await this.runner.cancel(runId).catch(() => false);
      const active = agentId ? this.activeExecutions.get(agentId) : undefined;
      if (active?.runId === runId) await active.execution;

      if (agentId) {
        await this.store.mutate((database) => {
          const agent = database.agents.find((candidate) => candidate.id === agentId);
          const run = database.runs.find((candidate) => candidate.id === runId);
          if (run && (run.status === "queued" || run.status === "running")) {
            run.status = "cancelled";
            run.completedAt = now();
          }
          const hasNonterminalRun = database.runs.some(
            (candidate) =>
              candidate.agentId === agentId &&
              (candidate.status === "queued" || candidate.status === "running"),
          );
          if (agent?.status === "busy" && !hasNonterminalRun) {
            agent.status = "ready";
            agent.lastError = null;
            agent.updatedAt = now();
          }
        });
      }
      if (transitionError) throw transitionError;
    } finally {
      this.cancellationRequests.delete(runId);
    }
  }
}
