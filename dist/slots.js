export function hashSlot(key) {
  const start = key.indexOf('{');
  const end = start < 0 ? -1 : key.indexOf('}', start + 1);
  if (end > start + 1) key = key.slice(start + 1, end);
  let crc = 0;
  for (const byte of new TextEncoder().encode(key)) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  return crc & 16383;
}
export function ownerOf(slot, nodes) { return nodes.findIndex(node => node.slots.some(([a,b]) => slot >= a && slot <= b)); }
