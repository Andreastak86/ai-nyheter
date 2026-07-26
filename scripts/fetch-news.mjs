import Anthropic from "@anthropic-ai/sdk";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPDATES_DIR = join(__dirname, "..", "src", "content", "updates");
const COMPANIES = ["anthropic", "google", "openai", "roundup"];

const client = new Anthropic();

function existingUpdates() {
  return readdirSync(UPDATES_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .slice(0, 25)
    .map((filename) => {
      const raw = readFileSync(join(UPDATES_DIR, filename), "utf-8");
      const title = raw.match(/^title:\s*"(.*)"\s*$/m)?.[1] ?? filename;
      const date = raw.match(/^date:\s*(\S+)\s*$/m)?.[1] ?? "";
      return `- ${date} [${filename}]: ${title}`;
    });
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function frontmatter({ title, date, company, summary, links }) {
  const linksYaml = (links ?? []).length
    ? [
        "links:",
        ...links.map(
          (l) => `    - label: "${l.label.replace(/"/g, '\\"')}"\n      url: "${l.url}"`,
        ),
      ].join("\n")
    : "links: []";

  return `---
title: "${title.replace(/"/g, '\\"')}"
date: ${date}
company: ${company}
summary: >
    ${summary.replace(/\n/g, "\n    ")}
${linksYaml}
---
`;
}

const existing = existingUpdates();

const publishTool = {
  name: "publish_update",
  description:
    "Publiser en genuint ny AI-nyhetsoppdatering du har funnet via websøk. Kall denne kun for nyheter som IKKE allerede finnes i listen over eksisterende oppdateringer.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Kort, konkret norsk tittel på nyheten." },
      date: {
        type: "string",
        description: "Dato nyheten ble annonsert, format YYYY-MM-DD.",
      },
      company: {
        type: "string",
        enum: COMPANIES,
        description:
          "anthropic, google eller openai for nyheter om ett selskap; roundup for oppsummeringer på tvers av flere selskaper.",
      },
      summary: {
        type: "string",
        description:
          "2-4 setninger på norsk som oppsummerer nyheten med konkrete detaljer (tall, modellnavn, datoer).",
      },
      slug: {
        type: "string",
        description: "Kort URL-vennlig slug i kebab-case, uten datoprefiks, f.eks. 'claude-opus-5'.",
      },
      links: {
        type: "array",
        description: "1-3 kildelenker.",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            url: { type: "string" },
          },
          required: ["label", "url"],
        },
      },
    },
    required: ["title", "date", "company", "summary", "slug"],
  },
};

const system = `Du er en researcher som holder et norsk AI-nyhetsnettsted oppdatert.
Bruk websøk til å finne ferske, konkrete nyheter (siste 7 dager) om Anthropic, OpenAI og Google sine
AI-modeller og -produkter. Kall verktøyet publish_update én gang per genuint ny nyhet du bekrefter via søk.
Ikke publiser noe som allerede finnes i listen over eksisterende oppdateringer under. Ikke publiser rykter
eller uverifiserte kilder - bruk minst én pålitelig kilde per nyhet. Hvis du ikke finner noe nytt og
verifiserbart, ikke kall verktøyet i det hele tatt.

Eksisterende oppdateringer (ikke publiser duplikater av disse):
${existing.join("\n") || "(ingen)"}`;

async function run() {
  let response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 8000,
    system,
    tools: [{ type: "web_search_20260209", name: "web_search" }, publishTool],
    messages: [
      {
        role: "user",
        content:
          "Finn siste ukers AI-nyheter fra Anthropic, OpenAI og Google, og publiser de som er nye og verifiserte.",
      },
    ],
  });

  // Server-side web search can exhaust its per-request round limit; resume on pause_turn.
  let guard = 0;
  while (response.stop_reason === "pause_turn" && guard < 3) {
    response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 8000,
      system,
      tools: [{ type: "web_search_20260209", name: "web_search" }, publishTool],
      messages: [
        {
          role: "user",
          content:
            "Finn siste ukers AI-nyheter fra Anthropic, OpenAI og Google, og publiser de som er nye og verifiserte.",
        },
        { role: "assistant", content: response.content },
      ],
    });
    guard += 1;
  }

  const publishCalls = response.content.filter(
    (block) => block.type === "tool_use" && block.name === "publish_update",
  );

  if (publishCalls.length === 0) {
    console.log("Ingen nye nyheter funnet.");
    return;
  }

  for (const call of publishCalls) {
    const update = call.input;
    if (!COMPANIES.includes(update.company)) {
      console.warn(`Hopper over "${update.title}" - ugyldig company: ${update.company}`);
      continue;
    }
    const slug = slugify(update.slug || update.title);
    const filename = `${update.date}-${slug}.md`;
    const path = join(UPDATES_DIR, filename);
    if (existsSync(path)) {
      console.log(`Hopper over ${filename} - finnes allerede.`);
      continue;
    }
    writeFileSync(path, frontmatter(update), "utf-8");
    console.log(`Skrev ${filename}`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
