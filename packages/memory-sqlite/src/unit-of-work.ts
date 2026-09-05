import type { DatabaseSync } from 'node:sqlite'

import { MemoryError } from '@proj-airi/memory-domain'

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value
}

/** A short, database-only SQLite transaction boundary. External work must happen after it returns. */
export class UnitOfWork {
  constructor(private readonly db: DatabaseSync) {}

  run<Result>(operation: (database: DatabaseSync) => Result): Result {
    if (this.db.isTransaction)
      throw new MemoryError('POLICY_VIOLATION', 'nested units of work are not supported')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation(this.db)
      if (isThenable(result))
        throw new MemoryError('POLICY_VIOLATION', 'unit-of-work callbacks must be synchronous and database-only')
      this.db.exec('COMMIT')
      return result
    }
    catch (error) {
      try {
        this.db.exec('ROLLBACK')
      }
      catch (rollbackError) {
        throw new MemoryError('PERSISTENCE_FAILED', 'operation failed and SQLite rollback also failed', { cause: new AggregateError([error, rollbackError], 'operation and rollback both failed') })
      }
      throw error
    }
  }
}
