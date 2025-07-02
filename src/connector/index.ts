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

// Define MongoDB query types without importing MongoDB yet to avoid errors
export interface MongoQuery {
  collection: string;
  operation: 'find' | 'aggregate' | 'distinct' | 'count';
  filter?: any;
  pipeline?: any[];
  field?: string;
  sort?: any;
  limit?: number;
  skip?: number;
  options?: any;
}

// --------------------------- Types ---------------------------

interface AnalysisContext {
  // Database configuration
  databaseType: 'postgres' | 'mysql' | 'mongodb';
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  pgDisableSsl?: boolean;
  url?: string;
  mongoOptions?: {
    authSource?: string;
    ssl?: boolean;
    replicaSet?: string;
    readPreference?: 'primary' | 'secondary' | 'primaryPreferred' | 'secondaryPreferred' | 'nearest';
    maxPoolSize?: number;
    minPoolSize?: number;
    serverSelectionTimeoutMS?: number;
    socketTimeoutMS?: number;
    connectTimeoutMS?: number;
  };
  
  // Runtime options
  maxQueryExecutionTime?: number;
  enableTurboMode?: boolean;
  enableHighReasoningMode?: boolean;
  slowQueryThreshold?: number;
  enableEDA?: boolean;
  
  // API keys
  openAIApiKey?: string;
  
  // Feature flags
  claudeDesktopMode?: boolean;
  mediumReasoningInClaudeMode?: boolean;
  enablePairwiseVoting?: boolean;
  recordSlowQueries?: boolean;
  enableEmbedFilter?: boolean;
  telemetry?: boolean;
  autoRetryInvalidJson?: boolean;
  
  // Logging configuration
  debugLogs?: boolean;
  logLevel?: string; // 'NONE', 'ERROR', 'INFO', or 'DEBUG'
  
  // Model options
  turboClassifierModel?: string;
  turboSQLModel?: string;
  turboSynthesisModel?: string;
  
  // Optional schema information if available
  schema?: Record<string, any>;
  indexes?: Record<string, any>;
  tableSizeCache?: Record<string, number>;
  
  // Function to run queries (can be overridden for testing/custom implementation)
  runQueryFn?: (sql: string, params: any[], cfg: any, context: AnalysisContext) => Promise<any>;
}

export interface ConnectorCfg {
  databaseType?: 'mysql' | 'postgres' | 'mongodb' | 'databricks';
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  url?: string; // For MongoDB connection strings and other direct URLs
  mongoOptions?: {
    authSource?: string;
    ssl?: boolean;
    replicaSet?: string;
    readPreference?: 'primary' | 'secondary' | 'primaryPreferred' | 'secondaryPreferred' | 'nearest';
    maxPoolSize?: number;
    minPoolSize?: number;
    serverSelectionTimeoutMS?: number;
    socketTimeoutMS?: number;
    connectTimeoutMS?: number;
  };
  databricksOptions?: {
    httpPath: string;     // /sql/1.0/warehouses/<warehouse-id> (REQUIRED)
    schema?: string;      // default schema within catalog (optional)
    timeout?: number;     // query timeout in ms (optional)
  };
  ssh?: {
    host: string;
    port?: number;
    username: string;
    privateKeyPath: string;
  };
  telemetry?: boolean;
  pgDisableSsl?: boolean;
}

// Add MongoDB connection string builder
export function buildMongoConnectionString(cfg: ConnectorCfg): string {
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
    if (mongoOptions.authSource) options.append('authSource', mongoOptions.authSource);
    if (mongoOptions.ssl) options.append('ssl', mongoOptions.ssl.toString());
    if (mongoOptions.replicaSet) options.append('replicaSet', mongoOptions.replicaSet);
    if (mongoOptions.readPreference) options.append('readPreference', mongoOptions.readPreference);
    if (mongoOptions.maxPoolSize) options.append('maxPoolSize', mongoOptions.maxPoolSize.toString());
    if (mongoOptions.minPoolSize) options.append('minPoolSize', mongoOptions.minPoolSize.toString());
    if (mongoOptions.serverSelectionTimeoutMS) options.append('serverSelectionTimeoutMS', mongoOptions.serverSelectionTimeoutMS.toString());
    if (mongoOptions.socketTimeoutMS) options.append('socketTimeoutMS', mongoOptions.socketTimeoutMS.toString());
    if (mongoOptions.connectTimeoutMS) options.append('connectTimeoutMS', mongoOptions.connectTimeoutMS.toString());
    
    const optionsString = options.toString();
    if (optionsString) {
      connectionString += `?${optionsString}`;
    }
  }
  
  return connectionString;
}

