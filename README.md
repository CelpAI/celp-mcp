# Celp MCP

A powerful MCP server that connects to databases and runs natural language queries through LLM planning and execution. This server understands database schema, indexes, and provides structured, accurate query results.

## 📋 Claude Desktop Integration

**The recommended way to use this MCP server is with Claude Desktop.**

To integrate with Claude Desktop:

1. Open Claude Desktop settings
2. Navigate to the MCP Server configuration section
3. Add the following configuration
4. Set up environment variables under "env" and save the configuration
5. Restart Claude Desktop:
```json
{
  "mcpServers": {
    "celp-mcp": {
      "command": "npx",
      "args": ["-y", "celp-mcp"],
      "env": {
        "DATABASE_HOST": "localhost",
        "DATABASE_USER": "postgres",
        "DATABASE_PASSWORD": "mysecretpassword",
        "DATABASE_NAME": "mydatabase",
        "DATABASE_TYPE": "postgres",
        "CELP_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

## 🚀 Installation Options

### Using npx (Recommended for Claude Desktop)

The fastest way to get started is with npx:

```bash
npx celp-mcp
```

This will download and run the package without permanent installation. This method works perfectly with Claude Desktop integration.

### Cloning the Repository (For Development or Customization)

If you prefer to clone the repository (also works with Claude Desktop):

```bash
git clone https://github.com/empowerlocal/mcp-server.git
cd mcp-server
npm install
npm run build
npm start
```

To use with Claude Desktop when cloning the repo, adjust your Claude Desktop configuration to point to your local installation.

### Global Installation

If you prefer a permanent installation:

```bash
npm install -g celp-mcp
celp-mcp
```

## 🔧 Environment Variables

This server requires specific environment variables to connect to your database. These are used both for direct execution and when configuring Claude Desktop integration:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_HOST` | Database hostname | localhost |
| `DATABASE_PORT` | Database port number | 5432 (Postgres), 3306 (MySQL) |
| `DATABASE_USER` | Database username | root |
| `DATABASE_PASSWORD` | Database password | |
| `DATABASE_NAME` | Database/schema name | test_db |
| `DATABASE_TYPE` | Either 'mysql' or 'postgres' | postgres |
| `CELP_API_KEY` | API key for Celp services (contact us to obtain) | |
| `OPENAI_API_KEY` | API key for OpenAI | |
| `DEBUG_LOGS` | Set to 'true' for detailed logging | false |
| `PG_DISABLE_SSL` | Set to 'true' to disable SSL for PostgreSQL | false |

> **Important**: A `CELP_API_KEY` is required to use this service. Please reach out to the Celp team to obtain your API key.

### Setting Environment Variables

#### Method 1: .env File (Recommended for Direct Execution)
Create a `.env` file in your current directory with the required variables:

```
DATABASE_HOST=localhost
DATABASE_USER=postgres
DATABASE_PASSWORD=mysecretpassword
DATABASE_NAME=mydatabase
DATABASE_TYPE=postgres
CELP_API_KEY=your_api_key_here
OPENAI_API_KEY=sk-...
```

#### Method 2: Command Line
Set variables directly in your terminal before running:

```bash
export DATABASE_HOST=localhost
export DATABASE_USER=postgres
export CELP_API_KEY=your_api_key_here
# Set other variables...
npx celp-mcp
```

#### Method 3: Claude Desktop Configuration
When using with Claude Desktop, set the environment variables in your Claude Desktop MCP configuration as shown in the Claude Desktop Integration section above.

## 💡 Key Features

- **Multi-Database Support**: Works with both MySQL and PostgreSQL
- **Schema Understanding**: Automatically discovers tables, columns, and relationships
- **Multi-Schema Support**: Handles multiple schemas in PostgreSQL
- **Natural Language Queries**: Translates natural language to SQL
- **Markdown Results**: Returns well-formatted query results
- **Secure Connections**: SSL support for database connections

## 🔍 Example Queries

Once configured, you can ask Claude natural language questions about your data:

- "Show me the top 10 customers by order value"
- "What's the average age of users who signed up last month?"
- "Find duplicate records in the customers table"
- "Which products have inventory below 10 units?"
- "Graph monthly sales for the past year"

## 📊 Multi-Schema Support

When connecting to a PostgreSQL database, the server automatically:

1. Discovers all available schemas (excluding system schemas)
2. Loads tables, columns, and indexes from all schemas
3. Uses schema-qualified identifiers when needed
4. Automatically determines which schemas and tables are relevant for a query

## 🔧 Troubleshooting

If you encounter issues:

1. **Connection Problems**: Verify database credentials and network access
2. **Schema Discovery Issues**: Enable debug logs with `DEBUG_LOGS=true`
3. **SSL Errors**: Try setting `PG_DISABLE_SSL=true` if your database doesn't use SSL

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a pull request.

## 📜 License

This project is licensed under the ISC License.
