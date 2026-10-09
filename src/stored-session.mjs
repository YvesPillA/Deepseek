/** Read a complete persisted session without claiming its writer. */
export async function readStoredSession(persistence,id,{signal}={}) {
  if(typeof persistence.readFrom==='function')return persistence.readFrom(id,0,signal);
  const handle=await persistence.open(id,'read',{signal});
  try {
    const {events}=await handle.read(0,undefined,{signal});
    return {meta:handle.header,events};
  } finally {await handle.close();}
}

export function isMissingStoredSession(error,id) {
  return (error?.name==='SessionPersistenceNotFoundError' && error.sessionId===id) ||
    error?.message===`session "${id}" not found`;
}

export function sessionEvents(session) {
  return typeof session.snapshotEvents==='function'?session.snapshotEvents():session.events;
}
