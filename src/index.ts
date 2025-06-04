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

require("dotenv").config();

/* ── Helper types ───────────────────────────────────────────────────── */
type DbType = "postgres" | "mysql";
interface DbCfg {
  databaseType: DbType;
  host: string;
  user: string;
  password: string;
  database: string;
  port?: number;
}

const DEBUG = process.env.DEBUG_LOGS === "true";
const log = (...a: any[]) => DEBUG && console.log(...a);

/* ── DB query executor (unchanged from reference) ───────────────────── */
export async function runQuery(cfg: DbCfg, sql: string, params: any[] = []) {
  if (cfg.databaseType === "postgres") {
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
export async function orchestrate(prompt: string, cfg?: DbCfg, mode: 'turbo' | 'reasoning' = 'turbo', databaseConnectionId?: string): Promise<string> {
  // const serverUrl = process.env.STREAMING_API_URL || "https://celp-mcp-server.onrender.com";
  const serverUrl = process.env.STREAMING_API_URL || "http://localhost:5006";
  const apiKey = process.env.CELP_API_KEY;
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
      try {
        if (!cfg) {
          throw new Error("No database configuration provided");
        }
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
      if (cfg && !databaseConnectionId) {
        const { schemaMap, indexMap } = await Connector.initMetadata(cfg);
        // console.log(`CLI: Loaded schema with ${Object.keys(schemaMap).length} tables`);
        socket.emit("schema_info", { schemaMap, indexMap });
      }else {
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

server.tool(
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
    }).optional(),
    celpApiKey: z.string().optional(),
  },
  async ({ prompt, databaseConfig, celpApiKey }) => {
    if (databaseConfig) {
      process.env.PG_DISABLE_SSL = databaseConfig.disableSSL === "true" ? "true" : "false";
      process.env.MYSQL_SSL = databaseConfig.disableSSL === "true" ? "false" : "true";
    }
    if (celpApiKey) {
      process.env.CELP_API_KEY = celpApiKey;
    }
    let cfg: DbCfg;
    if (databaseConfig) {
      cfg = {
        databaseType: databaseConfig.databaseType as DbType,
        host: databaseConfig.host || "localhost",
        user: databaseConfig.user || "root",
        password: databaseConfig.password || "",
        database: databaseConfig.database || "test_db",
        port: databaseConfig.port,
      };
    } else {
      cfg = {
        databaseType: (process.env.DATABASE_TYPE as DbType) || "postgres",
        host: process.env.DATABASE_HOST || "localhost",
        user: process.env.DATABASE_USER || "root",
        password: process.env.DATABASE_PASSWORD || "",
        database: process.env.DATABASE_NAME || "test_db",
        port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
      };
    }

    try {
      const md = await orchestrate(prompt, cfg, 'reasoning', process.env.DATABASE_CONNECTION_ID);
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
server.tool(
  "query-database-turbo",
  `### **When to Use (Natural-Language Heuristics)**

Because the model sees only the *user’s question* and minimal schema hints, Turbo Mode should activate automatically **whenever the request exhibits every one of these surface-level cues**.  Each cue corresponds to a first-principles driver of SQL complexity that the model *can* infer without deep schema knowledge:

| Signal in the User’s Question                                                                                                   | Why It Indicates Turbo Is Safe                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Single Factual Verb** — verbs like “count,” “list,” “show,” “sum,” “average,” or “max/min,” used **once**.                    | One aggregate or projection keeps the SQL to a single \`SELECT\`.                                     |
| **At Most One Qualifier Clause** — a lone filter such as a date range, status, or simple equality (“where status = ‘active’”).  | Few filters avoid nested logic or subqueries.                                                       |
| **No Comparative Language** — absent words like “versus,” “compare,” “trend,” “change over time,” “prior year,” “by each,” etc. | Comparisons imply multiple groupings, time windows, or self-joins.                                  |
| **No Multi-Dimensional Grouping Phrases** — avoids “by region and product,” “per user per month,” “split across categories.”    | Multiple dimensions require complex \`GROUP BY\` and often joins.                                     |
| **Mentions One Table-Like Concept** — either explicitly (“in \`orders\`”) or implicitly (“orders today,” “users last week”).      | Referencing several entities hints at join logic the model can’t verify quickly.                    |
| **Requests Raw IDs or a Small Top-N List** — e.g., “give me the top 5 order IDs.”                                               | The result set will be tiny, so execution latency is dominated by query planning—not data transfer. |
| **No Need for Explanation or Visualization** — the user asks only for the numbers or rows, not “explain why” or “graph this.”   | Generating narrative or charts costs tokens and time; Turbo avoids it.                              |

> **Quick mental check**: *Could you answer this with a single short sentence and a single‐line SQL query template?*
> If yes, Turbo Mode is appropriate.

---

### Limitations

* Unsuitable for multi-step or exploratory workflows
* May miss domain nuances captured in the standard reasoning path
* Provides limited explanation and simplistic visuals

---

### Effective Prompts

* “How many active users signed up last week?”
* “List the five most expensive orders.”
* “Show the total revenue for March 2025.”
* “What is the average session length today?”`,
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
    }).optional(),
    databaseConnectionId: z.string().optional(),
    celpApiKey: z.string().optional(),
  },
  async (args) => {
    const { prompt, databaseConfig, databaseConnectionId, celpApiKey } = args;
    console.log({args})
    if (databaseConfig) {
      process.env.PG_DISABLE_SSL = databaseConfig.disableSSL === "true" ? "true" : "false";
      process.env.MYSQL_SSL = databaseConfig.disableSSL === "true" ? "false" : "true";
    }
    if (celpApiKey) {
      process.env.CELP_API_KEY = celpApiKey;
    }
    if (databaseConnectionId) {
      process.env.DATABASE_CONNECTION_ID = databaseConnectionId;
    }
    let cfg: DbCfg | undefined;
    if (databaseConfig) {
      cfg = {
        databaseType: databaseConfig.databaseType as DbType,
        host: databaseConfig.host || "localhost",
        user: databaseConfig.user || "root",
        password: databaseConfig.password || "",
        database: databaseConfig.database || "test_db",
        port: databaseConfig.port,
      };
    } 

    // const cfg: DbCfg = databaseConfig || {
    //   databaseType: (process.env.DATABASE_TYPE as DbType) || "postgres",
    //   host: process.env.DATABASE_HOST || "localhost",
    //   user: process.env.DATABASE_USER || "root",
    //   password: process.env.DATABASE_PASSWORD || "",
    //   database: process.env.DATABASE_NAME || "test_db",
    // port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
    // };

    try {
      const md = await orchestrate(prompt, process.env.DATABASE_CONNECTION_ID ? undefined : cfg, 'turbo', process.env.DATABASE_CONNECTION_ID);
      return { content: [{ type: "text", text: md }] };
    } catch (e: any) {
      console.error("query-database error:", e);
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  },
);

server.tool(
  "get-schema",
  `
  Returns the schema map for the database. Only use this tool after previous attempts fail, or when specifically requested
`,
  {
    databaseConfig: z.object({
      databaseType: z.enum(["postgres", "mysql"]).optional(),
      host: z.string().optional(),
      user: z.string().optional(),
      password: z.string().optional(),
      database: z.string().optional(),
      port: z.number().optional(),
      disableSSL: z.enum(["true", "false"]).optional(),
    }).optional()
  },
  async (args, ctx) => {
    // console.log({args, ctx})
    console.log('attempting to get schema for')
    // if (process.env.CELP_API_KEY) {
    //   console.log('CELP_API_KEY2', process.env.CELP_API_KEY);
    //   console.log('DATABASE_CONNECTION_ID', process.env.DATABASE_CONNECTION_ID);
    //   process.exit(0);
    // }
    if(/*!cfg.host && */process.env.CELP_API_KEY && process.env.DATABASE_CONNECTION_ID){
    // Proxy to streaming API when using remote database connection
    const serverUrl = process.env.STREAMING_API_URL || "http://localhost:5006";
    const apiKey = process.env.CELP_API_KEY;
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
          databaseConnectionId: process.env.DATABASE_CONNECTION_ID,
          apiKey
        });
      });
    });
    }
    const cfg = args.databaseConfig || {
      databaseType: "postgres",
      host: process.env.DATABASE_HOST || "localhost",
      user: process.env.DATABASE_USER || "root",
      password: process.env.DATABASE_PASSWORD || "",
      database: process.env.DATABASE_NAME || "test_db",
      port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
    };
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

