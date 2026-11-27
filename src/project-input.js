export const MAX_PROJECT_BYTES = 32 * 1024 * 1024;

// Reject excessive structure before JSON.parse allocates an object graph.
// A full library has at most 12 * 3601 samples; leave room for curve arrays.
export function checkProjectJSON(text, reject, { maxBytes = MAX_PROJECT_BYTES, maxStringLength = 8192 } = {}) {
  if (text.length > maxBytes || utf8Length(text, maxBytes) > maxBytes) reject('프로젝트 파일은 최대 32 MiB까지 지원합니다.');
  let depth = 0, containers = 0, separators = 0, quoted = false, escaped = false, stringLength = 0;
  for (const character of text) {
    if (quoted) {
      if (++stringLength > maxStringLength) reject('프로젝트 문자열이 허용 길이를 초과합니다.');
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') { quoted = true; stringLength = 0; }
    else if (character === '{' || character === '[') {
      if (++depth > 16 || ++containers > 100000) reject('프로젝트 구조가 허용 복잡도를 초과합니다.');
    } else if (character === '}' || character === ']') {
      if (--depth < 0) reject('JSON 구조가 올바르지 않습니다.');
    }
    else if ((character === ',' || character === ':') && ++separators > 3000000) reject('프로젝트 항목 수가 허용 범위를 초과합니다.');
  }
}

// Count bytes without allocating a second copy of the input.
export function utf8Length(text, limit = Infinity) {
  let bytes = text.length;
  for (let i = 0; i < text.length && bytes <= limit; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 2;
      i++;
    } else if (unit >= 0x800) bytes += 2;
    else if (unit >= 0x80) bytes++;
  }
  return bytes;
}

export function parseBoundedJSON(text, limits) {
  checkProjectJSON(text, message => { throw new Error(message); }, limits);
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}