// Parameter binding helper for MongoDB queries
export function applyParamsToMongoQuery(queryObj: any, paramMap: Record<string, any>): any {
  if (!queryObj || typeof queryObj !== 'object') {
    return queryObj;
  }

  if (Array.isArray(queryObj)) {
    return queryObj.map(item => applyParamsToMongoQuery(item, paramMap));
  }

  const result: any = {};
  
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
          } else {
            processedValue = processedValue.replace(match[0], paramMap[paramPath]);
          }
        }
      }
      result[key] = processedValue;
    } else if (typeof value === 'object') {
      result[key] = applyParamsToMongoQuery(value, paramMap);
    } else {
      result[key] = value;
    }
  }
  
  return result;
}

// --------------------------- withTunnel ---------------------------
// (Simplified for now; would need more SSH tunnel work for MongoDB)
export async function withTunnel<T>(
  cfg: ConnectorCfg,
  fn: (localCfg: ConnectorCfg) => Promise<T>
): Promise<T> {
  // For now, just pass through. Real SSH tunneling would create a local port forward.
  return await fn(cfg);
}

// --------------------------- Token utilities ---------------------------
const tokenStore = new Map<string, { expires: number; data: any }>();

export function issueToken(data: any, ttlMs = 300_000): string {
  const token = crypto.randomBytes(16).toString('hex');
  tokenStore.set(token, { expires: Date.now() + ttlMs, data });
  return token;
}

export function verifyToken(token: string): any | null {
  const entry = tokenStore.get(token);
  if (!entry || Date.now() > entry.expires) {
    tokenStore.delete(token);
    return null;
  }
  return entry.data;
}

// --------------------------- runQuery ---------------------------
export async function runQuery<T = any[]>(
  query: string | MongoQuery,
  params: any[] = [],
  cfg: ConnectorCfg,
  context?: AnalysisContext
): Promise<T> {
    return await execQuery<T>(query, params, cfg);
  }

/**
 * Internal query execution function that handles the actual database interaction
 * @param context Optional AnalysisContext containing configuration settings
 */
