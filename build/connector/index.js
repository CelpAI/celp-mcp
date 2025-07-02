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
exports.tableSizeCache = exports.indexMap = exports.schemaMap = void 0;
exports.buildMongoConnectionString = buildMongoConnectionString;
exports.applyParamsToMongoQuery = applyParamsToMongoQuery;
exports.withTunnel = withTunnel;
exports.issueToken = issueToken;
exports.verifyToken = verifyToken;
exports.runQuery = runQuery;
exports.initMetadata = initMetadata;
const promise_1 = __importDefault(require("mysql2/promise"));
const pg_1 = __importDefault(require("pg"));
const crypto_1 = __importDefault(require("crypto"));
// Add MongoDB connection string builder
function buildMongoConnectionString(cfg) {
    const { host, port, user, password, database, mongoOptions } = cfg;
    // If a full connection URL is already provided, use it directly.
    if (cfg.url) {
        return cfg.url;
    }
    let connectionString = 'mongodb://';
    if (user && password) {
        connectionString += `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`;
    }
    connectionString += `${host}:${port || 27017}/${database}`;
    if (mongoOptions) {
        const options = new URLSearchParams();
        if (mongoOptions.authSource)
            options.append('authSource', mongoOptions.authSource);
        if (mongoOptions.ssl)
            options.append('ssl', mongoOptions.ssl.toString());
        if (mongoOptions.replicaSet)
            options.append('replicaSet', mongoOptions.replicaSet);
        if (mongoOptions.readPreference)
            options.append('readPreference', mongoOptions.readPreference);
        if (mongoOptions.maxPoolSize)
            options.append('maxPoolSize', mongoOptions.maxPoolSize.toString());
        if (mongoOptions.minPoolSize)
            options.append('minPoolSize', mongoOptions.minPoolSize.toString());
        if (mongoOptions.serverSelectionTimeoutMS)
            options.append('serverSelectionTimeoutMS', mongoOptions.serverSelectionTimeoutMS.toString());
        if (mongoOptions.socketTimeoutMS)
            options.append('socketTimeoutMS', mongoOptions.socketTimeoutMS.toString());
        if (mongoOptions.connectTimeoutMS)
            options.append('connectTimeoutMS', mongoOptions.connectTimeoutMS.toString());
        const optionsString = options.toString();
        if (optionsString) {
            connectionString += `?${optionsString}`;
        }
    }
    return connectionString;
}
// Parameter binding helper for MongoDB queries
function applyParamsToMongoQuery(queryObj, paramMap) {
    if (!queryObj || typeof queryObj !== 'object') {
        return queryObj;
    }
    if (Array.isArray(queryObj)) {
        return queryObj.map(item => applyParamsToMongoQuery(item, paramMap));
    }
    const result = {};
    for (const [key, value] of Object.entries(queryObj)) {
        if (typeof value === 'string' && value.includes(':{{') && value.includes('}}')) {
            // Extract parameter path from :{{path}} format
            const paramPattern = /:{{([^}]+)}}/g;
            let processedValue = value;
            let match;
            while ((match = paramPattern.exec(value)) !== null) {
                const paramPath = match[1];
                if (paramMap[paramPath] !== undefined) {
                    // Replace the entire value if it's just the parameter, otherwise do string replacement
                    if (value === match[0]) {
                        processedValue = paramMap[paramPath];
                    }
                    else {
                        processedValue = processedValue.replace(match[0], paramMap[paramPath]);
                    }
                }
            }
            result[key] = processedValue;
        }
        else if (typeof value === 'object') {
            result[key] = applyParamsToMongoQuery(value, paramMap);
        }
        else {
            result[key] = value;
        }
    }
    return result;
}
// --------------------------- withTunnel ---------------------------
// (Simplified for now; would need more SSH tunnel work for MongoDB)
async function withTunnel(cfg, fn) {
    // For now, just pass through. Real SSH tunneling would create a local port forward.
    return await fn(cfg);
}
// --------------------------- Token utilities ---------------------------
const tokenStore = new Map();
function issueToken(data, ttlMs = 300_000) {
    const token = crypto_1.default.randomBytes(16).toString('hex');
    tokenStore.set(token, { expires: Date.now() + ttlMs, data });
    return token;
}
function verifyToken(token) {
    const entry = tokenStore.get(token);
    if (!entry || Date.now() > entry.expires) {
        tokenStore.delete(token);
        return null;
    }
    return entry.data;
}
// --------------------------- runQuery ---------------------------
async function runQuery(query, params = [], cfg, context) {
    return await execQuery(query, params, cfg);
}
/**
 * Internal query execution function that handles the actual database interaction
 * @param context Optional AnalysisContext containing configuration settings
 */
