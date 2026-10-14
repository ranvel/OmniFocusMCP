// Create a tag, optionally nested under a parent found by id or by name.
// params: { name, parentTagID?, parentTagName? }  ->  { success, tagId }
runWrite(function (params) {
  var parent = null;
  if (params.parentTagID) {
    parent = Tag.byIdentifier(params.parentTagID);
    if (!parent) throw new Error('Parent tag not found: ' + params.parentTagID);
  } else if (params.parentTagName) {
    parent = firstByName(flattenedTags, params.parentTagName);
    if (!parent) throw new Error('Parent tag not found: ' + params.parentTagName);
  }
  var tag = parent ? new Tag(params.name, parent) : new Tag(params.name);
  return { success: true, tagId: tag.id.primaryKey };
})
