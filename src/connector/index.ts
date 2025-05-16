// Connector Module – Data Layer (RESTORED & ENHANCED)
// Keeps every credential-touching concern local. Public API:
//   • withTunnel(cfg, fn)   – wraps callback with optional SSH tunnel
//   • runQuery(sql, params, cfg) – executes SQL via mysql2 or pg
//   • issueToken / verifyToken – ephemeral auth tokens
//   • initMetadata(cfg) – loads schema / index / tableSize maps using same cfg
//   • Re-exports schemaMap, indexMap, tableSizeCache + low-level loaders

import mysql from 'mysql2/promise';
import pg from 'pg';
import crypto from 'crypto';

// --------------------------- Types ---------------------------

export interface ConnectorCfg {
  databaseType?: 'mysql' | 'postgres';
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  ssh?: {
    host: string;
    port?: number;
    username: string;
    privateKeyPath: string;
  };
}

// ----------------------- Token helpers -----------------------

const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 min
const tokenStore: Map<string, number> = new Map();

export const issueToken = (): string => {
  const token = crypto.randomBytes(16).toString('hex');
  tokenStore.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
};

export const verifyToken = (token: string): boolean => {
  const expiry = tokenStore.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    tokenStore.delete(token);
    return false;
  }
  return true;
};

// // -------------------------- SSH tunnel -----------------------

// export async function withTunnel<T>(cfg: ConnectorCfg, fn: () => Promise<T>): Promise<T> {
//   if (!cfg.ssh) return fn();

//   // @ts-ignore – optional dependency
//   const { default: tunnel } = await import('tunnel-ssh');
//   const fs = await import('fs');

//   const { host, port = 22, username, privateKeyPath } = cfg.ssh;
//   const privateKey = fs.readFileSync(privateKeyPath);
//   const localPort = await getFreePort();

//   const tunnelConfig: any = {
//     username,
//     host,
//     port,
//     privateKey,
//     dstHost: cfg.host,
//     dstPort: cfg.port || (cfg.databaseType === 'postgres' ? 5432 : 3306),
//     localHost: '127.0.0.1',
//     localPort,
//   };

//   return new Promise<T>((resolve, reject) => {
//     tunnel(tunnelConfig, async (error: any, server: any) => {
//       if (error) return reject(error);

//       // hijack cfg for the duration
//       const origHost = cfg.host;
//       const origPort = cfg.port;
//       cfg.host = '127.0.0.1';
//       cfg.port = localPort;

//       try {
//         const result = await fn();
//         server.close();
//         resolve(result);
//       } catch (err) {
//         server.close();
//         reject(err);
//       } finally {
//         cfg.host = origHost;
//         cfg.port = origPort;
//       }
//     });
//   });
// }

async function getFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = require('net').createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// --------------------------- runQuery ------------------------

export async function runQuery<T = any[]>(
  sql: string,
  params: any[] = [],
  cfg: ConnectorCfg,
): Promise<T> {
  const exec = async (): Promise<T> => {
    if (cfg.databaseType === 'postgres') {
      const client = new pg.Client({
        host: cfg.host,
        port: cfg.port || 5432,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        ...(process.env.PG_DISABLE_SSL === 'true'
          ? {}
          : { ssl: { rejectUnauthorized: false } }),
      } as any);
      await client.connect();
      try {
        const { rows } = await client.query(sql, params);
        return rows as unknown as T;
      } finally {
        await client.end();
      }
    }

    // default mysql
    const conn = await mysql.createConnection({
      host: cfg.host,
      port: cfg.port || 3306,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
    });
    try {
      const [rows] = await conn.query(sql, params);
      return rows as unknown as T;
    } finally {
      await conn.end();
    }
  };

  return exec();
}

// ----------------------- Schema utilities -------------------

// Centralised re-export (actual heavy lifting still in legacy file for parity)
// @ts-ignore – path exists at runtime after TS compile
import * as schemaUtils from '../connector/schemaManager';
export * from '../connector/schemaManager';

const {
  loadSchemaMap,
  loadTableSizes,
  loadAllPostgresIndexes,
  schemaMap,
  indexMap,
  tableSizeCache,
} = schemaUtils as any;

/**
 * Load schema, indexes & table sizes into in-memory maps so orchestrator can reason.
 * Returns the actual maps for convenience.
 */
export async function initMetadata(cfg: ConnectorCfg): Promise<{
  schemaMap: typeof schemaMap;
  indexMap: typeof indexMap;
  tableSizeCache: typeof tableSizeCache;
}> {
  const inner = async () => {
    // Reset all metadata before loading new data to prevent accumulation
    Object.keys(schemaMap).forEach(key => delete schemaMap[key]);
    Object.keys(indexMap).forEach(key => delete indexMap[key]);
    Object.keys(tableSizeCache).forEach(key => delete tableSizeCache[key]);
    
    if (cfg.databaseType === 'postgres') {
      const client = new pg.Client({
        host: cfg.host,
        port: cfg.port || 5432,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        ssl: process.env.PG_DISABLE_SSL === 'true' ? undefined : { rejectUnauthorized: false },
      } as any);
      await client.connect();
      await loadSchemaMap(client, cfg.database, 'postgres');
      await loadAllPostgresIndexes(client);
      await loadTableSizes(client, cfg.database, 'postgres');
      await client.end();
    } else {
      const conn = await mysql.createConnection({
        host: cfg.host,
        port: cfg.port || 3306,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
      });
      
      await loadSchemaMap(conn as any, cfg.database, 'mysql');
      await loadTableSizes(conn as any, cfg.database, 'mysql');
      await conn.end();
    }
  };

  await (inner());
  
  // Get fresh references AFTER loading is complete
  const { schemaMap: finalSchema, indexMap: finalIndex, tableSizeCache: finalSizes } = 
    await import('../connector/schemaManager');
  
  return { 
    schemaMap: finalSchema, 
    indexMap: finalIndex, 
    tableSizeCache: finalSizes 
  };
}

// Final explicit exports so downstream TS consumers can import directly.
export { schemaMap, indexMap, tableSizeCache };

// --------------------------- EOF ---------------------------- 