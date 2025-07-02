"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
// Initialize tools for OpenAI function calling without starting MCP server
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const zod_1 = require("zod");
const toolRegistry_1 = require("./toolRegistry");
const index_1 = require("./index");
const Connector = __importStar(require("./connector"));
const socket_io_client_1 = require("socket.io-client");
require("dotenv").config();
// Create a dummy server just for registering tools
const dummyServer = new mcp_js_1.McpServer({
    name: "celp-tools",
    version: "1.0.0",
    description: "Tools for OpenAI function calling",
    capabilities: { resources: {}, tools: {} },
});
// Register all tools
(0, toolRegistry_1.registerTool)(dummyServer, "query-database", `# Data Analyst Agent: Reasoning Analysis Mode

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
`, {
    prompt: zod_1.z.string(),
    databaseConfig: zod_1.z.object({
        databaseType: zod_1.z.enum(["postgres", "mysql"]).optional(),
        host: zod_1.z.string().optional(),
        user: zod_1.z.string().optional(),
        password: zod_1.z.string().optional(),
        database: zod_1.z.string().optional(),
        port: zod_1.z.number().optional(),
        disableSSL: zod_1.z.enum(["true", "false"]).optional(),
        mongoOptions: zod_1.z.object({
            authSource: zod_1.z.string().optional(),
            ssl: zod_1.z.boolean().optional(),
            replicaSet: zod_1.z.string().optional(),
            readPreference: zod_1.z.enum(["primary", "secondary", "primaryPreferred", "secondaryPreferred", "nearest"]).optional(),
            maxPoolSize: zod_1.z.number().optional(),
            serverSelectionTimeoutMS: zod_1.z.number().optional(),
            connectTimeoutMS: zod_1.z.number().optional(),
        }).optional(),
    }).optional(),
    celpApiKey: zod_1.z.string().optional(),
    databaseConnectionId: zod_1.z.string().optional(),
}, async (args) => {
    const { prompt, databaseConfig: databaseConfigRaw, databaseConnectionId, celpApiKey } = args;
    let databaseConfig;
    if (process.env.DONT_USE_DB_ENVS === "true") {
        databaseConfig = databaseConfigRaw;
    }
    const cfg = databaseConfig || (process.env.DONT_USE_DB_ENVS !== "true") ? {
        databaseType: process.env.DATABASE_TYPE,
        host: process.env.DATABASE_HOST || "localhost",
        user: process.env.DATABASE_USER || "postgres",
        password: process.env.DATABASE_PASSWORD || "postgres",
        database: process.env.DATABASE_NAME || "test_db",
        port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
        mongoOptions: {
            authSource: process.env.MONGO_AUTH_SOURCE || 'admin',
            ssl: process.env.MONGO_SSL === 'true',
            replicaSet: process.env.MONGO_REPLICA_SET,
            readPreference: process.env.MONGO_READ_PREFERENCE,
            maxPoolSize: process.env.MONGO_MAX_POOL_SIZE ? parseInt(process.env.MONGO_MAX_POOL_SIZE, 10) : 10,
            serverSelectionTimeoutMS: process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS ? parseInt(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS, 10) : 5000,
            connectTimeoutMS: process.env.MONGO_CONNECT_TIMEOUT_MS ? parseInt(process.env.MONGO_CONNECT_TIMEOUT_MS, 10) : 10000,
        },
    } : undefined;
    if ((process.env.DONT_USE_DB_ENVS === "true" && !celpApiKey) || (process.env.DONT_USE_DB_ENVS !== "true" && !process.env.CELP_API_KEY)) {
        throw new Error("No API key provided");
    }
    try {
        const md = await (0, index_1.orchestrate)(prompt, process.env.DONT_USE_DB_ENVS === "true" ? celpApiKey : process.env.CELP_API_KEY, databaseConnectionId, cfg, 'reasoning');
        return { content: [{ type: "text", text: md }] };
    }
    catch (e) {
        console.error("query-database error:", e);
        return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
});
(0, toolRegistry_1.registerTool)(dummyServer, "query-database-turbo", `### **When to Use (Natural-Language Heuristics)**

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

> **Quick mental check**: *Could you answer this with a single short sentence and a single‐line SQL query template?*
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
* "What is the average session length today?"`, {
    prompt: zod_1.z.string(),
    databaseConfig: zod_1.z.object({
        databaseType: zod_1.z.enum(["postgres", "mysql", "mongodb"]).optional(),
        host: zod_1.z.string().optional(),
        user: zod_1.z.string().optional(),
        password: zod_1.z.string().optional(),
        database: zod_1.z.string().optional(),
        port: zod_1.z.number().optional(),
        disableSSL: zod_1.z.enum(["true", "false"]).optional(),
        mongoOptions: zod_1.z.object({
            authSource: zod_1.z.string().optional(),
            ssl: zod_1.z.boolean().optional(),
            replicaSet: zod_1.z.string().optional(),
            readPreference: zod_1.z.enum(["primary", "secondary", "primaryPreferred", "secondaryPreferred", "nearest"]).optional(),
            maxPoolSize: zod_1.z.number().optional(),
            serverSelectionTimeoutMS: zod_1.z.number().optional(),
            connectTimeoutMS: zod_1.z.number().optional(),
        }).optional(),
    }).optional(),
    databaseConnectionId: zod_1.z.string().optional(),
    celpApiKey: zod_1.z.string().optional(),
}, async (args) => {
    const { prompt, databaseConfig: databaseConfigRaw, databaseConnectionId, celpApiKey } = args;
    let databaseConfig;
    if (process.env.DONT_USE_DB_ENVS === "true") {
        databaseConfig = databaseConfigRaw;
    }
    const cfg = databaseConfig || (process.env.DONT_USE_DB_ENVS !== "true") ? {
        databaseType: process.env.DATABASE_TYPE,
        host: process.env.DATABASE_HOST || "localhost",
        user: process.env.DATABASE_USER || "postgres",
        password: process.env.DATABASE_PASSWORD || "postgres",
        database: process.env.DATABASE_NAME || "test_db",
        port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
        mongoOptions: {
            authSource: process.env.MONGO_AUTH_SOURCE || 'admin',
            ssl: process.env.MONGO_SSL === 'true',
            replicaSet: process.env.MONGO_REPLICA_SET,
            readPreference: process.env.MONGO_READ_PREFERENCE,
            maxPoolSize: process.env.MONGO_MAX_POOL_SIZE ? parseInt(process.env.MONGO_MAX_POOL_SIZE, 10) : 10,
            serverSelectionTimeoutMS: process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS ? parseInt(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS, 10) : 5000,
            connectTimeoutMS: process.env.MONGO_CONNECT_TIMEOUT_MS ? parseInt(process.env.MONGO_CONNECT_TIMEOUT_MS, 10) : 10000,
        },
    } : undefined;
    if ((process.env.DONT_USE_DB_ENVS === "true" && !celpApiKey) || (process.env.DONT_USE_DB_ENVS !== "true" && !process.env.CELP_API_KEY)) {
        throw new Error("No API key provided");
    }
    try {
        const md = await (0, index_1.orchestrate)(prompt, process.env.DONT_USE_DB_ENVS === "true" ? celpApiKey : process.env.CELP_API_KEY, databaseConnectionId, cfg, 'turbo');
        return { content: [{ type: "text", text: md }] };
    }
    catch (e) {
        console.error("query-database error:", e);
        return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
});
(0, toolRegistry_1.registerTool)(dummyServer, "get-schema", `
  Returns the schema map for the database. Only use this tool after previous attempts fail, or when specifically requested
`, {
    databaseConfig: zod_1.z.object({
        databaseType: zod_1.z.enum(["postgres", "mysql", "mongodb"]).optional(),
        host: zod_1.z.string().optional(),
        user: zod_1.z.string().optional(),
        password: zod_1.z.string().optional(),
        database: zod_1.z.string().optional(),
        port: zod_1.z.number().optional(),
        disableSSL: zod_1.z.enum(["true", "false"]).optional()
    }).optional(),
    apiKey: zod_1.z.string().optional(),
    databaseConnectionId: zod_1.z.string().optional(),
    databricksOptions: zod_1.z.object({
        httpPath: zod_1.z.string().optional(),
    }).optional(),
    databricksHttpPath: zod_1.z.string().optional(),
}, async ({ databaseConfig: databaseConfigRaw, apiKey, databaseConnectionId }) => {
    if (apiKey && databaseConnectionId) {
        const serverUrl = process.env.STREAMING_API_URL || "https://celp-mcp-server.onrender.com";
        const socket = (0, socket_io_client_1.io)(serverUrl, {
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
                }
                else {
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
    let databaseConfig;
    if (process.env.DONT_USE_DB_ENVS === "true") {
        databaseConfig = databaseConfigRaw;
    }
    const cfg = databaseConfig || (process.env.DONT_USE_DB_ENVS !== "true") ? {
        databaseType: process.env.DATABASE_TYPE,
        host: process.env.DATABASE_HOST || "localhost",
        user: process.env.DATABASE_USER || "postgres",
        password: process.env.DATABASE_PASSWORD || "postgres",
        database: process.env.DATABASE_NAME || "test_db",
        port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
        mongoOptions: {
            authSource: process.env.MONGO_AUTH_SOURCE || 'admin',
            ssl: process.env.MONGO_SSL === 'true',
            replicaSet: process.env.MONGO_REPLICA_SET,
            readPreference: process.env.MONGO_READ_PREFERENCE,
            maxPoolSize: process.env.MONGO_MAX_POOL_SIZE ? parseInt(process.env.MONGO_MAX_POOL_SIZE, 10) : 10,
            serverSelectionTimeoutMS: process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS ? parseInt(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS, 10) : 5000,
            connectTimeoutMS: process.env.MONGO_CONNECT_TIMEOUT_MS ? parseInt(process.env.MONGO_CONNECT_TIMEOUT_MS, 10) : 10000,
        },
    } : undefined;
    const { schemaMap } = await Connector.initMetadata(cfg);
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(schemaMap, null, 2)
            },
        ],
    };
});
(0, toolRegistry_1.registerTool)(dummyServer, "get-index-map", `
  Returns the index map for the database. Only use this tool after previous attempts fail, or when specifically requested
`, {
    databaseConfig: zod_1.z.object({
        databaseType: zod_1.z.enum(["postgres", "mysql", "mongodb"]).optional(),
        host: zod_1.z.string().optional(),
        user: zod_1.z.string().optional(),
        password: zod_1.z.string().optional(),
        database: zod_1.z.string().optional(),
        port: zod_1.z.number().optional(),
        disableSSL: zod_1.z.enum(["true", "false"]).optional(),
    }).optional(),
    apiKey: zod_1.z.string().optional(),
    databaseConnectionId: zod_1.z.string().optional(),
}, async ({ databaseConfig: databaseConfigRaw, apiKey, databaseConnectionId }) => {
    if (apiKey && databaseConnectionId) {
        const serverUrl = process.env.STREAMING_API_URL || "https://celp-mcp-server.onrender.com";
        const socket = (0, socket_io_client_1.io)(serverUrl, {
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
                }
                else {
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
    let databaseConfig;
    if (process.env.DONT_USE_DB_ENVS === "true") {
        databaseConfig = databaseConfigRaw;
    }
    const cfg = databaseConfig || (process.env.DONT_USE_DB_ENVS !== "true") ? {
        databaseType: process.env.DATABASE_TYPE,
        host: process.env.DATABASE_HOST || "localhost",
        user: process.env.DATABASE_USER || "postgres",
        password: process.env.DATABASE_PASSWORD || "postgres",
        database: process.env.DATABASE_NAME || "test_db",
        port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
        mongoOptions: {
            authSource: process.env.MONGO_AUTH_SOURCE || 'admin',
            ssl: process.env.MONGO_SSL === 'true',
            replicaSet: process.env.MONGO_REPLICA_SET,
            readPreference: process.env.MONGO_READ_PREFERENCE,
            maxPoolSize: process.env.MONGO_MAX_POOL_SIZE ? parseInt(process.env.MONGO_MAX_POOL_SIZE, 10) : 10,
            serverSelectionTimeoutMS: process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS ? parseInt(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS, 10) : 5000,
            connectTimeoutMS: process.env.MONGO_CONNECT_TIMEOUT_MS ? parseInt(process.env.MONGO_CONNECT_TIMEOUT_MS, 10) : 10000,
        },
    } : undefined;
    const { indexMap } = await Connector.initMetadata(cfg);
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(indexMap, null, 2)
            },
        ],
    };
});
