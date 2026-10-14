import { editDateParam, type DateParts } from '../../utils/dateFormatting.js';
import { compileRepetitionSpec, type CompiledRepetition, type RepetitionSpec } from '../../utils/repetitionRule.js';
import { type TaskPosition } from '../../utils/taskMove.js';
import {
  compileReviewInterval,
  describeReviewInterval,
  type CompiledReviewInterval,
  type ReviewIntervalSpec,
} from '../../utils/reviewInterval.js';
import { executeOmniFocusWrite } from '../../utils/scriptExecution.js';
import { flattenName } from '../../utils/writeParams.js';

// Status options for tasks and projects
type TaskStatus = 'incomplete' | 'completed' | 'dropped' | 'skipped';
type ProjectStatus = 'active' | 'completed' | 'dropped' | 'onHold';

// Interface for item edit parameters
export interface EditItemParams {
  id?: string;                  // ID of the task or project to edit
  name?: string;                // Name of the task or project to edit (as fallback if ID not provided)
  itemType: 'task' | 'project'; // Type of item to edit
  
  // Common editable fields
  newName?: string;             // New name for the item
  newNote?: string;             // New note for the item
  newDueDate?: string;          // New due date in ISO format (empty string to clear)
  newDeferDate?: string;        // New defer date in ISO format (empty string to clear)
  newPlannedDate?: string;      // New planned date in ISO format (empty string to clear, tasks only)
  newFlagged?: boolean;         // New flagged status (false to remove flag, true to add flag)
  newEstimatedMinutes?: number; // New estimated minutes
  newRepeat?: RepetitionSpec | null; // New repetition rule; null clears it (#116)
  
  // Task-specific fields
  newStatus?: TaskStatus;       // New status for tasks (incomplete, completed, dropped, skipped - skipped requires repeating task)
  addTags?: string[];           // Tags to add to the task
  removeTags?: string[];        // Tags to remove from the task
  replaceTags?: string[];       // Tags to replace all existing tags with
  newProjectName?: string;      // Move task to this project; empty string or 'inbox' = move to inbox
  newParentTaskId?: string;     // Nest under this task; "" = back to project root / inbox (#138)
  position?: TaskPosition;      // Place among siblings in the target container (#138)
  
  // Project-specific fields
  newSequential?: boolean;      // Whether the project should be sequential
  newFolderName?: string;       // New folder to move the project to
  newProjectStatus?: ProjectStatus; // New status for projects
  markReviewed?: boolean;       // Mark the project as reviewed (advances next review date)
  newReviewInterval?: ReviewIntervalSpec; // How often the project comes up for review (#139)
  allowPastOccurrence?: boolean; // Opt in to mutating a completed repeat occurrence (#124)
}

export class EditItemParamError extends Error {}

/**
 * Refuse field combinations that can't mean what the caller intends. Unlike the
 * older type-specific fields (which a wrong itemType silently skips), the #138
 * and #139 fields fail loudly: a nesting or review-interval request that quietly
 * does nothing is a success line for a write that never happened.
 */
export function validateEditParams(params: EditItemParams): string | null {
  const moving = params.newParentTaskId !== undefined || params.position !== undefined;
  if (params.itemType === 'project' && moving) {
    return 'newParentTaskId and position apply to tasks only; projects are moved with newFolderName.';
  }
  if (params.newParentTaskId !== undefined && params.newProjectName !== undefined) {
    return 'Pass newParentTaskId or newProjectName, not both: a task nested under a parent follows that parent into its project.';
  }
  if (params.itemType === 'task' && params.newReviewInterval !== undefined) {
    return 'newReviewInterval applies to projects only.';
  }
  return null;
}

/**
 * What editItem.js receives. Dates are local wall-clock parts (`null` clears);
 * the repeat and review interval are compiled; the move is one object.
 */
export interface EditItemScriptParams {
  id?: string;
  name?: string;
  itemType: 'task' | 'project';
  allowPastOccurrence: boolean;
  newName?: string;
  newNote?: string;
  newDueDate?: DateParts | null;
  newDeferDate?: DateParts | null;
  newPlannedDate?: DateParts | null;
  newFlagged?: boolean;
  newEstimatedMinutes?: number;
  newRepeat?: CompiledRepetition | null;
  addTags?: string[];
  removeTags?: string[];
  replaceTags?: string[];
  newStatus?: TaskStatus;
  newProjectName?: string;
  move?: { parentId?: string; position?: TaskPosition };
  newSequential?: boolean;
  newProjectStatus?: ProjectStatus;
  newReviewInterval?: CompiledReviewInterval;
  /** The interval as query_omnifocus renders it, for the changedProperties label. */
  reviewIntervalLabel?: string;
  markReviewed?: boolean;
  newFolderName?: string;
}

