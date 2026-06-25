const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../../logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function write(level, section, message, err) {
  const ts = new Date().toISOString();
  const errDetail = err ? ` | ${err.stack || err.message}` : '';
  const line = `[${ts}] [${level}] [${section}] ${message}${errDetail}\n`;
  fs.appendFileSync(LOG_FILE, line);
  if (level === 'ERROR') console.error(line.trimEnd());
  else console.warn(line.trimEnd());
}

module.exports = {
  error: (section, message, err) => write('ERROR', section, message, err),
  warn:  (section, message, err) => write('WARN',  section, message, err),
};
