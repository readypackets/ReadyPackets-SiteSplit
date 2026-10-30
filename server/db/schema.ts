/**
 * Drizzle schema — 69 tables across eleven domains.
 *
 * Conventions:
 *  - MySQL table names are snake_case; TypeScript exports are camelCase.
 *  - Money is always an integer number of cents. No floating point.
 *  - Columns holding personal data are suffixed `Enc` and store an AES-256-GCM
 *    envelope; every searchable encrypted column has a companion blind index.
 *  - Soft deletion uses `deletedAt`; a retention sweeper purges expired rows.
 */
import {
  bigint,
  boolean,
  char,
  index,
  int,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  tinyint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

const id = () => int("id").autoincrement().primaryKey();
const createdAt = () => timestamp("created_at").notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at").notNull().defaultNow().onUpdateNow();

/* ------------------------------------------------------------------ */
/* Identity and access                                                 */
/* ------------------------------------------------------------------ */

export const users = mysqlTable(
  "users",
  {
    id: id(),
    /** HMAC blind index of the lowercased email. Mandatory on every write. */
    emailIndex: varchar("email_index", { length: 64 }).notNull(),
    emailEnc: text("email_enc").notNull(),
    /** Lowercased domain only, kept in clear for abuse analytics. */
    emailDomain: varchar("email_domain", { length: 190 }),
    firstNameEnc: text("first_name_enc"),
    middleNameEnc: text("middle_name_enc"),
    lastNameEnc: text("last_name_enc"),
    preferredNameEnc: text("preferred_name_enc"),
    suffixEnc: text("suffix_enc"),
    companyEnc: text("company_enc"),
    phoneEnc: text("phone_enc"),
    addressEnc: text("address_enc"),
    passwordHash: varchar("password_hash", { length: 255 }),
    role: varchar("role", { length: 16 }).notNull().default("customer"),
    loginMethod: varchar("login_method", { length: 16 }).notNull().default("local"),
    /** Per-account SAML gate; local conversion disables SSO without changing role or data. */
    samlLoginEnabled: boolean("saml_login_enabled").notNull().default(true),
    /** Keyed opaque identity binding after the first approved SAML assertion; never stores a raw NameID/object ID. */
    samlSubjectIndex: varchar("saml_subject_index", { length: 64 }),
    samlSubjectConfigId: int("saml_subject_config_id"),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    emailVerified: boolean("email_verified").notNull().default(false),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    onboardingCompletedAt: timestamp("onboarding_completed_at"),
    /** When set after onboarding completion, the customer must complete the wizard again. */
    onboardingForcedAt: timestamp("onboarding_forced_at"),
    lastLoginAt: timestamp("last_login_at"),
    lastLoginIp: varchar("last_login_ip", { length: 64 }),
    failedLoginCount: int("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until"),
    passwordChangedAt: timestamp("password_changed_at"),
    notesEnc: text("notes_enc"),
    /** Storage key for the user's avatar image (served via /api/files/avatar/:userId). */
    avatarStorageKey: varchar("avatar_storage_key", { length: 128 }),
    /** Unique referral code generated on first request; used for the referral programme. */
    referralCode: varchar("referral_code", { length: 48 }),
    /** Opaque customer-facing reference in RP-CUS-XXXXXXXX format. */
    customerNumber: varchar("customer_number", { length: 24 }),
    /** Compatibility identifier; customerNumber is the primary customer-facing reference. */
    publicId: varchar("public_id", { length: 32 }),
    marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
    timezone: varchar("timezone", { length: 64 }).notNull().default("America/New_York"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => ({
    emailIndexUnique: uniqueIndex("users_email_index_unique").on(table.emailIndex),
    roleIdx: index("users_role_idx").on(table.role),
    statusIdx: index("users_status_idx").on(table.status),
    deletedIdx: index("users_deleted_idx").on(table.deletedAt),
    referralCodeUnique: uniqueIndex("users_referral_code_unique").on(table.referralCode),
    customerNumberUnique: uniqueIndex("users_customer_number_unique").on(table.customerNumber),
    publicIdUnique: uniqueIndex("users_public_id_unique").on(table.publicId),
    samlSubjectUnique: uniqueIndex("users_saml_subject_unique").on(table.samlSubjectConfigId, table.samlSubjectIndex),
  }),
);

export const userMfa = mysqlTable(
  "user_mfa",
  {
    id: id(),
    userId: int("user_id").notNull(),
    /** TOTP shared secret, stored encrypted. */
    secretEnc: text("secret_enc").notNull(),
    confirmedAt: timestamp("confirmed_at"),
    lastUsedStep: int("last_used_step"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    userUnique: uniqueIndex("user_mfa_user_unique").on(table.userId),
  }),
);

export const userBackupCodes = mysqlTable(
  "user_backup_codes",
  {
    id: id(),
    userId: int("user_id").notNull(),
    /** SHA-256 of the code; the plaintext is shown once at enrolment. */
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    usedAt: timestamp("used_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    userIdx: index("user_backup_codes_user_idx").on(table.userId),
    codeIdx: index("user_backup_codes_hash_idx").on(table.codeHash),
  }),
);

export const userSessions = mysqlTable(
  "user_sessions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("user_id").notNull(),
    csrfSecret: varchar("csrf_secret", { length: 64 }).notNull(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: varchar("user_agent", { length: 255 }),
    /** True until the second factor has been presented for this session. */
    mfaPending: boolean("mfa_pending").notNull().default(false),
    /** Restricted sessions may only complete MFA enrolment or sign out. */
    restricted: boolean("restricted").notNull().default(false),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    revokedReason: varchar("revoked_reason", { length: 190 }),
    createdAt: createdAt(),
  },
  (table) => ({
    userIdx: index("user_sessions_user_idx").on(table.userId),
    statusIdx: index("user_sessions_status_idx").on(table.status),
    expiresIdx: index("user_sessions_expires_idx").on(table.expiresAt),
  }),
);

export const sharepointDelegatedAuthAttempts = mysqlTable(
  "sharepoint_delegated_auth_attempts",
  {
    id: id(),
    /** SHA-256 of the opaque OAuth state; the browser-visible state is never stored plaintext. */
    stateHash: char("state_hash", { length: 64 }).notNull(),
    /** AES-256-GCM protected PKCE verifier; bound to this single authorization attempt. */
    codeVerifierEnc: text("code_verifier_enc").notNull(),
    initiatedByUserId: int("initiated_by_user_id").notNull(),
    requestIp: varchar("request_ip", { length: 64 }),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    stateUnique: uniqueIndex("sharepoint_delegated_auth_state_unique").on(table.stateHash),
    expiryIdx: index("sharepoint_delegated_auth_expiry_idx").on(table.expiresAt),
  }),
);

export const passwordResetTokens = mysqlTable(
  "password_reset_tokens",
  {
    id: id(),
    userId: int("user_id").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    requestIp: varchar("request_ip", { length: 64 }),
    createdAt: createdAt(),
  },
  (table) => ({
    tokenUnique: uniqueIndex("password_reset_token_unique").on(table.tokenHash),
    userIdx: index("password_reset_user_idx").on(table.userId),
  }),
);

export const magicLinkTokens = mysqlTable(
  "magic_link_tokens",
  {
    id: id(),
    userId: int("user_id").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    requestIp: varchar("request_ip", { length: 64 }),
    requestUserAgent: varchar("request_user_agent", { length: 255 }),
    createdAt: createdAt(),
  },
  (table) => ({
    tokenUnique: uniqueIndex("magic_link_token_unique").on(table.tokenHash),
    userIdx: index("magic_link_user_idx").on(table.userId, table.createdAt),
    expiryIdx: index("magic_link_expiry_idx").on(table.expiresAt),
  }),
);

export const emailVerificationTokens = mysqlTable(
  "email_verification_tokens",
  {
    id: id(),
    userId: int("user_id").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    tokenUnique: uniqueIndex("email_verification_token_unique").on(table.tokenHash),
    userIdx: index("email_verification_user_idx").on(table.userId),
  }),
);

export const samlConfigs = mysqlTable("saml_configs", {
  id: id(),
  name: varchar("name", { length: 120 }).notNull(),
  enabled: boolean("enabled").notNull().default(false),
  entryPoint: varchar("entry_point", { length: 500 }).notNull(),
  issuer: varchar("issuer", { length: 255 }).notNull(),
  idpCertificate: text("idp_certificate").notNull(),
  signatureAlgorithm: varchar("signature_algorithm", { length: 32 })
    .notNull()
    .default("sha256"),
  attributeMapping: json("attribute_mapping"),
  defaultRole: varchar("default_role", { length: 16 }).notNull().default("customer"),
  autoProvision: boolean("auto_provision").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const registrationFields = mysqlTable(
  "registration_fields",
  {
    id: id(),
    fieldKey: varchar("field_key", { length: 64 }).notNull(),
    label: varchar("label", { length: 190 }).notNull(),
    helpText: varchar("help_text", { length: 255 }),
    fieldType: varchar("field_type", { length: 24 }).notNull().default("text"),
    options: json("options"),
    required: boolean("required").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    encrypted: boolean("encrypted").notNull().default(true),
    sortOrder: int("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    keyUnique: uniqueIndex("registration_fields_key_unique").on(table.fieldKey),
  }),
);

export const userProfileValues = mysqlTable(
  "user_profile_values",
  {
    userId: int("user_id").notNull(),
    fieldKey: varchar("field_key", { length: 64 }).notNull(),
    valueEnc: text("value_enc"),
    updatedAt: updatedAt(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.fieldKey] }),
  }),
);

/**
 * Append-only ledger for administrator-approved customer ID changes. The
 * unique historic value prevents a retired public ID from ever being assigned
 * to a different account, preserving a durable lookup and audit trail.
 */
export const customerIdChangeHistory = mysqlTable(
  "customer_id_change_history",
  {
    id: id(),
    userId: int("user_id").notNull(),
    previousCustomerId: varchar("previous_customer_id", { length: 24 }).notNull(),
    newCustomerId: varchar("new_customer_id", { length: 24 }).notNull(),
    reason: varchar("reason", { length: 255 }).notNull(),
    changedByUserId: int("changed_by_user_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    previousIdUnique: uniqueIndex("customer_id_change_history_previous_unique").on(table.previousCustomerId),
    userCreatedIdx: index("customer_id_change_history_user_created_idx").on(table.userId, table.createdAt),
  }),
);

