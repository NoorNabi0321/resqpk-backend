// Lightweight console logger with timestamps and ANSI colors for development.
// Kept dependency-free so it can be imported from anywhere without cycles.

const COLORS = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
};

function format(color, label, args) {
  const prefix = `${COLORS.gray}[${new Date().toISOString()}]${COLORS.reset} ${color}${label}${COLORS.reset}`;
  return [prefix, ...args];
}

const logger = {
  info(...args) {
    console.log(...format(COLORS.green, 'INFO ', args));
  },
  warn(...args) {
    console.warn(...format(COLORS.yellow, 'WARN ', args));
  },
  error(...args) {
    console.error(...format(COLORS.red, 'ERROR', args));
  },
  debug(...args) {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(...format(COLORS.blue, 'DEBUG', args));
    }
  },
};

export default logger;
