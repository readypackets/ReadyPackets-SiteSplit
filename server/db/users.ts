/**
 * User data access.
 *
 * Every write path that touches the email address also writes `email_index`;
 * this is the single invariant that keeps login working on an encrypted install.
 * Decryption is centralised in {@link decryptUser} so no caller can accidentally
 * expose a ciphertext envelope to the API surface.
 */
import { and, desc, eq, isNull, like, or, sql } from "drizzle-orm";
import { db } from "./client.js";
import { users, userProfileValues } from "./schema.js";
import { blindIndex, decryptField, encryptField, generateCustomerNumber } from "../security/crypto.js";
import type { UserRole } from "../../shared/domain.js";
import { insertedId } from "./result.js";

export interface DecryptedUser {
  id: number;
  email: string;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  preferredName: string | null;
  suffix: string | null;
  company: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  role: UserRole;
  loginMethod: string;
  samlLoginEnabled: boolean;
  status: string;
  emailVerified: boolean;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
  marketingOptIn: boolean;
  timezone: string;
  onboardingCompletedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  passwordHash: string | null;
  avatarStorageKey: string | null;
  referralCode: string | null;
  customerNumber: string | null;
  publicId: string | null;
}

type UserRow = typeof users.$inferSelect;

/** The name shown throughout the platform: preferred name wins when present. */
export function displayNameOf(user: {
  preferredName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string;
}): string {
  const first = user.preferredName?.trim() || user.firstName?.trim() || "";
  const last = user.lastName?.trim() ?? "";
  const combined = `${first} ${last}`.trim();
  return combined || user.email;
}

export function decryptUser(row: UserRow): DecryptedUser {
  const aad = `user:${row.id}`;
  return {
    id: row.id,
    email: decryptField(row.emailEnc, aad) ?? "",
    firstName: decryptField(row.firstNameEnc, aad),
    middleName: decryptField(row.middleNameEnc, aad),
    lastName: decryptField(row.lastNameEnc, aad),
    preferredName: decryptField(row.preferredNameEnc, aad),
    suffix: decryptField(row.suffixEnc, aad),
    company: decryptField(row.companyEnc, aad),
    phone: decryptField(row.phoneEnc, aad),
    address: decryptField(row.addressEnc, aad),
    notes: decryptField(row.notesEnc, aad),
    role: row.role as UserRole,
    loginMethod: row.loginMethod,
    samlLoginEnabled: row.samlLoginEnabled,
    status: row.status,
    emailVerified: row.emailVerified,
    mustChangePassword: row.mustChangePassword,
    mfaEnabled: row.mfaEnabled,
    marketingOptIn: row.marketingOptIn,
    timezone: row.timezone,
    onboardingCompletedAt: row.onboardingCompletedAt,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    passwordHash: row.passwordHash,
    avatarStorageKey: row.avatarStorageKey ?? null,
    referralCode: row.referralCode ?? null,
    customerNumber: row.customerNumber ?? null,
    publicId: row.publicId ?? null,
  };
}

export interface CreateUserInput {
  email: string;
  passwordHash?: string | null;
  role?: UserRole;
  loginMethod?: string;
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
  preferredName?: string | null;
  suffix?: string | null;
  company?: string | null;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  emailVerified?: boolean;
  mustChangePassword?: boolean;
  marketingOptIn?: boolean;
}

export async function createUser(input: CreateUserInput): Promise<DecryptedUser> {
  const email = input.email.trim().toLowerCase();
  const domain = email.includes("@") ? email.split("@")[1] ?? null : null;

  // Insert with a placeholder, then re-encrypt with the row id bound as AAD.
  const inserted = await db.insert(users).values({
    emailIndex: blindIndex(email),
    emailEnc: encryptField(email, "user:pending") ?? "",
    emailDomain: domain,
    passwordHash: input.passwordHash ?? null,
    role: input.role ?? "customer",
    loginMethod: input.loginMethod ?? "local",
    emailVerified: input.emailVerified ?? false,
    mustChangePassword: input.mustChangePassword ?? false,
    marketingOptIn: input.marketingOptIn ?? false,
    passwordChangedAt: input.passwordHash ? new Date() : null,
  });

  const userId = insertedId(inserted);
  const aad = `user:${userId}`;
  const basePatch = {
    emailEnc: encryptField(email, aad) ?? "",
    firstNameEnc: encryptField(input.firstName ?? null, aad),
    middleNameEnc: encryptField(input.middleName ?? null, aad),
    lastNameEnc: encryptField(input.lastName ?? null, aad),
    preferredNameEnc: encryptField(input.preferredName ?? null, aad),
    suffixEnc: encryptField(input.suffix ?? null, aad),
    companyEnc: encryptField(input.company ?? null, aad),
    phoneEnc: encryptField(input.phone ?? null, aad),
    addressEnc: encryptField(input.address ?? null, aad),
    notesEnc: encryptField(input.notes ?? null, aad),
  };

  // The database unique index is authoritative. Retrying a collision keeps the
  // opaque ID non-sequential without ever exposing the internal user primary key.
  let persisted = false;
  let lastError: unknown;
  for (let attempt = 0; attempt < 5 && !persisted; attempt += 1) {
    try {
      const customerNumber = generateCustomerNumber();
      await db
        .update(users)
        .set({ ...basePatch, customerNumber, publicId: customerNumber })
        .where(eq(users.id, userId));
      persisted = true;
    } catch (error) {
      lastError = error;
    }
  }
  if (!persisted) {
    throw lastError instanceof Error ? lastError : new Error("Unable to allocate a unique customer ID.");
  }

  const created = await getUserById(userId);
  if (!created) throw new Error("User creation failed to persist");
  return created;
}

