/**
 * Schema Manager
 * Handles loading and managing database schema information
 */

import mysql from "mysql2/promise";
import pg from "pg";

const debugLog = (...args: any[]) => {
  console.log(...args);
};

const debugError = (...args: any[]) => {
  console.error(...args);
};
/**
 * Example in-memory references to "schemaMap", "indexMap", and table sizes.
 * In a real setup, you might load these on startup from MySQL's information_schema,
 * or from your own metadata store.
 */
export let schemaMap: Record<string, Array<{ columnName: string }>> = {};
export let indexMap: Record<string, Array<any>> = {};
export let tableSizeCache: Record<string, number> = {};

/**
 * If you want to maintain any data sets or chunked data in memory,
 * you can use an object or array as below.
 */
export const processedDataIndex: Array<{
  chunkId: string;
  rawData: any;
  summary: string;
  analysis: string;
  metadata: any;
}> = [];

/**
 * For demonstration, keep global "structure metadata" that might be updated as we ingest new raw data.
 */
export let globalDataStructureMetadata: any = {
  tables: {},
  relationships: {},
  // Expand fields as needed
};

export async function loadSchemaMap(conn: mysql.Connection | pg.Client, dbName: string, databaseType: string = "mysql") {
  if (databaseType === "mysql") {
    await loadMysqlSchemaMap(conn as mysql.Connection, dbName);
  } else {
    // For PostgreSQL, load all schemas
    await loadAllPostgresSchemas(conn as pg.Client, dbName);
  }
}