export const delegates = mysqlTable(
  "delegates",
  {
    id: id(),
    ownerUserId: int("owner_user_id").notNull(),
    delegateUserId: int("delegate_user_id").notNull(),
    scope: varchar("scope", { length: 32 }).notNull().default("read"),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => ({
    pairIdx: index("delegates_pair_idx").on(table.ownerUserId, table.delegateUserId),
  }),
);

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

export const packetGroups = mysqlTable(
  "packet_groups",
  {
    id: id(),
    slug: varchar("slug", { length: 96 }).notNull(),
    groupNumber: int("group_number").notNull(),
    name: varchar("name", { length: 190 }).notNull(),
    category: varchar("category", { length: 120 }).notNull(),
    summary: text("summary"),
    icon: varchar("icon", { length: 48 }).notNull().default("Layers"),
    listed: boolean("listed").notNull().default(true),
    sortOrder: int("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    slugUnique: uniqueIndex("packet_groups_slug_unique").on(table.slug),
  }),
);

export const products = mysqlTable(
  "products",
  {
    id: id(),
    packetGroupId: int("packet_group_id").notNull(),
    sku: varchar("sku", { length: 64 }).notNull(),
    name: varchar("name", { length: 190 }).notNull(),
    tier: varchar("tier", { length: 24 }).notNull(),
    /** Integer cents. Null means "quote required". */
    priceCents: int("price_cents"),
    customPricing: boolean("custom_pricing").notNull().default(false),
    deliveryEstimate: varchar("delivery_estimate", { length: 96 }).notNull(),
    outcome: text("outcome"),
    description: text("description"),
    listed: boolean("listed").notNull().default(true),
    active: boolean("active").notNull().default(true),
    sortOrder: int("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    skuUnique: uniqueIndex("products_sku_unique").on(table.sku),
    groupIdx: index("products_group_idx").on(table.packetGroupId),
    listedIdx: index("products_listed_idx").on(table.listed, table.active),
  }),
);

export const productFeatures = mysqlTable(
  "product_features",
  {
    id: id(),
    productId: int("product_id").notNull(),
    label: varchar("label", { length: 255 }).notNull(),
    detail: text("detail"),
    inheritedFromTier: varchar("inherited_from_tier", { length: 24 }),
    sortOrder: int("sort_order").notNull().default(0),
  },
  (table) => ({
    productIdx: index("product_features_product_idx").on(table.productId),
  }),
);

export const bundleRules = mysqlTable("bundle_rules", {
  id: id(),
  name: varchar("name", { length: 120 }).notNull(),
  minimumGroups: int("minimum_groups").notNull().default(6),
  discountBasisPoints: int("discount_basis_points").notNull().default(1500),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const coupons = mysqlTable(
  "coupons",
  {
    id: id(),
    code: varchar("code", { length: 48 }).notNull(),
    description: varchar("description", { length: 255 }),
    discountType: varchar("discount_type", { length: 16 }).notNull().default("percent"),
    discountValue: int("discount_value").notNull(),
    maxRedemptions: int("max_redemptions"),
    redemptionCount: int("redemption_count").notNull().default(0),
    startsAt: timestamp("starts_at"),
    expiresAt: timestamp("expires_at"),
    active: boolean("active").notNull().default(true),
    createdByUserId: int("created_by_user_id"),
    updatedByUserId: int("updated_by_user_id"),
    disabledByUserId: int("disabled_by_user_id"),
    disabledAt: timestamp("disabled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    codeUnique: uniqueIndex("coupons_code_unique").on(table.code),
    creatorIdx: index("coupons_creator_idx").on(table.createdByUserId),
  }),
);

/** One immutable record per successful paid checkout that used a coupon. */
export const couponRedemptions = mysqlTable(
  "coupon_redemptions",
  {
    id: id(),
    couponId: int("coupon_id").notNull(),
    orderId: int("order_id").notNull(),
    userId: int("user_id").notNull(),
    paymentId: int("payment_id"),
    codeSnapshot: varchar("code_snapshot", { length: 48 }).notNull(),
    discountCents: int("discount_cents").notNull().default(0),
    redeemedAt: timestamp("redeemed_at").notNull().defaultNow(),
  },
  (table) => ({
    couponIdx: index("coupon_redemptions_coupon_idx").on(table.couponId, table.redeemedAt),
    orderUnique: uniqueIndex("coupon_redemptions_order_unique").on(table.orderId),
    userIdx: index("coupon_redemptions_user_idx").on(table.userId, table.redeemedAt),
  }),
);

/* ------------------------------------------------------------------ */
/* Orders and delivery                                                 */
/* ------------------------------------------------------------------ */

export const orders = mysqlTable(
  "orders",
  {
    id: id(),
    orderNumber: varchar("order_number", { length: 32 }).notNull(),
    userId: int("user_id").notNull(),
    /** Immutable evidence of whether the customer initiated the order or an administrator created it on their behalf. */
    createdByOrigin: varchar("created_by_origin", { length: 20 }).notNull().default("customer"),
    projectNameEnc: text("project_name_enc"),
    /** Immutable local snapshots used only for ReadyPackets-managed SharePoint paths. */
    sharepointCustomerFolderEnc: text("sharepoint_customer_folder_enc"),
    sharepointOrderFolderEnc: text("sharepoint_order_folder_enc"),
    status: varchar("status", { length: 32 }).notNull().default("new"),
    paymentStatus: varchar("payment_status", { length: 32 }).notNull().default("unpaid"),
    paymentRequirement: varchar("payment_requirement", { length: 20 }).notNull().default("required"),
    subtotalCents: int("subtotal_cents").notNull().default(0),
    discountCents: int("discount_cents").notNull().default(0),
    totalCents: int("total_cents").notNull().default(0),
    priceSource: varchar("price_source", { length: 20 }).notNull().default("catalog"),
    manualPriceCents: int("manual_price_cents"),
    isTestOrder: boolean("is_test_order").notNull().default(false),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    couponId: int("coupon_id"),
    bundleApplied: boolean("bundle_applied").notNull().default(false),
    integrityChoice: varchar("integrity_choice", { length: 24 }),
    mndaAcceptedAt: timestamp("mnda_accepted_at"),
    intakeCompletedAt: timestamp("intake_completed_at"),
    phase2ScheduledAt: timestamp("phase_2_scheduled_at"),
    deliveredAt: timestamp("delivered_at"),
    closedAt: timestamp("closed_at"),
    dueAt: timestamp("due_at"),
    completionPercent: int("completion_percent").notNull().default(0),
    internalNotesEnc: text("internal_notes_enc"),
    assignedToUserId: int("assigned_to_user_id"),
    canonVersion: varchar("canon_version", { length: 128 }),
    runMode: varchar("run_mode", { length: 32 }),
    releaseStatus: varchar("release_status", { length: 128 }),
    orderScopeMode: varchar("order_scope_mode", { length: 64 }),
    bundleScopeManifest: text("bundle_scope_manifest"),
    workflowId: int("workflow_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => ({
    numberUnique: uniqueIndex("orders_number_unique").on(table.orderNumber),
    userIdx: index("orders_user_idx").on(table.userId),
    statusIdx: index("orders_status_idx").on(table.status),
    createdIdx: index("orders_created_idx").on(table.createdAt),
    deletedIdx: index("orders_deleted_idx").on(table.deletedAt),
    workflowIdx: index("orders_workflow_idx").on(table.workflowId),
    testOrderIdx: index("orders_test_order_idx").on(table.isTestOrder),
    paymentRequirementIdx: index("orders_payment_requirement_idx").on(table.paymentRequirement),
  }),
);

/**
 * Append-only ledger for the narrowly permitted pre-evidence order reference
 * changes. A retired reference remains reserved forever and may be used to
 * reconcile older internal records without reassigning it to another order.
 */
export const orderIdChangeHistory = mysqlTable(
  "order_id_change_history",
  {
    id: id(),
    orderId: int("order_id").notNull(),
    previousOrderNumber: varchar("previous_order_number", { length: 64 }).notNull(),
    newOrderNumber: varchar("new_order_number", { length: 64 }).notNull(),
    reason: varchar("reason", { length: 255 }).notNull(),
    changedByUserId: int("changed_by_user_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    previousNumberUnique: uniqueIndex("order_id_change_history_previous_unique").on(table.previousOrderNumber),
    orderCreatedIdx: index("order_id_change_history_order_created_idx").on(table.orderId, table.createdAt),
  }),
);

export const orderWorkflows = mysqlTable(
  "order_workflows",
  {
    id: id(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    stages: json("stages").notNull(),
    customerPresentation: mysqlEnum("customer_presentation", ["cards", "wizard"]).notNull().default("wizard"),
    isDefault: boolean("is_default").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdByUserId: int("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    nameUnique: uniqueIndex("order_workflows_name_unique").on(table.name),
    activeIdx: index("order_workflows_active_idx").on(table.active, table.isDefault),
  }),
);

export const orderItems = mysqlTable(
  "order_items",
  {
    id: id(),
    orderId: int("order_id").notNull(),
    productId: int("product_id").notNull(),
    packetGroupId: int("packet_group_id").notNull(),
    /** Denormalised so historic invoices survive catalogue edits. */
    sku: varchar("sku", { length: 64 }).notNull(),
    name: varchar("name", { length: 190 }).notNull(),
    tier: varchar("tier", { length: 24 }).notNull(),
    unitPriceCents: int("unit_price_cents").notNull().default(0),
    quantity: int("quantity").notNull().default(1),
    lineTotalCents: int("line_total_cents").notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => ({
    orderIdx: index("order_items_order_idx").on(table.orderId),
  }),
);

export const orderStatusHistory = mysqlTable(
  "order_status_history",
  {
    id: id(),
    orderId: int("order_id").notNull(),
    fromStatus: varchar("from_status", { length: 32 }),
    toStatus: varchar("to_status", { length: 32 }).notNull(),
    actorUserId: int("actor_user_id"),
    reason: varchar("reason", { length: 255 }),
    createdAt: createdAt(),
  },
  (table) => ({
    orderIdx: index("order_status_history_order_idx").on(table.orderId),
  }),
);

export const orderQuestions = mysqlTable(
  "order_questions",
  {
    id: id(),
    orderId: int("order_id").notNull(),
    askedByUserId: int("asked_by_user_id").notNull(),
    questionEnc: text("question_enc").notNull(),
    phase: varchar("phase", { length: 64 }).notNull().default("phase_1"),
    required: boolean("required").notNull().default(true),
    status: varchar("status", { length: 16 }).notNull().default("open"),
    sortOrder: int("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    orderIdx: index("order_questions_order_idx").on(table.orderId),
    phaseIdx: index("order_questions_phase_idx").on(table.orderId, table.phase, table.status),
  }),
);

export const orderAnswers = mysqlTable(
  "order_answers",
  {
    id: id(),
    questionId: int("question_id").notNull(),
    orderId: int("order_id").notNull(),
    answeredByUserId: int("answered_by_user_id").notNull(),
    answerEnc: text("answer_enc").notNull(),
    version: int("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    questionIdx: index("order_answers_question_idx").on(table.questionId),
  }),
);

export const orderAnswerHistory = mysqlTable(
  "order_answer_history",
  {
    id: id(),
    answerId: int("answer_id").notNull(),
    previousAnswerEnc: text("previous_answer_enc").notNull(),
    version: int("version").notNull(),
    changedByUserId: int("changed_by_user_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    answerIdx: index("order_answer_history_answer_idx").on(table.answerId),
  }),
);

export const orderNotes = mysqlTable(
  "order_notes",
  {
    id: id(),
    orderId: int("order_id").notNull(),
    authorUserId: int("author_user_id").notNull(),
    bodyEnc: text("body_enc").notNull(),
    visibility: varchar("visibility", { length: 16 }).notNull().default("internal"),
    createdAt: createdAt(),
  },
  (table) => ({
    orderIdx: index("order_notes_order_idx").on(table.orderId),
  }),
);

export const orderMessageReceipts = mysqlTable(
  "order_message_receipts",
  {
    id: id(),
    orderNoteId: int("order_note_id").notNull(),
    userId: int("user_id").notNull(),
    readAt: timestamp("read_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    noteUserUnique: uniqueIndex("order_message_receipts_note_user_unique").on(table.orderNoteId, table.userId),
    userReadIdx: index("order_message_receipts_user_read_idx").on(table.userId, table.readAt),
  }),
);

export const orderShares = mysqlTable(
  "order_shares",
  {
    id: id(),
    orderId: int("order_id").notNull(),
    sharedWithUserId: int("shared_with_user_id").notNull(),
    scope: varchar("scope", { length: 16 }).notNull().default("read"),
    createdByUserId: int("created_by_user_id").notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => ({
    orderIdx: index("order_shares_order_idx").on(table.orderId),
    userIdx: index("order_shares_user_idx").on(table.sharedWithUserId),
  }),
);

export const intakeSubmissions = mysqlTable(
  "intake_submissions",
  {
    id: id(),
    orderId: int("order_id").notNull(),
    userId: int("user_id").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("draft"),
    projectNameEnc: text("project_name_enc"),
    desiredOutcomes: json("desired_outcomes"),
    integrityChoice: varchar("integrity_choice", { length: 24 }),
    submissionMethod: varchar("submission_method", { length: 16 })
      .notNull()
      .default("typed"),
    submittedAt: timestamp("submitted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    orderUnique: uniqueIndex("intake_submissions_order_unique").on(table.orderId),
  }),
);

export const intakeAnswers = mysqlTable(
  "intake_answers",
  {
    id: id(),
    submissionId: int("submission_id").notNull(),
    questionKey: varchar("question_key", { length: 48 }).notNull(),
    answerEnc: text("answer_enc"),
    attachmentFileId: int("attachment_file_id"),
    updatedAt: updatedAt(),
  },
  (table) => ({
    submissionIdx: index("intake_answers_submission_idx").on(table.submissionId),
  }),
);

export const sharepointSyncLog = mysqlTable(
  "sharepoint_sync_log",
  {
    id: id(),
    orderId: int("order_id").notNull(),
    operationType: varchar("operation_type", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    sharepointPath: varchar("sharepoint_path", { length: 1024 }).notNull(),
    fileId: int("file_id"),
    errorMessage: text("error_message"),
    attempts: int("attempts").notNull().default(0),
    fileExpiryDate: timestamp("file_expiry_date"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    orderIdx: index("sharepoint_sync_log_order_idx").on(table.orderId),
    statusIdx: index("sharepoint_sync_log_status_idx").on(table.status),
  }),
);

/**
 * An app-only Microsoft Graph identity scoped to selected SharePoint sites.
 * Credentials are encrypted with a row-bound AAD after insertion; never return
 * clientSecretEnc through a procedure.
 */
export const sharepointConnections = mysqlTable(
  "sharepoint_connections",
  {
    id: id(),
    name: varchar("name", { length: 120 }).notNull(),
    tenantId: varchar("tenant_id", { length: 190 }).notNull(),
    clientId: varchar("client_id", { length: 64 }).notNull(),
    clientSecretEnc: text("client_secret_enc").notNull(),
    siteId: varchar("site_id", { length: 512 }).notNull(),
    driveId: varchar("drive_id", { length: 512 }).notNull(),
    siteUrl: varchar("site_url", { length: 512 }),
    rootFolderPath: varchar("root_folder_path", { length: 240 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    lastTestedAt: timestamp("last_tested_at"),
    lastTestOk: boolean("last_test_ok"),
    lastError: varchar("last_error", { length: 800 }),
    createdByUserId: int("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    nameUnique: uniqueIndex("sharepoint_connections_name_unique").on(table.name),
    enabledIdx: index("sharepoint_connections_enabled_idx").on(table.enabled),
  }),
);

/**
 * Maps a workflow policy to one selected-site Graph identity. A target is a
 * named role, not a client-provided URL, keeping all transfers contained.
 */
export const sharepointTargetBindings = mysqlTable(
  "sharepoint_target_bindings",
  {
    id: id(),
    name: varchar("name", { length: 120 }).notNull(),
    targetRole: varchar("target_role", { length: 24 }).notNull(),
    connectionId: int("connection_id").notNull(),
    relativeRootPath: varchar("relative_root_path", { length: 240 }),
    enabled: boolean("enabled").notNull().default(true),
    createdByUserId: int("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    nameUnique: uniqueIndex("sharepoint_target_bindings_name_unique").on(table.name),
    connectionIdx: index("sharepoint_target_bindings_connection_idx").on(table.connectionId),
    roleEnabledIdx: index("sharepoint_target_bindings_role_enabled_idx").on(table.targetRole, table.enabled),
  }),
);

/** A persisted, immutable external location prevents name changes from moving customer material. */
export const orderSharepointLocations = mysqlTable(
  "order_sharepoint_locations",
  {
    id: id(),
    orderId: int("order_id").notNull(),
    targetBindingId: int("target_binding_id").notNull(),
    customerNameSnapshot: varchar("customer_name_snapshot", { length: 180 }).notNull(),
    customerIdSnapshot: varchar("customer_id_snapshot", { length: 24 }).notNull(),
    orderNumberSnapshot: varchar("order_number_snapshot", { length: 64 }).notNull(),
    resolvedPath: varchar("resolved_path", { length: 1024 }).notNull(),
    remoteFolderId: varchar("remote_folder_id", { length: 512 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    orderTargetUnique: uniqueIndex("order_sharepoint_locations_order_target_unique").on(table.orderId, table.targetBindingId),
    targetIdx: index("order_sharepoint_locations_target_idx").on(table.targetBindingId),
  }),
);

/** Administrators choose closed, versioned conversion profiles rather than command strings. */
export const conversionProfiles = mysqlTable(
  "conversion_profiles",
  {
    id: id(),
    name: varchar("name", { length: 120 }).notNull(),
    operation: varchar("operation", { length: 40 }).notNull(),
    settingsJson: json("settings_json"),
    revision: int("revision").notNull().default(1),
    toolFingerprint: varchar("tool_fingerprint", { length: 128 }).notNull(),
    active: boolean("active").notNull().default(true),
    createdByUserId: int("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    nameUnique: uniqueIndex("conversion_profiles_name_unique").on(table.name),
    operationActiveIdx: index("conversion_profiles_operation_active_idx").on(table.operation, table.active),
  }),
);

/** Immutable source snapshot plus durable lease state for a requested conversion. */
export const conversionJobs = mysqlTable(
  "conversion_jobs",
  {
    id: id(),
    orderId: int("order_id").notNull(),
    sourceFileId: int("source_file_id").notNull(),
    sourceFileVersion: int("source_file_version").notNull(),
    sourceStorageKey: varchar("source_storage_key", { length: 128 }).notNull(),
    sourceSha256: char("source_sha256", { length: 64 }).notNull(),
    sourceOriginalName: varchar("source_original_name", { length: 255 }).notNull(),
    sourcePhase: varchar("source_phase", { length: 64 }).notNull(),
    conversionProfileId: int("conversion_profile_id").notNull(),
    profileRevision: int("profile_revision").notNull(),
    profileOperation: varchar("profile_operation", { length: 40 }).notNull(),
    profileSettingsJson: json("profile_settings_json"),
    toolFingerprint: varchar("tool_fingerprint", { length: 128 }).notNull(),
    targetBindingsJson: json("target_bindings_json"),
    artifactFileId: int("artifact_file_id"),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    idempotencyKey: char("idempotency_key", { length: 64 }).notNull(),
    correlationId: char("correlation_id", { length: 36 }).notNull(),
    attempts: int("attempts").notNull().default(0),
    runAfter: timestamp("run_after").notNull().defaultNow(),
    leaseToken: char("lease_token", { length: 36 }),
    leaseExpiresAt: timestamp("lease_expires_at"),
    lastError: varchar("last_error", { length: 800 }),
    completedAt: timestamp("completed_at"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    idempotencyUnique: uniqueIndex("conversion_jobs_idempotency_unique").on(table.idempotencyKey),
    claimIdx: index("conversion_jobs_claim_idx").on(table.status, table.runAfter, table.leaseExpiresAt),
    sourceIdx: index("conversion_jobs_source_idx").on(table.sourceFileId, table.sourceFileVersion),
    orderIdx: index("conversion_jobs_order_idx").on(table.orderId),
  }),
);

/** A conversion output is an explicit file record linked to its immutable source snapshot. */
export const fileDerivatives = mysqlTable(
  "file_derivatives",
  {
    id: id(),
    sourceFileId: int("source_file_id").notNull(),
    sourceFileVersion: int("source_file_version").notNull(),
    sourceStorageKey: varchar("source_storage_key", { length: 128 }).notNull(),
    sourceSha256: char("source_sha256", { length: 64 }).notNull(),
    conversionProfileId: int("conversion_profile_id").notNull(),
    conversionProfileRevision: int("conversion_profile_revision").notNull(),
    artifactFileId: int("artifact_file_id").notNull(),
    outputSha256: char("output_sha256", { length: 64 }).notNull(),
    outputMime: varchar("output_mime", { length: 128 }).notNull(),
    outputExtension: varchar("output_extension", { length: 16 }).notNull(),
    toolFingerprint: varchar("tool_fingerprint", { length: 128 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    sourceProfileUnique: uniqueIndex("file_derivatives_source_profile_unique").on(table.sourceFileId, table.sourceFileVersion, table.conversionProfileId, table.conversionProfileRevision),
    artifactIdx: index("file_derivatives_artifact_idx").on(table.artifactFileId),
    sourceHashIdx: index("file_derivatives_source_hash_idx").on(table.sourceSha256),
  }),
);

/** Durable SharePoint transfer outbox using remote identity as retry evidence. */
export const sharepointTransferJobs = mysqlTable(
  "sharepoint_transfer_jobs",
  {
    id: id(),
    orderId: int("order_id").notNull(),
    sourceFileId: int("source_file_id").notNull(),
    artifactFileId: int("artifact_file_id"),
    targetBindingId: int("target_binding_id").notNull(),
    operationType: varchar("operation_type", { length: 32 }).notNull(),
    storageKeySnapshot: varchar("storage_key_snapshot", { length: 128 }).notNull(),
    sha256Snapshot: char("sha256_snapshot", { length: 64 }).notNull(),
    fileNameSnapshot: varchar("file_name_snapshot", { length: 255 }).notNull(),
    mimeSnapshot: varchar("mime_snapshot", { length: 128 }).notNull(),
    phaseSnapshot: varchar("phase_snapshot", { length: 64 }).notNull(),
    idempotencyKey: char("idempotency_key", { length: 64 }).notNull(),
    correlationId: char("correlation_id", { length: 36 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    attempts: int("attempts").notNull().default(0),
    runAfter: timestamp("run_after").notNull().defaultNow(),
    leaseToken: char("lease_token", { length: 36 }),
    leaseExpiresAt: timestamp("lease_expires_at"),
    remoteItemId: varchar("remote_item_id", { length: 512 }),
    remoteEtag: varchar("remote_etag", { length: 512 }),
    remoteSizeBytes: bigint("remote_size_bytes", { mode: "number" }),
    lastError: varchar("last_error", { length: 800 }),
    completedAt: timestamp("completed_at"),
    cancelledAt: timestamp("cancelled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    idempotencyUnique: uniqueIndex("sharepoint_transfer_jobs_idempotency_unique").on(table.idempotencyKey),
    claimIdx: index("sharepoint_transfer_jobs_claim_idx").on(table.status, table.runAfter, table.leaseExpiresAt),
    orderIdx: index("sharepoint_transfer_jobs_order_idx").on(table.orderId),
    targetIdx: index("sharepoint_transfer_jobs_target_idx").on(table.targetBindingId),
  }),
);

export const phaseKickoffConfigs = mysqlTable(
  "phase_kickoff_configs",
  {
    id: id(),
    phase: varchar("phase", { length: 32 }).notNull(),
    createFolders: boolean("create_folders").notNull().default(true),
    folderTemplate: json("folder_template"),
    attachPlaceholders: boolean("attach_placeholders").notNull().default(false),
    notifyCustomer: boolean("notify_customer").notNull().default(true),
    notifyWebhooks: boolean("notify_webhooks").notNull().default(false),
    emailTemplateKey: varchar("email_template_key", { length: 64 }),
    /** Auto-set order completion % when this phase is entered (0 = no auto-set). */
    completionPercent: int("completion_percent").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: updatedAt(),
  },
  (table) => ({
    phaseUnique: uniqueIndex("phase_kickoff_phase_unique").on(table.phase),
  }),
);

export const phaseJobs = mysqlTable(
  "phase_jobs",
  {
    id: id(),
    orderId: int("order_id").notNull(),
    phase: varchar("phase", { length: 32 }).notNull(),
    jobType: varchar("job_type", { length: 48 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    attempts: int("attempts").notNull().default(0),
    lastError: text("last_error"),
    runAfter: timestamp("run_after").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    statusIdx: index("phase_jobs_status_idx").on(table.status, table.runAfter),
    orderIdx: index("phase_jobs_order_idx").on(table.orderId),
  }),
);

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

export const files = mysqlTable(
  "files",
  {
    id: id(),
    /** Opaque, random storage key. Never derived from user input. */
    storageKey: varchar("storage_key", { length: 128 }).notNull(),
    storageTargetId: int("storage_target_id"),
    orderId: int("order_id"),
    ownerUserId: int("owner_user_id"),
    uploadedByUserId: int("uploaded_by_user_id").notNull(),
    originalName: varchar("original_name", { length: 255 }).notNull(),
    /** MIME type as determined by magic-byte inspection, not the client. */
    detectedMime: varchar("detected_mime", { length: 128 }).notNull(),
    extension: varchar("extension", { length: 16 }),
    sizeBytes: int("size_bytes").notNull(),
    /** Server-probed audio duration in whole seconds; null for non-audio or legacy files. */
    durationSeconds: int("duration_seconds"),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    category: varchar("category", { length: 32 }).notNull().default("deliverable"),
    /** Lifecycle phase assigned by the intake or staff workflow. */
    phase: varchar("phase", { length: 64 }).notNull().default("unassigned"),
    /** Customer visibility. Hidden files exist only in the admin workspace. */
    visibleToCustomer: boolean("visible_to_customer").notNull().default(false),
    isPlaceholder: boolean("is_placeholder").notNull().default(false),
    version: int("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => ({
    storageKeyUnique: uniqueIndex("files_storage_key_unique").on(table.storageKey),
    orderIdx: index("files_order_idx").on(table.orderId),
    orderPhaseIdx: index("files_order_phase_idx").on(table.orderId, table.phase, table.deletedAt),
    ownerIdx: index("files_owner_idx").on(table.ownerUserId),
    deletedIdx: index("files_deleted_idx").on(table.deletedAt),
  }),
);

export const fileVersions = mysqlTable(
  "file_versions",
  {
    id: id(),
    fileId: int("file_id").notNull(),
    storageKey: varchar("storage_key", { length: 128 }).notNull(),
    sizeBytes: int("size_bytes").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    version: int("version").notNull(),
    replacedByUserId: int("replaced_by_user_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    fileIdx: index("file_versions_file_idx").on(table.fileId),
  }),
);

export const fileAccessLog = mysqlTable(
  "file_access_log",
  {
    id: id(),
    fileId: int("file_id").notNull(),
    userId: int("user_id"),
    action: varchar("action", { length: 24 }).notNull(),
    ipAddress: varchar("ip_address", { length: 64 }),
    outcome: varchar("outcome", { length: 16 }).notNull().default("allowed"),
    createdAt: createdAt(),
  },
  (table) => ({
    fileIdx: index("file_access_log_file_idx").on(table.fileId),
    userIdx: index("file_access_log_user_idx").on(table.userId),
  }),
);

export const storageTargets = mysqlTable("storage_targets", {
  id: id(),
  name: varchar("name", { length: 120 }).notNull(),
  driver: varchar("driver", { length: 16 }).notNull().default("local"),
  config: json("config"),
  isDefault: boolean("is_default").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const fileTypeRules = mysqlTable(
  "file_type_rules",
  {
    id: id(),
    extension: varchar("extension", { length: 16 }).notNull(),
    mimeType: varchar("mime_type", { length: 128 }).notNull(),
    maxSizeBytes: int("max_size_bytes").notNull().default(26_214_400),
    allowed: boolean("allowed").notNull().default(true),
    appliesTo: varchar("applies_to", { length: 24 }).notNull().default("all"),
    createdAt: createdAt(),
  },
  (table) => ({
    extUnique: uniqueIndex("file_type_rules_ext_unique").on(table.extension),
  }),
);

/* ------------------------------------------------------------------ */
/* Agreements and policy                                               */
/* ------------------------------------------------------------------ */

export const policyDocuments = mysqlTable(
  "policy_documents",
  {
    id: id(),
    slug: varchar("slug", { length: 64 }).notNull(),
    title: varchar("title", { length: 190 }).notNull(),
    requiresAcceptance: boolean("requires_acceptance").notNull().default(false),
    isVisible: boolean("is_visible").notNull().default(true),
    publicRoute: varchar("public_route", { length: 96 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    slugUnique: uniqueIndex("policy_documents_slug_unique").on(table.slug),
  }),
);

export const policyVersions = mysqlTable(
  "policy_versions",
  {
    id: id(),
    policyId: int("policy_id").notNull(),
    version: varchar("version", { length: 24 }).notNull(),
    effectiveDate: varchar("effective_date", { length: 32 }).notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    published: boolean("published").notNull().default(true),
    createdByUserId: int("created_by_user_id"),
    createdAt: createdAt(),
  },
  (table) => ({
    policyIdx: index("policy_versions_policy_idx").on(table.policyId),
  }),
);

export const cookieConsentRecords = mysqlTable(
  "cookie_consent_records",
  {
    id: id(),
    /** SHA-256 digest of the opaque, HttpOnly browser consent token. */
    consentTokenHash: char("consent_token_hash", { length: 64 }).notNull(),
    userId: int("user_id"),
    consentVersion: varchar("consent_version", { length: 32 }).notNull(),
    preferencesAllowed: boolean("preferences_allowed").notNull().default(false),
    analyticsAllowed: boolean("analytics_allowed").notNull().default(false),
    marketingAllowed: boolean("marketing_allowed").notNull().default(false),
    action: mysqlEnum("action", ["accepted_all", "rejected_optional", "saved_preferences"]).notNull(),
    /** HMAC digests provide evidence without retaining raw IP or user-agent strings. */
    ipHash: char("ip_hash", { length: 64 }),
    userAgentHash: char("user_agent_hash", { length: 64 }),
    createdAt: createdAt(),
  },
  (table) => ({
    tokenIdx: index("cookie_consent_token_idx").on(table.consentTokenHash, table.createdAt),
    userIdx: index("cookie_consent_user_idx").on(table.userId, table.createdAt),
  }),
);

export const policyAcceptances = mysqlTable(
  "policy_acceptances",
  {
    id: id(),
    userId: int("user_id").notNull(),
    policyVersionId: int("policy_version_id").notNull(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: varchar("user_agent", { length: 255 }),
    acceptedAt: createdAt(),
  },
  (table) => ({
    userIdx: index("policy_acceptances_user_idx").on(table.userId),
  }),
);

export const mndaAcceptances = mysqlTable(
  "mnda_acceptances",
  {
    id: id(),
    userId: int("user_id").notNull(),
    orderId: int("order_id"),
    policyVersionId: int("policy_version_id").notNull(),
    signatureNameEnc: text("signature_name_enc").notNull(),
    signatureMethod: varchar("signature_method", { length: 24 })
      .notNull()
      .default("typed"),
    uploadedFileId: int("uploaded_file_id"),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: varchar("user_agent", { length: 255 }),
    acceptedAt: createdAt(),
  },
  (table) => ({
    userIdx: index("mnda_acceptances_user_idx").on(table.userId),
    orderIdx: index("mnda_acceptances_order_idx").on(table.orderId),
  }),
);

/* ------------------------------------------------------------------ */
/* Communication                                                       */
/* ------------------------------------------------------------------ */

export const tickets = mysqlTable(
  "tickets",
  {
    id: id(),
    ticketNumber: varchar("ticket_number", { length: 32 }).notNull(),
    userId: int("user_id").notNull(),
    orderId: int("order_id"),
    subjectEnc: text("subject_enc").notNull(),
    category: varchar("category", { length: 32 }).notNull().default("general"),
    status: varchar("status", { length: 16 }).notNull().default("open"),
    priority: varchar("priority", { length: 16 }).notNull().default("normal"),
    assignedToUserId: int("assigned_to_user_id"),
    lastReplyAt: timestamp("last_reply_at"),
    resolvedAt: timestamp("resolved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    numberUnique: uniqueIndex("tickets_number_unique").on(table.ticketNumber),
    userIdx: index("tickets_user_idx").on(table.userId),
    statusIdx: index("tickets_status_idx").on(table.status),
  }),
);

export const ticketReplies = mysqlTable(
  "ticket_replies",
  {
    id: id(),
    ticketId: int("ticket_id").notNull(),
    authorUserId: int("author_user_id").notNull(),
    bodyEnc: text("body_enc").notNull(),
    internalOnly: boolean("internal_only").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => ({
    ticketIdx: index("ticket_replies_ticket_idx").on(table.ticketId),
  }),
);

export const ticketAttachments = mysqlTable(
  "ticket_attachments",
  {
    id: id(),
    ticketId: int("ticket_id").notNull(),
    replyId: int("reply_id"),
    fileId: int("file_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    ticketIdx: index("ticket_attachments_ticket_idx").on(table.ticketId),
  }),
);

export const emailTemplates = mysqlTable(
  "email_templates",
  {
    id: id(),
    templateKey: varchar("template_key", { length: 64 }).notNull(),
    name: varchar("name", { length: 190 }).notNull(),
    subject: varchar("subject", { length: 255 }).notNull(),
    bodyHtml: text("body_html").notNull(),
    bodyText: text("body_text"),
    variables: json("variables"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    keyUnique: uniqueIndex("email_templates_key_unique").on(table.templateKey),
  }),
);

export const emailQueue = mysqlTable(
  "email_queue",
  {
    id: id(),
    toAddressEnc: text("to_address_enc").notNull(),
    templateKey: varchar("template_key", { length: 64 }),
    subject: varchar("subject", { length: 255 }).notNull(),
    bodyHtml: text("body_html").notNull(),
    bodyText: text("body_text"),
    /** Attachment intent is regenerated at send time; binary documents are never stored in the queue table. */
    attachmentManifest: json("attachment_manifest"),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    attempts: int("attempts").notNull().default(0),
    lastError: varchar("last_error", { length: 500 }),
    runAfter: timestamp("run_after").notNull().defaultNow(),
    sentAt: timestamp("sent_at"),
    cancelledAt: timestamp("cancelled_at"),
    sourceQueueId: int("source_queue_id"),
    createdAt: createdAt(),
  },
  (table) => ({
    statusIdx: index("email_queue_status_idx").on(table.status, table.runAfter),
  }),
);

export const emailLog = mysqlTable(
  "email_log",
  {
    id: id(),
    toAddressHash: varchar("to_address_hash", { length: 64 }).notNull(),
    toAddressEnc: text("to_address_enc"),
    bccAddressEnc: text("bcc_address_enc"),
    templateKey: varchar("template_key", { length: 64 }),
    subject: varchar("subject", { length: 255 }).notNull(),
    bodyHtmlEnc: text("body_html_enc"),
    bodyTextEnc: text("body_text_enc"),
    attachmentManifest: json("attachment_manifest"),
    status: varchar("status", { length: 16 }).notNull(),
    detail: varchar("detail", { length: 500 }),
    sentAt: timestamp("sent_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    createdIdx: index("email_log_created_idx").on(table.createdAt),
  }),
);

export const newsletterSubscribers = mysqlTable(
  "newsletter_subscribers",
  {
    id: id(),
    emailIndex: varchar("email_index", { length: 64 }).notNull(),
    emailEnc: text("email_enc").notNull(),
    confirmed: boolean("confirmed").notNull().default(false),
    confirmTokenHash: varchar("confirm_token_hash", { length: 64 }),
    unsubscribedAt: timestamp("unsubscribed_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    emailUnique: uniqueIndex("newsletter_email_unique").on(table.emailIndex),
  }),
);

export const maintenanceSubscribers = mysqlTable(
  "maintenance_subscribers",
  {
    id: id(),
    emailIndex: varchar("email_index", { length: 64 }).notNull(),
    emailEnc: text("email_enc").notNull(),
    notifiedAt: timestamp("notified_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    emailUnique: uniqueIndex("maintenance_email_unique").on(table.emailIndex),
  }),
);

export const notificationPreferences = mysqlTable(
  "notification_preferences",
  {
    userId: int("user_id").notNull(),
    channel: varchar("channel", { length: 32 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: updatedAt(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.channel] }),
  }),
);

export const contactMessages = mysqlTable(
  "contact_messages",
  {
    id: id(),
    nameEnc: text("name_enc").notNull(),
    emailEnc: text("email_enc").notNull(),
    emailIndex: varchar("email_index", { length: 64 }).notNull(),
    companyEnc: text("company_enc"),
    topic: varchar("topic", { length: 64 }).notNull().default("general"),
    messageEnc: text("message_enc").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("new"),
    ipAddress: varchar("ip_address", { length: 64 }),
    handledByUserId: int("handled_by_user_id"),
    createdAt: createdAt(),
  },
  (table) => ({
    statusIdx: index("contact_messages_status_idx").on(table.status),
  }),
);

/* ------------------------------------------------------------------ */
/* Community and content                                               */
/* ------------------------------------------------------------------ */

export const forumCategories = mysqlTable(
  "forum_categories",
  {
    id: id(),
    slug: varchar("slug", { length: 96 }).notNull(),
    name: varchar("name", { length: 190 }).notNull(),
    description: varchar("description", { length: 500 }),
    /** When true, non-members see a truncated teaser of topics. */
    teaserEnabled: boolean("teaser_enabled").notNull().default(true),
    sortOrder: int("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => ({
    slugUnique: uniqueIndex("forum_categories_slug_unique").on(table.slug),
  }),
);

export const forumTopics = mysqlTable(
  "forum_topics",
  {
    id: id(),
    categoryId: int("category_id").notNull(),
    userId: int("user_id").notNull(),
    slug: varchar("slug", { length: 190 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("published"),
    pinned: boolean("pinned").notNull().default(false),
    locked: boolean("locked").notNull().default(false),
    replyCount: int("reply_count").notNull().default(0),
    viewCount: int("view_count").notNull().default(0),
    /** Incremented each time a topic card is clicked on the public community teaser page. */
    teaserClickCount: int("teaser_click_count").notNull().default(0),
    lastPostAt: timestamp("last_post_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => ({
    slugUnique: uniqueIndex("forum_topics_slug_unique").on(table.slug),
    categoryIdx: index("forum_topics_category_idx").on(table.categoryId),
  }),
);

export const forumPosts = mysqlTable(
  "forum_posts",
  {
    id: id(),
    topicId: int("topic_id").notNull(),
    userId: int("user_id").notNull(),
    body: text("body").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("published"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => ({
    topicIdx: index("forum_posts_topic_idx").on(table.topicId),
  }),
);

export const forumReactions = mysqlTable(
  "forum_reactions",
  {
    id: id(),
    postId: int("post_id"),
    topicId: int("topic_id"),
    userId: int("user_id").notNull(),
    reaction: varchar("reaction", { length: 24 }).notNull().default("like"),
    createdAt: createdAt(),
  },
  (table) => ({
    postIdx: index("forum_reactions_post_idx").on(table.postId),
    userIdx: index("forum_reactions_user_idx").on(table.userId),
  }),
);

export const reviews = mysqlTable(
  "reviews",
  {
    id: id(),
    userId: int("user_id").notNull(),
    orderId: int("order_id").notNull(),
    productId: int("product_id"),
    rating: tinyint("rating").notNull(),
    title: varchar("title", { length: 190 }),
    body: text("body").notNull(),
    displayName: varchar("display_name", { length: 120 }),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    moderatedByUserId: int("moderated_by_user_id"),
    moderationNote: varchar("moderation_note", { length: 500 }),
    publishedAt: timestamp("published_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    statusIdx: index("reviews_status_idx").on(table.status),
    orderUnique: uniqueIndex("reviews_order_unique").on(table.orderId),
  }),
);

export const changelogEntries = mysqlTable(
  "changelog_entries",
  {
    id: id(),
    version: varchar("version", { length: 32 }).notNull(),
    title: varchar("title", { length: 190 }).notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    entryType: varchar("entry_type", { length: 24 }).notNull().default("improvement"),
    isPublic: boolean("is_public").notNull().default(true),
    releasedAt: timestamp("released_at").notNull().defaultNow(),
    createdByUserId: int("created_by_user_id"),
    createdAt: createdAt(),
  },
  (table) => ({
    publicIdx: index("changelog_public_idx").on(table.isPublic, table.releasedAt),
  }),
);

export const changelogEntryVersions = mysqlTable(
  "changelog_entry_versions",
  {
    id: id(),
    changelogEntryId: int("changelog_entry_id").notNull(),
    revisionNumber: int("revision_number").notNull(),
    version: varchar("version", { length: 32 }).notNull(),
    title: varchar("title", { length: 190 }).notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    entryType: varchar("entry_type", { length: 24 }).notNull(),
    isPublic: boolean("is_public").notNull().default(false),
    changeKind: varchar("change_kind", { length: 24 }).notNull().default("draft"),
    changedByUserId: int("changed_by_user_id"),
    createdAt: createdAt(),
  },
  (table) => ({
    entryRevisionUnique: uniqueIndex("changelog_entry_versions_entry_revision_unique").on(table.changelogEntryId, table.revisionNumber),
    entryIdx: index("changelog_entry_versions_entry_idx").on(table.changelogEntryId, table.createdAt),
  }),
);

export const homeContentBlocks = mysqlTable(
  "home_content_blocks",
  {
    id: id(),
    blockKey: varchar("block_key", { length: 64 }).notNull(),
    blockType: varchar("block_type", { length: 32 }).notNull().default("packet_card"),
    heading: varchar("heading", { length: 190 }),
    subheading: varchar("subheading", { length: 255 }),
    body: text("body"),
    linkLabel: varchar("link_label", { length: 96 }),
    linkHref: varchar("link_href", { length: 255 }),
    imagePath: varchar("image_path", { length: 255 }),
    enabled: boolean("enabled").notNull().default(true),
    sortOrder: int("sort_order").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (table) => ({
    keyUnique: uniqueIndex("home_content_key_unique").on(table.blockKey),
  }),
);

/* ------------------------------------------------------------------ */
/* Finance                                                             */
/* ------------------------------------------------------------------ */

export const invoices = mysqlTable(
  "invoices",
  {
    id: id(),
    invoiceNumber: varchar("invoice_number", { length: 32 }).notNull(),
    orderId: int("order_id").notNull(),
    userId: int("user_id").notNull(),
    amountCents: int("amount_cents").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("draft"),
    dueAt: timestamp("due_at"),
    issuedAt: timestamp("issued_at"),
    paidAt: timestamp("paid_at"),
    externalReference: varchar("external_reference", { length: 190 }),
    /** Paid-order invoices are published to the customer portal by default. */
    customerVisible: boolean("customer_visible").notNull().default(true),
    publishedAt: timestamp("published_at"),
    /** Timestamp when the customer copy was queued; delivery logs retain final transport status. */
    emailQueuedAt: timestamp("email_queued_at"),
    emailQueuedByUserId: int("email_queued_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    numberUnique: uniqueIndex("invoices_number_unique").on(table.invoiceNumber),
    orderIdx: index("invoices_order_idx").on(table.orderId),
  }),
);

export const payments = mysqlTable(
  "payments",
  {
    id: id(),
    orderId: int("order_id").notNull(),
    invoiceId: int("invoice_id"),
    provider: varchar("provider", { length: 32 }).notNull().default("manual"),
    providerReference: varchar("provider_reference", { length: 190 }),
    amountCents: int("amount_cents").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    /** Last four digits only; no card data is ever stored. */
    methodSummary: varchar("method_summary", { length: 64 }),
    receivedAt: timestamp("received_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    orderIdx: index("payments_order_idx").on(table.orderId),
    referenceIdx: index("payments_reference_idx").on(table.providerReference),
  }),
);

export const refunds = mysqlTable(
  "refunds",
  {
    id: id(),
    orderId: int("order_id").notNull(),
    paymentId: int("payment_id"),
    amountCents: int("amount_cents").notNull(),
    reason: varchar("reason", { length: 255 }),
    completionStage: int("completion_stage"),
    status: varchar("status", { length: 16 }).notNull().default("requested"),
    providerReference: varchar("provider_reference", { length: 190 }),
    requestedByUserId: int("requested_by_user_id").notNull(),
    approvedByUserId: int("approved_by_user_id"),
    processedAt: timestamp("processed_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    orderIdx: index("refunds_order_idx").on(table.orderId),
  }),
);

export const referrals = mysqlTable(
  "referrals",
  {
    id: id(),
    referrerUserId: int("referrer_user_id").notNull(),
    referredUserId: int("referred_user_id"),
    code: varchar("code", { length: 48 }).notNull(),
    orderId: int("order_id"),
    rewardCents: int("reward_cents").notNull().default(0),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    createdAt: createdAt(),
  },
  (table) => ({
    codeUnique: uniqueIndex("referrals_code_unique").on(table.code),
  }),
);

export const payouts = mysqlTable(
  "payouts",
  {
    id: id(),
    userId: int("user_id").notNull(),
    amountCents: int("amount_cents").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("requested"),
    method: varchar("method", { length: 32 }).notNull().default("manual"),
    referenceEnc: text("reference_enc"),
    processedAt: timestamp("processed_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    userIdx: index("payouts_user_idx").on(table.userId),
  }),
);

/* ------------------------------------------------------------------ */
/* Platform                                                            */
/* ------------------------------------------------------------------ */

export const siteSettings = mysqlTable(
  "site_settings",
  {
    settingKey: varchar("setting_key", { length: 96 }).primaryKey(),
    settingValue: text("setting_value"),
    valueType: varchar("value_type", { length: 16 }).notNull().default("string"),
    category: varchar("category", { length: 48 }).notNull().default("general"),
    description: varchar("description", { length: 255 }),
    /** Secret settings are never returned to a non-admin caller. */
    isSecret: boolean("is_secret").notNull().default(false),
    updatedByUserId: int("updated_by_user_id"),
    updatedAt: updatedAt(),
  },
  (table) => ({
    categoryIdx: index("site_settings_category_idx").on(table.category),
  }),
);

export const featureFlags = mysqlTable(
  "feature_flags",
  {
    flagKey: varchar("flag_key", { length: 64 }).primaryKey(),
    name: varchar("name", { length: 190 }).notNull(),
    description: varchar("description", { length: 255 }),
    enabled: boolean("enabled").notNull().default(true),
    scheduledEnableAt: timestamp("scheduled_enable_at"),
    scheduledDisableAt: timestamp("scheduled_disable_at"),
    updatedByUserId: int("updated_by_user_id"),
    updatedAt: updatedAt(),
  },
);

export const rateLimitConfigs = mysqlTable(
  "rate_limit_configs",
  {
    category: varchar("category", { length: 32 }).primaryKey(),
    label: varchar("label", { length: 96 }).notNull(),
    windowSeconds: int("window_seconds").notNull(),
    maxRequests: int("max_requests").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    penaltyEnabled: boolean("penalty_enabled").notNull().default(true),
    updatedAt: updatedAt(),
  },
);

export const ipBlacklist = mysqlTable(
  "ip_blacklist",
  {
    id: id(),
    /** Accepts a single address, a CIDR block, or a dashed range. */
    pattern: varchar("pattern", { length: 64 }).notNull(),
    patternType: varchar("pattern_type", { length: 16 }).notNull().default("single"),
    reason: varchar("reason", { length: 255 }),
    source: varchar("source", { length: 24 }).notNull().default("manual"),
    hitCount: int("hit_count").notNull().default(0),
    lastHitAt: timestamp("last_hit_at"),
    expiresAt: timestamp("expires_at"),
    createdByUserId: int("created_by_user_id"),
    createdAt: createdAt(),
  },
  (table) => ({
    patternUnique: uniqueIndex("ip_blacklist_pattern_unique").on(table.pattern),
    expiresIdx: index("ip_blacklist_expires_idx").on(table.expiresAt),
  }),
);

export const ipAllowlist = mysqlTable(
  "ip_allowlist",
  {
    id: id(),
    pattern: varchar("pattern", { length: 64 }).notNull(),
    patternType: varchar("pattern_type", { length: 16 }).notNull().default("single"),
    scope: varchar("scope", { length: 24 }).notNull().default("admin"),
    note: varchar("note", { length: 255 }),
    createdByUserId: int("created_by_user_id"),
    createdAt: createdAt(),
  },
  (table) => ({
    patternUnique: uniqueIndex("ip_allowlist_pattern_unique").on(table.pattern),
  }),
);

export const securityLogs = mysqlTable(
  "security_logs",
  {
    id: id(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    severity: varchar("severity", { length: 16 }).notNull().default("info"),
    userId: int("user_id"),
    /** Hashed identifier so failed logins can be correlated without storing PII. */
    subjectHash: varchar("subject_hash", { length: 64 }),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: varchar("user_agent", { length: 255 }),
    outcome: varchar("outcome", { length: 16 }).notNull().default("success"),
    message: varchar("message", { length: 500 }).notNull(),
    metadata: json("metadata"),
    createdAt: createdAt(),
  },
  (table) => ({
    typeIdx: index("security_logs_type_idx").on(table.eventType),
    severityIdx: index("security_logs_severity_idx").on(table.severity),
    createdIdx: index("security_logs_created_idx").on(table.createdAt),
    userIdx: index("security_logs_user_idx").on(table.userId),
  }),
);

export const activityLogs = mysqlTable(
  "activity_logs",
  {
    id: id(),
    actorUserId: int("actor_user_id"),
    actorRole: varchar("actor_role", { length: 16 }),
    action: varchar("action", { length: 96 }).notNull(),
    entityType: varchar("entity_type", { length: 48 }),
    entityId: varchar("entity_id", { length: 64 }),
    severity: varchar("severity", { length: 16 }).notNull().default("info"),
    summary: varchar("summary", { length: 500 }).notNull(),
    changes: json("changes"),
    ipAddress: varchar("ip_address", { length: 64 }),
    createdAt: createdAt(),
  },
  (table) => ({
    actorIdx: index("activity_logs_actor_idx").on(table.actorUserId),
    actionIdx: index("activity_logs_action_idx").on(table.action),
    entityIdx: index("activity_logs_entity_idx").on(table.entityType, table.entityId),
    createdIdx: index("activity_logs_created_idx").on(table.createdAt),
  }),
);

export const systemAlerts = mysqlTable(
  "system_alerts",
  {
    id: id(),
    alertKey: varchar("alert_key", { length: 96 }).notNull(),
    severity: varchar("severity", { length: 16 }).notNull().default("error"),
    source: varchar("source", { length: 48 }).notNull().default("server"),
    message: varchar("message", { length: 500 }).notNull(),
    detail: text("detail"),
    occurrences: int("occurrences").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    acknowledgedByUserId: int("acknowledged_by_user_id"),
    acknowledgedAt: timestamp("acknowledged_at"),
    resolvedAt: timestamp("resolved_at"),
  },
  (table) => ({
    keyIdx: index("system_alerts_key_idx").on(table.alertKey),
    severityIdx: index("system_alerts_severity_idx").on(table.severity),
  }),
);

export const backupLog = mysqlTable("backup_log", {
  id: id(),
  backupType: varchar("backup_type", { length: 24 }).notNull().default("scheduled"),
  status: varchar("status", { length: 16 }).notNull().default("running"),
  sizeBytes: int("size_bytes"),
  location: varchar("location", { length: 500 }),
  detail: varchar("detail", { length: 500 }),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  finishedAt: timestamp("finished_at"),
});

export const apiKeys = mysqlTable(
  "api_keys",
  {
    id: id(),
    name: varchar("name", { length: 120 }).notNull(),
    keyPrefix: varchar("key_prefix", { length: 16 }).notNull(),
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    scopes: json("scopes"),
    createdByUserId: int("created_by_user_id").notNull(),
    lastUsedAt: timestamp("last_used_at"),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    hashUnique: uniqueIndex("api_keys_hash_unique").on(table.keyHash),
    prefixIdx: index("api_keys_prefix_idx").on(table.keyPrefix),
  }),
);

export const orderPhaseLocks = mysqlTable(
  "order_phase_locks",
  {
    id: id(),
    orderId: int("order_id").notNull(),
    phaseKey: varchar("phase_key", { length: 64 }).notNull(),
    acknowledgementText: text("acknowledgement_text").notNull(),
    lockedByUserId: int("locked_by_user_id").notNull(),
    lockedAt: timestamp("locked_at").notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at"),
    reviewedByUserId: int("reviewed_by_user_id"),
    unlockedByUserId: int("unlocked_by_user_id"),
    unlockedAt: timestamp("unlocked_at"),
    unlockReason: varchar("unlock_reason", { length: 1000 }),
  },
  (table) => ({
    orderPhaseUnique: uniqueIndex("order_phase_locks_order_phase_unique").on(table.orderId, table.phaseKey),
    activeLockIdx: index("order_phase_locks_active_idx").on(table.orderId, table.unlockedAt),
    reviewQueueIdx: index("order_phase_locks_review_queue_idx").on(table.orderId, table.unlockedAt, table.reviewedAt),
  }),
);

export const orderWorkflowAdvances = mysqlTable(
  "order_workflow_advances",
  {
    id: id(),
    orderId: int("order_id").notNull(),
    phaseKey: varchar("phase_key", { length: 64 }).notNull(),
    advancedByUserId: int("advanced_by_user_id").notNull(),
    advancedAt: timestamp("advanced_at").notNull().defaultNow(),
  },
  (table) => ({
    orderPhaseUnique: uniqueIndex("order_workflow_advances_order_phase_unique").on(table.orderId, table.phaseKey),
    orderIdx: index("order_workflow_advances_order_idx").on(table.orderId, table.advancedAt),
  }),
);

export const workflowStageRuns = mysqlTable(
  "workflow_stage_runs",
  {
    id: id(),
    orderId: int("order_id").notNull(),
    workflowId: int("workflow_id").notNull(),
    stageKey: varchar("stage_key", { length: 64 }).notNull(),
    actions: json("actions").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("completed"),
    errorDetail: varchar("error_detail", { length: 1000 }),
    startedByUserId: int("started_by_user_id"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    orderIdx: index("workflow_stage_runs_order_idx").on(table.orderId, table.startedAt),
    workflowStageIdx: index("workflow_stage_runs_workflow_stage_idx").on(table.workflowId, table.stageKey),
    statusIdx: index("workflow_stage_runs_status_idx").on(table.status),
  }),
);

export const workflowCompletionJobs = mysqlTable(
  "workflow_completion_jobs",
  {
    id: id(),
    orderId: int("order_id").notNull(),
    workflowId: int("workflow_id").notNull(),
    stageKey: varchar("stage_key", { length: 64 }).notNull(),
    mode: varchar("mode", { length: 16 }).notNull(),
    minPercent: int("min_percent").notNull(),
    maxPercent: int("max_percent").notNull(),
    targetPercent: int("target_percent").notNull(),
    delayMinutes: int("delay_minutes").notNull().default(0),
    runAfter: timestamp("run_after").notNull().defaultNow(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    claimedAt: timestamp("claimed_at"),
    attempts: int("attempts").notNull().default(0),
    lastError: text("last_error"),
    scheduledByUserId: int("scheduled_by_user_id"),
    completedAt: timestamp("completed_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    statusRunIdx: index("workflow_completion_jobs_status_run_idx").on(table.status, table.runAfter),
    orderIdx: index("workflow_completion_jobs_order_idx").on(table.orderId, table.createdAt),
  }),
);

export const webhookEndpoints = mysqlTable(
  "webhook_endpoints",
  {
    id: id(),
    name: varchar("name", { length: 120 }).notNull(),
    url: varchar("url", { length: 500 }).notNull(),
    events: json("events"),
    secretEnc: text("secret_enc"),
    enabled: boolean("enabled").notNull().default(true),
    createdByUserId: int("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
);

export const webhookDeliveries = mysqlTable(
  "webhook_deliveries",
  {
    id: id(),
    endpointId: int("endpoint_id").notNull(),
    /** Denormalized context keeps operational delivery logs searchable without exposing payload internals. */
    orderId: int("order_id"),
    orderNumber: varchar("order_number", { length: 64 }),
    customerName: varchar("customer_name", { length: 255 }),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    payload: json("payload"),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    responseCode: int("response_code"),
    responseDetail: varchar("response_detail", { length: 1000 }),
    attempts: int("attempts").notNull().default(0),
    lastError: varchar("last_error", { length: 500 }),
    runAfter: timestamp("run_after").notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    endpointIdx: index("webhook_deliveries_endpoint_idx").on(table.endpointId),
    orderIdx: index("webhook_deliveries_order_idx").on(table.orderId, table.createdAt),
    statusIdx: index("webhook_deliveries_status_idx").on(table.status, table.runAfter),
  }),
);

export const scheduledJobs = mysqlTable(
  "scheduled_jobs",
  {
    id: id(),
    jobKey: varchar("job_key", { length: 64 }).notNull(),
    description: varchar("description", { length: 255 }),
    intervalSeconds: int("interval_seconds").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at"),
    lastStatus: varchar("last_status", { length: 16 }),
    lastDetail: varchar("last_detail", { length: 500 }),
    nextRunAt: timestamp("next_run_at"),
  },
  (table) => ({
    keyUnique: uniqueIndex("scheduled_jobs_key_unique").on(table.jobKey),
  }),
);

export const schemaMigrations = mysqlTable("schema_migrations", {
  filename: varchar("filename", { length: 190 }).primaryKey(),
  checksum: varchar("checksum", { length: 64 }).notNull(),
  appliedAt: timestamp("applied_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Rate limit penalties (persisted so they survive service restarts)
// ---------------------------------------------------------------------------
export const rateLimitPenalties = mysqlTable(
  "rate_limit_penalties",
  {
    id: id(),
    penaltyKey: varchar("penalty_key", { length: 128 }).notNull(), // "category:ip"
    ipAddress: varchar("ip_address", { length: 45 }).notNull(),
    category: varchar("category", { length: 32 }).notNull(),
    level: int("level").notNull().default(1),
    until: timestamp("until").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    keyUnique: uniqueIndex("rlp_key_unique").on(table.penaltyKey),
    untilIdx: index("rlp_until_idx").on(table.until),
    ipIdx: index("rlp_ip_idx").on(table.ipAddress),
  }),
);

// ---------------------------------------------------------------------------
// Email automations (event-triggered email sequences)
// ---------------------------------------------------------------------------
export const emailAutomations = mysqlTable(
  "email_automations",
  {
    id: id(),
    name: varchar("name", { length: 190 }).notNull(),
    description: varchar("description", { length: 500 }),
    /** The platform event that triggers this automation. */
    triggerEvent: varchar("trigger_event", { length: 64 }).notNull(),
    /** Optional filter: only trigger when this condition is met (JSON). */
    triggerCondition: json("trigger_condition"),
    /** Template key to send. */
    templateKey: varchar("template_key", { length: 64 }).notNull(),
    /** Delay in minutes before sending (0 = immediate). */
    delayMinutes: int("delay_minutes").notNull().default(0),
    /** Whether this automation is active. */
    enabled: boolean("enabled").notNull().default(true),
    /** Number of times this automation has fired. */
    runCount: int("run_count").notNull().default(0),
    lastRunAt: timestamp("last_run_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => ({
    triggerIdx: index("email_automations_trigger_idx").on(table.triggerEvent),
    enabledIdx: index("email_automations_enabled_idx").on(table.enabled),
  }),
);

// ── Tier 3: Finance / billing ─────────────────────────────────────────────────

export const subscriptionPlans = mysqlTable("subscription_plans", {
  id: id(),
  name: varchar("name", { length: 128 }).notNull(),
  slug: varchar("slug", { length: 64 }).notNull(),
  description: text("description"),
  priceCents: int("price_cents").notNull().default(0),
  intervalDays: int("interval_days").notNull().default(30),
  features: json("features"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const subscriptionItems = mysqlTable("subscription_items", {
  id: id(),
  userId: int("user_id").notNull(),
  planId: int("plan_id").notNull(),
  status: mysqlEnum("status", ["active", "paused", "cancelled", "expired"]).notNull().default("active"),
  currentPeriodStart: timestamp("current_period_start").notNull().defaultNow(),
  currentPeriodEnd: timestamp("current_period_end").notNull().defaultNow(),
  cancelledAt: timestamp("cancelled_at"),
  metadata: json("metadata"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const billingEvents = mysqlTable("billing_events", {
  id: id(),
  userId: int("user_id"),
  orderId: int("order_id"),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  amountCents: int("amount_cents").notNull().default(0),
  currency: char("currency", { length: 3 }).notNull().default("USD"),
  provider: varchar("provider", { length: 32 }).notNull().default("stripe"),
  providerEventId: varchar("provider_event_id", { length: 255 }),
  metadata: json("metadata"),
  createdAt: createdAt(),
});

// ── Tier 3: CRM ───────────────────────────────────────────────────────────────

export const crmContacts = mysqlTable("crm_contacts", {
  id: id(),
  userId: int("user_id"),
  firstName: varchar("first_name", { length: 100 }),
  lastName: varchar("last_name", { length: 100 }),
  company: varchar("company", { length: 200 }),
  emailEnc: text("email_enc"),
  emailIndex: varchar("email_index", { length: 64 }),
  phoneEnc: text("phone_enc"),
  source: varchar("source", { length: 64 }),
  status: mysqlEnum("status", ["lead", "prospect", "customer", "churned", "blocked"]).notNull().default("lead"),
  ownerUserId: int("owner_user_id"),
  tags: json("tags"),
  metadata: json("metadata"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamp("deleted_at"),
});

export const crmNotes = mysqlTable("crm_notes", {
  id: id(),
  contactId: int("contact_id").notNull(),
  authorUserId: int("author_user_id").notNull(),
  body: text("body").notNull(),
  noteType: mysqlEnum("note_type", ["call", "email", "meeting", "note", "task"]).notNull().default("note"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const crmTags = mysqlTable("crm_tags", {
  id: id(),
  name: varchar("name", { length: 64 }).notNull(),
  color: varchar("color", { length: 16 }).notNull().default("#6b7280"),
  createdAt: createdAt(),
});

// ── Tier 3: AI hub ────────────────────────────────────────────────────────────

export const aiSessions = mysqlTable("ai_sessions", {
  id: id(),
  userId: int("user_id"),
  sessionType: varchar("session_type", { length: 64 }).notNull().default("chat"),
  model: varchar("model", { length: 128 }).notNull(),
  title: varchar("title", { length: 255 }),
  status: mysqlEnum("status", ["active", "completed", "archived"]).notNull().default("active"),
  tokenCount: int("token_count").notNull().default(0),
  costMicroUsd: int("cost_micro_usd").notNull().default(0),
  metadata: json("metadata"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const aiMessages = mysqlTable("ai_messages", {
  id: id(),
  sessionId: int("session_id").notNull(),
  role: mysqlEnum("role", ["system", "user", "assistant", "tool"]).notNull(),
  content: mediumtext("content").notNull(),
  tokenCount: int("token_count").notNull().default(0),
  finishReason: varchar("finish_reason", { length: 32 }),
  metadata: json("metadata"),
  createdAt: createdAt(),
});

export const aiResponseLogs = mysqlTable("ai_response_logs", {
  id: id(),
  sessionId: int("session_id"),
  messageId: int("message_id"),
  model: varchar("model", { length: 128 }).notNull(),
  promptTokens: int("prompt_tokens").notNull().default(0),
  completionTokens: int("completion_tokens").notNull().default(0),
  latencyMs: int("latency_ms").notNull().default(0),
  finishReason: varchar("finish_reason", { length: 32 }),
  error: text("error"),
  createdAt: createdAt(),
});

// ── Tier 3: Inbound webhooks ──────────────────────────────────────────────────

export const inboundWebhookListeners = mysqlTable("inbound_webhook_listeners", {
  id: id(),
  name: varchar("name", { length: 128 }).notNull(),
  slug: varchar("slug", { length: 64 }).notNull(),
  secretHash: varchar("secret_hash", { length: 128 }),
  eventType: varchar("event_type", { length: 128 }),
  handler: varchar("handler", { length: 128 }).notNull().default("log"),
  enabled: boolean("enabled").notNull().default(true),
  createdByUserId: int("created_by_user_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const inboundWebhookEvents = mysqlTable("inbound_webhook_events", {
  id: id(),
  listenerId: int("listener_id").notNull(),
  sourceIp: varchar("source_ip", { length: 64 }),
  headers: json("headers"),
  payload: mediumtext("payload"),
  signatureValid: boolean("signature_valid"),
  processed: boolean("processed").notNull().default(false),
  error: text("error"),
  createdAt: createdAt(),
});

// ── Tier 3: API access ────────────────────────────────────────────────────────

export const apiKeyRateLimits = mysqlTable("api_key_rate_limits", {
  id: id(),
  apiKeyId: int("api_key_id").notNull(),
  windowSeconds: int("window_seconds").notNull().default(60),
  maxRequests: int("max_requests").notNull().default(100),
  updatedAt: updatedAt(),
});

export const apiRequestLogs = mysqlTable("api_request_logs", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  apiKeyId: int("api_key_id"),
  method: varchar("method", { length: 8 }).notNull(),
  path: varchar("path", { length: 512 }).notNull(),
  statusCode: smallint("status_code").notNull(),
  latencyMs: int("latency_ms").notNull().default(0),
  ipAddress: varchar("ip_address", { length: 64 }),
  userAgent: varchar("user_agent", { length: 512 }),
  createdAt: createdAt(),
});

export const apiActionLogs = mysqlTable("api_action_logs", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  apiKeyId: int("api_key_id"),
  action: varchar("action", { length: 128 }).notNull(),
  entityType: varchar("entity_type", { length: 64 }),
  entityId: int("entity_id"),
  result: varchar("result", { length: 32 }).notNull().default("success"),
  detail: text("detail"),
  createdAt: createdAt(),
});

// ── Tier 3: Outbound connections ──────────────────────────────────────────────

export const outboundConnections = mysqlTable("outbound_connections", {
  id: id(),
  name: varchar("name", { length: 128 }).notNull(),
  connectionType: varchar("connection_type", { length: 64 }).notNull().default("http"),
  baseUrl: varchar("base_url", { length: 512 }),
  authType: mysqlEnum("auth_type", ["none", "api_key", "bearer", "basic", "oauth2"]).notNull().default("none"),
  credentialsEnc: text("credentials_enc"),
  headers: json("headers"),
  timeoutMs: int("timeout_ms").notNull().default(10000),
  enabled: boolean("enabled").notNull().default(true),
  lastTestedAt: timestamp("last_tested_at"),
  lastTestOk: boolean("last_test_ok"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const outboundCallLogs = mysqlTable("outbound_call_logs", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  connectionId: int("connection_id").notNull(),
  method: varchar("method", { length: 8 }).notNull(),
  url: varchar("url", { length: 1024 }).notNull(),
  statusCode: smallint("status_code"),
  latencyMs: int("latency_ms").notNull().default(0),
  error: text("error"),
  triggeredBy: varchar("triggered_by", { length: 128 }),
  createdAt: createdAt(),
});

// ── Tier 3: Scheduling / availability ────────────────────────────────────────

export const availabilitySlots = mysqlTable("availability_slots", {
  id: id(),
  ownerUserId: int("owner_user_id").notNull(),
  slotType: varchar("slot_type", { length: 64 }).notNull().default("consultation"),
  startsAt: timestamp("starts_at").notNull(),
  endsAt: timestamp("ends_at").notNull(),
  durationMinutes: int("duration_minutes").notNull().default(30),
  maxBookings: int("max_bookings").notNull().default(1),
  currentBookings: int("current_bookings").notNull().default(0),
  isAvailable: boolean("is_available").notNull().default(true),
  notes: text("notes"),
  createdAt: createdAt(),
});

export const meetingBookings = mysqlTable("meeting_bookings", {
  id: id(),
  slotId: int("slot_id").notNull(),
  customerUserId: int("customer_user_id").notNull(),
  orderId: int("order_id"),
  status: mysqlEnum("status", ["pending", "confirmed", "cancelled", "completed", "no_show"]).notNull().default("pending"),
  notes: text("notes"),
  confirmationToken: varchar("confirmation_token", { length: 128 }),
  confirmedAt: timestamp("confirmed_at"),
  cancelledAt: timestamp("cancelled_at"),
  cancelReason: text("cancel_reason"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── Tier 3: Portal wizard slides ──────────────────────────────────────────────

export const orderAutomationRules = mysqlTable(
  "order_automation_rules",
  {
    id: id(),
    name: varchar("name", { length: 190 }).notNull(),
    triggerType: varchar("trigger_type", { length: 48 }).notNull(),
    triggerValue: varchar("trigger_value", { length: 64 }),
    actionType: varchar("action_type", { length: 48 }).notNull().default("set_completion_percent"),
    completionPercent: int("completion_percent"),
    emailTemplateKey: varchar("email_template_key", { length: 64 }),
    webhookEndpointId: int("webhook_endpoint_id"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: int("sort_order").notNull().default(0),
    createdByUserId: int("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    triggerIdx: index("order_automation_trigger_idx").on(table.triggerType, table.triggerValue),
    activeIdx: index("order_automation_active_idx").on(table.isActive),
  }),
);

export const orderQuestionTemplates = mysqlTable(
  "order_question_templates",
  {
    id: id(),
    name: varchar("name", { length: 190 }).notNull(),
    question: text("question").notNull(),
    phase: varchar("phase", { length: 64 }).notNull().default("unassigned"),
    required: boolean("required").notNull().default(true),
    sortOrder: int("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdByUserId: int("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({ phaseIdx: index("order_question_template_phase_idx").on(table.phase, table.isActive) }),
);

export const customReports = mysqlTable(
  "custom_reports",
  {
    id: id(),
    name: varchar("name", { length: 190 }).notNull(),
    description: varchar("description", { length: 500 }),
    dataset: varchar("dataset", { length: 32 }).notNull(),
    configJson: json("config_json").notNull(),
    createdByUserId: int("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    datasetIdx: index("custom_reports_dataset_idx").on(table.dataset),
    creatorIdx: index("custom_reports_creator_idx").on(table.createdByUserId),
  }),
);

export const portalAnnouncements = mysqlTable(
  "portal_announcements",
  {
    id: id(),
    title: varchar("title", { length: 255 }).notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    audience: varchar("audience", { length: 24 }).notNull().default("all"),
    isActive: boolean("is_active").notNull().default(true),
    startsAt: timestamp("starts_at"),
    endsAt: timestamp("ends_at"),
    createdByUserId: int("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({ visibleIdx: index("portal_announcement_visible_idx").on(table.isActive, table.startsAt, table.endsAt) }),
);

export const portalAnnouncementRecipients = mysqlTable(
  "portal_announcement_recipients",
  {
    id: id(),
    announcementId: int("announcement_id").notNull(),
    userId: int("user_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    announcementIdx: index("portal_announcement_recipient_announcement_idx").on(table.announcementId),
    userIdx: index("portal_announcement_recipient_user_idx").on(table.userId),
    recipientUnique: uniqueIndex("portal_announcement_recipient_unique").on(table.announcementId, table.userId),
  }),
);

export const portalWizardSlides = mysqlTable("portal_wizard_slides", {
  id: id(),
  title: varchar("title", { length: 255 }).notNull(),
  subtitle: text("subtitle"),
  bodyMarkdown: text("body_markdown"),
  imageUrl: varchar("image_url", { length: 512 }),
  ctaLabel: varchar("cta_label", { length: 128 }),
  ctaHref: varchar("cta_href", { length: 512 }),
  sortOrder: int("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  targetAudience: mysqlEnum("target_audience", ["all", "new", "returning"]).notNull().default("all"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── Tier 3: A/B testing ───────────────────────────────────────────────────────

export const pwaAbVariants = mysqlTable("pwa_ab_variants", {
  id: id(),
  experimentKey: varchar("experiment_key", { length: 128 }).notNull(),
  variantKey: varchar("variant_key", { length: 64 }).notNull(),
  description: text("description"),
  weight: int("weight").notNull().default(50),
  isControl: boolean("is_control").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
});

export const pwaAbEvents = mysqlTable("pwa_ab_events", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  experimentKey: varchar("experiment_key", { length: 128 }).notNull(),
  variantKey: varchar("variant_key", { length: 64 }).notNull(),
  userId: int("user_id"),
  sessionId: varchar("session_id", { length: 128 }),
  eventType: varchar("event_type", { length: 64 }).notNull().default("impression"),
  metadata: json("metadata"),
  createdAt: createdAt(),
});

// ── Tier 3: Admin preferences ─────────────────────────────────────────────────

export const adminNavPreferences = mysqlTable("admin_nav_preferences", {
  id: id(),
  userId: int("user_id").notNull(),
  pinnedItems: json("pinned_items"),
  collapsedSections: json("collapsed_sections"),
  defaultView: varchar("default_view", { length: 64 }),
  updatedAt: updatedAt(),
});

export const pinnedQuickAdd = mysqlTable("pinned_quick_add", {
  id: id(),
  userId: int("user_id").notNull(),
  actionKey: varchar("action_key", { length: 64 }).notNull(),
  label: varchar("label", { length: 128 }).notNull(),
  href: varchar("href", { length: 512 }).notNull(),
  sortOrder: int("sort_order").notNull().default(0),
  createdAt: createdAt(),
});

// ── Tier 3: Support permissions ───────────────────────────────────────────────

export const supportPermissions = mysqlTable("support_permissions", {
  id: id(),
  userId: int("user_id").notNull(),
  canViewAllTickets: boolean("can_view_all_tickets").notNull().default(false),
  canCloseTickets: boolean("can_close_tickets").notNull().default(false),
  canAssignTickets: boolean("can_assign_tickets").notNull().default(false),
  canViewCustomerPii: boolean("can_view_customer_pii").notNull().default(false),
  canIssueRefunds: boolean("can_issue_refunds").notNull().default(false),
  ticketCategories: json("ticket_categories"),
  grantedByUserId: int("granted_by_user_id").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── Tier 3: Feature toggle scheduling ────────────────────────────────────────

export const featureToggleSchedules = mysqlTable("feature_toggle_schedules", {
  id: id(),
  flagKey: varchar("flag_key", { length: 128 }).notNull(),
  scheduledValue: boolean("scheduled_value").notNull(),
  scheduledAt: timestamp("scheduled_at").notNull(),
  executedAt: timestamp("executed_at"),
  createdByUserId: int("created_by_user_id"),
  note: text("note"),
  createdAt: createdAt(),
});

// ── Tier 3: System backups ────────────────────────────────────────────────────

export const systemBackups = mysqlTable("system_backups", {
  id: id(),
  filename: varchar("filename", { length: 512 }).notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number", unsigned: true }).notNull().default(0),
  backupType: mysqlEnum("backup_type", ["full", "database", "files", "incremental"]).notNull().default("full"),
  status: mysqlEnum("status", ["running", "completed", "failed", "deleted"]).notNull().default("completed"),
  schemaVersion: varchar("schema_version", { length: 32 }),
  checksum: varchar("checksum", { length: 128 }),
  storagePath: varchar("storage_path", { length: 1024 }),
  triggeredBy: mysqlEnum("triggered_by", ["scheduler", "manual", "pre_upgrade"]).notNull().default("scheduler"),
  triggeredByUserId: int("triggered_by_user_id"),
  error: text("error"),
  createdAt: createdAt(),
});

// ── Tier 3: Email automation rate limits ──────────────────────────────────────

export const emailAutomationRateLimits = mysqlTable("email_automation_rate_limits", {
  id: id(),
  automationId: int("automation_id").notNull(),
  userId: int("user_id").notNull(),
  sentCount: int("sent_count").notNull().default(0),
  windowStart: timestamp("window_start").notNull().defaultNow(),
});

// ── Knowledge base ──────────────────────────────────────────────────────────

export const knowledgeBaseArticles = mysqlTable(
  "knowledge_base_articles",
  {
    id: id(),
    title: varchar("title", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 160 }).notNull(),
    category: varchar("category", { length: 96 }),
    excerpt: text("excerpt"),
    bodyMarkdown: text("body_markdown").notNull(),
    status: varchar("status", { length: 24 }).notNull().default("draft"),
    authorUserId: int("author_user_id").notNull(),
    reviewedByUserId: int("reviewed_by_user_id"),
    submittedAt: timestamp("submitted_at"),
    reviewedAt: timestamp("reviewed_at"),
    publishedAt: timestamp("published_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    slugUnique: uniqueIndex("knowledge_base_articles_slug_unique").on(table.slug),
    visibleIdx: index("knowledge_base_articles_visible_idx").on(table.status, table.publishedAt),
  }),
);

// ── Public frequently asked questions ───────────────────────────────────────

export const publicFaqs = mysqlTable(
  "public_faqs",
  {
    id: id(),
    question: varchar("question", { length: 500 }).notNull(),
    answerMarkdown: mediumtext("answer_markdown").notNull(),
    category: varchar("category", { length: 96 }),
    sortOrder: int("sort_order").notNull().default(0),
    isPublished: boolean("is_published").notNull().default(false),
    publishedAt: timestamp("published_at"),
    createdByUserId: int("created_by_user_id").notNull(),
    updatedByUserId: int("updated_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    publicOrderIdx: index("public_faqs_public_order_idx").on(table.isPublished, table.sortOrder, table.publishedAt),
    categoryIdx: index("public_faqs_category_idx").on(table.category),
  }),
);

// ── Marketing campaigns ─────────────────────────────────────────────────────

export const marketingCampaigns = mysqlTable(
  "marketing_campaigns",
  {
    id: id(),
    publicKey: varchar("public_key", { length: 32 }).notNull(),
    name: varchar("name", { length: 180 }).notNull(),
    objective: varchar("objective", { length: 32 }).notNull().default("awareness"),
    channel: varchar("channel", { length: 32 }).notNull().default("website"),
    status: varchar("status", { length: 24 }).notNull().default("draft"),
    audience: varchar("audience", { length: 255 }),
    headline: varchar("headline", { length: 255 }),
    message: text("message"),
    ctaLabel: varchar("cta_label", { length: 96 }),
    destinationUrl: varchar("destination_url", { length: 1024 }).notNull(),
    utmSource: varchar("utm_source", { length: 96 }),
    utmMedium: varchar("utm_medium", { length: 96 }),
    utmCampaign: varchar("utm_campaign", { length: 128 }),
    utmContent: varchar("utm_content", { length: 128 }),
    startsAt: timestamp("starts_at"),
    endsAt: timestamp("ends_at"),
    clickCount: int("click_count").notNull().default(0),
    conversionCount: int("conversion_count").notNull().default(0),
    createdByUserId: int("created_by_user_id").notNull(),
    updatedByUserId: int("updated_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    publicKeyUnique: uniqueIndex("marketing_campaigns_public_key_unique").on(table.publicKey),
    statusDatesIdx: index("marketing_campaigns_status_dates_idx").on(table.status, table.startsAt, table.endsAt),
    channelIdx: index("marketing_campaigns_channel_idx").on(table.channel),
  }),
);

// ── Tier 4: Forum teaser click tracking ──────────────────────────────────────

export const forumTeaserClicks = mysqlTable(
  "forum_teaser_clicks",
  {
    id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
    topicId: int("topic_id").notNull(),
    /** Anonymous session identifier (from cookie or generated). */
    sessionId: varchar("session_id", { length: 128 }),
    /** SHA-256 of the client IP, for deduplication without storing PII. */
    ipHash: varchar("ip_hash", { length: 64 }),
    referrer: varchar("referrer", { length: 512 }),
    createdAt: createdAt(),
  },
  (table) => ({
    topicIdx: index("forum_teaser_clicks_topic_idx").on(table.topicId),
    createdIdx: index("forum_teaser_clicks_created_idx").on(table.createdAt),
  }),
);

// ── Tier 4: Login page configurator ──────────────────────────────────────────

export const loginPageConfig = mysqlTable("login_page_config", {
  id: int("id").autoincrement().primaryKey(),
  heroHeadline: varchar("hero_headline", { length: 255 }),
  heroSubheadline: varchar("hero_subheadline", { length: 512 }),
  showTestimonial: boolean("show_testimonial").notNull().default(false),
  testimonialText: text("testimonial_text"),
  testimonialAuthor: varchar("testimonial_author", { length: 128 }),
  showFeatureList: boolean("show_feature_list").notNull().default(true),
  featureList: json("feature_list"),
  backgroundStyle: varchar("background_style", { length: 32 }).notNull().default("default"),
  accentColor: varchar("accent_color", { length: 32 }),
  /** Bounded copy and local-brand image keys; never arbitrary remote image URLs. */
  slideshowSlides: json("slideshow_slides"),
  updatedByUserId: int("updated_by_user_id"),
  updatedAt: updatedAt(),
});

// ── Customer collaboration workspaces ─────────────────────────────────────────
export const customerWorkspaces = mysqlTable("customer_workspaces", {
  id: id(),
  name: varchar("name", { length: 190 }).notNull(),
  slug: varchar("slug", { length: 96 }).notNull(),
  ownerUserId: int("owner_user_id").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => ({ slugUnique: uniqueIndex("customer_workspace_slug_unique").on(table.slug), ownerIdx: index("customer_workspace_owner_idx").on(table.ownerUserId) }));

export const customerWorkspaceMembers = mysqlTable("customer_workspace_members", {
  id: id(),
  workspaceId: int("workspace_id").notNull(),
  userId: int("user_id").notNull(),
  role: varchar("role", { length: 24 }).notNull().default("member"),
  invitedByUserId: int("invited_by_user_id"),
  createdAt: createdAt(),
  revokedAt: timestamp("revoked_at"),
}, (table) => ({ workspaceUserUnique: uniqueIndex("customer_workspace_member_unique").on(table.workspaceId, table.userId), userIdx: index("customer_workspace_member_user_idx").on(table.userId) }));


// ── Controlled platform upgrades ────────────────────────────────────────────
export const platformUpgradeRuns = mysqlTable(
  "platform_upgrade_runs",
  {
    id: id(),
    repository: varchar("repository", { length: 255 }).notNull(),
    branch: varchar("branch", { length: 128 }).notNull().default("main"),
    fromCommit: varchar("from_commit", { length: 64 }).notNull(),
    targetCommit: varchar("target_commit", { length: 64 }).notNull(),
    status: mysqlEnum("status", ["scanned", "approved", "running", "completed", "failed", "rolled_back"]).notNull().default("scanned"),
    changedFiles: json("changed_files"),
    scanSummary: json("scan_summary"),
    riskSummary: json("risk_summary"),
    backupFilename: varchar("backup_filename", { length: 512 }),
    rollbackSnapshot: varchar("rollback_snapshot", { length: 1024 }),
    output: text("output"),
    scannedByUserId: int("scanned_by_user_id").notNull(),
    approvedByUserId: int("approved_by_user_id"),
    approvedAt: timestamp("approved_at"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    rolledBackByUserId: int("rolled_back_by_user_id"),
    rolledBackAt: timestamp("rolled_back_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    statusCreatedIdx: index("platform_upgrade_runs_status_created_idx").on(table.status, table.createdAt),
    targetCommitIdx: index("platform_upgrade_runs_target_commit_idx").on(table.targetCommit),
  }),
);


/* ------------------------------------------------------------------ */
/* Native mobile OAuth and device sessions                            */
/* ------------------------------------------------------------------ */

/** A non-secret native installation identifier, revocable per user/device. */
export const mobileDevices = mysqlTable(
  "mobile_devices",
  {
    id: varchar("id", { length: 96 }).primaryKey(),
    userId: int("user_id").notNull(),
    platform: varchar("platform", { length: 16 }).notNull(),
    appVersion: varchar("app_version", { length: 32 }).notNull(),
    deviceName: varchar("device_name", { length: 128 }),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    revokedAt: timestamp("revoked_at"),
    revokedReason: varchar("revoked_reason", { length: 190 }),
    createdAt: createdAt(),
  },
  (table) => ({
    userIdx: index("mobile_devices_user_idx").on(table.userId),
    statusIdx: index("mobile_devices_status_idx").on(table.status),
    lastSeenIdx: index("mobile_devices_last_seen_idx").on(table.lastSeenAt),
  }),
);

export const mobileDeviceSessions = mysqlTable(
  "mobile_device_sessions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    tokenFamilyId: varchar("token_family_id", { length: 64 }).notNull(),
    deviceId: varchar("device_id", { length: 96 }).notNull(),
    userId: int("user_id").notNull(),
    /** OAuth scopes are server-authoritative and survive refresh-token rotation. */
    scopes: json("scopes").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    revokedReason: varchar("revoked_reason", { length: 190 }),
    createdAt: createdAt(),
  },
  (table) => ({
    familyIdx: uniqueIndex("mobile_device_sessions_family_uq").on(table.tokenFamilyId),
    userIdx: index("mobile_device_sessions_user_idx").on(table.userId),
    deviceIdx: index("mobile_device_sessions_device_idx").on(table.deviceId),
    expiresIdx: index("mobile_device_sessions_expires_idx").on(table.expiresAt),
  }),
);

export const mobileAuthorizationCodes = mysqlTable(
  "mobile_authorization_codes",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    codeHash: char("code_hash", { length: 64 }).notNull(),
    userId: int("user_id").notNull(),
    deviceId: varchar("device_id", { length: 96 }).notNull(),
    redirectUri: varchar("redirect_uri", { length: 512 }).notNull(),
    codeChallenge: varchar("code_challenge", { length: 128 }).notNull(),
    scopes: json("scopes").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    hashIdx: uniqueIndex("mobile_authorization_codes_hash_uq").on(table.codeHash),
    expiresIdx: index("mobile_authorization_codes_expires_idx").on(table.expiresAt),
    userIdx: index("mobile_authorization_codes_user_idx").on(table.userId),
  }),
);

export const mobileRefreshTokens = mysqlTable(
  "mobile_refresh_tokens",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    tokenHash: char("token_hash", { length: 64 }).notNull(),
    sessionId: varchar("session_id", { length: 64 }).notNull(),
    tokenFamilyId: varchar("token_family_id", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    expiresAt: timestamp("expires_at").notNull(),
    rotatedAt: timestamp("rotated_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: createdAt(),
  },
  (table) => ({
    hashIdx: uniqueIndex("mobile_refresh_tokens_hash_uq").on(table.tokenHash),
    sessionIdx: index("mobile_refresh_tokens_session_idx").on(table.sessionId),
    familyIdx: index("mobile_refresh_tokens_family_idx").on(table.tokenFamilyId),
    expiresIdx: index("mobile_refresh_tokens_expires_idx").on(table.expiresAt),
  }),
);

export const mobileIdempotencyKeys = mysqlTable(
  "mobile_idempotency_keys",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: int("user_id").notNull(),
    route: varchar("route", { length: 128 }).notNull(),
    keyHash: char("key_hash", { length: 64 }).notNull(),
    requestHash: char("request_hash", { length: 64 }).notNull(),
    responseJson: json("response_json").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    userKeyIdx: uniqueIndex("mobile_idempotency_keys_user_key_uq").on(table.userId, table.keyHash),
    expiresIdx: index("mobile_idempotency_keys_expires_idx").on(table.expiresAt),
  }),
);