export async function getUserById(userId: number): Promise<DecryptedUser | null> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  const row = rows[0];
  return row ? decryptUser(row) : null;
}

/** Lookup by email via the HMAC blind index — the only supported email query. */
export async function getUserByEmail(email: string): Promise<DecryptedUser | null> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.emailIndex, blindIndex(email)), isNull(users.deletedAt)))
    .limit(1);
  const row = rows[0];
  return row ? decryptUser(row) : null;
}

export async function emailExists(email: string): Promise<boolean> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.emailIndex, blindIndex(email)))
    .limit(1);
  return rows.length > 0;
}

export interface UpdateProfileInput {
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
  preferredName?: string | null;
  suffix?: string | null;
  company?: string | null;
  phone?: string | null;
  address?: string | null;
  timezone?: string;
  marketingOptIn?: boolean;
}

export async function updateUserProfile(
  userId: number,
  input: UpdateProfileInput,
): Promise<void> {
  const aad = `user:${userId}`;
  const patch: Partial<typeof users.$inferInsert> = {};
  if (input.firstName !== undefined) patch.firstNameEnc = encryptField(input.firstName, aad);
  if (input.middleName !== undefined) patch.middleNameEnc = encryptField(input.middleName, aad);
  if (input.lastName !== undefined) patch.lastNameEnc = encryptField(input.lastName, aad);
  if (input.preferredName !== undefined) {
    patch.preferredNameEnc = encryptField(input.preferredName, aad);
  }
  if (input.suffix !== undefined) patch.suffixEnc = encryptField(input.suffix, aad);
  if (input.company !== undefined) patch.companyEnc = encryptField(input.company, aad);
  if (input.phone !== undefined) patch.phoneEnc = encryptField(input.phone, aad);
  if (input.address !== undefined) patch.addressEnc = encryptField(input.address, aad);
  if (input.timezone !== undefined) patch.timezone = input.timezone;
  if (input.marketingOptIn !== undefined) patch.marketingOptIn = input.marketingOptIn;
  if (Object.keys(patch).length === 0) return;
  await db.update(users).set(patch).where(eq(users.id, userId));
}

export async function updateEmail(userId: number, email: string): Promise<void> {
  const normalised = email.trim().toLowerCase();
  const aad = `user:${userId}`;
  await db
    .update(users)
    .set({
      emailEnc: encryptField(normalised, aad) ?? "",
      emailIndex: blindIndex(normalised),
      emailDomain: normalised.includes("@") ? normalised.split("@")[1] ?? null : null,
      emailVerified: false,
    })
    .where(eq(users.id, userId));
}

export async function setPasswordHash(
  userId: number,
  passwordHash: string,
  options: { mustChangePassword?: boolean } = {},
): Promise<void> {
  await db
    .update(users)
    .set({
      passwordHash,
      passwordChangedAt: new Date(),
      mustChangePassword: options.mustChangePassword ?? false,
      failedLoginCount: 0,
      lockedUntil: null,
    })
    .where(eq(users.id, userId));
}

export async function setAdminNotes(userId: number, notes: string | null): Promise<void> {
  await db
    .update(users)
    .set({ notesEnc: encryptField(notes, `user:${userId}`) })
    .where(eq(users.id, userId));
}

export async function recordSuccessfulLogin(
  userId: number,
  ipAddress: string | null,
): Promise<void> {
  await db
    .update(users)
    .set({
      lastLoginAt: new Date(),
      lastLoginIp: ipAddress?.slice(0, 64) ?? null,
      failedLoginCount: 0,
      lockedUntil: null,
    })
    .where(eq(users.id, userId));
}

/**
 * Record a failed attempt and lock the account when the threshold is reached.
 * Returns the resulting lock expiry, if any.
 */
export async function recordFailedLogin(
  userId: number,
  threshold: number,
  lockMinutes: number,
): Promise<Date | null> {
  const rows = await db
    .select({ count: users.failedLoginCount })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const nextCount = (rows[0]?.count ?? 0) + 1;
  const lockedUntil = nextCount >= threshold ? new Date(Date.now() + lockMinutes * 60_000) : null;
  await db
    .update(users)
    .set({ failedLoginCount: nextCount, lockedUntil })
    .where(eq(users.id, userId));
  return lockedUntil;
}

