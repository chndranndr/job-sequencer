import { runStructured, type StructuredRunOptions } from "../structured.js";

export async function runAgentStructured<T>(options: StructuredRunOptions<T>): Promise<T> {
  return runStructured({ ...options, maxAttempts: 2 });
}
