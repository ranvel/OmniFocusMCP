import { executeOmniFocusWrite } from '../../utils/scriptExecution.js';
import { flattenName } from '../../utils/writeParams.js';

// Interface for item removal parameters
export interface RemoveItemParams {
  id?: string;          // ID of the task or project to remove
  name?: string;        // Name of the task or project to remove (as fallback if ID not provided)
  itemType: 'task' | 'project'; // Type of item to remove
  allowPastOccurrence?: boolean; // Opt in to removing a completed repeat occurrence (#124)
}

/** What removeItem.js receives. */
export interface RemoveItemScriptParams {
  id?: string;
  name?: string;
  itemType: 'task' | 'project';
  allowPastOccurrence: boolean;
}

interface RemoveItemScriptResult {
  success: true;
  id: string;
  name: string;
}

/**
 * Remove a task or project from OmniFocus
 */
export async function removeItem(params: RemoveItemParams): Promise<{success: boolean, id?: string, name?: string, error?: string}> {
  try {
    if (!params.id && !params.name) {
      return { success: false, error: 'Either id or name must be provided' };
    }

    const scriptParams: RemoveItemScriptParams = {
      itemType: params.itemType,
      allowPastOccurrence: params.allowPastOccurrence === true,
    };
    if (params.id) scriptParams.id = params.id;
    if (params.name) scriptParams.name = flattenName(params.name);

    const result = await executeOmniFocusWrite<RemoveItemScriptResult>('@removeItem.js', scriptParams);
    if (!result.success) {
      return { success: false, error: result.error };
    }
    return { success: true, id: result.id, name: result.name };
  } catch (error: any) {
    console.error("Error in removeItem execution:", error);
    return {
      success: false,
      error: error?.message || "Unknown error in removeItem"
    };
  }
}
