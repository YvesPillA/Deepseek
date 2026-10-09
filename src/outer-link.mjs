// Same-process capability bridge between trusted plugin entrypoints. The public
// foremanNext service remains read-only; its serialized/reflected fields contain
// no controller, userCommand or composition function. Not a model API.
const entries=new WeakMap();
export function registerOuterEntry(service,compose) {
  if(entries.has(service))throw new Error('Outer entry already registered');
  const entry={compose};entries.set(service,entry);
  return ()=>{if(entries.get(service)===entry)entries.delete(service);};
}
export async function mountOuterEntry(ctx,options) {
  const entry=entries.get(ctx.get('foremanNext'));
  if(!entry)throw new Error('Foreman host confirmation service is unavailable');
  await entry.compose(ctx,options);
}
