#!/usr/bin/env node
/**
 * celp‑stdio MCP server —— faithful port of the reference AnalysisClient
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { io, Socket } from "socket.io-client";
import { Client as PgClient } from "pg";
import { createConnection } from "mysql2/promise";
import type { DefaultEventsMap } from "socket.io/dist/typed-events";
import * as Connector from './connector';
import { ConnectorCfg, indexMap, schemaMap } from "./connector";
import { MongoClient } from "mongodb";
import { registerTool } from './toolRegistry';

require("dotenv").config();

/* ── Helper types ───────────────────────────────────────────────────── */
type DbType = "postgres" | "mysql" | "mongodb" | 'databricks';
interface DbCfg {
  databaseType: DbType;
  host: string;
  user: string;
  password: string;
  database: string;
  port?: number;
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
  databricksHttpPath?: string;
}

const DEBUG = process.env.DEBUG_LOGS === "true";
const log = (...a: any[]) => DEBUG && console.log(...a);

/* ── Databricks Connection Manager ────────────────────────────────────── */
interface DatabricksConnection {
  client: any;
  connection: any;
  isConnected: boolean;
  lastUsed: number;
  config: DbCfg;
}

class DatabricksConnectionManager {
  private connections = new Map<string, DatabricksConnection>();
  private initializationPromises = new Map<string, Promise<DatabricksConnection>>();
  private readonly CONNECTION_TIMEOUT = 30000; // 30 seconds
  private readonly IDLE_TIMEOUT = 300000; // 5 minutes
  private cleanupInterval?: NodeJS.Timeout;

  constructor() {
    // Clean up idle connections every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleConnections();
    }, 60000);
  }

  private getConnectionKey(cfg: DbCfg): string {
    return `${cfg.host}:${cfg.port || 443}:${cfg.user}:${cfg.database}`;
  }

  async getConnection(cfg: DbCfg): Promise<DatabricksConnection> {
    if (cfg.databaseType !== 'databricks') {
      throw new Error('This method is only for Databricks connections');
    }

    const key = this.getConnectionKey(cfg);
    
    // Check if we already have a connected instance
    const existing = this.connections.get(key);
    if (existing && existing.isConnected) {
      existing.lastUsed = Date.now();
      return existing;
    }

    // Check if we're already initializing this connection
    const initPromise = this.initializationPromises.get(key);
    if (initPromise) {
      return await initPromise;
    }

    // Create new connection
    const connectionPromise = this.createConnection(cfg, key);
    this.initializationPromises.set(key, connectionPromise);

    try {
      const connection = await connectionPromise;
      this.connections.set(key, connection);
      return connection;
    } finally {
      this.initializationPromises.delete(key);
    }
  }

  private async createConnection(cfg: DbCfg, key: string): Promise<DatabricksConnection> {
    console.error(`🔄 Initializing Databricks connection for ${cfg.host}...`);
    
    try {
      // Dynamic import to handle optional Databricks dependency
      const databricksSql = await import('@databricks/sql');
      
      const httpPath = cfg.databricksHttpPath;
      if (!httpPath) {
        throw new Error('Missing Databricks httpPath in configuration');
      }

      console.error(`⚡ Connecting to Databricks warehouse...`);
      
      const client = new databricksSql.DBSQLClient();
      const connection = await Promise.race([
        client.connect({
          host: cfg.host,
          path: httpPath,
          token: cfg.password, // token stored in password field
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Databricks connection timeout')), this.CONNECTION_TIMEOUT)
        )
      ]);

      console.error(`✅ Databricks connection established successfully!`);

      const databricksConnection: DatabricksConnection = {
        client,
        connection,
        isConnected: true,
        lastUsed: Date.now(),
        config: cfg
      };

      return databricksConnection;
    } catch (error) {
      console.error(`❌ Failed to connect to Databricks: ${(error as any).message}`);
      if ((error as any).code === 'MODULE_NOT_FOUND') {
        throw new Error('Databricks SQL driver not found. Please install: npm install @databricks/sql');
      }
      throw error;
    }
  }

  async executeQuery(sql: string, cfg: DbCfg): Promise<any> {
    const databricksConnection = await this.getConnection(cfg);
    
    try {
      const session = await databricksConnection.connection.openSession();
      const operation = await session.executeStatement(sql, {
        runAsync: true,
        maxRows: 10000,
      });
      
      const result = await operation.fetchAll();
      await operation.close();
      await session.close();
      
      databricksConnection.lastUsed = Date.now();
      return result;
      
    } catch (error) {
      console.error(`❌ Databricks query execution failed: ${(error as any).message}`);
      // Mark connection as potentially bad
      databricksConnection.isConnected = false;
      throw error;
    }
  }

  private async cleanupIdleConnections() {
    const now = Date.now();
    
    for (const [key, connection] of this.connections.entries()) {
      if (now - connection.lastUsed > this.IDLE_TIMEOUT) {
        console.error(`🧹 Cleaning up idle Databricks connection: ${key}`);
        try {
          await connection.connection.close();
        } catch (error) {
          console.warn(`Warning: Error closing idle connection: ${(error as any).message}`);
        }
        this.connections.delete(key);
      }
    }
  }

  async closeAll() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    for (const [key, connection] of this.connections.entries()) {
      try {
        await connection.connection.close();
      } catch (error) {
        console.warn(`Warning: Error closing connection ${key}: ${(error as any).message}`);
      }
    }
    
    this.connections.clear();
    this.initializationPromises.clear();
  }
}

