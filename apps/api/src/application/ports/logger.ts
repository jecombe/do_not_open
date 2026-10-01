/** The slice of pino the core uses, so tests can pass a silent one. */
export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };
