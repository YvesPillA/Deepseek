// Host-only read access. Request a fresh view after every async boundary;
// JournalStore shares an immutable view only while the committed state is unchanged.
export const readState=store=>store.readSnapshot?store.readSnapshot():store.snapshot();

export function freezeState(value) {
  if(value!==null && typeof value==='object' && !Object.isFrozen(value)) {
    for(const child of Object.values(value))freezeState(child);
    Object.freeze(value);
  }
  return value;
}
