'use strict';

/*
 * Parse every JavaScript file the app ships, server and browser alike.
 *
 * The browser scripts in public/ are not required by anything the test suite
 * loads, so a syntax error in one would pass every test and break a page.
 *
 *   node scripts/check-syntax.js
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dirs = ['.', 'lib', 'lib/sources', 'scripts', 'public', 'deploy', 'test'];
let failed = 0, checked = 0;
for (const d of dirs) {
  const dir = path.join(root, d);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const file = path.join(dir, f);
    // The Cloudflare Worker is an ES module; everything else is CommonJS or a
    // classic browser script.
    const args = /export default/.test(fs.readFileSync(file, 'utf8')) ? ['--input-type=module', '--check'] : ['--check', file];
    try {
      if (args[0] === '--input-type=module') execFileSync(process.execPath, args, { input: fs.readFileSync(file), stdio: ['pipe', 'pipe', 'pipe'] });
      else execFileSync(process.execPath, args, { stdio: 'pipe' });
      checked++;
    } catch (e) {
      failed++;
      console.error(`syntax error: ${path.relative(root, file)}\n${String(e.stderr || e.message)}`);
    }
  }
}
console.log(`checked ${checked} files, ${failed} with syntax errors`);
process.exit(failed ? 1 : 0);
