/**
 * list_wiki_pages tool — discovery wiki slugs before reading.
 *
 * Use case: AI doesn't know what wiki pages exist. Call this first to list,
 * then call get_wiki_page(slug) for the relevant one.
 *
 * Tip: returns slugs + titles only, no content — cheap on tokens.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { listWikiPages } from "../gitlab.ts";
import type { ToolContext } from "./index.ts";
import { ok, err } from "./result.ts";

export function listWikiPagesTool(ctx: ToolContext) {
  return defineTool({
    name: "list_wiki_pages",
    label: "List Wiki Pages",
    description:
      "List all wiki pages in the GitLab project (slug + title only, no content). " +
      "Use this FIRST to discover available pages, then call get_wiki_page(slug) to read one.",
    promptSnippet:
      "list_wiki_pages(): list wiki slugs/titles. Discover before get_wiki_page(slug).",
    promptGuidelines: [
      "If project stores docs in Wiki, call list_wiki_pages first to see what's available.",
      "Pair with get_wiki_page(slug) — never guess slugs blindly.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const res = await listWikiPages(ctx.mrContext.projectId);
      if (!res.ok) {
        return err(`Failed to list wiki pages: ${res.error}`);
      }
      if (res.pages.length === 0) {
        return ok("This project has no wiki pages.", { count: 0 });
      }
      const lines: string[] = [
        `# Wiki pages (${res.pages.length} total)`,
        ``,
        ...res.pages.map((p) => `- \`${p.slug}\` — ${p.title}`),
      ];
      return ok(lines.join("\n"), { count: res.pages.length });
    },
  });
}
