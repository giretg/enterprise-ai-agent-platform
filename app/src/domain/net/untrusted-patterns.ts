// Shared deterministic guards for untrusted web/content-derived data.
export const FORBIDDEN_HOST_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'raw_ip_host', pattern: /^\d{1,3}(\.\d{1,3}){3}$/ },
  { name: 'localhost_host', pattern: /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i },
  { name: 'metadata_host', pattern: /(169\.254\.169\.254|metadata\.google\.internal)/i },
  { name: 'known_exfil_sink', pattern: /(webhook\.site|requestbin|ngrok\.io|burpcollaborator)/i },
]

export const FORBIDDEN_PATH_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'data_uri_path', pattern: /^data:/i },
  { name: 'file_uri_path', pattern: /^file:/i },
]

export const SECRET_LIKE_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'bearer_literal', pattern: /\bbearer\s+[A-Za-z0-9._\-]{12,}/i },
  { name: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'long_hex_token', pattern: /\b[0-9a-f]{40,}\b/i },
  { name: 'jwt_like', pattern: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/ },
]