export async function loadMysqlSchemaMap(conn: mysql.Connection, dbName: string) {
  // Load columns from information_schema.COLUMNS
  const [rows] = await conn.query(
    `
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
    `,
    [dbName]
  );

  const localSchemaMap: Record<string, Array<any>> = {};

  for (const row of rows as Array<{
    TABLE_NAME: string;
    COLUMN_NAME: string;
    COLUMN_DEFAULT: any;
    IS_NULLABLE: string;
    DATA_TYPE: string;
    CHARACTER_MAXIMUM_LENGTH: number | null;
    NUMERIC_PRECISION: number | null;
    NUMERIC_SCALE: number | null;
    COLUMN_KEY: string;
    EXTRA: string;
  }>) {
    const tableName = row.TABLE_NAME/*.toLowerCase()*/;

    if (!localSchemaMap[tableName]) {
      localSchemaMap[tableName] = [];
    }
    localSchemaMap[tableName].push({
      columnName: row.COLUMN_NAME/*.toLowerCase()*/,
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

  schemaMap = localSchemaMap;

  // Load index information into a separate variable
  const [indexRows] = await conn.query(
    `
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
    `,
    [dbName]
  );

  for (const row of indexRows as Array<{
    TABLE_NAME: string;
    INDEX_NAME: string;
    COLUMN_NAME: string;
    NON_UNIQUE: number;
    SEQ_IN_INDEX: number;
    INDEX_TYPE: string;
  }>) {
    const tableName = row.TABLE_NAME/*.toLowerCase()*/;

    if (!indexMap[tableName]) {
      indexMap[tableName] = [];
    }
    indexMap[tableName].push({
      indexName: row.INDEX_NAME,
      columnName: row.COLUMN_NAME/*.toLowerCase()*/,
      nonUnique: row.NON_UNIQUE,
      seqInIndex: row.SEQ_IN_INDEX,
      indexType: row.INDEX_TYPE,
    });
  }

  // console.log("Loaded MySQL schema and indexes");
}

export async function loadAllPostgresSchemas(conn: pg.Client, dbName: string) {
  try {
    debugLog('MultiSchema', 'Discovering all PostgreSQL schemas');
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
    const localSchemaMap: Record<string, Array<any>> = {};
    
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
      } catch (error) {
        debugError('MultiSchema', `Error loading schema "${schemaName}"`, error);
      }
    }
    
    debugLog('MultiSchema', `Loaded complete schema map with ${Object.keys(localSchemaMap).length} qualified tables`);
    schemaMap = localSchemaMap;
  } catch (error) {
    debugError('MultiSchema', 'Error listing PostgreSQL schemas', error);
    schemaMap = {};
  }
}

// Keep the original loadPostgresSchemaMap for backward compatibility, but use it to load a single schema
export async function loadPostgresSchemaMap(conn: pg.Client, dbName: string) {
  // In PostgreSQL, schemas are used differently than in MySQL
  // By default, use 'public' schema, but also support custom schema
  let schemaName = 'public';
  
  // First, check if the provided dbName is actually a schema name in this PostgreSQL instance
  try {
    if (!dbName) {
      debugLog('MultiSchema', 'No database name provided, using default "public" schema');
      schemaName = 'public';
    } else {
      const schemaCheckResult = await conn.query(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = $1
      `, [dbName]);
      
      if (schemaCheckResult && Array.isArray(schemaCheckResult.rows) && schemaCheckResult.rows.length > 0) {
        schemaName = dbName;
        debugLog('MultiSchema', `Using provided schema name: ${schemaName}`);
      } else {
        debugLog('MultiSchema', `Schema "${dbName}" not found, defaulting to "public" schema`);
      }
    }
  } catch (error) {
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
    
    const localSchemaMap: Record<string, Array<any>> = {};
    
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
    
    schemaMap = localSchemaMap;
  } catch (error) {
    console.error(`Error loading PostgreSQL schema from "${schemaName}" schema:`, error);
    schemaMap = {};
  }
}

export async function loadTableSizes(conn: mysql.Connection | pg.Client, dbName: string, databaseType: string = "mysql") {
  if (databaseType === "mysql") {
    await loadMysqlTableSizes(conn as mysql.Connection, dbName);
  } else {
    // For PostgreSQL, load table sizes for all schemas
    await loadAllPostgresTableSizes(conn as pg.Client);
  }
}

export async function loadMysqlTableSizes(conn: mysql.Connection, dbName: string) {
  const [rows] = await conn.query(
    `
    SELECT TABLE_NAME, TABLE_ROWS
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ?
  `,
    [dbName]
  );
  
  for (const r of rows as Array<{ TABLE_NAME: string; TABLE_ROWS: number }>) {
    tableSizeCache[r.TABLE_NAME/*.toLowerCase()*/] = r.TABLE_ROWS;
  }
  // console.log("Loaded MySQL table sizes");
}

export async function loadAllPostgresTableSizes(conn: pg.Client) {
  try {
    debugLog('MultiSchema', 'Discovering all PostgreSQL schemas for table sizes');
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
        
        if (!result || !result.rows) continue;
        
        let totalRows = 0;
        for (const row of result.rows) {
          const qualifiedTableName = row.table_name;
          const rowCount = parseInt(row.table_rows, 10) || 0;
          tableSizeCache[qualifiedTableName] = rowCount;
          totalRows += rowCount;
        }
        
        debugLog('MultiSchema', `Loaded sizes for ${result.rows.length} tables in schema "${schemaName}", total rows: ${totalRows}`);
      } catch (error) {
        debugError('MultiSchema', `Error loading table sizes for schema "${schemaName}"`, error);
      }
    }
    
    debugLog('MultiSchema', `Loaded complete table size cache with ${Object.keys(tableSizeCache).length} qualified tables`);
  } catch (error) {
    debugError('MultiSchema', 'Error listing PostgreSQL schemas for table sizes', error);
  }
}

export async function loadAllPostgresIndexes(conn: pg.Client) {
  try {
    debugLog('MultiSchema', 'Loading PostgreSQL indexes from all schemas');
    
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
        indexMap[qualifiedTableName] = [];
      }
      
      // Extract column names from the index definition
      // This is a simplistic approach and might need refinement for complex indexes
      const indexDef = row.indexdef;
      const indexName = row.indexname;
      
      // Attempt to extract column names from the index definition
      // Format: CREATE INDEX indexname ON schema.table USING method (column1, column2, ...)
      const columnMatch = indexDef.match(/\(([^)]+)\)/);
      let columns: string[] = [];
      
      if (columnMatch && columnMatch[1]) {
        // Split the captured group by commas and clean up whitespace
        columns = columnMatch[1].split(',').map((col: string) => col.trim());
      }
      
      // Determine if it's a unique index
      const isUnique = indexDef.toLowerCase().includes('unique index');
      
      // Create a simplified representation of the index
      for (let i = 0; i < columns.length; i++) {
        indexMap[qualifiedTableName].push({
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
  } catch (error) {
    debugError('MultiSchema', 'Error loading PostgreSQL indexes', error);
    // Initialize empty index map if loading fails
    indexMap = {};
  }
} 