async function execQuery(query, params = [], cfg) {
    if (cfg.databaseType === 'mongodb') {
        try {
            // Dynamic import to handle optional MongoDB dependency
            const mongodb = await Promise.resolve().then(() => __importStar(require('mongodb')));
            const MongoClient = mongodb.MongoClient;
            const connectionString = buildMongoConnectionString(cfg);
            const client = new MongoClient(connectionString, cfg.mongoOptions);
            await client.connect();
            try {
                const db = client.db(cfg.database);
                if (typeof query === 'object' && 'operation' in query) {
                    const mongoQuery = query;
                    const collection = db.collection(mongoQuery.collection);
                    switch (mongoQuery.operation) {
                        case 'find':
                            const findCursor = collection.find(mongoQuery.filter || {}, mongoQuery.options || {});
                            if (mongoQuery.sort)
                                findCursor.sort(mongoQuery.sort);
                            if (mongoQuery.limit)
                                findCursor.limit(mongoQuery.limit);
                            if (mongoQuery.skip)
                                findCursor.skip(mongoQuery.skip);
                            return await findCursor.toArray();
                        case 'aggregate':
                            const aggCursor = collection.aggregate(mongoQuery.pipeline || [], mongoQuery.options || {});
                            return await aggCursor.toArray();
                        case 'distinct':
                            return await collection.distinct(mongoQuery.field, mongoQuery.filter || {});
                        case 'count':
                            const count = await collection.countDocuments(mongoQuery.filter || {}, mongoQuery.options || {});
                            return [{ count }];
                        default:
                            throw new Error(`Unsupported MongoDB operation: ${mongoQuery.operation}`);
                    }
                }
                else {
                    throw new Error('Invalid MongoDB query format');
                }
            }
            finally {
                await client.close();
            }
        }
        catch (error) {
            if (error.code === 'MODULE_NOT_FOUND') {
                throw new Error('MongoDB driver not found. Please install mongodb package: npm install mongodb');
            }
            throw error;
        }
    }
    if (cfg.databaseType === 'databricks') {
        // Forward to the main index's connection manager if available
        // This is a fallback implementation for cases where the connector is used directly
        try {
            // Dynamic import to handle optional Databricks dependency
            const databricksSql = await Promise.resolve().then(() => __importStar(require('@databricks/sql')));
            const httpPath = (cfg.databricksOptions && cfg.databricksOptions.httpPath) || cfg.databricksHttpPath;
            if (!httpPath) {
                throw new Error('Missing Databricks httpPath in configuration');
            }
            const client = new databricksSql.DBSQLClient();
            const connection = await client.connect({
                host: cfg.host,
                path: httpPath,
                token: cfg.password, // token stored in password field
            });
            try {
                const session = await connection.openSession();
                const operation = await session.executeStatement(query, {
                    runAsync: true,
                    maxRows: 10000,
                });
                const result = await operation.fetchAll();
                await operation.close();
                await session.close();
                return result;
            }
            finally {
                await connection.close();
            }
        }
        catch (error) {
            if (error.code === 'MODULE_NOT_FOUND') {
                throw new Error('Databricks SQL driver not found. Please install: npm install @databricks/sql');
            }
            throw error;
        }
    }
    if (cfg.databaseType === 'postgres') {
        // Use pgDisableSsl from context if available, otherwise fall back to environment variable
        const pgDisableSsl = cfg?.pgDisableSsl;
        const client = new pg_1.default.Client({
            host: cfg.host,
            port: cfg.port || 5432,
            user: cfg.user,
            password: cfg.password,
            database: cfg.database,
            ...(pgDisableSsl
                ? {}
                : { ssl: { rejectUnauthorized: false } }),
        });
        await client.connect();
        try {
            const { rows } = await client.query(query, params);
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
        const [rows] = await conn.query(query, params);
        return rows;
    }
    finally {
        await conn.end();
    }
}
// --------------------------- initMetadata ---------------------------
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
async function initMetadata(cfg, context) {
    const inner = async () => {
        if (cfg.databaseType === 'mongodb') {
            try {
                const mongodb = await Promise.resolve().then(() => __importStar(require('mongodb')));
                const MongoClient = mongodb.MongoClient;
                const connectionString = buildMongoConnectionString(cfg);
                const client = new MongoClient(connectionString, cfg.mongoOptions);
                await client.connect();
                await loadSchemaMap(client, cfg.database, 'mongodb');
                await loadTableSizes(client, cfg.database, 'mongodb');
                await client.close();
            }
            catch (error) {
                if (error.code === 'MODULE_NOT_FOUND') {
                    throw new Error('MongoDB driver not found. Please install mongodb package: npm install mongodb');
                }
                throw error;
            }
        }
        else if (cfg.databaseType === 'databricks') {
            // throw new Error(JSON.stringify(cfg));
            try {
                // Dynamic import to handle optional Databricks dependency
                const databricksSql = await Promise.resolve().then(() => __importStar(require('@databricks/sql')));
                const httpPath = (cfg.databricksOptions && cfg.databricksOptions.httpPath) || cfg.databricksHttpPath;
                if (!httpPath) {
                    throw new Error('Missing Databricks httpPath in configuration');
                }
                const client = new databricksSql.DBSQLClient();
                const connection = await client.connect({
                    host: cfg.host,
                    path: httpPath,
                    token: cfg.password, // token stored in password field
                });
                try {
                    await loadSchemaMap(connection, cfg.database, 'databricks', cfg);
                    await loadTableSizes(connection, cfg.database, 'databricks', cfg);
                    // Note: Databricks doesn't have traditional indexes, but we call this for consistency
                    // The actual implementation will handle clustering keys and partitioning info
                }
                finally {
                    await connection.close();
                }
            }
            catch (error) {
                if (error.code === 'MODULE_NOT_FOUND') {
                    throw new Error('Databricks SQL driver not found. Please install: npm install @databricks/sql');
                }
                throw error;
            }
        }
        else if (cfg.databaseType === 'postgres') {
            // Use pgDisableSsl from context if available, otherwise fall back to environment variable
            // const pgDisableSsl = context.pgDisableSsl
            const client = new pg_1.default.Client({
                host: cfg.host,
                port: cfg.port || 5432,
                user: cfg.user,
                password: cfg.password,
                database: cfg.database,
                ssl: cfg.pgDisableSsl ? undefined : { rejectUnauthorized: false },
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
