const { Pool } = require('pg');
require('dotenv').config();

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initializeDatabase() {
  const client = await pool.connect();
  
  try {
    // Create visitors table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS visitors (
        id SERIAL PRIMARY KEY,
        kommune VARCHAR(100) NOT NULL,
        antal INTEGER NOT NULL CHECK (antal >= 1 AND antal <= 50),
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        date_key VARCHAR(50) NOT NULL,
        fingerprint VARCHAR(64) NOT NULL,
        ip_address INET,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for better performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_visitors_date_key ON visitors(date_key);
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_visitors_fingerprint_date ON visitors(fingerprint, date_key);
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_visitors_kommune ON visitors(kommune);
    `);

    console.log('✅ Database tables initialized successfully');
    
  } catch (error) {
    console.error('❌ Error initializing database:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Database operations
class VisitorDB {
  // Add a new visitor registration
  static async addVisitor({ kommune, antal, fingerprint, ipAddress, dateKey }) {
    const client = await pool.connect();
    
    try {
      const result = await client.query(`
        INSERT INTO visitors (kommune, antal, fingerprint, ip_address, date_key)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, timestamp
      `, [kommune, antal, fingerprint, ipAddress, dateKey]);
      
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  // Check if visitor already registered today
  static async hasVisitorRegisteredToday(fingerprint, dateKey) {
    const client = await pool.connect();
    
    try {
      const result = await client.query(`
        SELECT id FROM visitors 
        WHERE fingerprint = $1 AND date_key = $2
        LIMIT 1
      `, [fingerprint, dateKey]);
      
      return result.rows.length > 0;
    } finally {
      client.release();
    }
  }

  // Get all visitors (for migration/export)
  static async getAllVisitors() {
    const client = await pool.connect();
    
    try {
      const result = await client.query(`
        SELECT * FROM visitors 
        ORDER BY timestamp DESC
      `);
      
      return result.rows;
    } finally {
      client.release();
    }
  }

  // Get visitors for a specific date
  static async getVisitorsByDate(dateKey) {
    const client = await pool.connect();
    
    try {
      const result = await client.query(`
        SELECT * FROM visitors 
        WHERE date_key = $1
        ORDER BY timestamp DESC
      `, [dateKey]);
      
      return result.rows;
    } finally {
      client.release();
    }
  }

  // Get visitor statistics
  static async getStatistics() {
    const client = await pool.connect();
    
    try {
      // Today's statistics
      const today = new Date().toDateString();
      
      const todayStats = await client.query(`
        SELECT 
          COUNT(*) as registrations,
          SUM(antal) as total_visitors,
          kommune,
          SUM(antal) as kommune_count
        FROM visitors 
        WHERE date_key = $1 
        GROUP BY kommune
        ORDER BY kommune_count DESC
      `, [today]);

      // Overall statistics
      const overallStats = await client.query(`
        SELECT 
          COUNT(*) as total_registrations,
          SUM(antal) as total_visitors,
          COUNT(DISTINCT date_key) as active_days
        FROM visitors
      `);

      // Daily breakdown
      const dailyBreakdown = await client.query(`
        SELECT 
          date_key,
          COUNT(*) as registrations,
          SUM(antal) as total_visitors
        FROM visitors 
        GROUP BY date_key 
        ORDER BY date_key DESC
        LIMIT 30
      `);

      // Latest registration
      const latestRegistration = await client.query(`
        SELECT timestamp, kommune, antal 
        FROM visitors 
        ORDER BY timestamp DESC 
        LIMIT 1
      `);

      return {
        today: todayStats.rows,
        overall: overallStats.rows[0] || { total_registrations: 0, total_visitors: 0, active_days: 0 },
        daily: dailyBreakdown.rows,
        latest: latestRegistration.rows[0] || null
      };
    } finally {
      client.release();
    }
  }

  // Delete today's data (for testing)
  static async clearTodayData(dateKey) {
    const client = await pool.connect();
    
    try {
      const result = await client.query(`
        DELETE FROM visitors WHERE date_key = $1
      `, [dateKey]);
      
      return result.rowCount;
    } finally {
      client.release();
    }
  }
}

module.exports = {
  pool,
  initializeDatabase,
  VisitorDB
};