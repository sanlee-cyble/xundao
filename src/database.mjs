export async function createDatabase({ databaseUrl = "", sqlitePath, databaseSsl = false } = {}) {
  if (databaseUrl) {
    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: databaseUrl,
      ...(databaseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    return { mode: "postgres", pool };
  }
  if (!sqlitePath) throw new Error("SQLite 模式缺少 sqlitePath");
  const { DatabaseSync } = await import("node:sqlite");
  return { mode: "sqlite", sqlite: new DatabaseSync(sqlitePath) };
}

export async function closeDatabase(database) {
  if (database?.mode === "postgres") await database.pool.end();
  else database?.sqlite?.close();
}

export async function dbExec(database, sql) {
  if (database?.mode === "postgres") return await database.pool.query(sql);
  return database.sqlite.exec(sql);
}

export async function dbAll(database, sqliteSql, sqliteParams = [], pgSql = sqliteSql, pgParams = sqliteParams) {
  if (database?.mode === "postgres") return (await database.pool.query(pgSql, pgParams)).rows;
  return database.sqlite.prepare(sqliteSql).all(...sqliteParams);
}

export async function dbGet(database, sqliteSql, sqliteParams = [], pgSql = sqliteSql, pgParams = sqliteParams) {
  if (database?.mode === "postgres") return (await database.pool.query(pgSql, pgParams)).rows[0];
  return database.sqlite.prepare(sqliteSql).get(...sqliteParams);
}

export async function dbRun(database, sqliteSql, sqliteParams = [], pgSql = sqliteSql, pgParams = sqliteParams) {
  if (database?.mode === "postgres") return await database.pool.query(pgSql, pgParams);
  return database.sqlite.prepare(sqliteSql).run(...sqliteParams);
}
