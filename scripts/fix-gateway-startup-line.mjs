/**
 * 修正 start-all.ps1 里的网关启动行
 *
 * 背景：该行的反斜杠在历史编辑中被转义层吞掉，变成
 *   C:UserswinnerDesktopurniture-adminun-gateway.bat
 * → 重启后网关起不来。
 *
 * 做法：改用正斜杠（cmd 的 cd /d 与 node 都接受正斜杠），彻底避开反斜杠被转义的问题。
 * 为什么用 write 工具写这个脚本：走 shell 内联时反斜杠会被再吞一层（本轮已踩一次）。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const F = 'E:/tools/site-server/start-all.ps1'
const lines = readFileSync(F, 'utf8').split('\n')

const GOOD = "    Start-Detached ('cmd.exe /c \"cd /d C:/Users/winner/Desktop/furniture-admin && set GW_TOKEN=aurum-gw-2026 && \"' + $Node + '\" src/gateway/server.js >> logs/gateway.log 2>&1\"') | Out-Null"

let fixed = 0
for (let i = 0; i < lines.length; i++) {
  const l = lines[i]
  // 凡是"网关启动"那一行（含 gateway.bat 或被吞成 un-gateway.bat / srcgatewayserver.js）都替换
  if (l.includes('Start-Detached') && (l.includes('gateway') || l.includes('un-gateway'))) {
    if (l.trim() !== GOOD.trim()) { lines[i] = GOOD; fixed++ }
  }
}
if (fixed) writeFileSync(F, lines.join('\n'), 'utf8')

console.log('   修正行数: ' + fixed)
for (const [i, l] of lines.entries()) {
  if (l.includes('Start-Detached') && l.includes('gateway')) {
    console.log('   第 ' + (i + 1) + ' 行 → ' + l.trim())
    console.log('   含正斜杠路径: ' + (l.includes('C:/Users/winner/Desktop/furniture-admin') ? '✅' : '❌'))
    console.log('   含 src/gateway/server.js: ' + (l.includes('src/gateway/server.js') ? '✅' : '❌'))
  }
}
