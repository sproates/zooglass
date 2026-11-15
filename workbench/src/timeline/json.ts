/** Lossless JSON for versioned simulation documents, never JavaScript payload numbers. */
export class Decimal {
  constructor(readonly text: string) {}
}
export type Json =
  null | boolean | string | Decimal | Json[] | { [key: string]: Json };
export const jsonLimits = { bytes: 16 * 1024 * 1024, depth: 64, digits: 4096 };

function decimal(token: string): Decimal {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)!;
  const [, sign, whole, fraction = "", power = "0"] = match;
  const exponent = Number(power);
  if (
    !Number.isSafeInteger(exponent) ||
    Math.abs(exponent) > jsonLimits.digits ||
    whole.length + fraction.length > jsonLimits.digits
  ) {
    throw new Error("invalid-json: decimal digit/exponent limit");
  }
  const digits = whole + fraction;
  const point = whole.length + exponent;
  if (Math.max(point, digits.length - point) > jsonLimits.digits) {
    throw new Error("invalid-json: expanded decimal limit");
  }
  let value =
    point <= 0
      ? "0." + "0".repeat(-point) + digits
      : point >= digits.length
        ? digits + "0".repeat(point - digits.length)
        : digits.slice(0, point) + "." + digits.slice(point);
  if (value.replace(".", "").length > jsonLimits.digits)
    throw new Error("invalid-json: expanded decimal digit limit");
  value = value
    .replace(/^0+(?=\d)/, "")
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
  return new Decimal((sign && value !== "0" ? "-" : "") + value);
}

function scalarString(value: string) {
  for (const point of value) {
    const code = point.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff)
      throw new Error("invalid-json: unpaired surrogate");
  }
  return value;
}

/** A caller may narrow the canonical budget, for example for the remaining JSONL artifact. */
export function parseJson(
  text: string,
  canonicalByteLimit = jsonLimits.bytes,
): Json {
  if (!Number.isSafeInteger(canonicalByteLimit) || canonicalByteLimit < 0)
    throw new Error(
      "invalid-json: canonical byte budget must be a nonnegative safe integer",
    );
  if (Buffer.byteLength(text) > jsonLimits.bytes)
    throw new Error("invalid-json: byte limit");
  const limit = Math.min(jsonLimits.bytes, canonicalByteLimit);
  let canonicalBytes = 0;
  const reserve = (bytes: number) => {
    canonicalBytes += bytes;
    if (canonicalBytes > limit)
      throw new Error("invalid-json: canonical byte limit");
  };
  let offset = 0;
  const whitespace = () => {
    while (/[ \t\r\n]/.test(text[offset] ?? "\0")) offset++;
  };
  const fail = (): never => {
    throw new Error(`invalid-json at character ${offset}`);
  };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === "\\") {
        offset++;
        continue;
      }
      if (char === '"') {
        const decoded = scalarString(
          JSON.parse(text.slice(start, offset)) as string,
        );
        reserve(Buffer.byteLength(JSON.stringify(decoded)));
        return decoded;
      }
    }
    return fail();
  };
  const value = (depth: number): Json => {
    whitespace();
    if (depth > jsonLimits.depth)
      throw new Error("invalid-json: nesting limit");
    if (text[offset] === '"') return string();
    if (text[offset] === "{" || text[offset] === "[") {
      reserve(2); // Both delimiters are present in every canonical container.
      const object = text[offset++] === "{";
      const result: { [key: string]: Json } = Object.create(null);
      const array: Json[] = [];
      const end = object ? "}" : "]";
      whitespace();
      if (text[offset] === end) {
        offset++;
        return object ? result : array;
      }
      for (;;) {
        if (object) {
          whitespace();
          if (text[offset] !== '"') fail();
          const key = string();
          if (Object.hasOwn(result, key))
            throw new Error(`invalid-json: duplicate key ${key}`);
          whitespace();
          if (text[offset++] !== ":") fail();
          reserve(1);
          result[key] = value(depth + 1);
        } else array.push(value(depth + 1));
        whitespace();
        if (text[offset] === end) {
          offset++;
          return object ? result : array;
        }
        if (text[offset++] !== ",") fail();
        reserve(1);
      }
    }
    for (const [literal, parsed] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        reserve(literal.length);
        return parsed;
      }
    }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      text.slice(offset),
    );
    if (!token) return fail();
    offset += token[0].length;
    const number = decimal(token[0]);
    reserve(number.text.length);
    return number;
  };
  const parsed = value(0);
  whitespace();
  if (offset !== text.length) fail();
  return parsed;
}

/** Unicode code-point order, not UTF-16 code-unit order. */
function compareKeys(a: string, b: string) {
  const left = Array.from(a, (c) => c.codePointAt(0)!);
  const right = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}
export function encodeJson(value: Json): string {
  if (value instanceof Decimal) return value.text;
  if (Array.isArray(value)) return "[" + value.map(encodeJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort(compareKeys)
        .map((key) => JSON.stringify(key) + ":" + encodeJson(value[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}
export function canonicalJson(
  text: string,
  canonicalByteLimit = jsonLimits.bytes,
): string {
  const encoded = encodeJson(parseJson(text, canonicalByteLimit));
  if (
    Buffer.byteLength(encoded) > Math.min(jsonLimits.bytes, canonicalByteLimit)
  )
    throw new Error("invalid-json: canonical byte limit");
  return encoded;
}
