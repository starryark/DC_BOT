import process from 'node:process'

import { DatabaseSync } from 'node:sqlite'

const [path, mode] = process.argv.slice(2)
const db = new DatabaseSync(path, { timeout: 500 })
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
const notify = value => process.send?.(value)
const die = () => process.kill(process.pid, 'SIGKILL')

if (mode === 'before-begin')
  die()
if (mode === 'after-begin') {
  db.exec('BEGIN IMMEDIATE')
  notify('begun')
  die()
}
else if (mode === 'before-commit') {
  db.exec('BEGIN IMMEDIATE; INSERT INTO imp208_crash_rows(id,value) VALUES (\'interrupted\',\'synthetic\');')
  notify('mutated')
  die()
}
else if (mode === 'after-commit') {
  db.exec('BEGIN IMMEDIATE; INSERT OR IGNORE INTO imp208_crash_rows(id,value) VALUES (\'committed\',\'synthetic\'); COMMIT')
  notify('committed')
  die()
}
else if (mode === 'wal-workload') {
  for (let index = 0; index < 200; index++)
    db.prepare('INSERT OR IGNORE INTO imp208_crash_rows(id,value) VALUES (?,?)').run(`wal-${index}`, 'synthetic')
  notify('wal-written')
  die()
}
else if (mode === 'before-checkpoint') {
  db.prepare('INSERT OR IGNORE INTO imp208_crash_rows(id,value) VALUES (\'checkpoint\',\'synthetic\')').run()
  notify('checkpoint-pending')
  die()
}
