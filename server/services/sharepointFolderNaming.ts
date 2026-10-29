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

/**
 * Create the immutable, data-minimised customer label for a newly created order.
 * Existing order snapshots are intentionally never recalculated: changing a
 * customer's name must not move or duplicate external SharePoint evidence.
 */
export function buildSharepointCustomerFolderName(input: {
  firstName: string | null | undefined;
  lastName: string | null | undefined;
  customerId: string;
}): string {
  const customerId = normalizeSharepointIdentitySegment(input.customerId, "RP-CUS-UNKNOWN");
  const firstName = normalizeSharepointIdentitySegment(input.firstName ?? "", "");
  const lastName = normalizeSharepointIdentitySegment(input.lastName ?? "", "");
  const humanParts = [firstName.slice(0, 2), lastName].filter(Boolean);
  const humanLabel = humanParts.join("-") || "Customer";
  // Keep the opaque customer identifier intact even if an unexpectedly long
  // legal name must be shortened. It is the collision-resistant component.
  const maximumHumanLength = Math.max(1, 180 - customerId.length - 1);
  return `${humanLabel.slice(0, maximumHumanLength)}-${customerId}`;
}

export function buildSharepointOrderFolderName(input: { projectName: string; orderNumber: string }): string {
  const projectName = normalizeSharepointIdentitySegment(input.projectName, "Order");
  const orderNumber = normalizeSharepointIdentitySegment(input.orderNumber, "RP-ORDER");
  return `${projectName}-${orderNumber}`.slice(0, 180);
}