// Global Databricks connection manager
const databricksManager = new DatabricksConnectionManager();

// Warmup function to pre-initialize Databricks connections
async function warmupDatabricksConnection() {
  // Check if we have Databricks configuration
  if (process.env.DATABASE_TYPE === 'databricks' && process.env.DATABRICKS_HOST) {
    const cfg: DbCfg = {
      databaseType: 'databricks',
      host: process.env.DATABRICKS_HOST,
      user: process.env.DATABRICKS_USER || 'databricks',
      password: process.env.DATABRICKS_TOKEN || '',
      database: process.env.DATABRICKS_CATALOG || 'default',
      port: process.env.DATABRICKS_PORT ? parseInt(process.env.DATABRICKS_PORT, 10) : undefined,
      databricksHttpPath: process.env.DATABRICKS_HTTP_PATH,
    };

    try {
      console.error('🚀 Warming up Databricks connection...');
      await databricksManager.getConnection(cfg);
      console.error('🎯 Databricks connection ready for use!');
    } catch (error) {
      console.warn(`⚠️  Databricks warmup failed: ${(error as any).message}`);
    }
  }
}

// Cleanup on exit
process.on('SIGINT', async () => {
  console.error('\n🔄 Shutting down Databricks connections...');
  await databricksManager.closeAll();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('\n🔄 Shutting down Databricks connections...');
  await databricksManager.closeAll();
  process.exit(0);
});

