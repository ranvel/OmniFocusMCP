import { toDateParts, type DateParts } from '../../utils/dateFormatting.js';
import { compileRepetitionSpec, type CompiledRepetition, type RepetitionSpec } from '../../utils/repetitionRule.js';
import { executeOmniFocusWrite } from '../../utils/scriptExecution.js';
import { flattenName } from '../../utils/writeParams.js';

// Interface for project creation parameters
export interface AddProjectParams {
  name: string;
  note?: string;
  dueDate?: string; // ISO date string
  deferDate?: string; // ISO date string
  flagged?: boolean;
  estimatedMinutes?: number;
  tags?: string[]; // Tag names
  folderName?: string; // Folder name or path (e.g. "Work/Engineering") to add project to
  sequential?: boolean; // Whether tasks should be sequential or parallel
  repeat?: RepetitionSpec; // Repetition rule (#116)
}

/** What addProject.js receives. */
export interface AddProjectScriptParams {
  name: string;
  note?: string;
  dueDate?: DateParts;
  deferDate?: DateParts;
  flagged?: boolean;
  estimatedMinutes?: number;
  tags?: string[];
  folderName?: string;
  sequential: boolean;
  repeat?: CompiledRepetition;
}

interface AddProjectScriptResult {
  success: true;
  projectId: string;
}

/** Translate the tool's parameters into the script's. Throws on a bad date or repeat. */
export function buildAddProjectScriptParams(params: AddProjectParams): AddProjectScriptParams {
  const out: AddProjectScriptParams = {
    name: flattenName(params.name),
    sequential: params.sequential === true,
  };
  if (params.note) out.note = params.note;
  if (params.dueDate) out.dueDate = toDateParts(params.dueDate);
  if (params.deferDate) out.deferDate = toDateParts(params.deferDate);
  if (params.flagged === true) out.flagged = true;
  if (params.estimatedMinutes) out.estimatedMinutes = params.estimatedMinutes;
  if (params.tags && params.tags.length > 0) out.tags = params.tags.map(flattenName);
  if (params.folderName) out.folderName = params.folderName;
  if (params.repeat) out.repeat = compileRepetitionSpec(params.repeat, { isProject: true });
  return out;
}

/**
 * Add a project to OmniFocus
 */
export async function addProject(params: AddProjectParams): Promise<{success: boolean, projectId?: string, error?: string}> {
  try {
    const scriptParams = buildAddProjectScriptParams(params);
    const result = await executeOmniFocusWrite<AddProjectScriptResult>('@addProject.js', scriptParams);
    if (!result.success) {
      return { success: false, error: result.error };
    }
    return { success: true, projectId: result.projectId };
  } catch (error: any) {
    console.error("Error in addProject:", error);
    return {
      success: false,
      error: error?.message || "Unknown error in addProject"
    };
  }
}