export async function isAccountLocked(userId: number): Promise<Date | null> {
  const rows = await db
    .select({ lockedUntil: users.lockedUntil })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const lockedUntil = rows[0]?.lockedUntil ?? null;
  if (lockedUntil && lockedUntil.getTime() > Date.now()) return lockedUntil;
  return null;
}

export async function markEmailVerified(userId: number): Promise<void> {
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, userId));
}

export async function setMfaEnabled(userId: number, enabled: boolean): Promise<void> {
  await db.update(users).set({ mfaEnabled: enabled }).where(eq(users.id, userId));
}

export async function setUserRole(userId: number, role: UserRole): Promise<void> {
  await db.update(users).set({ role }).where(eq(users.id, userId));
}

export async function setUserStatus(userId: number, status: string): Promise<void> {
  await db.update(users).set({ status }).where(eq(users.id, userId));
}

export async function setLoginMethod(userId: number, method: string): Promise<void> {
  await db.update(users).set({ loginMethod: method }).where(eq(users.id, userId));
}

export async function completeOnboarding(userId: number): Promise<void> {
  await db
    .update(users)
    .set({ onboardingCompletedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function softDeleteUser(userId: number): Promise<void> {
  await db
    .update(users)
    .set({ deletedAt: new Date(), status: "deleted" })
    .where(eq(users.id, userId));
}

export async function restoreUser(userId: number): Promise<void> {
  await db
    .update(users)
    .set({ deletedAt: null, status: "active" })
    .where(eq(users.id, userId));
}

export interface ListUsersOptions {
  role?: UserRole;
  status?: string;
  /** Matches on email domain and creation date only; encrypted fields are not searchable. */
  domain?: string;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export async function listUsers(options: ListUsersOptions = {}): Promise<DecryptedUser[]> {
  const conditions = [] as ReturnType<typeof eq>[];
  if (!options.includeDeleted) conditions.push(isNull(users.deletedAt) as never);
  if (options.role) conditions.push(eq(users.role, options.role));
  if (options.status) conditions.push(eq(users.status, options.status));
  if (options.domain) conditions.push(like(users.emailDomain, `%${options.domain}%`) as never);

  const rows = await db
    .select()
    .from(users)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(users.createdAt))
    .limit(Math.min(options.limit ?? 50, 500))
    .offset(options.offset ?? 0);

  return rows.map(decryptUser);
}

export async function countUsers(options: ListUsersOptions = {}): Promise<number> {
  const conditions = [] as ReturnType<typeof eq>[];
  if (!options.includeDeleted) conditions.push(isNull(users.deletedAt) as never);
  if (options.role) conditions.push(eq(users.role, options.role));
  if (options.status) conditions.push(eq(users.status, options.status));
  const rows = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(users)
    .where(conditions.length > 0 ? and(...conditions) : undefined);
  return Number(rows[0]?.total ?? 0);
}

/**
 * Search users by decrypting candidate rows in the application layer.
 * Encrypted columns cannot be matched in SQL, so the candidate set is bounded
 * and the filter is applied after decryption.
 */
export async function searchUsers(term: string, limit = 50): Promise<DecryptedUser[]> {
  const normalised = term.trim().toLowerCase();
  if (!normalised) return listUsers({ limit });

  // An exact email match is resolvable through the blind index without a scan.
  if (normalised.includes("@")) {
    const exact = await getUserByEmail(normalised);
    if (exact) return [exact];
  }

  const rows = await db
    .select()
    .from(users)
    .where(
      or(
        isNull(users.deletedAt),
        sql`${users.deletedAt} IS NULL`,
      ),
    )
    .orderBy(desc(users.createdAt))
    .limit(2_000);

  const matches: DecryptedUser[] = [];
  for (const row of rows) {
    const user = decryptUser(row);
    const haystack = [
      user.email,
      user.firstName,
      user.lastName,
      user.preferredName,
      user.company,
      user.phone,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (haystack.includes(normalised)) matches.push(user);
    if (matches.length >= limit) break;
  }
  return matches;
}

export async function getProfileValues(userId: number): Promise<Record<string, string | null>> {
  const rows = await db
    .select()
    .from(userProfileValues)
    .where(eq(userProfileValues.userId, userId));
  const output: Record<string, string | null> = {};
  for (const row of rows) {
    output[row.fieldKey] = decryptField(row.valueEnc, `profile:${userId}:${row.fieldKey}`);
  }
  return output;
}

export async function setProfileValue(
  userId: number,
  fieldKey: string,
  value: string | null,
): Promise<void> {
  const encrypted = encryptField(value, `profile:${userId}:${fieldKey}`);
  await db
    .insert(userProfileValues)
    .values({ userId, fieldKey, valueEnc: encrypted })
    .onDuplicateKeyUpdate({ set: { valueEnc: encrypted } });
}
