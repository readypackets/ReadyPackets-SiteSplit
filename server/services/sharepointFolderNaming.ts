/**
 * Deterministic names for ReadyPackets-managed SharePoint customer and order
 * folders. They are deliberately conservative so customer-controlled input
 * cannot introduce traversal, nested folders, control characters, or Windows
 * reserved device names into the external document library.
 */
export function normalizeSharepointIdentitySegment(value: string, fallback: string): string {
  const normalized = value.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[^A-Za-z0-9 _().@+-]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  const safe = normalized && normalized !== "." && normalized !== ".." ? normalized : fallback;
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe);
  return `${reserved ? "rp_" : ""}${safe}`.slice(0, 96);
}

export function buildSharepointCustomerFolderName(input: { email: string; customerId: string }): string {
  const email = normalizeSharepointIdentitySegment(input.email.toLowerCase(), "customer");
  const customerId = normalizeSharepointIdentitySegment(input.customerId, "RP-CUS-UNKNOWN");
  return `${email}-${customerId}`.slice(0, 180);
}

export function buildSharepointOrderFolderName(input: { projectName: string; orderNumber: string }): string {
  const projectName = normalizeSharepointIdentitySegment(input.projectName, "Order");
  const orderNumber = normalizeSharepointIdentitySegment(input.orderNumber, "RP-ORDER");
  return `${projectName}-${orderNumber}`.slice(0, 180);
}
