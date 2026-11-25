/**
 * Session ids come out of log contents, which are untrusted, and end up in paths that are read and, for deletion, removed.
 * Only letters, digits, `_` and `-` pass: no dot or slash, so `..` or `a/b` can never name another folder.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

export const isSafeSessionId = (id: unknown): id is string => typeof id === 'string' && SAFE_SESSION_ID.test(id);
