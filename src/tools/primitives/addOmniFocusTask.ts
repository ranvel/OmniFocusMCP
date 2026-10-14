import { toDateParts, type DateParts } from '../../utils/dateFormatting.js';
import { compileRepetitionSpec, type CompiledRepetition, type RepetitionSpec } from '../../utils/repetitionRule.js';
import { executeOmniFocusWrite } from '../../utils/scriptExecution.js';
import { flattenName } from '../../utils/writeParams.js';

// Interface for task creation parameters
export interface AddOmniFocusTaskParams {
  name: string;
  note?: string;
  dueDate?: string; // ISO date string
  deferDate?: string; // ISO date string
  plannedDate?: string; // ISO date string
  flagged?: boolean;
  estimatedMinutes?: number;
  tags?: string[]; // Tag names
  projectId?: string; // Project id to add task to (preferred when disambiguation is needed)
  projectName?: string; // Project name to add task to (used when projectId is not supplied)
  repeat?: RepetitionSpec; // Repetition rule (#116)
  // Hierarchy support
  parentTaskId?: string;
  parentTaskName?: string;
  hierarchyLevel?: number; // ignored for single add
}

/** What addTask.js receives. */
export interface AddTaskScriptParams {
  name: string;
  note?: string;
  dueDate?: DateParts;
  deferDate?: DateParts;
  plannedDate?: DateParts;
  flagged?: boolean;
  estimatedMinutes?: number;
  tags?: string[];
  projectId?: string;
  projectName?: string;
  parentTaskId?: string;
  parentTaskName?: string;
  repeat?: CompiledRepetition;
}

export type TaskPlacement = 'parent' | 'project' | 'inbox';

interface AddTaskScriptResult {
  success: true;
  taskId: string;
  placement: TaskPlacement;
}

/** Translate the tool's parameters into the script's. Throws on a bad date or repeat. */
export function buildAddTaskScriptParams(params: AddOmniFocusTaskParams): AddTaskScriptParams {
  const out: AddTaskScriptParams = { name: flattenName(params.name) };
  if (params.note) out.note = params.note;
  if (params.dueDate) out.dueDate = toDateParts(params.dueDate);
  if (params.deferDate) out.deferDate = toDateParts(params.deferDate);
  if (params.plannedDate) out.plannedDate = toDateParts(params.plannedDate);
  if (params.flagged === true) out.flagged = true;
  if (params.estimatedMinutes) out.estimatedMinutes = params.estimatedMinutes;
  if (params.tags && params.tags.length > 0) out.tags = params.tags.map(flattenName);
  if (params.projectId) out.projectId = params.projectId;
  else if (params.projectName) out.projectName = flattenName(params.projectName);
  if (params.parentTaskId) out.parentTaskId = params.parentTaskId;
  if (params.parentTaskName) out.parentTaskName = flattenName(params.parentTaskName);
  if (params.repeat) out.repeat = compileRepetitionSpec(params.repeat, { isProject: false });
  return out;
}

// Backoff schedule (ms) for confirming a freshly-created task is resolvable.
// First probe is immediate; on a warm database it hits and adds one cheap read.
// The tail (~1.5s total) only elapses in the rare cold/racy case.
const VERIFY_DELAYS_MS = [0, 50, 100, 200, 400, 800];

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Retry a "is this task resolvable yet?" probe on a backoff schedule, returning
 * true as soon as the probe succeeds and false if it never does.
 *
 * Extracted (with injectable probe/sleep) so the retry behavior can be unit
 * tested without driving osascript. See verifyTaskResolvable for why this exists.
 */
export async function verifyPersistedWithRetries(
  probe: () => Promise<boolean>,
  opts: { delaysMs?: number[]; sleepFn?: (ms: number) => Promise<void> } = {}
): Promise<boolean> {
  const delays = opts.delaysMs ?? VERIFY_DELAYS_MS;
  const doSleep = opts.sleepFn ?? sleep;
  for (const delay of delays) {
    if (delay > 0) await doSleep(delay);
    if (await probe()) return true;
  }
  return false;
}

/**
 * Confirm a newly-created task is resolvable by its id in a SEPARATE osascript
 * invocation before we report success (issue #57).
 *
 * OmniFocus commits new objects on its own run loop. Immediately after a
 * create, the record can be briefly invisible to a fresh lookup from another
 * process, so an immediate follow-up edit_item (by the id we returned) finds
 * nothing — yet add reported success. That silent false-success is the worst
 * failure class: it makes the audit trail lie.
 *
 * The re-fetch MUST be a separate process. An in-script re-fetch (inside the
 * creating script) resolves the in-memory object even when it isn't yet visible
 * to other processes, so it cannot distinguish committed from uncommitted —
 * verified empirically. A bounded, separate-process retry waits the commit out —
 * the same effect as the reporter's manual query-between-calls workaround — and
 * lets us return an honest failure if the task truly never lands.
 */
async function verifyTaskResolvable(taskId: string): Promise<boolean> {
  const probe = async (): Promise<boolean> => {
    try {
      const result = await executeOmniFocusWrite<{ success: true; found: boolean }>('@verifyTask.js', { id: taskId });
      return result.success === true && result.found === true;
    } catch {
      // Treat a transient osascript error as not-yet-resolvable and keep retrying.
      return false;
    }
  };

  return verifyPersistedWithRetries(probe);
}

/**
 * Add a task to OmniFocus
 */
export async function addOmniFocusTask(params: AddOmniFocusTaskParams): Promise<{success: boolean, taskId?: string, error?: string, placement?: TaskPlacement}> {
  try {
    const scriptParams = buildAddTaskScriptParams(params);
    const result = await executeOmniFocusWrite<AddTaskScriptResult>('@addTask.js', scriptParams);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Before reporting success, confirm the task actually persisted and is
    // resolvable by the id we're about to hand back (issue #57). Without this,
    // an immediate follow-up edit_item can operate on a not-yet-committed task
    // and the "success" we returned would be a lie.
    if (result.taskId) {
      const persisted = await verifyTaskResolvable(result.taskId);
      if (!persisted) {
        return {
          success: false,
          taskId: result.taskId,
          placement: result.placement,
          error: `Task "${params.name}" was created but could not be confirmed in OmniFocus after retries; it may not have persisted. Please retry.`
        };
      }
    }

    return {
      success: true,
      taskId: result.taskId,
      placement: result.placement
    };
  } catch (error: any) {
    console.error("Error in addOmniFocusTask:", error);
    return {
      success: false,
      error: error?.message || "Unknown error in addOmniFocusTask"
    };
  }
}
