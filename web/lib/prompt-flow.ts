import { z } from "zod";

/** Runtime schema for campaigns.prompt_flow. Keep in sync with config/prompt-flow.schema.json. */
export const promptSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  title: z.string().min(1).max(200),
  body: z.string().max(1000).optional(),
  prepSeconds: z.number().int().min(0).max(60).default(5),
  minSeconds: z.number().int().min(0).max(600).default(0),
  maxSeconds: z.number().int().min(5).max(600),
  optional: z.boolean().default(false),
});

export const fieldSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  label: z.string().min(1).max(80),
  type: z.enum(["text", "email", "url"]).default("text"),
  required: z.boolean().default(false),
  maxLength: z.number().int().min(1).max(500).default(200),
  public: z.boolean().default(true),
});

export const promptFlowSchema = z
  .object({
    version: z.literal(1),
    intro: z
      .object({
        title: z.string().max(120).optional(),
        body: z.string().max(1000).optional(),
        estimatedMinutes: z.number().min(0).optional(),
      })
      .default({}),
    fields: z.array(fieldSchema).max(10).default([]),
    prompts: z.array(promptSchema).min(1).max(20),
    recording: z
      .object({
        maxRetakes: z.number().int().min(0).max(10).default(3),
        maxSegmentBytes: z.number().int().min(1_048_576).max(5_368_709_120).default(524_288_000),
        mimeTypes: z.array(z.string()).optional(),
        video: z
          .object({
            width: z.number().int().default(1280),
            height: z.number().int().default(720),
            frameRate: z.number().int().default(30),
          })
          .default({}),
      })
      .default({}),
  })
  .superRefine((flow, ctx) => {
    const ids = new Set<string>();
    flow.prompts.forEach((p, i) => {
      if (ids.has(p.id)) ctx.addIssue({ code: "custom", path: ["prompts", i, "id"], message: "duplicate prompt id" });
      ids.add(p.id);
      if (p.minSeconds > p.maxSeconds)
        ctx.addIssue({ code: "custom", path: ["prompts", i], message: "minSeconds > maxSeconds" });
    });
    if (flow.prompts.every((p) => p.optional))
      ctx.addIssue({ code: "custom", path: ["prompts"], message: "at least one prompt must be required" });
  });

export type PromptFlow = z.infer<typeof promptFlowSchema>;
export type Prompt = z.infer<typeof promptSchema>;
export type FlowField = z.infer<typeof fieldSchema>;

export const brandingSchema = z
  .object({
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).default("#4f46e5"),
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).default("#ffffff"),
    textColor: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).default("#0f172a"),
    radius: z.number().min(0).max(40).default(14),
    fontFamily: z.string().max(200).default("system-ui, sans-serif"),
    logoUrl: z.string().url().optional(),
    wallTitle: z.string().max(120).optional(),
  })
  .default({});

export type Branding = z.infer<typeof brandingSchema>;
