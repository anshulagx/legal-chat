// Isolated hosted QA may use a database-scoped identity without permission to
// create another database. Production never accepts a collection namespace override.
export function collectionName(base: string) {
  const prefix = process.env.MONGODB_COLLECTION_PREFIX ?? '';
  if (prefix && (process.env.NODE_ENV !== 'test' || !/^qa04_[a-z0-9]{8,40}_$/.test(prefix))) {
    throw new Error('Invalid isolated QA collection prefix.');
  }
  return `${prefix}${base}`;
}
