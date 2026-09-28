export function reconcileEvents(current, incoming) {
  const indexMap = new Map();
  const result = [];
  const process = (obj) => {
    const id = obj.id;
    const position = indexMap.get(id);
    if (position === undefined) {
      indexMap.set(id, result.length);
      result.push({ ...obj });
    } else {
      result[position] = { ...obj };
    }
  };
  current.forEach(process);
  incoming.forEach(process);
  return result;
}
