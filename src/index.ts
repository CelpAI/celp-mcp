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
async function runQuery(cfg: DbCfg, sql: string, params: any[] = []) {
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

/* ── Schema loader (identical logic to reference, trimmed comments) ─── */
async function loadSchema(cfg: DbCfg) {
  const schemaMap: any = {};
  const indexMap: any = {};

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
      const { rows } = await client.query(`
        SELECT table_name,column_name,data_type,is_nullable,column_default,character_maximum_length
        FROM information_schema.columns
        WHERE table_schema='public'
        ORDER BY table_name,ordinal_position
      `);
      rows.forEach((r: any) => {
        if (!schemaMap[r.table_name]) schemaMap[r.table_name] = { name: r.table_name, columns: [] };
        schemaMap[r.table_name].columns.push({
          name: r.column_name,
          type: r.data_type,
          nullable: r.is_nullable === "YES",
          defaultValue: r.column_default,
          maxLength: r.character_maximum_length,
        });
      });

      const { rows: idx } = await client.query(`
        SELECT t.relname table_name,i.relname index_name,a.attname column_name,
               ix.indisunique is_unique,ix.indisprimary is_primary
        FROM pg_class t, pg_class i, pg_index ix, pg_attribute a
        WHERE t.oid = ix.indrelid AND i.oid = ix.indexrelid
          AND a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
          AND t.relkind = 'r'
      `);
      idx.forEach((r: any) => {
        const k = `${r.table_name}.${r.index_name}`;
        if (!indexMap[k])
          indexMap[k] = { table: r.table_name, name: r.index_name, columns: [], isUnique: r.is_unique, isPrimary: r.is_primary };
        indexMap[k].columns.push(r.column_name);
      });
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
      const [cols]: any = await conn.query(`
        SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE,IS_NULLABLE,COLUMN_DEFAULT,CHARACTER_MAXIMUM_LENGTH
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,ORDINAL_POSITION
      `, [cfg.database]);
      cols.forEach((r: any) => {
        if (!schemaMap[r.TABLE_NAME]) schemaMap[r.TABLE_NAME] = { name: r.TABLE_NAME, columns: [] };
        schemaMap[r.TABLE_NAME].columns.push({
          name: r.COLUMN_NAME,
          type: r.DATA_TYPE,
          nullable: r.IS_NULLABLE === "YES",
          defaultValue: r.COLUMN_DEFAULT,
          maxLength: r.CHARACTER_MAXIMUM_LENGTH,
        });
      });

      const [idx]: any = await conn.query(`
        SELECT TABLE_NAME,INDEX_NAME,COLUMN_NAME,NON_UNIQUE
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX
      `, [cfg.database]);
      idx.forEach((r: any) => {
        const k = `${r.TABLE_NAME}.${r.INDEX_NAME}`;
        if (!indexMap[k])
          indexMap[k] = { table: r.TABLE_NAME, name: r.INDEX_NAME, columns: [], isUnique: r.NON_UNIQUE === 0, isPrimary: r.INDEX_NAME === "PRIMARY" };
        indexMap[k].columns.push(r.COLUMN_NAME);
      });
    } finally {
      await conn.end();
    }
  }
  return { schemaMap, indexMap };
}

/* ── Single orchestration roundtrip ─────────────────────────────────── */
async function orchestrate(prompt: string, cfg: DbCfg): Promise<string> {
  const serverUrl = process.env.STREAMING_API_URL || "https://celp-mcp-server.onrender.com";
  // const serverUrl = process.env.STREAMING_API_URL || "http://localhost:5006";
  const apiKey = process.env.CELP_API_KEY;
  const socket: Socket<DefaultEventsMap, DefaultEventsMap> = io(serverUrl, {
    auth: apiKey ? { token: apiKey } : undefined,
    extraHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  }); // identical to reference

  /* Prepare schema in the background */
  const schemaPromise = loadSchema(cfg);

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
      const { schemaMap, indexMap } = await schemaPromise;
      socket.emit("schema_info", { schemaMap, indexMap });

      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      socket.emit("orchestrate", { prompt, databaseType: cfg.databaseType, requestId });
    });
  });
}

/* ── MCP stdio server setup ─────────────────────────────────────────── */
const server = new McpServer({
  name: "celp-stdio",
  version: "1.3.0",
  capabilities: { resources: {}, tools: {} },
});

server.tool(
  "query-database",
  "Run queries against a database to answer user prompts, prioritizing accuracy and reasoning",
  { 
    prompt: z.string(),
    databaseConfig: z.object({
      databaseType: z.enum(["postgres", "mysql"]),
      host: z.string(),
      user: z.string(),
      password: z.string(),
      database: z.string(),
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
    const cfg: DbCfg =  databaseConfig || {
      databaseType: (process.env.DATABASE_TYPE as DbType) || "postgres",
      host: process.env.DATABASE_HOST || "localhost",
      user: process.env.DATABASE_USER || "root",
      password: process.env.DATABASE_PASSWORD || "",
      database: process.env.DATABASE_NAME || "test_db",
      port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
    };

    try {
      const md = await orchestrate(prompt, cfg);
      return { content: [{ type: "text", text: md }] };
    } catch (e: any) {
      console.error("query-database error:", e);
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  },
);
server.tool(
  "query-database-fast",
  "Run queries against a database to answer user prompts, prioritizing speed to completion. Use this for most cases instead of query-database. Unless the user prompt obviously requests a more complex analysis.",
  {
    prompt: z.string(),
    databaseConfig: z.object({
      databaseType: z.enum(["postgres", "mysql"]),
      host: z.string(),
      user: z.string(),
      password: z.string(),
      database: z.string(),
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
    const cfg: DbCfg =  databaseConfig || {
      databaseType: (process.env.DATABASE_TYPE as DbType) || "postgres",
      host: process.env.DATABASE_HOST || "localhost",
      user: process.env.DATABASE_USER || "root",
      password: process.env.DATABASE_PASSWORD || "",
      database: process.env.DATABASE_NAME || "test_db",
      port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
    };

    try {
      const md = await orchestrate(prompt, cfg);
      return { content: [{ type: "text", text: md }] };
    } catch (e: any) {
      console.error("query-database error:", e);
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  },
);
server.tool(
  "query-database-turbo",
  "Run queries against a database to answer user prompts, prioritizing speed to completion. Don't use this unless specifically preferred or requested by the user. ",
  {
    prompt: z.string(),
    databaseConfig: z.object({
      databaseType: z.enum(["postgres", "mysql"]),
      host: z.string(),
      user: z.string(),
      password: z.string(),
      database: z.string(),
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
    const cfg: DbCfg =  databaseConfig || {
      databaseType: (process.env.DATABASE_TYPE as DbType) || "postgres",
      host: process.env.DATABASE_HOST || "localhost",
      user: process.env.DATABASE_USER || "root",
      password: process.env.DATABASE_PASSWORD || "",
      database: process.env.DATABASE_NAME || "test_db",
      port: process.env.DATABASE_PORT ? parseInt(process.env.DATABASE_PORT, 10) : undefined,
    };

    try {
      const md = await orchestrate(prompt, cfg);
      return { content: [{ type: "text", text: md }] };
    } catch (e: any) {
      console.error("query-database error:", e);
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  },
);

(async () => {
  await server.connect(new StdioServerTransport());
})().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
