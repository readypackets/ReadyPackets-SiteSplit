/**
 * Phase I intake form and mutual NDA acceptance.
 *
 * The intake questionnaire follows Phase 1 Intake Form v1.0. Answers are stored
 * encrypted per question, drafts are saved without validation, and submission
 * applies the full validation set. MNDA acceptance records the typed signature
 * together with the address and agent, which is what makes the record evidentiary.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  intakeAnswers,
  intakeSubmissions,
  files,
  orderPhaseLocks,
  mndaAcceptances,
  policyAcceptances,
  policyDocuments,
  policyVersions,
} from "../db/schema.js";
import { decryptField, encryptField } from "../security/crypto.js";
import { recordActivity } from "../observability/audit.js";
import { getSetting, getSettingNumber } from "../services/settings.js";
import { OrderStateError, applyOrderAutomationRules, assertOrderAccess, assertOrderWritableAccess, syncOrderWorkflowProgress, transitionOrder } from "../services/orders.js";
import { exportIntakeMarkdownToPhaseTwo } from "../services/sharepoint.js";
import { protectedProcedure, router } from "../trpc/trpc.js";
import { INTAKE_OUTCOMES, INTEGRITY_CHOICES } from "../../shared/domain.js";
import { insertedId } from "../db/result.js";
import { getUserById } from "../db/users.js";

/**
 * Question catalogue for Phase I. `minLength` mirrors the guidance in the source
 * form: the deep-dive answers are the raw material for the analysis, so a
 * one-line response is rejected.
 */
/**
 * Typed MNDA signing is bound to the authenticated account name.  Unicode
 * normalization, case folding, and whitespace collapsing permit ordinary
 * display differences without accepting a different person’s name.
 */
function normalizeSignerName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

export const INTAKE_QUESTIONS = [
  {
    key: "concept_summary",
    section: "Section 1 — The Core Concept",
    label: "In one paragraph, what is your invention or idea?",
    help: "Explain it as you would to a knowledgeable friend. Avoid jargon.",
    minLength: 120,
    maxLength: 4000,
    required: true,
  },
  {
    key: "problem_solved",
    section: "Section 1 — The Core Concept",
    label: "What specific problem does it solve?",
    help: "Describe the pain point and who experiences it.",
    minLength: 80,
    maxLength: 4000,
    required: true,
  },
  {
    key: "current_stage",
    section: "Section 1 — The Core Concept",
    label: "What stage is the concept at today?",
    help: "Napkin sketch, CAD model, prototype, pilot, or in market.",
    minLength: 20,
    maxLength: 2000,
    required: true,
  },
  {
    key: "target_customer",
    section: "Section 2 — Market & Customer",
    label: "Who is the target customer or user?",
    minLength: 40,
    maxLength: 3000,
    required: true,
  },
  {
    key: "existing_alternatives",
    section: "Section 2 — Market & Customer",
    label: "How do people solve this problem today?",
    help: "Name competitors or workarounds, however imperfect.",
    minLength: 40,
    maxLength: 3000,
    required: true,
  },
  {
    key: "differentiation",
    section: "Section 2 — Market & Customer",
    label: "What makes your approach different or better?",
    minLength: 40,
    maxLength: 3000,
    required: true,
  },
  {
    key: "technical_detail",
    section: "Section 3 — Technical Deep Dive",
    label: "Describe how it works technically, in as much detail as you can.",
    help: "Materials, mechanisms, software architecture, chemistry — whatever applies.",
    minLength: 150,
    maxLength: 8000,
    required: true,
  },
  {
    key: "known_risks",
    section: "Section 3 — Technical Deep Dive",
    label: "What technical risks or unknowns concern you most?",
    minLength: 40,
    maxLength: 4000,
    required: true,
  },
  {
    key: "ip_status",
    section: "Section 4 — Intellectual Property",
    label: "What is the current IP position?",
    help: "Filed, provisional, published, trade secret, or nothing yet.",
    minLength: 20,
    maxLength: 2000,
    required: true,
  },
  {
    key: "prior_disclosure",
    section: "Section 4 — Intellectual Property",
    label: "Has the concept been publicly disclosed in any form?",
    help: "Pitch events, crowdfunding, social media, academic papers.",
    minLength: 10,
    maxLength: 2000,
    required: true,
  },
  {
    key: "resources_available",
    section: "Section 5 — Resources & Constraints",
    label: "What resources do you have available?",
    help: "Budget range, team, facilities, partners.",
    minLength: 30,
    maxLength: 3000,
    required: true,
  },
  {
    key: "timeline",
    section: "Section 5 — Resources & Constraints",
    label: "What timeline are you working to, and why?",
    minLength: 20,
    maxLength: 2000,
    required: true,
  },
  {
    key: "success_definition",
    section: "Section 6 — Definition of Success",
    label: "Twelve months from now, what does success look like?",
    minLength: 40,
    maxLength: 3000,
    required: true,
  },
  {
    key: "additional_context",
    section: "Section 6 — Definition of Success",
    label: "Anything else we should know?",
    minLength: 0,
    maxLength: 5000,
    required: false,
  },
] as const;

