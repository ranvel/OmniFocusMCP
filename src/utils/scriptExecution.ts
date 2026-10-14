import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { existsSync } from "fs";
import { Logger } from './logger.js';
import { JXA_FORMAT_DATE_SOURCE } from './dateSerialization.js';

const execAsync = promisify(exec);
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB — default 1MB is too small for large OmniFocus databases

let _logger: Logger | null = null;

export function setScriptLogger(logger: Logger): void {
  _logger = logger;
}

// --- osascript contention control (issue #80, problem B) -----------------------
// OmniFocus.app is a single-threaded shared resource. Under concurrency it
// returns `AppleEvent timed out (-1712)` and, at the default timeout, hangs each
// caller for ~120s. We can't fix cross-process contention from inside one server,
// but we can stop a single server from making it worse and fail fast instead of
// hanging: (1) bound how many osascript children we run at once, (2) impose a
// Node-level timeout that kills a stuck osascript, (3) retry timeouts with
// backoff — but ONLY for idempotent reads. A -1712 on a write may have partially
// applied, so retrying a create could duplicate; writes fail fast and honestly.

function resolvePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const MAX_CONCURRENT_OSASCRIPT = resolvePositiveIntEnv('OMNIFOCUS_MCP_MAX_CONCURRENT_OSASCRIPT', 4);
const OSASCRIPT_TIMEOUT_MS = resolvePositiveIntEnv('OMNIFOCUS_MCP_OSASCRIPT_TIMEOUT_MS', 60_000);

/** Minimal FIFO semaphore bounding concurrent work. */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const osascriptSemaphore = new Semaphore(MAX_CONCURRENT_OSASCRIPT);

/**
 * Classify an osascript failure (issue #121).
 *
 * These two cases look similar and are opposite signals:
 *
 * - `app-timeout` — the app ANSWERED, with `-1712`. It is alive and contended.
 *   Retrying is reasonable.
 * - `client-kill` — our own Node timeout SIGTERMed the child because the app
 *   never answered at all. The app is wedged, and a process sample of a wedged
 *   OmniFocus shows why retrying is actively harmful: every osascript we kill
 *   leaves a `receiveFrom-<pid>` AppleEvent dispatch queue inside the app,
 *   blocked forever on ownership it will never get. Eight such orphaned queues
 *   were counted in one snapshot — four from a concurrency burst, four from
 *   retries. Nothing on our side can release them; only killing the app can.
 *
 * Our timeout (60s) is shorter than the AppleEvent default (~120s), so the kill
 * fires first in practice — which made `client-kill` the dominant case on the
 * retry path it is least safe for.
 */
export type OsascriptFailureClass = 'app-timeout' | 'client-kill' | 'other';

export function classifyOsascriptError(err: unknown): OsascriptFailureClass {
  const e = err as { message?: string; stderr?: string; killed?: boolean; signal?: string };
  if (e?.killed === true || e?.signal === 'SIGTERM') return 'client-kill';
  const text = `${e?.message ?? ''} ${e?.stderr ?? ''}`;
  if (text.includes('-1712') || text.includes('AppleEvent timed out') || text.includes('timed out')) {
    return 'app-timeout';
  }
  return 'other';
}

/**
 * The union of both transient classes.
 *
 * Retained for callers that just want "was this transient?", but do NOT use it
 * as a retry gate: retrying a `client-kill` is what amplifies a wedge (#121).
 * Gate on `classifyOsascriptError(err) === 'app-timeout'` instead.
 */
export function isRetryableOsascriptError(err: unknown): boolean {
  return classifyOsascriptError(err) !== 'other';
}

// --- app health circuit breaker (issue #121) ----------------------------------
// Once the app has failed to answer at all, further dispatches make things
// strictly worse. Hold that state process-wide so queued queries fail fast
// instead of each burning a full timeout (and each leaving another orphaned
// queue) against a target already known to be dead.

