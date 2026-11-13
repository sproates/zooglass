import { Decimal, type Json } from "./json.js";
export function invalid(path: string, message: string): never {
  throw new Error(`invalid-scenario: ${path}: ${message}`);
}
export function object(
  value: Json | undefined,
  path: string,
  fields?: string[],
): { [key: string]: Json } {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Decimal
  )
    return invalid(path, "expected object");
  if (fields) {
    for (const key of Object.keys(value))
      if (!fields.includes(key)) invalid(`${path}.${key}`, "unknown field");
    for (const key of fields)
      if (!Object.hasOwn(value, key))
        invalid(`${path}.${key}`, "required field");
  }
  return value;
}
export function text(value: Json | undefined, path: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024)
    return invalid(path, "expected nonblank string, at most 1024 characters");
  return value;
}
export function integer(
  value: Json | undefined,
  path: string,
  max = Number.MAX_SAFE_INTEGER,
  min = 0,
): number {
  const number =
    value instanceof Decimal && !value.text.includes(".")
      ? Number(value.text)
      : NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max)
    return invalid(path, `expected integer ${min}..${max}`);
  return number;
}
export function list(
  value: Json | undefined,
  path: string,
  max = 1000,
): Json[] {
  if (!Array.isArray(value) || value.length > max)
    return invalid(path, `expected array with at most ${max} entries`);
  return value;
}
export function choice(
  value: Json | undefined,
  path: string,
  choices: readonly string[],
): string {
  const result = text(value, path);
  if (!choices.includes(result))
    return invalid(path, `supported values: ${choices.join(", ")}`);
  return result;
}
export function unique(id: string, seen: Set<string>, path: string) {
  if (seen.has(id)) invalid(path, `duplicate identity ${id}`);
  seen.add(id);
}
export function reference(
  value: Json | undefined,
  ids: Set<string>,
  path: string,
): string {
  const id = text(value, path);
  if (!ids.has(id)) invalid(path, `unknown identity ${id}`);
  return id;
}
