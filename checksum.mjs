import { createHash } from 'crypto';
import { readFileSync } from 'fs';

const sql = readFileSync('airi/packages/memory-sqlite/src/schema/v9.ts', 'utf8');
const match = sql.match(/export const schemaV9 = `([\s\S]*?)`/);
if (match) {
  console.log(createHash('sha256').update(match[1]).digest('hex'));
} else {
  console.log('No match');
}