const UNRESPONSIVE_COOLDOWN_MS = resolvePositiveIntEnv(
  'OMNIFOCUS_MCP_UNRESPONSIVE_COOLDOWN_MS',
  30_000
);
const PROBE_TIMEOUT_MS = resolvePositiveIntEnv('OMNIFOCUS_MCP_PROBE_TIMEOUT_MS', 5_000);

export class AppUnresponsiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppUnresponsiveError';
  }
}

const UNRESPONSIVE_MESSAGE =
  'OmniFocus is not responding to AppleEvents. Requests are paused to avoid making it worse. ' +
  'If this persists, quit every omnifocus-mcp process and then restart OmniFocus (in that order).';

let unresponsiveSince: number | null = null;

/** Test hook: clear the breaker. */
export function _resetAppHealth(): void {
  unresponsiveSince = null;
}

export function markAppUnresponsive(now: number = Date.now()): void {
  if (unresponsiveSince === null) {
    _logger?.error(
      'scriptExecution',
      'OmniFocus did not answer before the timeout; pausing dispatch (issue #121).'
    );
  }
  unresponsiveSince = now;
}

export function markAppResponsive(): void {
  if (unresponsiveSince !== null) {
    _logger?.info('scriptExecution', 'OmniFocus is answering again; resuming dispatch.');
  }
  unresponsiveSince = null;
}

/** True while the breaker is open and still inside its cooldown. */
export function isAppKnownUnresponsive(now: number = Date.now()): boolean {
  return unresponsiveSince !== null && now - unresponsiveSince < UNRESPONSIVE_COOLDOWN_MS;
}

/** True when the breaker is open but the cooldown has elapsed — probe once. */
export function shouldProbeAppHealth(now: number = Date.now()): boolean {
  return unresponsiveSince !== null && now - unresponsiveSince >= UNRESPONSIVE_COOLDOWN_MS;
}

/**
 * One cheap AppleEvent with a short timeout, used to decide whether the app has
 * recovered. Deliberately does NOT go through the semaphore: if wedged queries
 * are holding every slot, the probe must still be able to run. It is also the
 * only thing we send while the breaker is open, so at most one transaction per
 * cooldown is risked against a possibly-wedged app.
 */
