import { D1_MAX_BOUND_PARAMETERS } from "../../src";

/**
 * Wraps a local D1 binding so tests see what production D1 enforces but local SQLite does not: a statement binding
 * more than 100 parameters fails as it would on Cloudflare. It also records executed statements (for the
 * 1000-queries-per-invocation budget) and can run a hook before a statement executes, to interleave a competing
 * write at a precise point.
 */
export interface InstrumentedD1 {
  d1: D1Database;
  /** SQL of every statement executed, including each member of a batch. */
  executed: string[];
  /** Largest number of parameters any statement bound. */
  maxBoundParameters(): number;
}

export interface InstrumentOptions {
  /** Awaited before each statement (or batch member) executes; receives its SQL. */
  beforeExecute?: (sql: string) => Promise<void> | void;
}

const EXECUTORS = new Set<PropertyKey>(["all", "raw", "run", "first"]);

type AnyFunction = (...args: unknown[]) => unknown;

export function instrumentD1(d1: D1Database, options: InstrumentOptions = {}): InstrumentedD1 {
  const executed: string[] = [];
  let maxBound = 0;
  // Wrapped statement -> the real statement and its SQL, so batches hand D1 the originals.
  const originals = new WeakMap<object, { statement: D1PreparedStatement; sql: string }>();

  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => {
            maxBound = Math.max(maxBound, values.length);
            if (values.length > D1_MAX_BOUND_PARAMETERS) {
              throw new Error(
                `D1 allows at most ${D1_MAX_BOUND_PARAMETERS} bound parameters; this statement binds ${values.length}: ${sql}`,
              );
            }
            return wrap(target.bind(...values), sql);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (EXECUTORS.has(property)) {
          return async (...args: unknown[]) => {
            await options.beforeExecute?.(sql);
            executed.push(sql);
            return (value as AnyFunction).apply(target, args);
          };
        }
        return (value as AnyFunction).bind(target);
      },
    });
    originals.set(proxy, { statement, sql });
    return proxy;
  };

  const database = new Proxy(d1, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const members = statements.map((statement) => originals.get(statement) ?? { statement, sql: "" });
          for (const member of members) await options.beforeExecute?.(member.sql);
          executed.push(...members.map((member) => member.sql));
          return target.batch(members.map((member) => member.statement));
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as AnyFunction).bind(target) : value;
    },
  });

  return { d1: database, executed, maxBoundParameters: () => maxBound };
}
