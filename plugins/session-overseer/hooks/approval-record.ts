// FR-14 approval record: what the person typed, captured from the raw prompt (not the
// transcript). Masking, the 4 KB cap and file mode 0600 happen in the store bridge (scripts/store.cjs).
// Rating tokens (FR-17, `r12 y`) are never recorded. Pure: no engine access.

export const RATING = /^r[0-9]+ [yn]$/

export type ApprovalRecord = { message_id: string; ts: string; exact_text: string; scope: null }

export function approvalRecord(text: string, ts: string, messageId: string): ApprovalRecord | null {
  if (!text.trim() || RATING.test(text.trim())) return null
  return { message_id: messageId, ts, exact_text: text, scope: null }
}
