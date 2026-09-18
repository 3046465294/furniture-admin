/**
 * 重置管理员口令（新口令只打印一次），并吊销所有旧会话。
 * 用法：node scripts/reset-password.js [用户名]
 *       $env:NEW_PASSWORD="自定义口令" ; node scripts/reset-password.js
 */
import { db } from '../src/db.js';
import { hashPassword, generatePassword } from '../src/auth.js';

const username = process.argv[2] ?? 'admin';
const plain = process.env.NEW_PASSWORD ?? generatePassword(16);

const user = db.prepare('select id, username from users where username = ?').get(username);
if (!user) {
  console.error(`[reset-password] 找不到用户：${username}`);
  process.exit(1);
}

db.prepare('update users set password_hash = ?, failed_count = 0, locked_until = 0 where id = ?')
  .run(hashPassword(plain), user.id);

const revoked = db.prepare('update sessions set revoked = 1 where user_id = ? and revoked = 0').run(user.id);
console.log('-----------------------------------------------------------');
console.log(`  用户：${user.username}`);
console.log(`  新口令（请立刻保存，只显示这一次）：${plain}`);
console.log(`  已吊销该用户的 ${revoked.changes} 个旧会话`);
console.log('-----------------------------------------------------------');
