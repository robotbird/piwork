import "server-only";

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { listPiPackages } from "@/lib/db/pi-package-queries";
import { MANAGED_AGENT_DIR } from "@/lib/pi-packages/agent-dir";
import {
  DEFAULT_WEB_SEARCH_PACKAGES,
  isWebSearchPackage,
} from "@/lib/pi-packages/runtime-flag";

/**
 * Host-side pi-web-access MCP service (phase 2 of the sandbox host tools
 * bridge). Spawns the plugin's official standalone entry (`dist/mcp-cli.js`,
 * backed by createStandaloneWebToolCore) and drives it with the official
 * @earendil-works/pi-mcp client over stdio — no Pi session runtime involved.
 *
 * Credential isolation: the child gets a dedicated agentDir (never the chat
 * MANAGED_AGENT_DIR) and only the env vars the admin explicitly allowlists via
 * PIWORK_WEB_ACCESS_PASS_ENV (comma separated, e.g. TAVILY_API_KEY). Provider
 * selection lives in <agentDir>/web-search.json — an explicit admin decision,
 * never inferred. No bulk *_API_KEY passthrough.
 */

/** Dedicated config dir for the MCP child (web-search.json, cache). */
export const WEB_ACCESS_AGENT_DIR = path.resolve(
  process.cwd(),
  ".piwork",
  "web-access"
);

export const WEB_SEARCH_MCP_TOOL = "web_search";
/** Inner timeout (must fire before the sandbox extension's outer one). */
export const WEB_SEARCH_MCP_TIMEOUT_MS = 30_000;
const MAX_RESULT_CHARS = 64 * 1024;

export type ClientBundle = {
  client: McpClient;
  transport: StdioTransport;
};

export type WebAccessServiceDeps = {
  /** Test injection; default resolves from the managed agentDir npm root. */
  resolveCliPath?: () => Promise<string | null>;
  /** Test injection for the spawned client. */
  connect?: (cliPath: string) => Promise<ClientBundle>;
  env?: Record<string, string | undefined>;
};

export class WebAccessUnavailableError extends Error {}

export class WebAccessService {
  private readonly deps: WebAccessServiceDeps;
  private bundle: ClientBundle | undefined;
  private starting: Promise<ClientBundle> | undefined;
  private disposed = false;

  constructor(deps: WebAccessServiceDeps = {}) {
    this.deps = deps;
  }

  /** Plugin CLI path (npm install root under the managed agentDir). */
  async cliPath(): Promise<string | null> {
    if (this.deps.resolveCliPath) {
      return this.deps.resolveCliPath();
    }
    try {
      const records = await listPiPackages();
      const match = records.find(
        (record) =>
          record.resourceSummary.extensions > 0 && isWebSearchPackage(record)
      );
      if (!match) {
        return null;
      }
      const root = path.join(
        MANAGED_AGENT_DIR,
        "npm",
        "node_modules",
        match.name
      );
      const pkgRaw = await readFile(path.join(root, "package.json"), "utf8")
        .then((text) => JSON.parse(text) as { bin?: Record<string, string> })
        .catch(() => null);
      const relative = pkgRaw?.bin?.["pi-web-access-mcp"] ?? "dist/mcp-cli.js";
      const cliPath = path.join(root, relative);
      return (await stat(cliPath).then(
        () => true,
        () => false
      ))
        ? cliPath
        : null;
    } catch {
      return null;
    }
  }

  /** Route-level capability signal: installed plugin with a loadable CLI. */
  async available(): Promise<boolean> {
    return (await this.cliPath()) !== null;
  }

