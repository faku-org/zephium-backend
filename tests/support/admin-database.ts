import { migrateAdmin } from "../../scripts/admin-migrate";
import { testDatabase as baseDatabase } from "./database";
export async function testDatabase() {
  const fixture = await baseDatabase();
  try {
    await migrateAdmin(fixture.db.sql);
    return fixture;
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
