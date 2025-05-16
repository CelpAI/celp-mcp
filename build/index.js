#!/usr/bin/env node
"use strict";
/**
 * celp‑stdio MCP server —— faithful port of the reference AnalysisClient
 */
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
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const zod_1 = require("zod");
const socket_io_client_1 = require("socket.io-client");
const pg_1 = require("pg");
const promise_1 = require("mysql2/promise");
const Connector = __importStar(require("./connector"));
require("dotenv").config();
const DEBUG = process.env.DEBUG_LOGS === "true";
const log = (...a) => DEBUG && console.log(...a);
/* ── DB query executor (unchanged from reference) ───────────────────── */
async function runQuery(cfg, sql, params = []) {
    if (cfg.databaseType === "postgres") {
        const client = new pg_1.Client({
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
        }
        finally {
            await client.end();
        }
    }
    else {
        const conn = await (0, promise_1.createConnection)({
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
    }
}
/* ── Single orchestration roundtrip ─────────────────────────────────── */
async function orchestrate(prompt, cfg) {
    const serverUrl = process.env.STREAMING_API_URL || "https://celp-mcp-server.onrender.com";
    // const serverUrl = process.env.STREAMING_API_URL || "http://localhost:5006";
    const apiKey = process.env.CELP_API_KEY;
    const socket = (0, socket_io_client_1.io)(serverUrl, {
        auth: apiKey ? { token: apiKey } : undefined,
        extraHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    }); // identical to reference
    /* Prepare schema in the background */
    return new Promise((resolve, reject) => {
        let finalMarkdown = "";
        socket.on("connect_error", (e) => {
            socket.disconnect();
            reject(new Error(`Socket error: ${e.message}`));
        });
        /* 1. handle DB query requests */
        socket.on("query_request", async ({ queryId, sql, params }) => {
            log("query_request", queryId);
            try {
                const result = await runQuery(cfg, sql, params);
                socket.emit("query_result", { queryId, result });
            }
            catch (e) {
                socket.emit("query_result", { queryId, error: e.message });
            }
        });
        /* 2. handle streaming orchestration messages */
        socket.on("orchestration_chunk", ({ chunk }) => {
            if (chunk?.type === "summary")
                log("summary", chunk.text);
            if (chunk?.type === "final")
                finalMarkdown = chunk.markdown ?? "";
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
            const { schemaMap, indexMap } = await Connector.initMetadata(cfg);
            // console.log(`CLI: Loaded schema with ${Object.keys(schemaMap).length} tables`);
            socket.emit("schema_info", { schemaMap, indexMap });
            const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            socket.emit("orchestrate", { prompt, databaseType: cfg.databaseType, requestId, apiKey });
        });
    });
}
/* ── MCP stdio server setup ─────────────────────────────────────────── */
const server = new mcp_js_1.McpServer({
    name: "celp-stdio",
    version: "1.3.0",
    capabilities: { resources: {}, tools: {} },
});
server.tool("query-database", "## Purpose: Run queries against a database to answer user prompts, prioritizing accuracy and reasoning\n\n## Restrictions:\n- Don't sent database credentials in the payload, it's handled by the server.\n- Don't sent API keys in the payload, it's handled by the server.", {
    prompt: zod_1.z.string(),
    databaseConfig: zod_1.z.object({
        databaseType: zod_1.z.enum(["postgres", "mysql"]),
        host: zod_1.z.string(),
        user: zod_1.z.string(),
        password: zod_1.z.string(),
        database: zod_1.z.string(),
        port: zod_1.z.number().optional(),
        disableSSL: zod_1.z.enum(["true", "false"]).optional(),
    }).optional(),
    celpApiKey: zod_1.z.string().optional(),
}, async ({ prompt, databaseConfig, celpApiKey }) => {
    if (databaseConfig) {
        process.env.PG_DISABLE_SSL = databaseConfig.disableSSL === "true" ? "true" : "false";
        process.env.MYSQL_SSL = databaseConfig.disableSSL === "true" ? "false" : "true";
    }
    if (celpApiKey) {
        process.env.CELP_API_KEY = celpApiKey;
    }
    const cfg = databaseConfig || {
        databaseType: process.env.DATABASE_TYPE || "postgres",
        host: process.env.DATABASE_HOST || "localhost",
        user: process.env.DATABASE_USER || "root",
        password: process.env.DATABASE_PASSWORD || "",
        database: process.env.DATABASE_NAME || "test_db",
        port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
    };
    try {
        const md = await orchestrate(prompt, cfg);
        return { content: [{ type: "text", text: md }] };
    }
    catch (e) {
        console.error("query-database error:", e);
        return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
});
server.tool("query-database-fast", "## Purpose: Run queries against a database to answer user prompts, prioritizing speed to completion. Use this for most cases instead of query-database. Unless the user prompt obviously requests a more complex analysis.\n\n## Restrictions:\n- Don't sent database credentials in the payload, it's handled by the server.\n- Don't sent API keys in the payload, it's handled by the server.", {
    prompt: zod_1.z.string(),
    databaseConfig: zod_1.z.object({
        databaseType: zod_1.z.enum(["postgres", "mysql"]),
        host: zod_1.z.string(),
        user: zod_1.z.string(),
        password: zod_1.z.string(),
        database: zod_1.z.string(),
        port: zod_1.z.number().optional(),
        disableSSL: zod_1.z.enum(["true", "false"]).optional(),
    }).optional(),
    celpApiKey: zod_1.z.string().optional(),
}, async ({ prompt, databaseConfig, celpApiKey }) => {
    if (databaseConfig) {
        process.env.PG_DISABLE_SSL = databaseConfig.disableSSL === "true" ? "true" : "false";
        process.env.MYSQL_SSL = databaseConfig.disableSSL === "true" ? "false" : "true";
    }
    if (celpApiKey) {
        process.env.CELP_API_KEY = celpApiKey;
    }
    const cfg = databaseConfig || {
        databaseType: process.env.DATABASE_TYPE || "postgres",
        host: process.env.DATABASE_HOST || "localhost",
        user: process.env.DATABASE_USER || "root",
        password: process.env.DATABASE_PASSWORD || "",
        database: process.env.DATABASE_NAME || "test_db",
        port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
    };
    try {
        const md = await orchestrate(prompt, cfg);
        return { content: [{ type: "text", text: md }] };
    }
    catch (e) {
        console.error("query-database error:", e);
        return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
});
server.tool("query-database-turbo", "## Purpose: Run queries against a database to answer user prompts, prioritizing speed to completion. Don't use this unless specifically preferred or requested by the user.\n\n## Restrictions:\n- Don't sent database credentials in the payload, it's handled by the server..\n- Don't sent API keys in the payload, it's handled by the server.", {
    prompt: zod_1.z.string(),
    databaseConfig: zod_1.z.object({
        databaseType: zod_1.z.enum(["postgres", "mysql"]),
        host: zod_1.z.string(),
        user: zod_1.z.string(),
        password: zod_1.z.string(),
        database: zod_1.z.string(),
        port: zod_1.z.number().optional(),
        disableSSL: zod_1.z.enum(["true", "false"]).optional(),
    }).optional(),
    celpApiKey: zod_1.z.string().optional(),
}, async ({ prompt, databaseConfig, celpApiKey }) => {
    if (databaseConfig) {
        process.env.PG_DISABLE_SSL = databaseConfig.disableSSL === "true" ? "true" : "false";
        process.env.MYSQL_SSL = databaseConfig.disableSSL === "true" ? "false" : "true";
    }
    if (celpApiKey) {
        process.env.CELP_API_KEY = celpApiKey;
    }
    const cfg = databaseConfig || {
        databaseType: process.env.DATABASE_TYPE || "postgres",
        host: process.env.DATABASE_HOST || "localhost",
        user: process.env.DATABASE_USER || "root",
        password: process.env.DATABASE_PASSWORD || "",
        database: process.env.DATABASE_NAME || "test_db",
        port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
    };
    try {
        const md = await orchestrate(prompt, cfg);
        return { content: [{ type: "text", text: md }] };
    }
    catch (e) {
        console.error("query-database error:", e);
        return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
});
(async () => {
    await server.connect(new stdio_js_1.StdioServerTransport());
})().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
});
