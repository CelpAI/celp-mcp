# Celp-MCP – Database & Analytics Server for the Model-Context-Protocol

> **TL;DR for LLMs**  
> *Connect via MCP **stdio** transport, call `initialize`, then use one of the four tools described below.*  
> Tools are **idempotent** and expect *structured JSON* arguments – never place credentials inside the `prompt` field.

---

## 1&nbsp;•&nbsp;What this server does

`celp-mcp` exposes **natural-language analytics over SQL, MongoDB and Databricks** warehouses to any **MCP-compatible client**.  
Internally it hosts a light agent that

1. maps NL questions → multi-step SQL / Mongo / Spark plans,  
2. executes those plans locally against the database (no data leaves the machine), and  
3. streams back **markdown reports** with tables, charts and findings.

The server follows the **Model-Context-Protocol (MCP)** 2025-03-26 spec and ships with the standard **stdio transport**.  
No network sockets are opened unless you start the optional remote streaming helper.

---

## 2&nbsp;•&nbsp;Exposed MCP tools

| Name | Purpose | Speed vs Reasoning | Required params |
|------|---------|--------------------|-----------------|
| `query-database` | High-fidelity multi-step analysis | ⭐ Accuracy | `prompt` *(string)*, optional `databaseConfig`, `databaseConnectionId`, `celpApiKey` |
| `query-database-turbo` | One-shot, single-query path | ⚡ Speed | same as above |
| `get-schema` | Return **schema map** the agent would use | – | same as above (all optional) |
| `get-index-map` | Return **index / key map** for optimisation | – | same as above (all optional) |

### 2.1 Tool argument schemas (abridged)
All four tools share the same optional `databaseConfig` object.  
```jsonc
{
  "databaseConfig": {
    "databaseType": "postgres | mysql | mongodb | databricks", // default from env
    "host": "string",
    "user": "string",
    "password": "string",  // never include in prompts!
    "database": "string",   // db / catalog / default schema
    "port": 5432,
    "disableSSL": "true | false",
    "mongoOptions": { … },
    "databricksOptions": { "httpPath": "…" }
  },
  "prompt": "Natural-language question to answer",
  "databaseConnectionId": "string        // optional Render-hosted ID",
  "celpApiKey": "string"                 // if env not set
}
```

Parameters are validated with `zod` before execution.  
If `process.env.DONT_USE_DB_ENVS !== "true"` you can omit `databaseConfig` entirely and rely on environment variables instead.

---

## 3&nbsp;•&nbsp;Quick-start for **MCP clients / LLM agents**

1. **Launch** the server:
   ```bash
   npx -y celp-mcp            # or: npm i -g celp-mcp && celp-mcp
   ```
2. **Initialize** via MCP:
   ```jsonc
   // Client → Server (stdio)
   { "id": 0, "jsonrpc": "2.0", "method": "initialize", "params": {"capabilities": {}} }
   ```
3. The server responds with its capabilities (tools list).  
4. **Call tools** using `call_tool` requests:
   ```jsonc
   {
     "id": 1,
     "jsonrpc": "2.0",
     "method": "call_tool",
     "params": {
       "name": "query-database-turbo",
       "arguments": {
         "prompt": "How many orders were placed yesterday?"
       }
     }
   }
   ```
5. Read streamed progress on `stderr`, final markdown arrives as the `result` field of the response.

> **Tool selection heuristic**: default to *turbo* when the user question can be answered by **one SELECT**; otherwise choose *query-database*.

---

## 4&nbsp;•&nbsp;Environment variables

Below is the **authoritative list** of variables the server reads at startup.  
You may provide them via shell, a `.env` file, or an `env` block inside your Claude / Cursor configuration.

