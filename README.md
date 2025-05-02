# MCP Database Query Server

A server that connects to databases and runs natural language queries through LLM planning and execution.

## Features

- Supports both MySQL and PostgreSQL databases
- Multi-schema support for PostgreSQL databases (automatically detects and uses all available schemas)
- Detailed logging for debugging when enabled
- Handles large tables through partitioning
- Provides markdown-formatted results

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_HOST` | Database hostname |
| `DATABASE_PORT` | Database port number |
| `DATABASE_USER` | Database username |
| `DATABASE_PASSWORD` | Database password |
| `DATABASE_NAME` | Database/schema name (for MySQL), or default schema (for PostgreSQL) |
| `DATABASE_TYPE` | Either 'mysql' or 'postgres' |
| `OPENAI_API_KEY` | API key for OpenAI |
| `DEBUG_LOGS` | Set to 'true' to enable detailed debug logging |
| `PG_DISABLE_SSL` | Set to 'true' to disable SSL for PostgreSQL connections |

## Multi-Schema Support

When connecting to a PostgreSQL database, the server automatically:

1. Discovers all available schemas (excluding system schemas)
2. Loads tables, columns, and indexes from all schemas
3. Uses schema-qualified identifiers (`schema_name.table_name`) when needed
4. Automatically determines which schemas and tables are relevant for a given query

This allows querying across multiple schemas in a single database without any additional configuration.

## Debug Logging

To enable detailed debug logging, set the environment variable:

```
DEBUG_LOGS=true
```

This will output detailed information about:
- Schema discovery and loading
- Table and schema selection process
- Query generation and execution
- Multi-schema operations

Debug logs include timestamps and component labels to help identify the source of each log entry.

## Usage

```
npm install
npm start
``` 