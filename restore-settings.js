const fs = require('fs');
let ns = fs.readFileSync('services/notificationService.js', 'utf8');

// The corrupted block has excessive leading spaces and wrong indentation
// Fix line 76: too many leading spaces before "const result"
const lines = ns.split('\n');
for (let i = 0; i < lines.length; i++) {
  // Fix line 76 (index 75): const result has 50 spaces, should have 10
  if (lines[i].includes('const result = await pushService.sendPushToUser(r.id, {') && lines[i].length > 20) {
    lines[i] = '          const result = await pushService.sendPushToUser(r.id, {';
  }
  // Fix line 81 (index 80): "if (result.skipped)" has 1 space, should have 10
  if (lines[i].trim() === 'if (result.skipped) {' && lines[i].startsWith(' if')) {
    lines[i] = '          if (result.skipped) {';
  }
}

ns = lines.join('\n');
fs.writeFileSync('services/notificationService.js', ns, 'utf8');
console.log('notificationService.js indentation fixed');

// Verify it parses
try {
  new Function(ns);
  console.log('Syntax check: OK');
} catch (e) {
  console.error('Syntax error:', e.message);
}