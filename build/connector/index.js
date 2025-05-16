"use strict";
// Connector Module – Data Layer (RESTORED & ENHANCED)
// Keeps every credential-touching concern local. Public API:
//   • withTunnel(cfg, fn)   – wraps callback with optional SSH tunnel
//   • runQuery(sql, params, cfg) – executes SQL via mysql2 or pg
//   • issueToken / verifyToken – ephemeral auth tokens
//   • initMetadata(cfg) – loads schema / index / tableSize maps using same cfg
//   • Re-exports schemaMap, indexMap, tableSizeCache + low-level loaders
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tableSizeCache = exports.indexMap = exports.schemaMap = exports.verifyToken = exports.issueToken = void 0;
exports.runQuery = runQuery;
exports.initMetadata = initMetadata;
const promise_1 = __importDefault(require("mysql2/promise"));
const pg_1 = __importDefault(require("pg"));
const crypto_1 = __importDefault(require("crypto"));
// ----------------------- Token helpers -----------------------
const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 min
const tokenStore = new Map();
const issueToken = () => {
    const token = crypto_1.default.randomBytes(16).toString('hex');
    tokenStore.set(token, Date.now() + TOKEN_TTL_MS);
    return token;
};
exports.issueToken = issueToken;
const verifyToken = (token) => {
    const expiry = tokenStore.get(token);
    if (!expiry)
        return false;
    if (Date.now() > expiry) {
        tokenStore.delete(token);
        return false;
    }
    return true;
};
exports.verifyToken = verifyToken;
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
async function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = require('net').createServer();
        srv.listen(0, () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}
// --------------------------- runQuery ------------------------
async function runQuery(sql, params = [], cfg) {
    const exec = async () => {
        if (cfg.databaseType === 'postgres') {
            const client = new pg_1.default.Client({
                host: cfg.host,
                port: cfg.port || 5432,
                user: cfg.user,
                password: cfg.password,
                database: cfg.database,
                ...(process.env.PG_DISABLE_SSL === 'true'
                    ? {}
                    : { ssl: { rejectUnauthorized: false } }),
            });
            await client.connect();
            try {
                const { rows } = await client.query(sql, params);
                return rows;
            }
            finally {
                await client.end();
            }
        }
        // default mysql
        const conn = await promise_1.default.createConnection({
            host: cfg.host,
            port: cfg.port || 3306,
            user: cfg.user,
            password: cfg.password,
            database: cfg.database,
        });
        try {
            const [rows] = await conn.query(sql, params);
            return rows;
        }
        finally {
            await conn.end();
        }
    };
    return exec();
}
// ----------------------- Schema utilities -------------------
// Centralised re-export (actual heavy lifting still in legacy file for parity)
// @ts-ignore – path exists at runtime after TS compile
const schemaUtils = __importStar(require("../connector/schemaManager"));
__exportStar(require("../connector/schemaManager"), exports);
const { loadSchemaMap, loadTableSizes, loadAllPostgresIndexes, schemaMap, indexMap, tableSizeCache, } = schemaUtils;
exports.schemaMap = schemaMap;
exports.indexMap = indexMap;
exports.tableSizeCache = tableSizeCache;
/**
 * Load schema, indexes & table sizes into in-memory maps so orchestrator can reason.
 * Returns the actual maps for convenience.
 */
async function initMetadata(cfg) {
    const inner = async () => {
        // Reset all metadata before loading new data to prevent accumulation
        Object.keys(schemaMap).forEach(key => delete schemaMap[key]);
        Object.keys(indexMap).forEach(key => delete indexMap[key]);
        Object.keys(tableSizeCache).forEach(key => delete tableSizeCache[key]);
        if (cfg.databaseType === 'postgres') {
            const client = new pg_1.default.Client({
                host: cfg.host,
                port: cfg.port || 5432,
                user: cfg.user,
                password: cfg.password,
                database: cfg.database,
                ssl: process.env.PG_DISABLE_SSL === 'true' ? undefined : { rejectUnauthorized: false },
            });
            await client.connect();
            await loadSchemaMap(client, cfg.database, 'postgres');
            await loadAllPostgresIndexes(client);
            await loadTableSizes(client, cfg.database, 'postgres');
            await client.end();
        }
        else {
            const conn = await promise_1.default.createConnection({
                host: cfg.host,
                port: cfg.port || 3306,
                user: cfg.user,
                password: cfg.password,
                database: cfg.database,
            });
            await loadSchemaMap(conn, cfg.database, 'mysql');
            await loadTableSizes(conn, cfg.database, 'mysql');
            await conn.end();
        }
    };
    await (inner());
    // Get fresh references AFTER loading is complete
    const { schemaMap: finalSchema, indexMap: finalIndex, tableSizeCache: finalSizes } = await Promise.resolve().then(() => __importStar(require('../connector/schemaManager')));
    return {
        schemaMap: finalSchema,
        indexMap: finalIndex,
        tableSizeCache: finalSizes
    };
}
// --------------------------- EOF ---------------------------- 