export async function probeOmniFocusAlive(
  execFn: (cmd: string, opts: any) => Promise<unknown> = execAsync as any,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<boolean> {
  try {
    await execFn(
      `osascript -e 'tell application "OmniFocus" to get name of default document'`,
      { timeout: timeoutMs, killSignal: 'SIGTERM', maxBuffer: 64 * 1024 }
    );
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `attempt`, retrying with backoff while `shouldRetry(err)` holds. Extracted
 * (with injectable sleep) so the retry policy is unit-testable without osascript.
 */
export async function withOsascriptRetry<T>(
  attempt: () => Promise<T>,
  opts: {
    shouldRetry: (err: unknown) => boolean;
    backoffsMs?: number[];
    sleepFn?: (ms: number) => Promise<void>;
  }
): Promise<T> {
  // Backoffs lengthened from [500, 1500] (#121): sub-2s gaps gave a contended
  // app no room to drain before the next full query landed on it.
  const backoffs = opts.backoffsMs ?? [2000, 6000];
  const doSleep = opts.sleepFn ?? sleep;
  let i = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (i >= backoffs.length || !opts.shouldRetry(err)) throw err;
      _logger?.error('scriptExecution', `osascript retryable failure (attempt ${i + 1}); retrying`);
      await doSleep(backoffs[i]);
      i++;
    }
  }
}

export interface RunOsascriptOptions {
  language?: 'AppleScript' | 'JavaScript';
  maxBuffer?: number;
  timeoutMs?: number;
  /** Only enable for idempotent reads — see the note above. */
  retryOnTimeout?: boolean;
}

/**
 * Execute an osascript file behind the shared concurrency gate with a hard
 * timeout, optionally retrying transient timeouts. All osascript invocations in
 * the server route through here so the bounds actually apply globally per-process.
 */
export async function runOsascriptFile(
  tempFile: string,
  options: RunOsascriptOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const {
    language,
    maxBuffer = MAX_BUFFER,
    timeoutMs = OSASCRIPT_TIMEOUT_MS,
    retryOnTimeout = false,
  } = options;
  const langFlag = language === 'JavaScript' ? '-l JavaScript ' : '';
  const cmd = `osascript ${langFlag}"${tempFile}"`;

  // Circuit breaker (#121). While the app is known unresponsive, dispatch
  // nothing at all — every osascript we send and then kill leaves a permanently
  // blocked AppleEvent queue inside the app. Failing fast here is not just
  // faster, it avoids inflicting further damage.
  if (isAppKnownUnresponsive()) {
    throw new AppUnresponsiveError(UNRESPONSIVE_MESSAGE);
  }
  if (shouldProbeAppHealth()) {
    if (await probeOmniFocusAlive()) {
      markAppResponsive();
    } else {
      markAppUnresponsive();
      throw new AppUnresponsiveError(UNRESPONSIVE_MESSAGE);
    }
  }

  const attempt = () =>
    osascriptSemaphore.run(() =>
      execAsync(cmd, { maxBuffer, timeout: timeoutMs, killSignal: 'SIGTERM' })
    );

  // A client-kill means the app never answered. Do not retry it — trip the
  // breaker and surface an honest error instead. Only an app-reported timeout
  // (-1712), which proves the app is alive and merely contended, is retried.
  const run = async (): Promise<{ stdout: string; stderr: string }> => {
    try {
      const out = retryOnTimeout
        ? await withOsascriptRetry(attempt, {
            shouldRetry: (err) => classifyOsascriptError(err) === 'app-timeout',
          })
        : await attempt();
      markAppResponsive();
      return out;
    } catch (err) {
      if (classifyOsascriptError(err) === 'client-kill') {
        markAppUnresponsive();
        throw new AppUnresponsiveError(UNRESPONSIVE_MESSAGE);
      }
      throw err;
    }
  };

  return run();
}

// Helper function to execute OmniFocus scripts
export async function executeJXA(script: string): Promise<any[]> {
  const start = Date.now();
  try {
    // Write the script to a temporary file in the system temp directory
    const tempFile = join(tmpdir(), `jxa_script_${crypto.randomUUID()}.js`);

    // Write the script to the temporary file
    writeFileSync(tempFile, script);

    _logger?.debug("scriptExecution", "Executing JXA script");

    // Execute the script using osascript (read path — safe to retry on -1712)
    const { stdout, stderr } = await runOsascriptFile(tempFile, {
      language: 'JavaScript',
      retryOnTimeout: true,
    });

    if (stderr) {
      console.error("Script stderr output:", stderr);
    }

    // Clean up the temporary file
    unlinkSync(tempFile);

    const elapsed = Date.now() - start;
    _logger?.debug("scriptExecution", `JXA script completed in ${elapsed}ms`);

    // Parse the output as JSON
    try {
      const result = JSON.parse(stdout);
      return result;
    } catch (e) {
      console.error("Failed to parse script output as JSON:", e);

      // If this contains a "Found X tasks" message, treat it as a successful non-JSON response
      if (stdout.includes("Found") && stdout.includes("tasks")) {
        return [];
      }

      return [];
    }
  } catch (error) {
    const elapsed = Date.now() - start;
    _logger?.error("scriptExecution", `JXA script failed after ${elapsed}ms: ${error}`);
    console.error("Failed to execute JXA script:", error);
    throw error;
  }
}

const escapeContent = (content: string) => {
  return content
    .replace(/\\/g, "\\\\") // Escape backslashes
    .replace(/`/g, "\\`") // Escape backticks
    .replace(/\$/g, "\\$"); // Escape dollar signs
};

/**
 * A JavaScript string literal for any string. `JSON.stringify` already escapes
 * quotes, backslashes and control characters; the two Unicode line separators
 * are the one thing JSON allows raw that a JS source line must not contain.
 */
function jsStringLiteral(value: string): string {
  // Spelled without \u escapes in source so no tool between here and the
  // file can turn them into the raw characters they stand for.
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return JSON.stringify(value)
    .split(LS).join('\\' + 'u2028')
    .split(PS).join('\\' + 'u2029');
}

/**
 * Resolve `@name.js` to a file under `omnifocusScripts/` (dist first, then
 * src); any other path is used as given.
 */
function resolveScriptPath(scriptPath: string): string {
  if (!scriptPath.startsWith("@")) return scriptPath;
  const scriptName = scriptPath.substring(1);
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  const distPath = join(__dirname, "..", "utils", "omnifocusScripts", scriptName);
  const srcPath = join(__dirname, "..", "..", "src", "utils", "omnifocusScripts", scriptName);

  if (existsSync(distPath)) return distPath;
  if (existsSync(srcPath)) return srcPath;
  return join(__dirname, "..", "omnifocusScripts", scriptName);
}

/**
 * The one JXA shim that carries an OmniJS payload into OmniFocus. `sections`
 * are joined with blank lines into the payload; the payload is escaped into a
 * template literal, so backslashes, backticks and `$` in it survive verbatim.
 */
function buildOmniJsWrapper(sections: string[]): string {
  const escapedScript = escapeContent(sections.join("\n\n"));
  return `
    function run() {
      try {
        const app = Application('OmniFocus');
        app.includeStandardAdditions = true;

        // Run the OmniJS script in OmniFocus and capture the output
        const result = app.evaluateJavascript(\`${escapedScript}\`);

        // Return the result
        return result;
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    }
    `;
}

/** Write the wrapper to a temp file and run it through the shared transport. */
async function runOmniJsPayload(opts: {
  label: string;
  sections: string[];
  retryOnTimeout: boolean;
}): Promise<{ stdout: string; stderr: string }> {
  const tempFile = join(tmpdir(), `jxa_wrapper_${crypto.randomUUID()}.js`);
  _logger?.debug("scriptExecution", `Executing OmniFocus script: ${opts.label}`);
  writeFileSync(tempFile, buildOmniJsWrapper(opts.sections));
  try {
    return await runOsascriptFile(tempFile, {
      language: 'JavaScript',
      retryOnTimeout: opts.retryOnTimeout,
    });
  } finally {
    try { unlinkSync(tempFile); } catch {}
  }
}

/**
 * Run a read-only OmniJS script inside OmniFocus. Arguments arrive in the
 * payload as the `argv` array (only declared when there are any). Safe to retry
 * on -1712 because reads are idempotent.
 */
export async function executeOmniFocusScript(
  scriptPath: string,
  args?: string[]
): Promise<any> {
  const start = Date.now();
  try {
    const scriptContent = readFileSync(resolveScriptPath(scriptPath), "utf8");

    // Every payload gets `formatDate` from the canonical implementation (#91) instead
    // of declaring its own. The payloads each used to carry a `toISOString()` copy,
    // which meant a timezone fix had to be applied in N places or silently only
    // half-land. Payloads must NOT declare `formatDate` themselves — a `function`
    // declaration alongside this `const` is a redeclaration SyntaxError, which the
    // prelude test asserts against.
    const sections = [JXA_FORMAT_DATE_SOURCE];
    if (args && args.length > 0) {
      const quotedArgs = args.map((arg) => `"${escapeContent(arg)}"`).join(", ");
      sections.push(`// Set up arguments\nconst argv = [${quotedArgs}];`);
    }
    sections.push(scriptContent);

    // Read path — safe to retry on -1712.
    const { stdout, stderr } = await runOmniJsPayload({
      label: scriptPath,
      sections,
      retryOnTimeout: true,
    });

    if (stderr) {
      console.error("Script stderr output:", stderr);
    }

    const elapsed = Date.now() - start;
    _logger?.debug("scriptExecution", `OmniFocus script completed in ${elapsed}ms`);

    // Parse the output as JSON
    try {
      return JSON.parse(stdout);
    } catch (parseError) {
      console.error("Error parsing script output:", parseError);
      return stdout;
    }
  } catch (error) {
    const elapsed = Date.now() - start;
    _logger?.error("scriptExecution", `OmniFocus script failed after ${elapsed}ms: ${error}`);
    console.error("Failed to execute OmniFocus script:", error);
    throw error;
  }
}

// --- writes ---------------------------------------------------------------------

/** The shape every write script returns when it fails. */
export interface WriteFailure {
  success: false;
  error: string;
}

let writeHelpersSource: string | null = null;

/** `_writeHelpers.js`, read once: the functions every write payload shares. */
function loadWriteHelpers(): string {
  if (writeHelpersSource === null) {
    writeHelpersSource = readFileSync(resolveScriptPath("@_writeHelpers.js"), "utf8");
  }
  return writeHelpersSource;
}

/**
 * An error that escapes a payload reaches the JXA shim's `catch` as
 * "Error: <message> undefined:1:436" — the JS error class and a source offset
 * into the payload. Neither helps the caller; keep the message.
 */
export function normalizeOmniJsError(error: string): string {
  return error.replace(/^Error: /, '').replace(/ undefined:\d+:\d+$/, '');
}

/**
 * Run an OmniJS write script inside OmniFocus.
 *
 * `params` travel as ONE JSON document: the payload gets `argv[0]` as a string
 * literal built with `jsStringLiteral`, so nothing the caller sends is ever
 * spliced into source. The payload evaluates to a JSON string in the
 * `{ success, ... }` / `{ success: false, error }` shape; whatever goes wrong
 * — transport, a throw the payload didn't catch, unparseable output — comes
 * back as `{ success: false, error }` rather than an exception, so callers
 * see one shape.
 *
 * Never retried: a -1712 on a write may have partially applied (see the note
 * at the top of this file), so a retry could duplicate a create.
 */
export async function executeOmniFocusWrite<T extends { success: boolean }>(
  scriptPath: string,
  params: unknown
): Promise<T | WriteFailure> {
  const start = Date.now();
  let stdout: string;
  try {
    const scriptContent = readFileSync(resolveScriptPath(scriptPath), "utf8");
    const sections = [
      JXA_FORMAT_DATE_SOURCE,
      loadWriteHelpers(),
      `// Parameters: one JSON document, decoded by the payload\nconst argv = [${jsStringLiteral(JSON.stringify(params ?? {}))}];`,
      scriptContent,
    ];
    const result = await runOmniJsPayload({ label: scriptPath, sections, retryOnTimeout: false });
    stdout = result.stdout;
    if (result.stderr) {
      console.error("Script stderr output:", result.stderr);
    }
    _logger?.debug("scriptExecution", `OmniFocus write completed in ${Date.now() - start}ms`);
  } catch (error: any) {
    _logger?.error("scriptExecution", `OmniFocus write failed after ${Date.now() - start}ms: ${error}`);
    console.error("Failed to execute OmniFocus write:", error);
    return { success: false, error: error?.message || `Unknown error running ${scriptPath}` };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { success: false, error: `Failed to parse result: ${stdout}` };
  }
  if (parsed && typeof parsed === "object" && !("success" in parsed) && typeof parsed.error === "string") {
    // The JXA shim's catch: the payload threw instead of returning a result.
    return { success: false, error: normalizeOmniJsError(parsed.error) };
  }
  return parsed as T;
}

/** Internals exposed for tests only. */
export const _testExports = { escapeContent, jsStringLiteral, buildOmniJsWrapper };