/* ── DB query executor (unchanged from reference) ───────────────────── */
export async function runQuery(cfg: DbCfg, sql: string, params: any[] = []) {
  if (cfg.databaseType === "mongodb") {
    try {
      const mongodb = await import('mongodb');
      const MongoClient = mongodb.MongoClient;
      const connectionString = Connector.buildMongoConnectionString(cfg);
      const client = new MongoClient(connectionString, cfg.mongoOptions);
      try {
        await client.connect();
        await Connector.loadSchemaMap(client, cfg.database, 'mongodb');
        await Connector.loadTableSizes(client, cfg.database, 'mongodb');
        return await Connector.runQuery(sql, params, cfg);
      } finally {
        await client.close();
      }
    } catch (error) {
      if ((error as any).code === 'MODULE_NOT_FOUND') {
        throw new Error('MongoDB driver not found. Please install mongodb package: npm install mongodb');
      }
      throw error;
    }
  } else if (cfg.databaseType === "postgres") {
    const client = new PgClient({
      host: cfg.host,
      port: cfg.port || 5432,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      ssl: process.env.PG_DISABLE_SSL === "true" ? undefined : { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      const { rows } = await client.query(sql, params);
      return rows;
    } finally {
      await client.end();
    }
  } else if (cfg.databaseType === "databricks") {
    // Use the connection manager for improved performance
    return await databricksManager.executeQuery(sql, cfg);
  } else {
    const conn = await createConnection({
      host: cfg.host,
      port: cfg.port || 3306,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
    });
    try {
      const [rows] = await conn.query(sql, params);
      return rows as any[];
    } finally {
      await conn.end();
    }
  }
}

/* ── Single orchestration roundtrip ─────────────────────────────────── */
export async function orchestrate(prompt: string, apiKey: string, databaseConnectionId?: string, cfg?: DbCfg, mode: 'turbo' | 'reasoning'='turbo'): Promise<string> {
  const serverUrl = process.env.STREAMING_API_URL || "https://celp-mcp-server.onrender.com";
  // const serverUrl = process.env.STREAMING_API_URL || "http://localhost:5006";
  // const apiKey = apiKey || process.env.CELP_API_KEY;
  const socket: Socket<DefaultEventsMap, DefaultEventsMap> = io(serverUrl, {
    auth: apiKey ? { token: apiKey } : undefined,
    extraHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  }); // identical to reference

  /* Prepare schema in the background */


  return new Promise<string>((resolve, reject) => {
    let finalMarkdown = "";

    socket.on("connect_error", (e) => {
      socket.disconnect();
      reject(new Error(`Socket error: ${e.message}`));
    });

    /* 1. handle DB query requests */
    socket.on("query_request", async ({ queryId, sql, params }) => {
      log("query_request", queryId);
      if (!cfg) {
        socket.emit("query_result", { queryId, error: "No database configuration provided" });
        return;
      }
      try {
        const result = await runQuery(cfg, sql, params);
        socket.emit("query_result", { queryId, result });
      } catch (e: any) {
        socket.emit("query_result", { queryId, error: e.message });
      }
    });

    /* 2. handle streaming orchestration messages */
    socket.on("orchestration_chunk", ({ chunk }) => {
      if (chunk?.type === "summary") log("summary", chunk.text);
      if (chunk?.type === "final") finalMarkdown = chunk.markdown ?? "";
    });
    socket.on("orchestration_error", ({ error }) => {
      socket.disconnect();
      reject(new Error(error));
    });
    socket.on("orchestration_complete", () => {
      socket.disconnect();
      resolve(finalMarkdown || "No results found");
    });

    /* 3. after socket opens, send schema then orchestrate */
    socket.on("connect", async () => {
      log("connected", socket.id);
      
      // Pre-warm Databricks connection if this is a Databricks configuration
      if (cfg && cfg.databaseType === 'databricks') {
        try {
          await databricksManager.getConnection(cfg);
        } catch (error) {
          console.warn(`Databricks pre-warm failed: ${(error as any).message}`);
        }
      }
      
      if (!databaseConnectionId && cfg) {
        const { schemaMap, indexMap } = await Connector.initMetadata(cfg as any);
        // console.log(`CLI: Loaded schema with ${Object.keys(schemaMap).length} tables`);
        socket.emit("schema_info", { schemaMap, indexMap });
      } else {
        socket.emit("schema_info", { databaseConnectionId });
      }


      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      // resolve(JSON.stringify({ prompt, databaseType: cfg?.databaseType, requestId, apiKey, mode, databaseConnectionId }));
      socket.emit("orchestrate", { prompt, databaseType: cfg?.databaseType, requestId, apiKey, mode, databaseConnectionId });
    });
  });
}

/* ── MCP stdio server setup ─────────────────────────────────────────── */
const server = new McpServer({
  name: "celp-stdio",
  version: "1.3.0",
  description: `
  # Data Analyst Agent: Tool Context for LLM Usage

Based on my analysis of the codebase, I've created a context description that explains how this system works and how an LLM should interact with it:

---

## Tool Description

The **Data Analyst Agent** is a natural language to database analytics system that allows you to answer complex data questions by:

- Translating natural language queries into multi-step SQL analysis plans
- Executing these plans against MySQL or PostgreSQL databases
- Synthesizing the results into coherent markdown reports with insights

---

## How It Works

When a user submits a natural language query:

1. The system evaluates query complexity and generates multiple possible solution plans  
2. It selects the optimal plan through a voting mechanism  
3. It executes the plan step-by-step, with each step building on previous results  
4. It synthesizes a final report addressing the original question  

---

## Capabilities

You can use this tool to:

- Analyze data across multiple tables with complex relationships  
- Perform multi-step analyses where each step builds on previous results  
- Generate parameterized queries that reference data from earlier steps  
- Recover from errors and optimize underperforming queries  
- Produce insightful summaries with visualizations when appropriate  

---

## How to Craft Effective Prompts

When using this tool, prompts should:

- Be specific about the analysis goal (metrics, time periods, entities of interest)  
- Include any relevant business context needed for interpretation  
- Specify the format of the desired output (tables, charts, insights)  
- For complex analyses, break down into logical components  

---

## Behind the Scenes

The system:

- Uses LLMs to generate solution plans and SQL queries  
- Maintains a \`DataContext\` that stores results between steps  
- Automatically optimizes and repairs failing queries  

---

## Limitations

When using this tool, be aware:

- Each step can only access data from the immediately previous step  
- Very large result sets require summarization which may lose detail  
- For optimal performance, limit the scope of analysis to relevant tables and data points  

---

## Example Usage

For a prompt like:

> "Analyze our sales performance by region for Q1, highlighting underperforming product categories"

The system will:

- Determine database tables containing sales, regions, and products  
- Generate a plan to analyze performance metrics  
- Execute SQL queries that join appropriate tables and compute aggregations  
- Present a final report with insights about regional performance and underperforming categories  

---

This tool excels at answering specific analytical questions about data by handling all the complexity of SQL generation, execution, and result interpretation.
`,
  capabilities: { resources: {}, tools: {} },
});

registerTool(
  server,
  "query-database",
  `# Data Analyst Agent: Reasoning Analysis Mode

This tool translates natural language into multi-step SQL analysis plans and executes them against databases. Use this for complex analytical questions requiring more reasoning.

## Capabilities
- Performs multi-step analyses with each step building on previous results
- Analyzes data across multiple tables with complex relationships
- Handles complex queries requiring careful reasoning and planning
- Produces comprehensive markdown reports with insights

## When to Use
- For complex analytical questions requiring deep reasoning
- When accuracy and comprehensiveness is more important than speed
- For queries involving multiple tables or complex relationships
- When detailed insights and explanations are needed

## Effective Prompts
- Be specific about metrics, time periods, and entities of interest
- Include relevant business context for interpretation
- Specify desired output format (tables, charts, insights)
- For complex analyses, break down into logical components

## Restrictions:
- Don't sent database credentials in the payload, it's handled by the server.
- Don't sent API keys in the payload, it's handled by the server.
`,
  {
    prompt: z.string(),
    databaseConfig: z.object({
      databaseType: z.enum(["postgres", "mysql"]).optional(),
      host: z.string().optional(),
      user: z.string().optional(),
      password: z.string().optional(),
      database: z.string().optional(),
      port: z.number().optional(),
      disableSSL: z.enum(["true", "false"]).optional(),
      mongoOptions: z.object({
        authSource: z.string().optional(),
        ssl: z.boolean().optional(),
        replicaSet: z.string().optional(),
        readPreference: z.enum(["primary", "secondary", "primaryPreferred", "secondaryPreferred", "nearest"]).optional(),
        maxPoolSize: z.number().optional(),
        serverSelectionTimeoutMS: z.number().optional(),
        connectTimeoutMS: z.number().optional(),
      }).optional(),
    }).optional(),
    celpApiKey: z.string().optional(),
    databaseConnectionId: z.string().optional(),
  },
  async (args) => {
    const { prompt, databaseConfig: databaseConfigRaw, databaseConnectionId, celpApiKey } = args;
    // console.log({args})
    // if (process.env.DONT_USE_DB_ENVS !== "true") {
    //   if (databaseConfig) {
    //     process.env.PG_DISABLE_SSL = databaseConfig.disableSSL === "true" ? "true" : "false";
    //     process.env.MYSQL_SSL = databaseConfig.disableSSL === "true" ? "false" : "true";
    //   }
    //   if (celpApiKey) {
    //     process.env.CELP_API_KEY = celpApiKey;
    //   }
    //   if (databaseConnectionId) {
    //     process.env.DATABASE_CONNECTION_ID = databaseConnectionId;
    //   }
    // }
    let databaseConfig: typeof databaseConfigRaw | undefined;
    if(process.env.DONT_USE_DB_ENVS === "true") {
      databaseConfig = databaseConfigRaw;
    }
    const cfg = databaseConfig || (process.env.DONT_USE_DB_ENVS !== "true") ? {
      databaseType: process.env.DATABASE_TYPE as DbType,
      host: process.env.DATABASE_HOST || process.env.DATABRICKS_HOST || "localhost",
      user: process.env.DATABASE_USER || process.env.DATABRICKS_USER || "postgres",
      password: process.env.DATABASE_PASSWORD || process.env.DATABRICKS_TOKEN || "postgres",
      database: process.env.DATABASE_NAME || process.env.DATABRICKS_CATALOG || "test_db",
      port: (process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined) || (process.env.DATABRICKS_PORT ? parseInt(process.env.DATABRICKS_PORT, 10) : undefined),
      mongoOptions: {
        authSource: process.env.MONGO_AUTH_SOURCE || 'admin',
        ssl: process.env.MONGO_SSL === 'true',
        replicaSet: process.env.MONGO_REPLICA_SET,
        readPreference: process.env.MONGO_READ_PREFERENCE as "primary" | "secondary" | "primaryPreferred" | "secondaryPreferred" | "nearest",
        maxPoolSize: process.env.MONGO_MAX_POOL_SIZE ? parseInt(process.env.MONGO_MAX_POOL_SIZE, 10) : 10,
        serverSelectionTimeoutMS: process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS ? parseInt(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS, 10) : 5000,
        connectTimeoutMS: process.env.MONGO_CONNECT_TIMEOUT_MS ? parseInt(process.env.MONGO_CONNECT_TIMEOUT_MS, 10) : 10000,
      },
      url: process.env.MONGO_URL,
      databricksHttpPath: process.env.DATABRICKS_HTTP_PATH,
      databricksOptions: {
        httpPath: process.env.DATABRICKS_HTTP_PATH,
        schema: process.env.DATABRICKS_SCHEMA,
      },
    } : undefined;

    // const cfg: DbCfg = databaseConfig || {
    //   databaseType: (process.env.DATABASE_TYPE as DbType) || "postgres",
    //   host: process.env.DATABASE_HOST || "localhost",
    //   user: process.env.DATABASE_USER || "root",
    //   password: process.env.DATABASE_PASSWORD || "",
    //   database: process.env.DATABASE_NAME || "test_db",
    // port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
    // };

    if ((process.env.DONT_USE_DB_ENVS === "true" && !celpApiKey) || (process.env.DONT_USE_DB_ENVS !== "true" && !process.env.CELP_API_KEY)) {
      throw new Error("No API key provided");
    }
    try {
      const md = await orchestrate(prompt, process.env.DONT_USE_DB_ENVS === "true" ? celpApiKey! : process.env.CELP_API_KEY!, databaseConnectionId, cfg, 'reasoning');
      return { content: [{ type: "text", text: md }] };
    } catch (e: any) {
      console.error("query-database error:", e);
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  },
);
// server.tool(
//   "query-database-fast",
//   `# Data Analyst Agent: Balanced Mode

// This tool provides a balanced approach to database analysis, maintaining good accuracy while completing queries faster than the standard mode.

// ## Capabilities
// - Translates natural language to optimized SQL queries
// - Balances between depth of analysis and speed of execution
// - Can handle moderately complex analytical questions
// - Produces concise markdown reports with key insights

// ## When to Use
// - For typical analytical questions that don't require extensive reasoning
// - When a good balance between speed and depth is needed
// - For most standard database queries

// ## Effective Prompts
// - Clearly state the specific metrics or information needed
// - Provide context about what tables or data are relevant
// - Be concise but complete in your question formulation
// - Mention any time constraints or filters that should be applied

// ## Restrictions:
// - Don't sent database credentials in the payload, it's handled by the server.
// - Don't sent API keys in the payload, it's handled by the server.`,
//   {
//     prompt: z.string(),
//     databaseConfig: z.object({
//       databaseType: z.enum(["postgres", "mysql"]),
//       host: z.string(),
//       user: z.string(),
//       password: z.string(),
//       database: z.string(),
//       port: z.number().optional(),
//       disableSSL: z.enum(["true", "false"]).optional(),
//     }).optional(),
//     celpApiKey: z.string().optional(),
//   },
//   async ({ prompt, databaseConfig, celpApiKey }) => {
//     if (databaseConfig) {
//       process.env.PG_DISABLE_SSL = databaseConfig.disableSSL === "true" ? "true" : "false";
//       process.env.MYSQL_SSL = databaseConfig.disableSSL === "true" ? "false" : "true";
//     }
//     if (celpApiKey) {
//       process.env.CELP_API_KEY = celpApiKey;
//     }
//     const cfg: DbCfg = databaseConfig || {
//       databaseType: (process.env.DATABASE_TYPE as DbType) || "postgres",
//       host: process.env.DATABASE_HOST || "localhost",
//       user: process.env.DATABASE_USER || "root",
//       password: process.env.DATABASE_PASSWORD || "",
//       database: process.env.DATABASE_NAME || "test_db",
//       port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
//     };

//     try {
//       const md = await orchestrate(prompt, cfg, 'reasoning');
//       return { content: [{ type: "text", text: md }] };
//     } catch (e: any) {
//       console.error("query-database error:", e);
//       return { content: [{ type: "text", text: `Error: ${e.message}` }] };
//     }
//   },
// );
registerTool(
  server,
  "query-database-turbo",
  `### **When to Use (Natural-Language Heuristics)**

Because the model sees only the *user's question* and minimal schema hints, Turbo Mode should activate automatically **whenever the request exhibits every one of these surface-level cues**.  Each cue corresponds to a first-principles driver of SQL complexity that the model *can* infer without deep schema knowledge:

| Signal in the User's Question                                                                                                   | Why It Indicates Turbo Is Safe                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Single Factual Verb** — verbs like "count," "list," "show," "sum," "average," or "max/min," used **once**.                    | One aggregate or projection keeps the SQL to a single \`SELECT\`.                                     |
| **At Most One Qualifier Clause** — a lone filter such as a date range, status, or simple equality ("where status = 'active'").  | Few filters avoid nested logic or subqueries.                                                       |
| **No Comparative Language** — absent words like "versus," "compare," "trend," "change over time," "prior year," "by each," etc. | Comparisons imply multiple groupings, time windows, or self-joins.                                  |
| **No Multi-Dimensional Grouping Phrases** — avoids "by region and product," "per user per month," "split across categories."    | Multiple dimensions require complex \`GROUP BY\` and often joins.                                     |
| **Mentions One Table-Like Concept** — either explicitly ("in \`orders\`") or implicitly ("orders today," "users last week").      | Referencing several entities hints at join logic the model can't verify quickly.                    |
| **Requests Raw IDs or a Small Top-N List** — e.g., "give me the top 5 order IDs."                                               | The result set will be tiny, so execution latency is dominated by query planning—not data transfer. |
| **No Need for Explanation or Visualization** — the user asks only for the numbers or rows, not "explain why" or "graph this."   | Generating narrative or charts costs tokens and time; Turbo avoids it.                              |

> **Quick mental check**: *Could you answer this with a single short sentence and a single-line SQL query template?*
> If yes, Turbo Mode is appropriate.

---

### Limitations

* Unsuitable for multi-step or exploratory workflows
* May miss domain nuances captured in the standard reasoning path
* Provides limited explanation and simplistic visuals

---

### Effective Prompts

* "How many active users signed up last week?"
* "List the five most expensive orders."
* "Show the total revenue for March 2025."
* "What is the average session length today?"`,
  {
    prompt: z.string(),
    databaseConfig: z.object({
      databaseType: z.enum(["postgres", "mysql", "mongodb", "databricks"]).optional(),
      host: z.string().optional(),
      user: z.string().optional(),
      password: z.string().optional(),
      database: z.string().optional(),
      port: z.number().optional(),
      disableSSL: z.enum(["true", "false"]).optional(),
      mongoOptions: z.object({
        authSource: z.string().optional(),
        ssl: z.boolean().optional(),
        replicaSet: z.string().optional(),
        readPreference: z.enum(["primary", "secondary", "primaryPreferred", "secondaryPreferred", "nearest"]).optional(),
        maxPoolSize: z.number().optional(),
        serverSelectionTimeoutMS: z.number().optional(),
        connectTimeoutMS: z.number().optional(),
      }).optional(),
      databricksHttpPath: z.string().optional(),  
    }).optional(),
    databaseConnectionId: z.string().optional(),
    celpApiKey: z.string().optional(),
  },
  async (args) => {
    const { prompt, databaseConfig: databaseConfigRaw, databaseConnectionId, celpApiKey } = args;
    // console.log({args})
    // if (process.env.DONT_USE_DB_ENVS !== "true") {
    //   if (databaseConfig) {
    //     process.env.PG_DISABLE_SSL = databaseConfig.disableSSL === "true" ? "true" : "false";
    //     process.env.MYSQL_SSL = databaseConfig.disableSSL === "true" ? "false" : "true";
    //   }
    //   if (celpApiKey) {
    //     process.env.CELP_API_KEY = celpApiKey;
    //   }
    //   if (databaseConnectionId) {
    //     process.env.DATABASE_CONNECTION_ID = databaseConnectionId;
    //   }
    // }
    let databaseConfig: typeof databaseConfigRaw | undefined;
    if(process.env.DONT_USE_DB_ENVS === "true") {
      databaseConfig = databaseConfigRaw;
    }
    const cfg = databaseConfig || (process.env.DONT_USE_DB_ENVS !== "true") ? {
      databaseType: process.env.DATABASE_TYPE as DbType,
      host: process.env.DATABASE_HOST || process.env.DATABRICKS_HOST || "localhost",
      user: process.env.DATABASE_USER || process.env.DATABRICKS_USER || "postgres",
      password: process.env.DATABASE_PASSWORD || process.env.DATABRICKS_TOKEN || "postgres",
      database: process.env.DATABASE_NAME || process.env.DATABRICKS_CATALOG || "test_db",
      port: (process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined) || (process.env.DATABRICKS_PORT ? parseInt(process.env.DATABRICKS_PORT, 10) : undefined),
      mongoOptions: {
        authSource: process.env.MONGO_AUTH_SOURCE || 'admin',
        ssl: process.env.MONGO_SSL === 'true',
        replicaSet: process.env.MONGO_REPLICA_SET,
        readPreference: process.env.MONGO_READ_PREFERENCE as "primary" | "secondary" | "primaryPreferred" | "secondaryPreferred" | "nearest",
        maxPoolSize: process.env.MONGO_MAX_POOL_SIZE ? parseInt(process.env.MONGO_MAX_POOL_SIZE, 10) : 10,
        serverSelectionTimeoutMS: process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS ? parseInt(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS, 10) : 5000,
        connectTimeoutMS: process.env.MONGO_CONNECT_TIMEOUT_MS ? parseInt(process.env.MONGO_CONNECT_TIMEOUT_MS, 10) : 10000,
      },
      url: process.env.MONGO_URL,
      databricksHttpPath: process.env.DATABRICKS_HTTP_PATH,
      databricksOptions: {
        httpPath: process.env.DATABRICKS_HTTP_PATH,
        schema: process.env.DATABRICKS_SCHEMA,
      },
    } : undefined;

    // const cfg: DbCfg = databaseConfig || {
    //   databaseType: (process.env.DATABASE_TYPE as DbType) || "postgres",
    //   host: process.env.DATABASE_HOST || "localhost",
    //   user: process.env.DATABASE_USER || "root",
    //   password: process.env.DATABASE_PASSWORD || "",
    //   database: process.env.DATABASE_NAME || "test_db",
    // port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
    // };

    if ((process.env.DONT_USE_DB_ENVS === "true" && !celpApiKey) || (process.env.DONT_USE_DB_ENVS !== "true" && !process.env.CELP_API_KEY)) {
      throw new Error("No API key provided");
    }
    try {
      const md = await orchestrate(prompt, process.env.DONT_USE_DB_ENVS === "true" ? celpApiKey! : process.env.CELP_API_KEY!, databaseConnectionId, cfg, 'turbo');
      return { content: [{ type: "text", text: md }] };
    } catch (e: any) {
      console.error("query-database error:", e);
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  },
);

registerTool(
  server,
  "get-schema",
  `
  Returns the schema map for the database. Only use this tool after previous attempts fail, or when specifically requested
`,
  {
    databaseConfig: z.object({
      databaseType: z.enum(["postgres", "mysql", "mongodb", "databricks"]).optional(),
      host: z.string().optional(),
      user: z.string().optional(),
      password: z.string().optional(),
      database: z.string().optional(),
      port: z.number().optional(),
      disableSSL: z.enum(["true", "false"]).optional()
    }).optional(),
    apiKey: z.string().optional(),
    databaseConnectionId: z.string().optional(),
  },
  async ({ databaseConfig: databaseConfigRaw, apiKey, databaseConnectionId }) => {
    // console.log({args, ctx})
    // console.log('attempting to get schema for')
    // if (process.env.CELP_API_KEY) {
    //   console.log('CELP_API_KEY2', process.env.CELP_API_KEY);
    //   console.log('DATABASE_CONNECTION_ID', process.env.DATABASE_CONNECTION_ID);
    //   process.exit(0);
    // }
    if (apiKey && databaseConnectionId) {
      // Proxy to streaming API when using remote database connection
      // const serverUrl = process.env.STREAMING_API_URL || "http://localhost:5006";
        const serverUrl = process.env.STREAMING_API_URL || "https://celp-mcp-server.onrender.com";
      const socket: Socket<DefaultEventsMap, DefaultEventsMap> = io(serverUrl, {
        auth: apiKey ? { token: apiKey } : undefined,
        extraHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      });

      return new Promise((resolve, reject) => {
        socket.on("connect_error", (e) => {
          socket.disconnect();
          reject(new Error(`Socket error: ${e.message}`));
        });

        socket.on("schema_map_result", ({ schemaMap, error }) => {
          socket.disconnect();
          if (error) {
            reject(new Error(error));
          } else {
            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(schemaMap, null, 2)
                },
              ],
            });
          }
        });

        socket.on("connect", () => {
          socket.emit("get_schema_map", {
            databaseConnectionId,
            apiKey
          });
        });
      });
    }
    let databaseConfig: typeof databaseConfigRaw | undefined;
    if(process.env.DONT_USE_DB_ENVS === "true") {
      databaseConfig = databaseConfigRaw;
    }
    const cfg = databaseConfig || (process.env.DONT_USE_DB_ENVS !== "true") ? {
      databaseType: process.env.DATABASE_TYPE as DbType,
      host: process.env.DATABASE_HOST || process.env.DATABRICKS_HOST || "localhost",
      user: process.env.DATABASE_USER || process.env.DATABRICKS_USER || "postgres",
      password: process.env.DATABASE_PASSWORD || process.env.DATABRICKS_TOKEN || "postgres",
      database: process.env.DATABASE_NAME || process.env.DATABRICKS_CATALOG || "test_db",
      port: (process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined) || (process.env.DATABRICKS_PORT ? parseInt(process.env.DATABRICKS_PORT, 10) : undefined),
      mongoOptions: {
        authSource: process.env.MONGO_AUTH_SOURCE || 'admin',
        ssl: process.env.MONGO_SSL === 'true',
        replicaSet: process.env.MONGO_REPLICA_SET,
        readPreference: process.env.MONGO_READ_PREFERENCE as "primary" | "secondary" | "primaryPreferred" | "secondaryPreferred" | "nearest",
        maxPoolSize: process.env.MONGO_MAX_POOL_SIZE ? parseInt(process.env.MONGO_MAX_POOL_SIZE, 10) : 10,
        serverSelectionTimeoutMS: process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS ? parseInt(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS, 10) : 5000,
        connectTimeoutMS: process.env.MONGO_CONNECT_TIMEOUT_MS ? parseInt(process.env.MONGO_CONNECT_TIMEOUT_MS, 10) : 10000,
      },
      url: process.env.MONGO_URL,
      databricksHttpPath: process.env.DATABRICKS_HTTP_PATH,
      databricksOptions: {
        httpPath: process.env.DATABRICKS_HTTP_PATH,
        schema: process.env.DATABRICKS_SCHEMA,
      },
    } : undefined;
// throw new Error(JSON.stringify(cfg))
    const { schemaMap } = await Connector.initMetadata(cfg as ConnectorCfg);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(schemaMap, null, 2)
        },
      ],
    };
  }
);

