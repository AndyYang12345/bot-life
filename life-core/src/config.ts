import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';

// Passwords never appear in process arguments, connection URLs or exported data.
export function databaseConfig(path: string): PoolConfig {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!['127.0.0.1', 'localhost', '::1'].includes(value.host)) throw new Error('database_must_be_local');
  return { host: value.host, port: value.port, database: value.database, user: value.user,
    password: readFileSync(value.passwordFile, 'utf8').trim(), max: 5,
    connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000,
    statement_timeout: 15000, application_name: 'qqbot-life' };
}
