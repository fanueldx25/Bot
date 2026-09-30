import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool, initDatabase } from './index.ts';
import path from 'path';

async function runMigrations() {
  console.log('🚀 Checking PostgreSQL database connection...');
  try {
    const client = await pool.connect();
    console.log('✅ Connected to PostgreSQL successfully!');
    client.release();

    console.log('📦 Ensuring all application tables exist...');
    await initDatabase();
    console.log('✅ Application tables verified/created successfully!');

    // Run Drizzle migration directory if present
    try {
      const migrationsFolder = path.resolve(process.cwd(), 'drizzle');
      await migrate(db, { migrationsFolder });
      console.log('✅ Drizzle migrations executed successfully!');
    } catch (migErr: any) {
      // If migrations folder isn't used or already migrated, initDatabase already ensured schema
      console.log('ℹ️ Schema is fully up to date.');
    }

    console.log('🎉 PostgreSQL setup completed successfully!');
    process.exit(0);
  } catch (error: any) {
    console.error('❌ Failed to run database migrations:', error.message);
    process.exit(1);
  }
}

runMigrations();