registerTool(
  server,
  "get-index-map",
  `
  Returns the index map for the database. Only use this tool after previous attempts fail, or when specifically requested
`,
  {
    databaseConfig: z.object({
      databaseType: z.enum(["postgres", "mysql", "mongodb", "databricks"]).optional(),
      host: z.string().optional(),
      user: z.string().optional(),
      password: z.string().optional(),
      database: z.string().optional(),
      port: z.number().optional(),
      disableSSL: z.enum(["true", "false"]).optional(),
    }).optional(),
    apiKey: z.string().optional(),
    databaseConnectionId: z.string().optional(),
  },
  async ({ databaseConfig: databaseConfigRaw, apiKey, databaseConnectionId }) => {
    // console.log('attempting to get index map for')
    if (apiKey && databaseConnectionId) {
      // const serverUrl = process.env.STREAMING_API_URL || "http://localhost:5006";
        const serverUrl = process.env.STREAMING_API_URL || "https://celp-mcp-server.onrender.com";

      const socket: Socket<DefaultEventsMap, DefaultEventsMap> = io(serverUrl, {
        auth: apiKey ? { token: apiKey } : undefined,
        extraHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      });

      return new Promise((resolve, reject) => {
        socket.on("connect_error", (e) => {
          socket.disconnect();
          reject(new Error(`Socket error: ${e.message}`));
        });

        socket.on("index_map_result", ({ indexMap, error }) => {
          socket.disconnect();
          if (error) {
            reject(new Error(error));
          } else {
            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(indexMap, null, 2)
                },
              ],
            });
          }
        });

        socket.on("connect", () => {
          socket.emit("get_index_map", {
            databaseConnectionId,
            apiKey
          });
        });
      });
    }

    if (apiKey && databaseConnectionId) {
      // Proxy to streaming API when using remote database connection
      // const serverUrl = process.env.STREAMING_API_URL || "http://localhost:5006";
        const serverUrl = process.env.STREAMING_API_URL || "https://celp-mcp-server.onrender.com";

      const socket: Socket<DefaultEventsMap, DefaultEventsMap> = io(serverUrl, {
        auth: apiKey ? { token: apiKey } : undefined,
        extraHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      });

      return new Promise((resolve, reject) => {
        socket.on("connect_error", (e) => {
          socket.disconnect();
          reject(new Error(`Socket error: ${e.message}`));
        });

        socket.on("index_map_result", ({ indexMap, error }) => {
          socket.disconnect();
          if (error) {
            reject(new Error(error));
          } else {
            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify(indexMap, null, 2)
                },
              ],
            });
          }
        });

        socket.on("connect", () => {
          socket.emit("get_index_map", {
            databaseConnectionId,
            apiKey
          });
        });
      });
    }

    let databaseConfig: typeof databaseConfigRaw | undefined;
    if(process.env.DONT_USE_DB_ENVS === "true") {
      databaseConfig = databaseConfigRaw;
    }
    const cfg = databaseConfig || (process.env.DONT_USE_DB_ENVS !== "true") ? {
      databaseType: process.env.DATABASE_TYPE as DbType,
      host: process.env.DATABASE_HOST || process.env.DATABRICKS_HOST || "localhost",
      user: process.env.DATABASE_USER || process.env.DATABRICKS_USER || "postgres",
      password: process.env.DATABASE_PASSWORD || process.env.DATABRICKS_TOKEN || "postgres",
      database: process.env.DATABASE_NAME || process.env.DATABRICKS_CATALOG || "test_db",
      port: (process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined) || (process.env.DATABRICKS_PORT ? parseInt(process.env.DATABRICKS_PORT, 10) : undefined),
      mongoOptions: {
        authSource: process.env.MONGO_AUTH_SOURCE || 'admin',
        ssl: process.env.MONGO_SSL === 'true',
        replicaSet: process.env.MONGO_REPLICA_SET,
        readPreference: process.env.MONGO_READ_PREFERENCE as "primary" | "secondary" | "primaryPreferred" | "secondaryPreferred" | "nearest",
        maxPoolSize: process.env.MONGO_MAX_POOL_SIZE ? parseInt(process.env.MONGO_MAX_POOL_SIZE, 10) : 10,
        serverSelectionTimeoutMS: process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS ? parseInt(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS, 10) : 5000,
        connectTimeoutMS: process.env.MONGO_CONNECT_TIMEOUT_MS ? parseInt(process.env.MONGO_CONNECT_TIMEOUT_MS, 10) : 10000,
      },
      url: process.env.MONGO_URL,
      databricksHttpPath: process.env.DATABRICKS_HTTP_PATH,
      databricksOptions: {
        httpPath: process.env.DATABRICKS_HTTP_PATH,
        schema: process.env.DATABRICKS_SCHEMA,
      },
    } : undefined;
    const { indexMap } = await Connector.initMetadata(cfg as ConnectorCfg);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(indexMap, null, 2)
        },
      ],
    };
  }
);

(async () => {
  // Start warmup in parallel with server connection
  const warmupPromise = warmupDatabricksConnection();
  
  await server.connect(new StdioServerTransport());
  
  // Warmup can continue in background
  warmupPromise.catch((e) => {
    console.warn("Databricks warmup failed:", e);
  });
})().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
