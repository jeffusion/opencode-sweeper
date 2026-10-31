const AUTH_VALUE = /\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_FIELD =
  /(["']?)\b(authorization|password|token|secret)\b\1(\s*[:=]\s*)((?:"[^"]*"|'[^']*'|[^\s,;}\]]+))/gi;

function redactField(
  _match: string,
  keyQuote: string,
  key: string,
  separator: string,
  value: string,
): string {
  const valueQuote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
  return `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[redacted]${valueQuote}`;
}

/** Remove authorization schemes, secret fields and the configured server password from a message. */
export function redactSecrets(message: string): string {
  const redacted = message.replace(AUTH_VALUE, "$1 [redacted]").replace(SECRET_FIELD, redactField);
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  return password ? redacted.split(password).join("[redacted]") : redacted;
}