type IntakeQuestionKey = (typeof INTAKE_QUESTIONS)[number]["key"];

const QUESTION_MAP = new Map(INTAKE_QUESTIONS.map((question) => [question.key, question]));

function toTrpcError(error: unknown): never {
  if (error instanceof OrderStateError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  throw error;
}

function renderIntakeMarkdown(input: {
  orderId: number;
  submissionId: number;
  projectName: string | null;
  desiredOutcomes: string[];
  integrityChoice: string | null;
  submittedAt: Date;
  answers: Map<string, string>;
}): string {
  const lines = [
    "# ReadyPackets Intake Answers",
    "",
    `- **Order ID:** ${input.orderId}`,
    `- **Submission ID:** ${input.submissionId}`,
    `- **Project:** ${input.projectName?.trim() || "Not provided"}`,
    `- **Submitted:** ${input.submittedAt.toISOString()}`,
    `- **Desired outcomes:** ${input.desiredOutcomes.join(", ") || "Not provided"}`,
    `- **Integrity choice:** ${input.integrityChoice || "Not provided"}`,
    "",
  ];

  let currentSection = "";
  for (const question of INTAKE_QUESTIONS) {
    if (question.section !== currentSection) {
      currentSection = question.section;
      lines.push(`## ${currentSection}`, "");
    }
    const answer = (input.answers.get(question.key) ?? "").trim() || "Not provided";
    lines.push(`### ${question.label}`, "", answer, "");
  }
  return `${lines.join("\n").trim()}\n`;
}

async function getOrCreateSubmission(orderId: number, userId: number): Promise<number> {
  const rows = await db
    .select({ id: intakeSubmissions.id })
    .from(intakeSubmissions)
    .where(eq(intakeSubmissions.orderId, orderId))
    .limit(1);
  const existing = rows[0];
  if (existing) return existing.id;

  const inserted = await db.insert(intakeSubmissions).values({ orderId, userId });
  return insertedId(inserted);
}

export const intakeRouter = router({
  /** Legacy built-in questions are intentionally disabled; staff assign order-specific Phase 1 and Phase 2 questions instead. */
  questions: protectedProcedure.query(() =>
    INTAKE_QUESTIONS.map((question) => ({
      key: question.key,
      section: question.section,
      label: question.label,
      help: "help" in question ? question.help : null,
      minLength: question.minLength,
      maxLength: question.maxLength,
      required: question.required,
    })).slice(0, 0),
  ),

  outcomes: protectedProcedure.query(() => ({
    desiredOutcomes: INTAKE_OUTCOMES,
    integrityChoices: INTEGRITY_CHOICES,
  })),

  get: protectedProcedure
    .input(z.object({ orderId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      try {
        await assertOrderAccess(input.orderId, ctx.session.user.id, ctx.session.user.role);
      } catch (error) {
        toTrpcError(error);
      }

      const rows = await db
        .select()
        .from(intakeSubmissions)
        .where(eq(intakeSubmissions.orderId, input.orderId))
        .limit(1);
      const submission = rows[0];

      if (!submission) {
        return {
          status: "draft" as const,
          submittedAt: null,
          projectName: null as string | null,
          desiredOutcomes: [] as string[],
          integrityChoice: null as string | null,
          answers: {} as Record<string, string>,
          limits: {
            maxDocuments: await getSettingNumber("intake.max_documents", 5),
            allowedDocumentTypes: await getSetting("intake.allowed_document_types") ?? ".pdf,.doc,.docx,.txt",
            maxPitchRecordings: await getSettingNumber("intake.max_pitch_recordings", 1),
            maxPitchLengthSeconds: await getSettingNumber("intake.max_pitch_length_seconds", 300),
            microphonePreflightEnabled: (await getSetting("intake.microphone_preflight_enabled")) !== "false",
          },
        };
      }

      const answerRows = await db
        .select()
        .from(intakeAnswers)
        .where(eq(intakeAnswers.submissionId, submission.id));

      const answers: Record<string, string> = {};
      for (const row of answerRows) {
        const value = decryptField(row.answerEnc, `intake:${submission.id}:${row.questionKey}`);
        if (value !== null) answers[row.questionKey] = value;
      }

      return {
        status: submission.status as "draft" | "submitted",
        submittedAt: submission.submittedAt,
        projectName: decryptField(submission.projectNameEnc, `intake:${submission.id}`),
        desiredOutcomes: (submission.desiredOutcomes as string[] | null) ?? [],
        integrityChoice: submission.integrityChoice,
        answers,
        limits: {
          maxDocuments: await getSettingNumber("intake.max_documents", 5),
          allowedDocumentTypes: await getSetting("intake.allowed_document_types") ?? ".pdf,.doc,.docx,.txt",
                      maxPitchRecordings: await getSettingNumber("intake.max_pitch_recordings", 1),
            maxPitchLengthSeconds: await getSettingNumber("intake.max_pitch_length_seconds", 300),
            microphonePreflightEnabled: (await getSetting("intake.microphone_preflight_enabled")) !== "false",
          },
        };
      }
),

  /** Save a draft. Length rules are not applied until submission. */
  save: protectedProcedure
    .input(
      z.object({
        orderId: z.number().int().positive(),
        projectName: z.string().trim().min(1, "Enter an order or project name.").max(190),
        desiredOutcomes: z.array(z.enum(INTAKE_OUTCOMES)).max(4).optional(),
        integrityChoice: z.enum(INTEGRITY_CHOICES).optional(),
        answers: z.record(z.string().max(8000)).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await assertOrderWritableAccess(input.orderId, ctx.session.user.id, ctx.session.user.role);
      } catch (error) {
        toTrpcError(error);
      }

      const existing = await db
        .select({ status: intakeSubmissions.status })
        .from(intakeSubmissions)
        .where(eq(intakeSubmissions.orderId, input.orderId))
        .limit(1);
      if (existing[0]?.status === "submitted") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This intake form has already been submitted and can no longer be edited.",
        });
      }

      const submissionId = await getOrCreateSubmission(input.orderId, ctx.session.user.id);

      const patch: Partial<typeof intakeSubmissions.$inferInsert> = {};
      if (input.projectName !== undefined) {
        patch.projectNameEnc = encryptField(input.projectName, `intake:${submissionId}`);
      }
      if (input.desiredOutcomes !== undefined) patch.desiredOutcomes = input.desiredOutcomes;
      if (input.integrityChoice !== undefined) patch.integrityChoice = input.integrityChoice;
      if (Object.keys(patch).length > 0) {
        await db
          .update(intakeSubmissions)
          .set(patch)
          .where(eq(intakeSubmissions.id, submissionId));
      }

      for (const [key, value] of Object.entries(input.answers ?? {})) {
        if (!QUESTION_MAP.has(key as IntakeQuestionKey)) continue;
        const encrypted = encryptField(value, `intake:${submissionId}:${key}`);
        const found = await db
          .select({ id: intakeAnswers.id })
          .from(intakeAnswers)
          .where(
            and(
              eq(intakeAnswers.submissionId, submissionId),
              eq(intakeAnswers.questionKey, key),
            ),
          )
          .limit(1);
        if (found[0]) {
          await db
            .update(intakeAnswers)
            .set({ answerEnc: encrypted })
            .where(eq(intakeAnswers.id, found[0].id));
        } else {
          await db.insert(intakeAnswers).values({
            submissionId,
            questionKey: key,
            answerEnc: encrypted,
          });
        }
      }

      return { ok: true as const, submissionId };
    }),

  submit: protectedProcedure
    .input(
      z.object({
        orderId: z.number().int().positive(),
        confirmAccurate: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!input.confirmAccurate) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Please confirm that the information you have provided is accurate.",
        });
      }

      try {
        await assertOrderWritableAccess(input.orderId, ctx.session.user.id, ctx.session.user.role);
      } catch (error) {
        toTrpcError(error);
      }

      const rows = await db
        .select()
        .from(intakeSubmissions)
        .where(eq(intakeSubmissions.orderId, input.orderId))
        .limit(1);
      const submission = rows[0];
      if (!submission) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Start the intake form before submitting it.",
        });
      }
      if (submission.status === "submitted") return { ok: true as const };

      const answerRows = await db
        .select()
        .from(intakeAnswers)
        .where(eq(intakeAnswers.submissionId, submission.id));
      const answerMap = new Map(
        answerRows.map((row) => [
          row.questionKey,
          decryptField(row.answerEnc, `intake:${submission.id}:${row.questionKey}`) ?? "",
        ]),
      );

      const problems: string[] = [];
      // There is no built-in questionnaire. Required responses are controlled by
      // the Phase 1 or Phase 2 questions that staff assign to this order.

      // Enforce file limits on submission
      const orderFiles = await db
        .select({ category: files.category, detectedMime: files.detectedMime })
        .from(files)
        .where(and(eq(files.orderId, input.orderId), isNull(files.deletedAt)));
      
      const documents = orderFiles.filter(f => f.category === "intake_attachment" && !f.detectedMime.startsWith("audio/"));
      const pitchRecordings = orderFiles.filter(f => f.category === "intake_attachment" && f.detectedMime.startsWith("audio/"));
      
      const maxDocs = await getSettingNumber("intake.max_documents", 5);
      const maxPitches = await getSettingNumber("intake.max_pitch_recordings", 1);
      
      if (documents.length > maxDocs) {
        problems.push(`You have attached ${documents.length} documents, but the limit is ${maxDocs}. Please remove some before submitting.`);
      }
      if (pitchRecordings.length > maxPitches) {
        problems.push(`You have attached ${pitchRecordings.length} pitch recordings, but the limit is ${maxPitches}. Please remove some before submitting.`);
      }

      if (problems.length > 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: problems.join(" ") });
      }

      const outcomes = (submission.desiredOutcomes as string[] | null) ?? [];
      const submittedAt = new Date();
      await db
        .update(intakeSubmissions)
        .set({ status: "submitted", submittedAt })
        .where(eq(intakeSubmissions.id, submission.id));
      await db.insert(orderPhaseLocks).values({
        orderId: input.orderId,
        phaseKey: "phase_1",
        acknowledgementText: "I acknowledge that submitting this Phase 1 intake locks my customer files, WebM recording, and responses until an administrator confirms an unlock.",
        lockedByUserId: ctx.session.user.id,
        lockedAt: submittedAt,
      }).onDuplicateKeyUpdate({
        set: {
          acknowledgementText: "I acknowledge that submitting this Phase 1 intake locks my customer files, WebM recording, and responses until an administrator confirms an unlock.",
          lockedByUserId: ctx.session.user.id,
          lockedAt: submittedAt,
          unlockedByUserId: null,
          unlockedAt: null,
          unlockReason: null,
        },
      });

      const intakeMarkdown = renderIntakeMarkdown({
        orderId: input.orderId,
        submissionId: submission.id,
        projectName: decryptField(submission.projectNameEnc, `intake:${submission.id}`),
        desiredOutcomes: outcomes,
        integrityChoice: submission.integrityChoice,
        submittedAt,
        answers: answerMap,
      });
      void exportIntakeMarkdownToPhaseTwo(input.orderId, intakeMarkdown).catch((error) =>
        recordActivity({
          actorUserId: null,
          action: "sharepoint.intake_markdown_export_failed",
          entityType: "order",
          entityId: input.orderId,
          summary: `Intake Markdown export queued unsuccessfully: ${error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180)}`,
        }),
      );

      const workflowProgress = await syncOrderWorkflowProgress(input.orderId);
      await applyOrderAutomationRules(input.orderId, "intake_submitted");

      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: ctx.session.user.role,
        action: "intake.submit",
        entityType: "order",
        entityId: input.orderId,
        summary: "Phase I intake form submitted",
        changes: { workflowProgress },
        ipAddress: ctx.clientIp,
      });

      // Advance the order when both Phase I gates are now satisfied.
      try {
        await transitionOrder({
          orderId: input.orderId,
          to: "phase_2_synthesis",
          actorUserId: ctx.session.user.id,
          actorRole: ctx.session.user.role,
          reason: "Intake submitted and MNDA on file",
          ipAddress: ctx.clientIp,
        });
        return { ok: true as const, advanced: true };
      } catch {
        // The MNDA is still outstanding; the order stays in Phase I.
        return { ok: true as const, advanced: false };
      }
    }),

  /* ---------------------------------------------------------------- */
  /* Mutual NDA                                                        */
  /* ---------------------------------------------------------------- */

  mndaDocument: protectedProcedure.query(async () => {
    const rows = await db
      .select({
        versionId: policyVersions.id,
        version: policyVersions.version,
        effectiveDate: policyVersions.effectiveDate,
        bodyMarkdown: policyVersions.bodyMarkdown,
        title: policyDocuments.title,
      })
      .from(policyDocuments)
      .innerJoin(policyVersions, eq(policyVersions.policyId, policyDocuments.id))
      .where(and(eq(policyDocuments.slug, "mnda"), eq(policyVersions.published, true)))
      .orderBy(desc(policyVersions.id))
      .limit(1);
    const document = rows[0];
    if (!document) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "The mutual NDA has not been published yet. Please contact us.",
      });
    }
    return document;
  }),

  mndaStatus: protectedProcedure
    .input(z.object({ orderId: z.number().int().positive().optional() }))
    .query(async ({ ctx, input }) => {
      const condition = input.orderId
        ? and(
            eq(mndaAcceptances.userId, ctx.session.user.id),
            eq(mndaAcceptances.orderId, input.orderId),
          )
        : eq(mndaAcceptances.userId, ctx.session.user.id);
      const rows = await db
        .select({ id: mndaAcceptances.id, acceptedAt: mndaAcceptances.acceptedAt })
        .from(mndaAcceptances)
        .where(condition)
        .orderBy(desc(mndaAcceptances.acceptedAt))
        .limit(1);
      return { accepted: rows.length > 0, acceptedAt: rows[0]?.acceptedAt ?? null };
    }),

  acceptMnda: protectedProcedure
    .input(
      z.object({
        orderId: z.number().int().positive().optional(),
        signatureName: z.string().trim().min(3).max(120),
        confirmAuthority: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!input.confirmAuthority) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Confirm that you are authorised to sign this agreement.",
        });
      }

      const signer = await getUserById(ctx.session.user.id);
      const accountName = [signer?.firstName, signer?.lastName].filter((value): value is string => Boolean(value?.trim())).join(" ");
      if (!accountName || normalizeSignerName(input.signatureName) !== normalizeSignerName(accountName)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Enter the first and last name recorded on your ReadyPackets account to sign this agreement.",
        });
      }

      if (input.orderId !== undefined) {
        try {
          await assertOrderWritableAccess(input.orderId, ctx.session.user.id, ctx.session.user.role);
        } catch (error) {
          toTrpcError(error);
        }
      }

      const versionRows = await db
        .select({ id: policyVersions.id })
        .from(policyDocuments)
        .innerJoin(policyVersions, eq(policyVersions.policyId, policyDocuments.id))
        .where(and(eq(policyDocuments.slug, "mnda"), eq(policyVersions.published, true)))
        .orderBy(desc(policyVersions.id))
        .limit(1);
      const versionId = versionRows[0]?.id;
      if (!versionId) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The mutual NDA has not been published yet.",
        });
      }

      const inserted = await db.insert(mndaAcceptances).values({
        userId: ctx.session.user.id,
        orderId: input.orderId ?? null,
        policyVersionId: versionId,
        signatureNameEnc: encryptField(input.signatureName, "mnda:pending") ?? "",
        signatureMethod: "typed",
        ipAddress: ctx.clientIp.slice(0, 64),
        userAgent: ctx.userAgent,
      });
      const acceptanceId = insertedId(inserted);
      await db
        .update(mndaAcceptances)
        .set({
          signatureNameEnc: encryptField(input.signatureName, `mnda:${acceptanceId}`) ?? "",
        })
        .where(eq(mndaAcceptances.id, acceptanceId));

      await db.insert(policyAcceptances).values({
        userId: ctx.session.user.id,
        policyVersionId: versionId,
        ipAddress: ctx.clientIp.slice(0, 64),
        userAgent: ctx.userAgent,
      });

      void recordActivity({
        actorUserId: ctx.session.user.id,
        actorRole: ctx.session.user.role,
        action: "mnda.accept",
        entityType: "order",
        entityId: input.orderId ?? null,
        summary: "Mutual NDA signed",
        ipAddress: ctx.clientIp,
      });

      if (input.orderId) {
        try {
          await transitionOrder({
            orderId: input.orderId,
            to: "phase_2_synthesis",
            actorUserId: ctx.session.user.id,
            actorRole: ctx.session.user.role,
            reason: "MNDA signed and intake on file",
            ipAddress: ctx.clientIp,
          });
          return { ok: true as const, advanced: true };
        } catch {
          return { ok: true as const, advanced: false };
        }
      }

      return { ok: true as const, advanced: false };
    }),
});
