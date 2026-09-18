/**
 * 种子数据 CLI
 *   node scripts/seed.js           仅在业务数据为空时写入
 *   node scripts/seed.js --force   清空业务表后重写（不动账号与会话）
 */
import { db } from '../src/db.js';
import { resetDemoData, isBusinessDataEmpty } from '../src/seed-data.js';

const force = process.argv.includes('--force');
if (!force && !isBusinessDataEmpty(db)) {
  console.log('[seed] 已有业务数据，跳过（要重写请加 --force）');
  process.exit(0);
}
const r = resetDemoData(db, { force: true });
console.log(`[seed] 完成：${r.categories} 个分类、${r.products} 个商品、${r.orders} 个订单`);