  /**
   * Runs one web_search call. Errors (spawn failure, MCP error result, plugin
   * "Error: ..." text) throw — callers surface an allowlisted message.
   */
  async webSearch(
    input: { numResults?: number; query: string; recencyFilter?: string },
    signal?: AbortSignal
  ): Promise<string> {
    const { client } = await this.ensureClient();
    const result = await client.callTool(
      WEB_SEARCH_MCP_TOOL,
      {
        numResults: input.numResults,
        query: input.query,
        ...(input.recencyFilter ? { recencyFilter: input.recencyFilter } : {}),
      },
      { signal, timeoutMs: WEB_SEARCH_MCP_TIMEOUT_MS }
    );
    if (result.isError) {
      throw new Error(firstText(result.content) || "web_search failed");
    }
    const text = firstText(result.content);
    if (!text) {
      throw new Error("web_search returned no content");
    }
    // The plugin reports provider failures as plain "Error: ..." text without
    // the MCP isError flag (web-tool-core content convention).
    if (text.startsWith("Error:")) {
      throw new Error(text.slice("Error:".length).trim() || "search failed");
    }
    return text.length > MAX_RESULT_CHARS
      ? `${text.slice(0, MAX_RESULT_CHARS)}…[truncated]`
      : text;
  }

  /** Probes the child; also used by tests for handshake verification. */
  async listTools(signal?: AbortSignal): Promise<string[]> {
    const { client } = await this.ensureClient();
    const tools = await client.listTools({ signal });
    return tools.map((tool) => tool.name);
  }

  async close(): Promise<void> {
    this.disposed = true;
    const { bundle } = this;
    this.bundle = undefined;
    await bundle?.client.close().catch(() => undefined);
  }

  private ensureClient(): Promise<ClientBundle> {
    if (this.disposed) {
      return Promise.reject(
        new WebAccessUnavailableError("web access service disposed")
      );
    }
    if (this.bundle) {
      return Promise.resolve(this.bundle);
    }
    this.starting ??= this.spawn().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async spawn(): Promise<ClientBundle> {
    const cliPath = await this.cliPath();
    if (!cliPath) {
      throw new WebAccessUnavailableError(
        "pi-web-access plugin is not installed"
      );
    }
    if (this.deps.connect) {
      return this.retain(await this.deps.connect(cliPath));
    }
    const client = new McpClient({
      name: "piwork-host-tools",
      version: "1.0.0",
    });
    // Credential allowlist: only vars the admin names explicitly.
    const passEnv =
      (this.deps.env ?? process.env).PIWORK_WEB_ACCESS_PASS_ENV ?? "";
    const allowed = new Set(
      passEnv
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    );
    const env: Record<string, string> = {
      LANG: process.env.LANG ?? "C.UTF-8",
      PATH: process.env.PATH ?? "",
      PI_CODING_AGENT_DIR: WEB_ACCESS_AGENT_DIR,
    };
    for (const name of allowed) {
      const value = process.env[name];
      if (value !== undefined) {
        env[name] = value;
      }
    }
    const transport = new StdioTransport({
      args: [cliPath],
      command: process.execPath,
      env,
      inheritEnv: false,
      onStderr: (chunk) => {
        console.warn("[web-access] mcp stderr:", chunk.slice(0, 500));
      },
      stderr: "pipe",
    });
    client.onClose(() => {
      if (this.bundle?.client === client) {
        this.bundle = undefined;
      }
    });
    await client.connect(transport);
    return this.retain({ client, transport });
  }

  private retain(bundle: ClientBundle): ClientBundle {
    if (this.disposed) {
      throw new WebAccessUnavailableError("web access service disposed");
    }
    this.bundle = bundle;
    return bundle;
  }
}

function firstText(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return (block as { text: string }).text;
    }
  }
  return null;
}

const WEB_ACCESS_KEY = Symbol.for("piwork.web-access");
const globalScope = globalThis as Record<symbol, WebAccessService | undefined>;

export function getWebAccessService(): WebAccessService {
  globalScope[WEB_ACCESS_KEY] ??= new WebAccessService();
  return globalScope[WEB_ACCESS_KEY];
}

export const DEFAULT_WEB_ACCESS_PACKAGE_NAMES = DEFAULT_WEB_SEARCH_PACKAGES;