| Variable | Applies to | Required | Description |
|----------|-----------|----------|-------------|
| `DATABASE_TYPE` | all | ✅ | `postgres`, `mysql`, `mongodb`, or `databricks` |
| `DATABASE_HOST` | sql / databricks | ✅ (unless using `MONGO_URL`) | Hostname or IP |
| `DATABASE_PORT` | sql |   | Defaults: 5432 / 3306 / 27017 |
| `DATABASE_USER` | sql / databricks | ✅ | Auth username (use `databricks` for DBX) |
| `DATABASE_PASSWORD` | sql | ✅ | Password for above user |
| `DATABASE_NAME` | sql / databricks | ✅ | Database (schema) / DBX catalog |
| `MONGO_URL` | mongodb |   | Full connection string – overrides the host/port variables |
| `MONGO_*` | mongodb |   | Fine-tune SSL, replica set, pool size etc. (see table below) |
| `DATABRICKS_HOST` | databricks | ✅ | Workspace hostname, e.g. `abcd.us-east-1.azuredatabricks.net` |
| `DATABRICKS_TOKEN` | databricks | ✅ | Personal-access token (goes into `password` field) |
| `DATABRICKS_HTTP_PATH` | databricks | ✅ | SQL warehouse http path (`/sql/1.0/warehouses/…`) |
| `DATABRICKS_PORT` | databricks |   | Defaults to 443 |
| `CELP_API_KEY` | all | ✅ | Key for the cloud-side orchestration API |
| `OPENAI_API_KEY` | optional |   | Only needed if you enable LLM sampling features |
| `PG_DISABLE_SSL` | postgres |   | Set `true` to connect without SSL |
| `DEBUG_LOGS` | all |   | `true` → verbose logging |

### 4.1 PostgreSQL & MySQL — minimal example
```bash
# .env
DATABASE_TYPE=postgres
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USER=readonly
DATABASE_PASSWORD=supersecret
DATABASE_NAME=analytics
CELP_API_KEY=sk-...
```
Equivalent **programmatic** `databaseConfig` object:
```jsonc
{
  "databaseType": "postgres",
  "host": "localhost",
  "user": "readonly",
  "password": "supersecret",
  "database": "analytics",
  "port": 5432
}
```

### 4.2 MongoDB
```bash
DATABASE_TYPE=mongodb
MONGO_URL=mongodb://analytics_user:pw@db1.example.com:27017/marketing?authSource=admin
CELP_API_KEY=sk-...

```
`mongoOptions` can be passed inline:
```jsonc
{
  "databaseType": "mongodb",
  "host": "db1.example.com",
  "user": "analytics_user",
  "password": "pw",
  "database": "marketing",
  "mongoOptions": {
    "authSource": "admin",
    "ssl": true,
    "readPreference": "primaryPreferred"
  }
}
```

### 4.3 Databricks SQL Warehouse
```bash
DATABASE_TYPE=databricks
DATABRICKS_HOST=adb-1234567890.2.azuredatabricks.net
DATABRICKS_TOKEN=dapiXXXXXXXXXXXXXXXX
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/0123456789abcdef
DATABRICKS_PORT=443               # optional
DATABRICKS_CATALOG=main           # becomes DATABASE_NAME internally
DATABASE_USER=databricks          # not actually used but required
CELP_API_KEY=sk-...
```
Programmatic form:
```jsonc
{
  "databaseType": "databricks",
  "host": "adb-1234567890.2.azuredatabricks.net",
  "user": "databricks",
  "password": "dapiXXXXXXXXXXXXXXXX",   // personal-access token
  "database": "main",                   // catalog / schema
  "databricksOptions": {
    "httpPath": "/sql/1.0/warehouses/0123456789abcdef"
  }
}
```

> **Tip** : set `DONT_USE_DB_ENVS=true` in the shell if you want the server to **ignore env vars** and rely solely on the `databaseConfig` you pass in each tool call.

---

## 5&nbsp;•&nbsp;Claude / Cursor integration recipes

Place the JSON block below in:
* **Claude Desktop →** `~/Library/Application Support/Claude/claude_desktop_config.json`
* **Cursor (VS Code) →** your *Settings JSON* or `.vscode/mcp.json`

