export const MAX_PROJECT_BYTES = 32 * 1024 * 1024;

// Reject excessive structure before JSON.parse allocates an object graph.
// A full library has at most 12 * 3601 samples; leave room for curve arrays.
export function checkProjectJSON(text, reject) {
  if (text.length > MAX_PROJECT_BYTES) reject('프로젝트 파일은 최대 32 MiB까지 지원합니다.');
  let depth = 0, containers = 0, separators = 0, quoted = false, escaped = false, stringLength = 0;
  for (const character of text) {
    if (quoted) {
      if (++stringLength > 8192) reject('프로젝트 문자열이 허용 길이를 초과합니다.');
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') { quoted = true; stringLength = 0; }
    else if (character === '{' || character === '[') {
      if (++depth > 16 || ++containers > 100000) reject('프로젝트 구조가 허용 복잡도를 초과합니다.');
    } else if (character === '}' || character === ']') depth--;
    else if ((character === ',' || character === ':') && ++separators > 3000000) reject('프로젝트 항목 수가 허용 범위를 초과합니다.');
  }
}
