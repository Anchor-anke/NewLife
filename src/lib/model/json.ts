/**
 * 从模型返回的文本里宽松地提取一个 JSON **对象**。
 *
 * 即便请求里已经要求了严格 JSON，实际返回仍可能是三种形态：
 * 裸 JSON、被 ```json 围栏包住的 JSON、以及前后夹带解释文字的 JSON。
 * 直接 `JSON.parse` 会因为后两种白白浪费一次重试，所以这里做一次宽松提取。
 *
 * 刻意拒绝数组：约定的输出结构是一个对象，返回数组说明模型跑偏了，
 * 应该触发一次带错误回灌的重试，而不是把数组交给下游去猜。
 */
export function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const candidates: string[] = [trimmed];

  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed;
    } catch {
      // 换下一个候选
    }
  }
  return null;
}