### 5.1 PostgreSQL
```jsonc
{
  "mcpServers": {
    "celp-postgres": {
      "command": "npx",
      "args": ["-y", "celp-mcp"],
      "env": {
        "DATABASE_TYPE": "postgres",
        "DATABASE_HOST": "127.0.0.1",
        "DATABASE_PORT": "5432",
        "DATABASE_USER": "readonly",
        "DATABASE_PASSWORD": "supersecret",
        "DATABASE_NAME": "analytics",
        "PG_DISABLE_SSL": "true",
        "CELP_API_KEY": "sk-..."
      }
    }
  }
}
```

### 5.2 MySQL
```jsonc
{
  "mcpServers": {
    "celp-mysql": {
      "command": "npx",
      "args": ["-y", "celp-mcp"],
      "env": {
        "DATABASE_TYPE": "mysql",
        "DATABASE_HOST": "db.internal",
        "DATABASE_PORT": "3306",
        "DATABASE_USER": "readonly",
        "DATABASE_PASSWORD": "pw",
        "DATABASE_NAME": "ecommerce",
        "CELP_API_KEY": "sk-..."
      }
    }
  }
}
```

### 5.3 MongoDB (connection-string form)
```jsonc
{
  "mcpServers": {
    "celp-mongo": {
      "command": "npx",
      "args": ["-y", "celp-mcp"],
      "env": {
        "DATABASE_TYPE": "mongodb",
        "MONGO_URL": "mongodb://analytics_user:pw@db1.example.com:27017/marketing?authSource=admin&ssl=true",
        "CELP_API_KEY": "sk-..."
      }
    }
  }
}
```

### 5.4 Databricks SQL Warehouse
```jsonc
{
  "mcpServers": {
    "celp-dbx": {
      "command": "npx",
      "args": ["-y", "celp-mcp"],
      "env": {
        "DATABASE_TYPE": "databricks",
        "DATABRICKS_HOST": "adb-1234567890.2.azuredatabricks.net",
        "DATABRICKS_TOKEN": "dapiXXXXXXXXXXXXXXXX",
        "DATABRICKS_HTTP_PATH": "/sql/1.0/warehouses/0123456789abcdef",
        "DATABRICKS_CATALOG": "main",
        "CELP_API_KEY": "sk-..."
      }
    }
  }
}
```

> **After saving**, restart Claude / Cursor. The server will be launched on demand and the four tools will be advertised to the language model automatically.

---

## 6&nbsp;•&nbsp;Advanced usage & orchestration API

`query-database*` tools ultimately send work to an **LLM-driven orchestration service** at
`https://celp-mcp-server.onrender.com`.  
To override (e.g., when self-hosting) set `STREAMING_API_URL`.

The path `src/index.ts::orchestrate` shows the full client–socket workflow, including
schema pre-upload and incremental chunk handling. Feel free to reuse it for custom front-ends.

---

## 7&nbsp;•&nbsp;Security & privacy

* All SQL / Mongo / Spark queries run **locally**.  
* The orchestration service only receives generated SQL, never raw data.  
* Credentials are kept in the process env, never serialized over MCP or sockets.

For production deployments we recommend:

1. Provision a **read-only DB user**.
2. Restrict network access to the DB port.
3. Rotate `CELP_API_KEY` regularly.
4. Audit agent prompts to avoid prompt-injection.

---

## 8&nbsp;•&nbsp;Development

```bash
git clone https://github.com/your-org/mcp-server.git
cd mcp-server
pnpm install
pnpm build && pnpm start              # runs built JS
pnpm dev                               # ts-node + watch
```

The main entry point is [`src/index.ts`](./src/index.ts).  
Tool definitions live in [`src/initTools.ts`](./src/initTools.ts).

---

## 9&nbsp;•&nbsp;License

Released under the **MIT License** – see [`LICENSE`](./LICENSE) for full text.
