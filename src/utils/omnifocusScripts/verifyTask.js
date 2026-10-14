// Is a task resolvable by id from a fresh process? (#57)
// params: { id }  ->  { success, found }
runWrite(function (params) {
  return { success: true, found: Task.byIdentifier(params.id) !== null };
})
