import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const updates = defineCollection({
    loader: glob({ pattern: "**/*.md", base: "./src/content/updates" }),
    schema: z.object({
        title: z.string(),
        date: z.date(),
        company: z.enum(["anthropic", "google", "openai", "roundup"]),
        summary: z.string(),
        links: z
            .array(
                z.object({
                    label: z.string(),
                    url: z.string().url(),
                }),
            )
            .default([]),
    }),
});

export const collections = { updates };