server.tool(
  "get-index-map",
  `
  Returns the index map for the database. Only use this tool after previous attempts fail, or when specifically requested
`,
  {
    databaseConfig: z.object({
      databaseType: z.enum(["postgres", "mysql"]).optional(),
      host: z.string().optional(),
      user: z.string().optional(),
      password: z.string().optional(),
      database: z.string().optional(),
      port: z.number().optional(),
      disableSSL: z.enum(["true", "false"]).optional(),
    }).optional()
  },
  async ({ databaseConfig }) => {
    console.log('attempting to get index map for')
    if(process.env.CELP_API_KEY && process.env.DATABASE_CONNECTION_ID){
      const serverUrl = process.env.STREAMING_API_URL || "http://localhost:5006";
      const apiKey = process.env.CELP_API_KEY;
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
            databaseConnectionId: process.env.DATABASE_CONNECTION_ID,
            apiKey
          });
        });
      });
    }

    if (process.env.CELP_API_KEY && process.env.DATABASE_CONNECTION_ID) {
      // Proxy to streaming API when using remote database connection
      const serverUrl = process.env.STREAMING_API_URL || "http://localhost:5006";
      const apiKey = process.env.CELP_API_KEY;
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
            databaseConnectionId: process.env.DATABASE_CONNECTION_ID,
            apiKey
          });
        });
      });
    }
    const cfg = databaseConfig || {
      databaseType: "postgres",
      host: process.env.DATABASE_HOST || "localhost",
      user: process.env.DATABASE_USER || "postgres",
      password: process.env.DATABASE_PASSWORD || "postgres",
      database: process.env.DATABASE_NAME || "test_db",
      port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
    };
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
  await server.connect(new StdioServerTransport());
})().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
