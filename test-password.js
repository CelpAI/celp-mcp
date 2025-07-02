#!/usr/bin/env node

require('dotenv').config();

console.log('Environment variables:');
console.log('DATABASE_PASSWORD length:', process.env.DATABASE_PASSWORD?.length || 0);
console.log('DATABASE_PASSWORD value:', JSON.stringify(process.env.DATABASE_PASSWORD));
console.log('Contains @:', process.env.DATABASE_PASSWORD?.includes('@'));

// Test direct connection
const { Client } = require('pg');

const testConnection = async () => {
  const client = new Client({
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT) || 5432,
    user: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME || 'postgres',
    ssl: process.env.PG_DISABLE_SSL === 'true' ? undefined : { rejectUnauthorized: false },
  });

  try {
    console.log('Attempting to connect with password:', process.env.DATABASE_PASSWORD?.replace(/./g, '*'));
    await client.connect();
    console.log('✅ Connection successful!');
    await client.end();
  } catch (error) {
    console.log('❌ Connection failed:', error.message);
  }
};

if (process.env.DATABASE_TYPE === 'postgres') {
  testConnection();
} else {
  console.log('Set DATABASE_TYPE=postgres to test PostgreSQL connection');
} 