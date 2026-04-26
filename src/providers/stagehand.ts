import { Stagehand } from "@browserbasehq/stagehand";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { PotterError } from "../errors.js";
import { makeLogger, type Logger } from "../logging.js";

export type StagehandEnv = "LOCAL" | "BROWSERBASE";

export interface StagehandSession {
  id: string;
  env: StagehandEnv;
  stagehand: Stagehand;
  createdAt: Date;
  lastActivity: Date;
}

export interface CreateSessionOptions {
  viewport?: { width: number; height: number };
  userAgent?: string;
  stealth?: boolean;
  forceLocal?: boolean;
}

interface InternalSession extends StagehandSession {
  timeoutTimer: NodeJS.Timeout;
  inFlightLeases: number;
}

const pickEnv = (forceLocal: boolean | undefined): StagehandEnv => {
  if (forceLocal) return "LOCAL";
  const cfg = loadConfig();
  const hasBrowserbase = Boolean(cfg.browserbaseApiKey && cfg.browserbaseProjectId);
  return hasBrowserbase ? "BROWSERBASE" : "LOCAL";
};

class StagehandManager {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly log: Logger = makeLogger(loadConfig().logLevel);
  private shutdownRegistered = false;

  async createSession(options: CreateSessionOptions = {}): Promise<StagehandSession> {
    this.ensureShutdownHook();

    const cfg = loadConfig();
    const env = pickEnv(options.forceLocal);
    const tool = "potter_browser_open";

    if (env === "BROWSERBASE" && (!cfg.browserbaseApiKey || !cfg.browserbaseProjectId)) {
      throw new PotterError({
        tool,
        provider: "stagehand",
        reason:
          "Browserbase credentials missing: POTTER_BROWSERBASE_API_KEY and POTTER_BROWSERBASE_PROJECT_ID both required.",
        retryable: false,
        recommended_action:
          "Add both Browserbase values to .env, or pass forceLocal=true to use local Playwright.",
      });
    }

    const stagehandOpts: ConstructorParameters<typeof Stagehand>[0] = {
      env,
      verbose: 0,
      disablePino: true,
      logger: (line) => {
        const level =
          line.level === 0 ? "error" : line.level === 1 ? "info" : "debug";
        this.log(level, "stagehand", {
          category: line.category,
        });
      },
    };

    if (env === "BROWSERBASE") {
      stagehandOpts.apiKey = cfg.browserbaseApiKey;
      stagehandOpts.projectId = cfg.browserbaseProjectId;
      if (options.viewport) {
        stagehandOpts.browserbaseSessionCreateParams = {
          projectId: cfg.browserbaseProjectId!,
          browserSettings: {
            viewport: options.viewport,
          },
        };
      }
      if (options.userAgent || options.stealth) {
        this.log("warn", "stagehand_unsupported_option", {
          msg: "userAgent and stealth not wired for Browserbase in Phase 1; options ignored.",
        });
      }
    } else if (options.viewport) {
      stagehandOpts.localBrowserLaunchOptions = { viewport: options.viewport };
    }

    const stagehand = new Stagehand(stagehandOpts);
    try {
      await stagehand.init();
    } catch (err) {
      try {
        await stagehand.close({ force: true });
      } catch (closeErr) {
        this.log("warn", "stagehand_init_cleanup_failed", {
          error: closeErr instanceof Error ? closeErr.message : String(closeErr),
        });
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new PotterError({
        tool,
        provider: "stagehand",
        reason,
        retryable: false,
        recommended_action:
          env === "BROWSERBASE"
            ? "Verify Browserbase credentials and that the project has available sessions."
            : "Run `npx playwright install chromium` and retry. Chromium is required in LOCAL mode.",
      });
    }

    const id = randomUUID();
    const now = new Date();
    const timeoutMs = cfg.browserSessionTimeoutMinutes * 60_000;
    const timeoutTimer = setTimeout(() => {
      this.closeSession(id).catch((err) =>
        this.log("warn", "stagehand_timeout_close_failed", {
          id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }, timeoutMs);
    timeoutTimer.unref();

    const session: InternalSession = {
      id,
      env,
      stagehand,
      createdAt: now,
      lastActivity: now,
      timeoutTimer,
      inFlightLeases: 0,
    };
    this.sessions.set(id, session);
    this.log("info", "stagehand_session_opened", { id, env });
    return this.toPublic(session);
  }

  async withLease<T>(id: string, tool: string, op: (session: StagehandSession) => Promise<T>): Promise<T> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new PotterError({
        tool,
        provider: "stagehand",
        reason: `Unknown or expired session: ${id}`,
        retryable: false,
        recommended_action:
          "Call potter_browser_open to get a new session; sessions time out after POTTER_BROWSER_SESSION_TIMEOUT_MINUTES of inactivity.",
      });
    }
    session.inFlightLeases += 1;
    clearTimeout(session.timeoutTimer);
    session.lastActivity = new Date();
    try {
      return await op(this.toPublic(session));
    } finally {
      session.inFlightLeases = Math.max(0, session.inFlightLeases - 1);
      session.lastActivity = new Date();
      if (session.inFlightLeases === 0 && this.sessions.has(id)) {
        const cfg = loadConfig();
        session.timeoutTimer = setTimeout(() => {
          if ((this.sessions.get(id)?.inFlightLeases ?? 0) === 0) {
            this.closeSession(id).catch(() => undefined);
          }
        }, cfg.browserSessionTimeoutMinutes * 60_000);
        session.timeoutTimer.unref();
      }
    }
  }

  getSession(id: string, tool = "potter_browser_*"): StagehandSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new PotterError({
        tool,
        provider: "stagehand",
        reason: `Unknown or expired session: ${id}`,
        retryable: false,
        recommended_action:
          "Call potter_browser_open to get a new session; sessions time out after POTTER_BROWSER_SESSION_TIMEOUT_MINUTES of inactivity.",
      });
    }
    this.touch(session);
    return this.toPublic(session);
  }

