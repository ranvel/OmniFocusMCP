// Delete a task or project found by id (then name as a fallback).
// params: { id?, name?, itemType, allowPastOccurrence? }  ->  { success, id, name }
runWrite(function (params) {
  var item = resolveTaskOrProject(params.itemType, params.id, params.name);
  if (!item) throw new Error('Item not found');
  if (!params.allowPastOccurrence) assertLiveOccurrence(item, params.itemType);
  var result = { success: true, id: itemId(item, params.itemType), name: item.name };
  deleteObject(item);
  return result;
})