interface EditItemScriptResult {
  success: true;
  id: string;
  name: string;
  changedProperties: string;
}

/**
 * Validate the tool's parameters and translate them into the script's. Throws
 * EditItemParamError, RepetitionSpecError, ReviewIntervalSpecError or an
 * invalid-date error; editItem turns those into a failed result.
 */
export function buildEditItemScriptParams(params: EditItemParams): EditItemScriptParams {
  const invalid = validateEditParams(params);
  if (invalid) throw new EditItemParamError(invalid);

  const out: EditItemScriptParams = {
    itemType: params.itemType,
    allowPastOccurrence: params.allowPastOccurrence === true,
  };
  if (params.id) out.id = params.id;
  if (params.name) out.name = flattenName(params.name);

  if (params.newName !== undefined) out.newName = flattenName(params.newName);
  if (params.newNote !== undefined) out.newNote = params.newNote;
  const due = editDateParam(params.newDueDate);
  if (due !== undefined) out.newDueDate = due;
  const defer = editDateParam(params.newDeferDate);
  if (defer !== undefined) out.newDeferDate = defer;
  const planned = editDateParam(params.newPlannedDate);
  if (planned !== undefined) out.newPlannedDate = planned;
  if (params.newFlagged !== undefined) out.newFlagged = params.newFlagged;
  if (params.newEstimatedMinutes !== undefined) out.newEstimatedMinutes = params.newEstimatedMinutes;
  if (params.newRepeat !== undefined) {
    out.newRepeat = params.newRepeat === null
      ? null
      : compileRepetitionSpec(params.newRepeat, { isProject: params.itemType === 'project' });
  }

  if (params.replaceTags && params.replaceTags.length > 0) {
    out.replaceTags = params.replaceTags.map(flattenName);
  } else {
    if (params.addTags && params.addTags.length > 0) out.addTags = params.addTags.map(flattenName);
    if (params.removeTags && params.removeTags.length > 0) out.removeTags = params.removeTags.map(flattenName);
  }

  if (params.newStatus !== undefined) out.newStatus = params.newStatus;
  if (params.newProjectName !== undefined) out.newProjectName = flattenName(params.newProjectName);
  if (params.newParentTaskId !== undefined || params.position !== undefined) {
    out.move = {};
    if (params.newParentTaskId !== undefined) out.move.parentId = params.newParentTaskId;
    if (params.position !== undefined) out.move.position = params.position;
  }

  if (params.newSequential !== undefined) out.newSequential = params.newSequential;
  if (params.newProjectStatus !== undefined) out.newProjectStatus = params.newProjectStatus;
  if (params.newReviewInterval !== undefined) {
    out.newReviewInterval = compileReviewInterval(params.newReviewInterval);
    out.reviewIntervalLabel = describeReviewInterval(params.newReviewInterval);
  }
  if (params.markReviewed === true) out.markReviewed = true;
  if (params.newFolderName !== undefined && params.newFolderName !== '') out.newFolderName = params.newFolderName;

  return out;
}

/**
 * Edit a task or project in OmniFocus
 */
export async function editItem(params: EditItemParams): Promise<{
  success: boolean, 
  id?: string, 
  name?: string, 
  changedProperties?: string,
  error?: string
}> {
  try {
    const scriptParams = buildEditItemScriptParams(params);
    if (!params.id && !params.name) {
      return { success: false, error: 'Either id or name must be provided' };
    }

    const result = await executeOmniFocusWrite<EditItemScriptResult>('@editItem.js', scriptParams);
    if (!result.success) {
      return { success: false, error: result.error };
    }
    return {
      success: true,
      id: result.id,
      name: result.name,
      changedProperties: result.changedProperties,
    };
  } catch (error: any) {
    console.error("Error in editItem execution:", error);
    return {
      success: false,
      error: error?.message || "Unknown error in editItem"
    };
  }
}
