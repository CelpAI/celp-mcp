# Advanced configuration

This appendix collects **every** environment variable and optional flag understood by the server, plus full examples for each supported database.

## Full environment-variable matrix

| Variable | Applies to | Required | Description |
|----------|-----------|----------|-------------|
| `DATABASE_TYPE` | all | ✅ | `postgres`, `mysql`, `mongodb`, or `databricks` |
| `DATABASE_HOST` | sql / mongo / databricks | ✅ (unless using `MONGO_URL`) | Hostname or IP |
| `DATABASE_PORT` | sql / mongo |   | Defaults: 5432 / 3306 / 27017 |
| `DATABASE_USER` | sql / mongo / databricks | ✅* | Auth username (`databricks` for DBX) |
| `DATABASE_PASSWORD` | sql / mongo | ✅* | Password for above user |
| `DATABASE_NAME` | sql / databricks | ✅ | Database (schema) / DBX catalog |
| `MONGO_URL` | mongodb |   | Full connection string – overrides the host/port variables |
| `MONGO_SSL` | mongodb |   | `true` / `false` – toggle TLS |
| `MONGO_REPLICA_SET` | mongodb |   | Replica-set name |
| `MONGO_READ_PREFERENCE` | mongodb |   | primary / secondary / … |
| `MONGO_MAX_POOL_SIZE` | mongodb |   | Connection-pool size |
| `DATABRICKS_HOST` | databricks | ✅ | Workspace hostname |
| `DATABRICKS_TOKEN` | databricks | ✅ | Personal-access token (goes into `password` field) |
| `DATABRICKS_HTTP_PATH` | databricks | ✅ | SQL warehouse http path (`/sql/1.0/warehouses/…`) |
| `DATABRICKS_PORT` | databricks |   | Defaults to 443 |
| `DATABRICKS_CATALOG` | databricks |   | Default catalog / schema (maps to `DATABASE_NAME`) |
| `CELP_API_KEY` | all | ✅ | Authorises orchestration API |
| `OPENAI_API_KEY` | optional |   | Needed only if you enable LLM sampling |
| `PG_DISABLE_SSL` | postgres |   | `true` → connect without SSL |
| `DEBUG_LOGS` | all |   | `true` → verbose logging |

`*` For MongoDB these fields are optional when you supply a full `MONGO_URL`.

---

## Example snippets

### PostgreSQL / MySQL (`.env` file)
```bash
DATABASE_TYPE=postgres
DATABASE_HOST=db.internal
DATABASE_PORT=5432
DATABASE_USER=readonly
DATABASE_PASSWORD=secret
DATABASE_NAME=analytics
CELP_API_KEY=sk-...
```

### MongoDB (connection-string form)
```bash
DATABASE_TYPE=mongodb
MONGO_URL=mongodb://analytics_user:pw@db1.example.com:27017/marketing?authSource=admin&ssl=true
CELP_API_KEY=sk-...
```

### Databricks SQL Warehouse
```bash
DATABASE_TYPE=databricks
DATABRICKS_HOST=adb-1234567890.2.azuredatabricks.net
DATABRICKS_TOKEN=dapiXXXXXXXXXXXXXXXX
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/0123456789abcdef
DATABRICKS_CATALOG=main
CELP_API_KEY=sk-...
```

Programmatic `databaseConfig` equivalent:
```jsonc
{
  "databaseType": "databricks",
  "host": "adb-1234567890.2.azuredatabricks.net",
  "user": "databricks",
  "password": "dapiXXXXXXXXXXXXXXXX",
  "database": "main",
  "databricksOptions": {
    "httpPath": "/sql/1.0/warehouses/0123456789abcdef"
  }
}
```

---

## Tips & troubleshooting

* **Disable env-var fallback**: set `DONT_USE_DB_ENVS=true` if you want the server to ignore process env and rely solely on the `databaseConfig` passed in each tool call.
* **Debug logs**: set `DEBUG_LOGS=true` to print query traffic and socket events to stderr.
* **SSL on Postgres**: most cloud Postgres providers enforce TLS—​leave `PG_DISABLE_SSL` unset (default) unless you're connecting to a local dev instance. 