async function execQuery<T = any[]>(
  query: string | MongoQuery,
  params: any[] = [],
  cfg: ConnectorCfg,
): Promise<T> {
  if (cfg.databaseType === 'mongodb') {
    try {
      // Dynamic import to handle optional MongoDB dependency
      const mongodb = await import('mongodb');
      const MongoClient = mongodb.MongoClient;
      
      const connectionString = buildMongoConnectionString(cfg);
      const client = new MongoClient(connectionString, cfg.mongoOptions);
      
      await client.connect();
      try {
        const db = client.db(cfg.database);
        
        if (typeof query === 'object' && 'operation' in query) {
          const mongoQuery = query as MongoQuery;
          const collection = db.collection(mongoQuery.collection);
          switch (mongoQuery.operation) {
                case 'find':
                  const findCursor = collection.find(
                    mongoQuery.filter || {},
                    mongoQuery.options || {}
                  );
                  if (mongoQuery.sort) findCursor.sort(mongoQuery.sort);
                  if (mongoQuery.limit) findCursor.limit(mongoQuery.limit);
                  if (mongoQuery.skip) findCursor.skip(mongoQuery.skip);
                  return await findCursor.toArray() as unknown as T;
                  
                case 'aggregate':
                  const aggCursor = collection.aggregate(
                    mongoQuery.pipeline || [],
                    mongoQuery.options || {}
                  );
                  return await aggCursor.toArray() as unknown as T;
                  
                case 'distinct':
                  return await collection.distinct(
                    mongoQuery.field!,
                    mongoQuery.filter || {}
                  ) as unknown as T;
                  
                case 'count':
                  const count = await collection.countDocuments(
                    mongoQuery.filter || {},
                    mongoQuery.options || {}
                  );
                  return [{ count }] as unknown as T;
                  
                default:
                  throw new Error(`Unsupported MongoDB operation: ${mongoQuery.operation}`);
              }
            
        } else {
          throw new Error('Invalid MongoDB query format');
        }
      } finally {
        await client.close();
      }
    } catch (error) {
      if ((error as any).code === 'MODULE_NOT_FOUND') {
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
      const databricksSql = await import('@databricks/sql');
      
      const httpPath = (cfg.databricksOptions && cfg.databricksOptions.httpPath) || (cfg as any).databricksHttpPath;
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
        const operation = await session.executeStatement(query as string, {
          runAsync: true,
          maxRows: 10000,
        });
        
        const result = await operation.fetchAll();
        await operation.close();
        await session.close();
        return result as unknown as T;
        
      } finally {
        await connection.close();
      }
    } catch (error) {
      if ((error as any).code === 'MODULE_NOT_FOUND') {
        throw new Error('Databricks SQL driver not found. Please install: npm install @databricks/sql');
      }
      throw error;
    }
  }

  if (cfg.databaseType === 'postgres') {
    // Use pgDisableSsl from context if available, otherwise fall back to environment variable
    const pgDisableSsl = cfg?.pgDisableSsl
    
    const client = new pg.Client({
      host: cfg.host,
      port: cfg.port || 5432,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      ...(pgDisableSsl
        ? {}
        : { ssl: { rejectUnauthorized: false } }),
    } as any);
    await client.connect();
    try {
      const { rows } = await client.query(query as string, params);
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
    const [rows] = await conn.query(query as string, params);
    return rows as unknown as T;
  } finally {
    await conn.end();
  }
}

// --------------------------- initMetadata ---------------------------
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
export async function initMetadata(cfg: ConnectorCfg, context?: AnalysisContext): Promise<{
  schemaMap: typeof schemaMap;
  indexMap: typeof indexMap;
  tableSizeCache: typeof tableSizeCache;
}> {
  const inner = async () => {
    
    if (cfg.databaseType === 'mongodb') {
      try {
        const mongodb = await import('mongodb');
        const MongoClient = mongodb.MongoClient;
        const connectionString = buildMongoConnectionString(cfg);
        const client = new MongoClient(connectionString, cfg.mongoOptions);
        await client.connect();
        await loadSchemaMap(client, cfg.database, 'mongodb');
        await loadTableSizes(client, cfg.database, 'mongodb');
        await client.close();
      } catch (error) {
        if ((error as any).code === 'MODULE_NOT_FOUND') {
          throw new Error('MongoDB driver not found. Please install mongodb package: npm install mongodb');
        }
        throw error;
      }
    } else if (cfg.databaseType === 'databricks') {
      // throw new Error(JSON.stringify(cfg));
      try {
        // Dynamic import to handle optional Databricks dependency
        const databricksSql = await import('@databricks/sql');
        
        const httpPath = (cfg.databricksOptions && cfg.databricksOptions.httpPath) || (cfg as any).databricksHttpPath;
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
        } finally {
          await connection.close();
        }
      } catch (error) {
        if ((error as any).code === 'MODULE_NOT_FOUND') {
          throw new Error('Databricks SQL driver not found. Please install: npm install @databricks/sql');
        }
        throw error;
      }
    } else if (cfg.databaseType === 'postgres') {
      // Use pgDisableSsl from context if available, otherwise fall back to environment variable
      // const pgDisableSsl = context.pgDisableSsl
      
      const client = new pg.Client({
        host: cfg.host,
        port: cfg.port || 5432,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        ssl: cfg.pgDisableSsl ? undefined : { rejectUnauthorized: false },
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