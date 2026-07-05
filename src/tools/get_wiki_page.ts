/**
 * get_wiki_page tool — đọc GitLab project wiki page.
 *
 * Cho project lưu ADRs / runbooks / design docs trong GitLab Wiki thay vì
 * committed trong repo. Bot không clone wiki (chỉ clone source branch), nên
 * cần tool này để fetch qua API.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { getWikiPage } from "../gitlab.ts";
import type { ToolContext } from "./index.ts";
import { ok, err } from "./result.ts";

const MAX_WIKI_BYTES = 200_000;

export function getWikiPageTool(ctx: ToolContext) {
  return defineTool({
    name: "get_wiki_page",
    label: "Get Wiki Page",
    description:
      "Read a GitLab project wiki page by slug. Use when project stores ADRs, design docs, " +
      "or runbooks in the project Wiki rather than in the repo. The wiki is not part of the git clone.",
    promptSnippet:
      "get_wiki_page(slug): read GitLab project wiki page. For ADRs/docs stored outside repo.",
    parameters: Type.Object({
      slug: Type.String({
        description: "Wiki page slug (URL-friendly identifier). e.g. 'architecture-decisions', 'home'",
      }),
    }),
    async execute(_id, params) {
      const res = await getWikiPage(ctx.mrContext.projectId, params.slug);
      if (!res.ok) {
        return err(`Wiki page '${params.slug}' not found: ${res.error}`);
      }
      const truncated = res.page.content.length > MAX_WIKI_BYTES;
      const content = truncated ? res.page.content.slice(0, MAX_WIKI_BYTES) + "\n\n... (truncated)" : res.page.content;
      return ok(
        `# Wiki: ${res.page.title}\nSlug: ${res.page.slug} | Format: ${res.page.format}\n\n${content}`,
        { slug: res.page.slug, truncated },
      );
    },
  });
}
