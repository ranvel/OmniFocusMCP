import { executeOmniFocusWrite } from '../../utils/scriptExecution.js';
import { flattenName } from '../../utils/writeParams.js';

export interface CreateTagParams {
  name: string;
  parentTagName?: string; // Name of an existing tag to nest the new tag under
  parentTagID?: string;   // ID of an existing tag to nest the new tag under (takes precedence over parentTagName)
}

/** What createTag.js sends back. */
export interface CreateTagScriptParams {
  name: string;
  parentTagID?: string;
  parentTagName?: string;
}

interface CreateTagScriptResult {
  success: true;
  tagId: string;
}

/**
 * Create a tag in OmniFocus
 */
export async function createTag(params: CreateTagParams): Promise<{success: boolean, tagId?: string, name?: string, error?: string}> {
  try {
    const scriptParams: CreateTagScriptParams = { name: flattenName(params.name) };
    if (params.parentTagID) scriptParams.parentTagID = params.parentTagID;
    else if (params.parentTagName) scriptParams.parentTagName = flattenName(params.parentTagName);

    const result = await executeOmniFocusWrite<CreateTagScriptResult>('@createTag.js', scriptParams);
    if (!result.success) {
      return { success: false, error: result.error };
    }
    return {
      success: true,
      tagId: result.tagId,
      // The script does not echo the name; the caller's input is the
      // authoritative value anyway.
      name: params.name,
    };
  } catch (error: any) {
    console.error("Error in createTag:", error);
    return {
      success: false,
      error: error?.message || "Unknown error in createTag"
    };
  }
}
