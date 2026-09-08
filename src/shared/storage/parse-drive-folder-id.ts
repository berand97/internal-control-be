export const parseDriveFolderId = (
  raw: string | null | undefined,
): string | null | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null) {
    return null;
  }
  const value = raw.trim();
  if (value === '') {
    return null;
  }
  const fromFolders = /\/folders\/([a-zA-Z0-9_-]+)/.exec(value);
  if (fromFolders?.[1]) {
    return fromFolders[1];
  }
  const fromQuery = /[?&]id=([a-zA-Z0-9_-]+)/.exec(value);
  if (fromQuery?.[1]) {
    return fromQuery[1];
  }
  return value;
};
