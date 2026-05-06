const { Pool } = require('pg');
const logger = require('./logger');

const poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
};

const pool = process.env.DATABASE_URL ? new Pool(poolConfig) : null;

if (pool) {
    pool.on('error', (err) => {
        logger.error('❌ Unexpected error on idle database client', err);
    });

    pool.on('connect', () => {
        logger.info('✔️ Database pool connected');
    });
} else {
    logger.warn('⚠️ DATABASE_URL not defined. Database features will be disabled.');
}

module.exports = {
    pool,
    query: (text, params) => pool ? pool.query(text, params) : Promise.reject(new Error('Database not initialized')),
};
