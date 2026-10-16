import { existsSync } from 'node:fs';
import path from 'node:path';

// Reuse only the executable; every test/development instance has separate data and ports.
export function configureMongoBinary() {
  if (process.env.MONGOMS_SYSTEM_BINARY) return;
  if (process.platform !== 'win32') return;
  for (const version of ['8.2', '8.0', '7.0']) {
    const binary = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'MongoDB', 'Server', version, 'bin', 'mongod.exe');
    if (existsSync(binary)) {
      process.env.MONGOMS_SYSTEM_BINARY = binary;
      process.env.MONGOMS_SYSTEM_BINARY_VERSION_CHECK = 'false';
      return;
    }
  }
}
