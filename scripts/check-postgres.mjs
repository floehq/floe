import pg from 'pg';

async function checkPostgres() {
  const client = new pg.Client({
    connectionString: "postgresql://neondb_owner:npg_QPqcg0IAmUu8@ep-odd-cell-a1i2hun8-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=verify-full&channel_binding=require",
  });

  try {
    await client.connect();
    const res = await client.query("SELECT file_id, status, target_chain FROM floe_files ORDER BY created_at DESC LIMIT 5");
    console.log("Recent files:", JSON.stringify(res.rows, null, 2));
    await client.end();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

checkPostgres();
