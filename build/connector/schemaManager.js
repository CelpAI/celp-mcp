"use strict";
/**
 * Schema Manager
 * Handles loading and managing database schema information
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.globalDataStructureMetadata = exports.processedDataIndex = exports.tableSizeCache = exports.indexMap = exports.schemaMap = void 0;
exports.loadMongoSchemaMap = loadMongoSchemaMap;
exports.loadMongoIndexes = loadMongoIndexes;
exports.loadMongoCollectionStats = loadMongoCollectionStats;
exports.loadDatabricksSchemaMap = loadDatabricksSchemaMap;
exports.loadDatabricksTableSizes = loadDatabricksTableSizes;
exports.loadDatabricksIndexes = loadDatabricksIndexes;
exports.loadSchemaMap = loadSchemaMap;
exports.loadMysqlSchemaMap = loadMysqlSchemaMap;
exports.loadAllPostgresSchemas = loadAllPostgresSchemas;
exports.loadPostgresSchemaMap = loadPostgresSchemaMap;
exports.loadTableSizes = loadTableSizes;
exports.loadMysqlTableSizes = loadMysqlTableSizes;
exports.loadAllPostgresTableSizes = loadAllPostgresTableSizes;
exports.loadAllPostgresIndexes = loadAllPostgresIndexes;
const debugLog = (...args) => {
    // console.log(...args);
};
const debugError = (...args) => {
    console.error(...args);
};
/**
 * Example in-memory references to "schemaMap", "indexMap", and table sizes.
 * In a real setup, you might load these on startup from MySQL's information_schema,
 * or from your own metadata store.
 */
exports.schemaMap = {};
exports.indexMap = {};
exports.tableSizeCache = {};
/**
 * If you want to maintain any data sets or chunked data in memory,
 * you can use an object or array as below.
 */
exports.processedDataIndex = [];
/**
 * For demonstration, keep global "structure metadata" that might be updated as we ingest new raw data.
 */
