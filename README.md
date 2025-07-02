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

---

## 3&nbsp;•&nbsp;Plug-and-play usage

For most users **no manual JSON-RPC calls are necessary**. Any modern MCP client (Claude Desktop, Cursor, `@modelcontextprotocol/sdk`, etc.) will:

1. Spawn the server as a subprocess via the command provided in your config (see Section 5).
2. Negotiate the MCP handshake automatically.
3. Surface the four tools (`query-database`, `query-database-turbo`, `get-schema`, `get-index-map`) to the language model.

All you have to supply are

* the **command & args** (usually `npx -y celp-mcp`), and
* the **environment variables** for your database + `CELP_API_KEY`.

If you are building a **custom MCP client** and need low-level details (e.g. raw `initialize` / `call_tool` payloads), see the annotated code in [`src/index.ts`](./src/index.ts) or the official protocol docs at <https://modelcontextprotocol.io>.

---

## 4&nbsp;•&nbsp;Essential environment variables

At minimum the process needs:

| Database | Required vars |
|----------|---------------|
| Postgres/MySQL | `DATABASE_TYPE` · `DATABASE_HOST` · `DATABASE_USER` · `DATABASE_PASSWORD` · `DATABASE_NAME` |
| MongoDB  | Either the five above **or** a single `MONGO_URL` |
| Databricks | `DATABASE_TYPE=databricks` · `DATABRICKS_HOST` · `DATABRICKS_TOKEN` · `DATABRICKS_HTTP_PATH` · `DATABRICKS_CATALOG` |

And for **every** setup:

* `CELP_API_KEY` – authorises the orchestration backend.

That's all an MCP client must supply.  
See **docs/ADVANCED.md** if you want SSL flags, replica-set tuning, debug logging, etc.

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
`https://celp-celp-mcp.onrender.com`.  
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
git clone https://github.com/CelpAI/celp-mcp.git
cd celp-mcp
pnpm install
pnpm build && pnpm start              # runs built JS
pnpm dev                               # ts-node + watch
```

The main entry point is [`src/index.ts`](./src/index.ts).  
Tool definitions live in [`src/initTools.ts`](./src/initTools.ts).

---

## 9&nbsp;•&nbsp;License

Released under the **MIT License** – see [`LICENSE`](./LICENSE) for full text.
