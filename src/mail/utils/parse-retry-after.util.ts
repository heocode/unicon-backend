export function parseRetryAfterSeconds(
  headers: Readonly<Record<string, string>> | null,
  operationNow: Date,
): number | undefined {
  const rawValue = findHeader(headers, 'retry-after');

  if (!rawValue) {
    return undefined;
  }

  if (/^[0-9]+$/.test(rawValue)) {
    const seconds = Number(rawValue);

    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }

  if (
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(
      rawValue,
    )
  ) {
    return undefined;
  }

  const retryAtMilliseconds = Date.parse(rawValue);

  if (!Number.isFinite(retryAtMilliseconds)) {
    return undefined;
  }

  return Math.max(
    0,
    Math.ceil((retryAtMilliseconds - operationNow.getTime()) / 1_000),
  );
}

function findHeader(
  headers: Readonly<Record<string, string>> | null,
  expectedName: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === expectedName,
  );

  return entry?.[1].trim();
}
