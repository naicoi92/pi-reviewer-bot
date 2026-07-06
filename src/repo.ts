/**
 * Repo access trong CI-job mode.
 *
 * KHÔNG còn `cloneForReview` (D1-revised) — CI runner đã checkout source branch
 * vào `process.cwd()`. `repoDir` resolve từ `context.ts` (LOCAL_REPO_PATH fallback
 * cho debug ngoài CI). Chỉ giữ `readFileOrNull` cho config loader.
 */

import { join } from "node:path";
import { repoDir } from "./context.ts";

export { repoDir };

/**
 * Read a UTF-8 file dưới dir, trả null nếu missing. Dùng cho config loader
 * (.pi/config.yaml) + scope-check helpers.
 */
export async function readFileOrNull(
	dir: string,
	relPath: string,
): Promise<string | null> {
	const abs = join(dir, relPath);
	try {
		return await Bun.file(abs).text();
	} catch {
		return null;
	}
}