  async closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    clearTimeout(session.timeoutTimer);
    this.sessions.delete(id);
    try {
      await session.stagehand.close();
      this.log("info", "stagehand_session_closed", { id, env: session.env });
    } catch (err) {
      this.log("warn", "stagehand_close_failed", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async closeSessionSafely(id: string, maxWaitMs = 30_000): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    const start = Date.now();
    while (session.inFlightLeases > 0 && Date.now() - start < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (session.inFlightLeases > 0) {
      this.log("warn", "stagehand_close_forced_with_leases", {
        id,
        leases: session.inFlightLeases,
      });
    }
    await this.closeSession(id);
  }

  async closeAllSessions(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.closeSession(id)));
  }

  listSessions(): Array<Omit<StagehandSession, "stagehand">> {
    return [...this.sessions.values()].map(
      ({ stagehand: _sh, timeoutTimer: _t, inFlightLeases: _l, ...rest }) => rest,
    );
  }

  size(): number {
    return this.sessions.size;
  }

  private touch(session: InternalSession): void {
    session.lastActivity = new Date();
    clearTimeout(session.timeoutTimer);
    const cfg = loadConfig();
    session.timeoutTimer = setTimeout(() => {
      this.closeSession(session.id).catch(() => undefined);
    }, cfg.browserSessionTimeoutMinutes * 60_000);
    session.timeoutTimer.unref();
  }

  private toPublic(session: InternalSession): StagehandSession {
    return {
      id: session.id,
      env: session.env,
      stagehand: session.stagehand,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
    };
  }

  private ensureShutdownHook(): void {
    if (this.shutdownRegistered) return;
    this.shutdownRegistered = true;
    const cleanup = () => {
      this.closeAllSessions().catch(() => undefined);
    };
    process.on("beforeExit", cleanup);
    process.on("exit", cleanup);
  }
}

let instance: StagehandManager | null = null;

export const getStagehand = (): StagehandManager => {
  if (instance === null) instance = new StagehandManager();
  return instance;
};

export const closeAllStagehandSessions = async (): Promise<void> => {
  if (instance === null) return;
  await instance.closeAllSessions();
};