exports.globalDataStructureMetadata = {
    tables: {},
    relationships: {},
    // Expand fields as needed
};
// MongoDB schema inference functions
async function loadMongoSchemaMap(client, dbName) {
    debugLog('SchemaManager', 'Loading MongoDB schema map');
    const db = client.db(dbName);
    const collections = await db.listCollections().toArray();
    const localSchemaMap = {};
    for (const collectionInfo of collections) {
        const collectionName = collectionInfo.name;
        debugLog('SchemaManager', `Analyzing collection: ${collectionName}`);
        try {
            const collection = db.collection(collectionName);
            // Get sample documents to infer schema
            const sampleSize = 100;
            const sampleDocs = await collection.aggregate([
                { $sample: { size: sampleSize } }
            ]).toArray();
            if (sampleDocs.length === 0) {
                debugLog('SchemaManager', `Collection ${collectionName} is empty`);
                localSchemaMap[collectionName] = [];
                continue;
            }
            // Infer field schema from sample documents
            const fieldSchema = inferFieldsFromDocuments(sampleDocs);
            localSchemaMap[collectionName] = fieldSchema;
            debugLog('SchemaManager', `Inferred ${fieldSchema.length} fields for ${collectionName}`);
        }
        catch (error) {
            debugError('SchemaManager', `Error analyzing collection ${collectionName}:`, error);
            localSchemaMap[collectionName] = [];
        }
    }
    exports.schemaMap = localSchemaMap;
    debugLog('SchemaManager', `Loaded schema for ${Object.keys(localSchemaMap).length} collections`);
}
function inferFieldsFromDocuments(docs) {
    const fieldMap = new Map();
    // Analyze each document
    docs.forEach(doc => {
        analyzeDocumentFields(doc, fieldMap, '');
    });
    // Convert to schema format
    const fields = [];
    fieldMap.forEach((fieldInfo, fieldPath) => {
        const types = Array.from(fieldInfo.types);
        const primaryType = getMostCommonType(types);
        fields.push({
            columnName: fieldPath,
            dataType: primaryType,
            isNullable: fieldInfo.nullCount > 0 ? 'YES' : 'NO',
            nullPercentage: (fieldInfo.nullCount / fieldInfo.totalCount) * 100,
            isArray: fieldInfo.isArray,
            isNested: fieldInfo.isNested,
            allTypes: types,
            sampleValues: fieldInfo.sampleValues.slice(0, 5), // Keep top 5 sample values
            occurrenceCount: fieldInfo.totalCount - fieldInfo.nullCount
        });
    });
    return fields.sort((a, b) => a.columnName.localeCompare(b.columnName));
}
function analyzeDocumentFields(obj, fieldMap, prefix) {
    for (const [key, value] of Object.entries(obj)) {
        const fieldPath = prefix ? `${prefix}.${key}` : key;
        if (!fieldMap.has(fieldPath)) {
            fieldMap.set(fieldPath, {
                name: fieldPath,
                types: new Set(),
                isArray: false,
                isNested: false,
                nullCount: 0,
                totalCount: 0,
                sampleValues: []
            });
        }
        const fieldInfo = fieldMap.get(fieldPath);
        fieldInfo.totalCount++;
        if (value === null || value === undefined) {
            fieldInfo.nullCount++;
            fieldInfo.types.add('null');
        }
        else if (Array.isArray(value)) {
            fieldInfo.isArray = true;
            fieldInfo.types.add('array');
            // Analyze array elements
            if (value.length > 0) {
                const elementType = typeof value[0];
                fieldInfo.types.add(`array<${elementType}>`);
                // If array contains objects, analyze nested structure
                if (elementType === 'object' && value[0] !== null) {
                    fieldInfo.isNested = true;
                    value.slice(0, 3).forEach((item, index) => {
                        if (typeof item === 'object' && item !== null) {
                            analyzeDocumentFields(item, fieldMap, `${fieldPath}[${index}]`);
                        }
                    });
                }
            }
            fieldInfo.sampleValues.push(value.slice(0, 3)); // Sample first 3 array elements
        }
        else if (typeof value === 'object' && value !== null) {
            fieldInfo.isNested = true;
            fieldInfo.types.add('object');
            // Recursively analyze nested object
            analyzeDocumentFields(value, fieldMap, fieldPath);
            fieldInfo.sampleValues.push('[nested object]');
        }
        else {
            const type = typeof value;
            fieldInfo.types.add(type);
            // Add sample values (keep unique ones)
            if (fieldInfo.sampleValues.length < 10 && !fieldInfo.sampleValues.includes(value)) {
                fieldInfo.sampleValues.push(value);
            }
        }
    }
}
function getMostCommonType(types) {
    if (types.length === 1)
        return types[0];
    // Priority order for mixed types
    const typePriority = ['string', 'number', 'boolean', 'object', 'array', 'null'];
    for (const type of typePriority) {
        if (types.includes(type))
            return type;
    }
    return types[0] || 'unknown';
}
async function loadMongoIndexes(client, dbName) {
    debugLog('SchemaManager', 'Loading MongoDB indexes');
    const db = client.db(dbName);
    const collections = await db.listCollections().toArray();
    const localIndexMap = {};
    for (const collectionInfo of collections) {
        const collectionName = collectionInfo.name;
        const collection = db.collection(collectionName);
        try {
            const indexes = await collection.indexes();
            localIndexMap[collectionName] = indexes.map((index) => ({
                indexName: index.name,
                keys: index.key,
                unique: index.unique || false,
                sparse: index.sparse || false,
                compound: Object.keys(index.key).length > 1,
                fields: Object.keys(index.key),
                direction: index.key,
                textIndex: index.weights ? true : false,
                partialFilter: index.partialFilterExpression || null
            }));
            debugLog('SchemaManager', `Loaded ${indexes.length} indexes for collection ${collectionName}`);
        }
        catch (error) {
            debugError('SchemaManager', `Error loading indexes for ${collectionName}:`, error);
            localIndexMap[collectionName] = [];
        }
    }
    exports.indexMap = localIndexMap;
}
async function loadMongoCollectionStats(client, dbName) {
    debugLog('SchemaManager', 'Loading MongoDB collection statistics');
    const db = client.db(dbName);
    const collections = await db.listCollections().toArray();
    const localSizeCache = {};
    for (const collectionInfo of collections) {
        const collectionName = collectionInfo.name;
        try {
            const stats = await db.command({ collStats: collectionName });
            localSizeCache[collectionName] = stats.count || 0;
            debugLog('SchemaManager', `Collection ${collectionName}: ${stats.count} documents`);
        }
        catch (error) {
            debugError('SchemaManager', `Error getting stats for ${collectionName}:`, error);
            localSizeCache[collectionName] = 0;
        }
    }
    exports.tableSizeCache = localSizeCache;
}
async function loadDatabricksSchemaMap(conn, catalogName, schemaName = 'default', config) {
    debugLog('SchemaManager', `Loading Databricks schema from catalog ${catalogName}`);
    try {
        // Use the existing connection directly instead of creating new ones
        const session = await conn.openSession();
        // Load schema information for ALL schemas in the catalog, not just 'default'
        // This matches the behavior of loadDatabricksTableSizes
        const query = `
      SELECT 
        table_catalog,
        table_schema, 
        table_name,
        column_name,
        data_type,
        is_nullable,
        column_default,
        ordinal_position
      FROM ${catalogName}.information_schema.columns
      WHERE table_catalog = '${catalogName}'
      ORDER BY table_schema, table_name, ordinal_position
    `;
        const operation = await session.executeStatement(query, { runAsync: true, maxRows: 50000 });
        const rows = await operation.fetchAll();
        await operation.close();
        await session.close();
        const localSchemaMap = {};
        for (const row of rows) {
            // Use catalog.schema.table naming convention
            const qualifiedTableName = `${row.table_catalog}.${row.table_schema}.${row.table_name}`;
            if (!localSchemaMap[qualifiedTableName]) {
                localSchemaMap[qualifiedTableName] = [];
            }
            localSchemaMap[qualifiedTableName].push({
                columnName: row.column_name,
                dataType: row.data_type,
                nullable: row.is_nullable === 'YES',
                defaultValue: row.column_default,
                position: row.ordinal_position
            });
        }
        exports.schemaMap = localSchemaMap;
        debugLog('SchemaManager', `Loaded ${Object.keys(localSchemaMap).length} Databricks tables`);
    }
    catch (error) {
        debugError('SchemaManager', `Error loading Databricks schema from ${catalogName}.${schemaName}:`, error);
        exports.schemaMap = {};
    }
}
async function loadDatabricksTableSizes(conn, catalogName, config) {
    debugLog('SchemaManager', `Loading Databricks table sizes for catalog ${catalogName}`);
    try {
        // Use the existing connection directly instead of creating new ones
        const session = await conn.openSession();
        const localSizeCache = {};
        try {
            // Try to get table list from system information_schema (more efficient than SHOW commands)
            const tablesQuery = `
        SELECT 
          CONCAT(table_catalog, '.', table_schema, '.', table_name) as qualified_name,
          table_catalog,
          table_schema,
          table_name
        FROM system.information_schema.tables
        WHERE table_catalog = '${catalogName}'
        AND table_type = 'MANAGED'
        ORDER BY table_catalog, table_schema, table_name
      `;
            const tablesOperation = await session.executeStatement(tablesQuery, { runAsync: true, maxRows: 10000 });
            const tables = await tablesOperation.fetchAll();
            await tablesOperation.close();
            debugLog('SchemaManager', `Found ${tables.length} tables to process from system.information_schema`);
            // If we got tables from information_schema, use those (much more efficient)
            if (tables.length > 0) {
                // Process tables in batches to avoid overwhelming the connection
                const batchSize = 10;
                for (let i = 0; i < tables.length; i += batchSize) {
                    const batch = tables.slice(i, i + batchSize);
                    // Process batch in parallel for better performance
                    const batchPromises = batch.map(async (table) => {
                        const qualifiedName = table.qualified_name;
                        try {
                            // Use DESCRIBE DETAIL to get table statistics (this is the standard Databricks approach)
                            const describeQuery = `DESCRIBE DETAIL ${qualifiedName}`;
                            const describeOperation = await session.executeStatement(describeQuery, { runAsync: true, maxRows: 100 });
                            const description = await describeOperation.fetchAll();
                            await describeOperation.close();
                            // Extract row count from DESCRIBE DETAIL results
                            let rowCount = 0;
                            if (description && description.length > 0) {
                                const tableInfo = description[0];
                                // DESCRIBE DETAIL returns numRows field directly
                                rowCount = parseInt(tableInfo.numRows, 10) || 0;
                            }
                            return { qualifiedName, rowCount };
                        }
                        catch (error) {
                            debugError('SchemaManager', `Error getting size for ${qualifiedName}:`, error);
                            return { qualifiedName, rowCount: 0 };
                        }
                    });
                    // Wait for batch to complete
                    const batchResults = await Promise.all(batchPromises);
                    // Update cache with batch results
                    for (const result of batchResults) {
                        localSizeCache[result.qualifiedName] = result.rowCount;
                        debugLog('SchemaManager', `Table ${result.qualifiedName}: ${result.rowCount} rows`);
                    }
                    debugLog('SchemaManager', `Processed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(tables.length / batchSize)}`);
                }
                await session.close();
                exports.tableSizeCache = localSizeCache;
                debugLog('SchemaManager', `Loaded sizes for ${Object.keys(localSizeCache).length} Databricks tables via optimized batch processing`);
                return;
            }
        }
        catch (error) {
            debugLog('SchemaManager', 'system.information_schema.tables not available, falling back to SHOW method');
        }
        // Fallback: Use the original method with individual SHOW/DESCRIBE queries
        debugLog('SchemaManager', 'Using fallback method with SHOW commands');
        // Query all schemas in the catalog
        const schemasQuery = `SHOW SCHEMAS IN ${catalogName}`;
        let schemasOperation = await session.executeStatement(schemasQuery, { runAsync: true, maxRows: 1000 });
        const schemas = await schemasOperation.fetchAll();
        await schemasOperation.close();
        for (const schema of schemas) {
            const schemaName = schema.databaseName || schema.namespace_name || schema.schema_name;
            try {
                const tablesQuery = `SHOW TABLES IN ${catalogName}.${schemaName}`;
                let tablesOperation = await session.executeStatement(tablesQuery, { runAsync: true, maxRows: 1000 });
                const tables = await tablesOperation.fetchAll();
                await tablesOperation.close();
                for (const table of tables) {
                    const tableName = table.tableName || table.table_name;
                    const qualifiedName = `${catalogName}.${schemaName}.${tableName}`;
                    try {
                        // Use DESCRIBE EXTENDED to get table statistics
                        const describeQuery = `DESCRIBE EXTENDED ${qualifiedName}`;
                        let describeOperation = await session.executeStatement(describeQuery, { runAsync: true, maxRows: 1000 });
                        const description = await describeOperation.fetchAll();
                        await describeOperation.close();
                        // Parse statistics from description
                        let rowCount = 0;
                        for (const row of description) {
                            if (row.col_name === 'Statistics' && row.data_type) {
                                // Extract row count from statistics string
                                const rowCountMatch = row.data_type.match(/(\d+)\s+rows?/i);
                                if (rowCountMatch) {
                                    rowCount = parseInt(rowCountMatch[1], 10);
                                }
                                break;
                            }
                        }
                        localSizeCache[qualifiedName] = rowCount;
                        debugLog('SchemaManager', `Table ${qualifiedName}: ${rowCount} rows`);
                    }
                    catch (error) {
                        debugError('SchemaManager', `Error getting size for ${qualifiedName}:`, error);
                        localSizeCache[qualifiedName] = 0;
                    }
                }
            }
            catch (error) {
                debugError('SchemaManager', `Error loading tables from schema ${schemaName}:`, error);
            }
        }
        await session.close();
        exports.tableSizeCache = localSizeCache;
        debugLog('SchemaManager', `Loaded sizes for ${Object.keys(localSizeCache).length} Databricks tables via individual queries`);
    }
    catch (error) {
        debugError('SchemaManager', `Error loading Databricks table sizes for catalog ${catalogName}:`, error);
        exports.tableSizeCache = {};
    }
}
async function loadDatabricksIndexes(conn, catalogName, config) {
    debugLog('SchemaManager', 'Loading Databricks clustering information');
    // Databricks doesn't have traditional indexes, but has clustering keys
    // For now, just initialize empty index map
    // Could be extended to include:
    // - Clustering columns from DESCRIBE EXTENDED
    // - Partition columns
    // - Z-order columns
    exports.indexMap = {};
    debugLog('SchemaManager', 'Databricks index map initialized (clustering keys not yet implemented)');
}
async function loadSchemaMap(conn, dbName, databaseType = "mysql", config) {
    if (databaseType === "mysql") {
        await loadMysqlSchemaMap(conn, dbName);
    }
    else if (databaseType === "postgres") {
        // For PostgreSQL, load all schemas
        await loadAllPostgresSchemas(conn, dbName);
    }
    else if (databaseType === "mongodb") {
        await loadMongoSchemaMap(conn, dbName);
    }
    else if (databaseType === "databricks") {
        // throw new Error("trying databricks");
        await loadDatabricksSchemaMap(conn, dbName, config?.databricksOptions?.schema || 'default', config);
    }
}
async function loadMysqlSchemaMap(conn, dbName) {
    // Load columns from information_schema.COLUMNS
    const [rows] = await conn.query(`
    SELECT 
      TABLE_NAME,
      COLUMN_NAME,
      COLUMN_DEFAULT,
      IS_NULLABLE,
      DATA_TYPE,
      CHARACTER_MAXIMUM_LENGTH,
      NUMERIC_PRECISION,
      NUMERIC_SCALE,
      COLUMN_KEY,
      EXTRA
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ?
    ORDER BY TABLE_NAME, ORDINAL_POSITION
    `, [dbName]);
    const localSchemaMap = {};
    for (const row of rows) {
        const tableName = row.TABLE_NAME /*.toLowerCase()*/;
        if (!localSchemaMap[tableName]) {
            localSchemaMap[tableName] = [];
        }
        localSchemaMap[tableName].push({
            columnName: row.COLUMN_NAME /*.toLowerCase()*/,
            default: row.COLUMN_DEFAULT,
            isNullable: row.IS_NULLABLE,
            dataType: row.DATA_TYPE,
            charMaxLength: row.CHARACTER_MAXIMUM_LENGTH,
            numericPrecision: row.NUMERIC_PRECISION,
            numericScale: row.NUMERIC_SCALE,
            key: row.COLUMN_KEY,
            extra: row.EXTRA,
        });
    }
    exports.schemaMap = localSchemaMap;
    // Load index information into a separate variable
    const [indexRows] = await conn.query(`
    SELECT 
      TABLE_NAME,
      INDEX_NAME,
      COLUMN_NAME,
      NON_UNIQUE,
      SEQ_IN_INDEX,
      INDEX_TYPE
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = ?
    ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
    `, [dbName]);
    // Reset the indexMap before populating it to prevent memory leaks
    exports.indexMap = {};
    for (const row of indexRows) {
        const tableName = row.TABLE_NAME /*.toLowerCase()*/;
        if (!exports.indexMap[tableName]) {
            exports.indexMap[tableName] = [];
        }
        exports.indexMap[tableName].push({
            indexName: row.INDEX_NAME,
            columnName: row.COLUMN_NAME /*.toLowerCase()*/,
            nonUnique: row.NON_UNIQUE,
            seqInIndex: row.SEQ_IN_INDEX,
            indexType: row.INDEX_TYPE,
        });
    }
    // console.log("Loaded MySQL schema and indexes");
}
async function loadAllPostgresSchemas(conn, dbName) {
    try {
        debugLog('MultiSchema', 'Discovering all PostgreSQL schemas');
        // Reset the schemaMap before populating it to prevent memory leaks
        exports.schemaMap = {};
        // Get all schemas in the database, excluding system schemas
        const schemasResult = await conn.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY schema_name
    `);
        const schemas = schemasResult.rows.map(row => row.schema_name);
        debugLog('MultiSchema', `Found ${schemas.length} PostgreSQL schemas`, schemas);
        // Initialize a combined schema map
        const localSchemaMap = {};
        // Load tables and columns for each schema
        for (const schemaName of schemas) {
            try {
                debugLog('MultiSchema', `Loading tables and columns for schema "${schemaName}"`);
                const result = await conn.query(`
          SELECT 
            c.table_name, 
            c.column_name, 
            c.data_type,
            c.character_maximum_length,
            c.numeric_precision,
            c.numeric_scale,
            c.is_nullable,
            c.column_default,
            c.ordinal_position
          FROM information_schema.columns c
          JOIN information_schema.tables t 
            ON c.table_name = t.table_name AND c.table_schema = t.table_schema
          WHERE c.table_schema = $1
            AND t.table_type = 'BASE TABLE'
          ORDER BY c.table_name, c.ordinal_position
        `, [schemaName]);
                if (!result || !result.rows || result.rows.length === 0) {
                    debugLog('MultiSchema', `No tables found in schema "${schemaName}"`);
                    continue;
                }
                const tablesFound = new Set();
                for (const row of result.rows) {
                    const tableName = row.table_name;
                    tablesFound.add(tableName);
                    // Use schema-qualified table name as the key
                    const qualifiedTableName = `${schemaName}.${tableName}`;
                    if (!localSchemaMap[qualifiedTableName]) {
                        localSchemaMap[qualifiedTableName] = [];
                    }
                    localSchemaMap[qualifiedTableName].push({
                        columnName: row.column_name,
                        dataType: row.data_type,
                        maxLength: row.character_maximum_length,
                        precision: row.numeric_precision,
                        scale: row.numeric_scale,
                        nullable: row.is_nullable === 'YES',
                        defaultValue: row.column_default,
                        position: row.ordinal_position
                    });
                }
                debugLog('MultiSchema', `Loaded ${tablesFound.size} tables from schema "${schemaName}"`);
            }
            catch (error) {
                debugError('MultiSchema', `Error loading schema "${schemaName}"`, error);
            }
        }
        debugLog('MultiSchema', `Loaded complete schema map with ${Object.keys(localSchemaMap).length} qualified tables`);
        exports.schemaMap = localSchemaMap;
    }
    catch (error) {
        debugError('MultiSchema', 'Error listing PostgreSQL schemas', error);
        exports.schemaMap = {};
    }
}
// Keep the original loadPostgresSchemaMap for backward compatibility, but use it to load a single schema
async function loadPostgresSchemaMap(conn, dbName) {
    // In PostgreSQL, schemas are used differently than in MySQL
    // By default, use 'public' schema, but also support custom schema
    let schemaName = 'public';
    // First, check if the provided dbName is actually a schema name in this PostgreSQL instance
    try {
        if (!dbName) {
            debugLog('MultiSchema', 'No database name provided, using default "public" schema');
            schemaName = 'public';
        }
        else {
            const schemaCheckResult = await conn.query(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = $1
      `, [dbName]);
            if (schemaCheckResult && Array.isArray(schemaCheckResult.rows) && schemaCheckResult.rows.length > 0) {
                schemaName = dbName;
                debugLog('MultiSchema', `Using provided schema name: ${schemaName}`);
            }
            else {
                debugLog('MultiSchema', `Schema "${dbName}" not found, defaulting to "public" schema`);
            }
        }
    }
    catch (error) {
        debugError('MultiSchema', `Error checking for schema "${dbName}", defaulting to "public" schema`, error);
    }
    // Load columns from information_schema for PostgreSQL
    // console.log(`Loading PostgreSQL schema from "${schemaName}" schema`);
    try {
        const result = await conn.query(`
      SELECT 
        c.table_name, 
        c.column_name, 
        c.data_type,
        c.character_maximum_length,
        c.numeric_precision,
        c.numeric_scale,
        c.is_nullable,
        c.column_default,
        c.ordinal_position
      FROM information_schema.columns c
      JOIN information_schema.tables t 
        ON c.table_name = t.table_name AND c.table_schema = t.table_schema
      WHERE c.table_schema = $1
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position
    `, [schemaName]);
        const localSchemaMap = {};
        for (const row of result.rows) {
            const tableName = row.table_name;
            // Use schema-qualified table name as the key
            const qualifiedTableName = `${schemaName}.${tableName}`;
            if (!localSchemaMap[qualifiedTableName]) {
                localSchemaMap[qualifiedTableName] = [];
            }
            localSchemaMap[qualifiedTableName].push({
                columnName: row.column_name,
                dataType: row.data_type,
                maxLength: row.character_maximum_length,
                precision: row.numeric_precision,
                scale: row.numeric_scale,
                nullable: row.is_nullable === 'YES',
                defaultValue: row.column_default,
                position: row.ordinal_position
            });
        }
        exports.schemaMap = localSchemaMap;
    }
    catch (error) {
        console.error(`Error loading PostgreSQL schema from "${schemaName}" schema:`, error);
        exports.schemaMap = {};
    }
}
async function loadTableSizes(conn, dbName, databaseType = "mysql", config) {
    if (databaseType === "mysql") {
        await loadMysqlTableSizes(conn, dbName);
    }
    else if (databaseType === "postgres") {
        // For PostgreSQL, load table sizes for all schemas
        await loadAllPostgresTableSizes(conn);
    }
    else if (databaseType === "mongodb") {
        await loadMongoCollectionStats(conn, dbName);
    }
    else if (databaseType === "databricks") {
        await loadDatabricksTableSizes(conn, dbName, config);
    }
}
async function loadMysqlTableSizes(conn, dbName) {
    const [rows] = await conn.query(`
    SELECT TABLE_NAME, TABLE_ROWS
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ?
  `, [dbName]);
    for (const r of rows) {
        exports.tableSizeCache[r.TABLE_NAME /*.toLowerCase()*/] = r.TABLE_ROWS;
    }
    // console.log("Loaded MySQL table sizes");
}
async function loadAllPostgresTableSizes(conn) {
    try {
        debugLog('MultiSchema', 'Discovering all PostgreSQL schemas for table sizes');
        // Reset the tableSizeCache before populating it to prevent memory leaks
        exports.tableSizeCache = {};
        // Get all schemas in the database, excluding system schemas
        const schemasResult = await conn.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY schema_name
    `);
        const schemas = schemasResult.rows.map(row => row.schema_name);
        debugLog('MultiSchema', `Found ${schemas.length} schemas for table sizes`);
        // Load table sizes for each schema
        for (const schemaName of schemas) {
            try {
                debugLog('MultiSchema', `Loading table sizes for schema "${schemaName}"`);
                const result = await conn.query(`
          SELECT
            schemaname || '.' || relname AS table_name,
            n_live_tup AS table_rows
          FROM
            pg_stat_user_tables
          WHERE
            schemaname = $1
        `, [schemaName]);
                if (!result || !result.rows)
                    continue;
                let totalRows = 0;
                for (const row of result.rows) {
                    const qualifiedTableName = row.table_name;
                    const rowCount = parseInt(row.table_rows, 10) || 0;
                    exports.tableSizeCache[qualifiedTableName] = rowCount;
                    totalRows += rowCount;
                }
                debugLog('MultiSchema', `Loaded sizes for ${result.rows.length} tables in schema "${schemaName}", total rows: ${totalRows}`);
            }
            catch (error) {
                debugError('MultiSchema', `Error loading table sizes for schema "${schemaName}"`, error);
            }
        }
        debugLog('MultiSchema', `Loaded complete table size cache with ${Object.keys(exports.tableSizeCache).length} qualified tables`);
    }
    catch (error) {
        debugError('MultiSchema', 'Error listing PostgreSQL schemas for table sizes', error);
    }
}
async function loadAllPostgresIndexes(conn) {
    try {
        debugLog('MultiSchema', 'Loading PostgreSQL indexes from all schemas');
        // Reset the indexMap before loading new indexes to prevent memory leaks
        exports.indexMap = {};
        // Load all indexes across all user schemas
        const result = await conn.query(`
      SELECT
        schemaname,
        tablename,
        indexname,
        indexdef
      FROM
        pg_indexes
      WHERE
        schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY
        schemaname, tablename, indexname
    `);
        // Process indexes
        let currentSchema = '';
        let currentTable = '';
        let indexCount = 0;
        for (const row of result.rows) {
            const schemaName = row.schemaname;
            const tableName = row.tablename;
            const qualifiedTableName = `${schemaName}.${tableName}`;
            if (currentSchema !== schemaName) {
                currentSchema = schemaName;
                currentTable = '';
            }
            if (currentTable !== qualifiedTableName) {
                currentTable = qualifiedTableName;
                exports.indexMap[qualifiedTableName] = [];
            }
            // Extract column names from the index definition
            // This is a simplistic approach and might need refinement for complex indexes
            const indexDef = row.indexdef;
            const indexName = row.indexname;
            // Attempt to extract column names from the index definition
            // Format: CREATE INDEX indexname ON schema.table USING method (column1, column2, ...)
            const columnMatch = indexDef.match(/\(([^)]+)\)/);
            let columns = [];
            if (columnMatch && columnMatch[1]) {
                // Split the captured group by commas and clean up whitespace
                columns = columnMatch[1].split(',').map((col) => col.trim());
            }
            // Determine if it's a unique index
            const isUnique = indexDef.toLowerCase().includes('unique index');
            // Create a simplified representation of the index
            for (let i = 0; i < columns.length; i++) {
                exports.indexMap[qualifiedTableName].push({
                    indexName: indexName,
                    columnName: columns[i],
                    nonUnique: isUnique ? 0 : 1,
                    seqInIndex: i + 1,
                    indexType: indexDef.includes('USING btree') ? 'BTREE' :
                        indexDef.includes('USING hash') ? 'HASH' :
                            indexDef.includes('USING gist') ? 'GIST' :
                                indexDef.includes('USING gin') ? 'GIN' :
                                    'OTHER'
                });
            }
            indexCount++;
        }
        debugLog('MultiSchema', `Loaded ${indexCount} PostgreSQL indexes across all schemas`);
    }
    catch (error) {
        debugError('MultiSchema', 'Error loading PostgreSQL indexes', error);
        // Initialize empty index map if loading fails
        exports.indexMap = {};
    }
}
