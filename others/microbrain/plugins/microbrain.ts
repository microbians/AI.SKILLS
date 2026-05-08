/**
 * Microbrain Plugin for OpenCode
 *
 * Reactive SQLite memory system that persists knowledge across sessions.
 * Provides automatic context injection, memory extraction on compaction,
 * and custom tools for searching/saving memories.
 *
 * @license MIT
 */

import { type Plugin, tool } from "@opencode-ai/plugin";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

// ═══════════════════ DATABASE HELPERS ═══════════════════

const MEMORY_TYPES = ["error", "api", "decision", "pattern", "context", "preference"] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];

interface Memory {
	id: number;
	type: MemoryType;
	subject: string;
	content: string;
	keywords: string;
	importance: number;
	file_refs: string;
	session_id: number;
	created_at: string;
	updated_at: string;
}

function getDbPath(directory: string): string {
	// Check both locations — .opencode/memory.db is canonical
	const opencodePath = join(directory, ".opencode", "memory.db");
	const claudePath = join(directory, ".claude", "memory.db");
	if (existsSync(opencodePath)) return opencodePath;
	if (existsSync(claudePath)) return claudePath;
	return opencodePath; // Default to .opencode/memory.db for creation
}

function openDb(directory: string): Database | null {
	const dbPath = getDbPath(directory);
	if (!existsSync(dbPath)) return null;
	try {
		return new Database(dbPath);
	} catch {
		return null;
	}
}

function ensureDb(directory: string): Database {
	const dbPath = getDbPath(directory);
	const dir = join(directory, ".opencode");
	if (!existsSync(dir)) {
		// Safety: never create directories at filesystem root
		if (!directory || directory === "/" || directory.length < 3) {
			throw new Error(`Refusing to create .opencode in invalid directory: "${directory}"`);
		}
		mkdirSync(dir, { recursive: true });
	}
	const db = new Database(dbPath);
	// Create schema if needed
	db.exec(`
		CREATE TABLE IF NOT EXISTS memories (
			id INTEGER PRIMARY KEY,
			type TEXT CHECK(type IN ('api','error','decision','pattern','context','preference')),
			subject TEXT NOT NULL,
			content TEXT NOT NULL,
			keywords TEXT,
			importance INTEGER DEFAULT 3,
			file_refs TEXT,
			session_id INTEGER,
			created_at TEXT DEFAULT (datetime('now')),
			updated_at TEXT DEFAULT (datetime('now'))
		);
		CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
			subject, content, keywords,
			content='memories', content_rowid='id'
		);
		CREATE TABLE IF NOT EXISTS sessions (
			id INTEGER PRIMARY KEY,
			date TEXT NOT NULL,
			topic TEXT,
			started_at TEXT DEFAULT (datetime('now')),
			ended_at TEXT,
			summary TEXT
		);
		-- FTS triggers for auto-sync
		CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
			INSERT INTO memories_fts(rowid, subject, content, keywords)
			VALUES (new.id, new.subject, new.content, new.keywords);
		END;
		CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, subject, content, keywords)
			VALUES ('delete', old.id, old.subject, old.content, old.keywords);
		END;
		CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, subject, content, keywords)
			VALUES ('delete', old.id, old.subject, old.content, old.keywords);
			INSERT INTO memories_fts(rowid, subject, content, keywords)
			VALUES (new.id, new.subject, new.content, new.keywords);
		END;
	`);
	return db;
}

// ═══════════════════ SEARCH HELPERS ═══════════════════

function searchMemories(
	db: Database,
	query: string,
	opts: { type?: string; limit?: number; minImportance?: number; fileRef?: string }
): Memory[] {
	const { type, limit = 10, minImportance = 1, fileRef } = opts;

	// Build WHERE clauses
	const conditions: string[] = ["m.importance >= ?"];
	const params: (string | number)[] = [minImportance];

	if (type && MEMORY_TYPES.includes(type as MemoryType)) {
		conditions.push("m.type = ?");
		params.push(type);
	}

	if (fileRef) {
		conditions.push("m.file_refs LIKE ?");
		params.push(`%${fileRef}%`);
	}

	const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

	// Try FTS first if query has content
	if (query && query.trim().length > 0) {
		try {
			// Sanitize FTS query: remove special chars, convert spaces to OR
			const ftsQuery = query
				.replace(/[^\w\s.-]/g, "")
				.trim()
				.split(/\s+/)
				.filter((w) => w.length > 1)
				.join(" OR ");

			if (ftsQuery.length > 0) {
				const stmt = db.prepare(`
					SELECT m.id, m.type, m.subject, m.content, m.keywords,
						   m.importance, m.file_refs, m.session_id,
						   m.created_at, m.updated_at
					FROM memories m
					JOIN memories_fts f ON m.id = f.rowid
					WHERE memories_fts MATCH ? ${whereClause}
					ORDER BY m.importance DESC, m.updated_at DESC
					LIMIT ?
				`);
				const results = stmt.all(ftsQuery, ...params, limit) as Memory[];
				if (results.length > 0) return results;
			}
		} catch {
			// FTS failed, fall through to LIKE search
		}

		// Fallback: LIKE search
		const likeStmt = db.prepare(`
			SELECT id, type, subject, content, keywords, importance,
				   file_refs, session_id, created_at, updated_at
			FROM memories m
			WHERE (m.subject LIKE ? OR m.content LIKE ? OR m.keywords LIKE ?)
			${whereClause}
			ORDER BY m.importance DESC, m.updated_at DESC
			LIMIT ?
		`);
		const likePattern = `%${query}%`;
		return likeStmt.all(likePattern, likePattern, likePattern, ...params, limit) as Memory[];
	}

	// No query: return recent important memories
	const recentStmt = db.prepare(`
		SELECT id, type, subject, content, keywords, importance,
			   file_refs, session_id, created_at, updated_at
		FROM memories m
		WHERE 1=1 ${whereClause}
		ORDER BY m.importance DESC, m.updated_at DESC
		LIMIT ?
	`);
	return recentStmt.all(...params, limit) as Memory[];
}

function formatMemories(memories: Memory[]): string {
	if (memories.length === 0) return "No memories found.";

	return memories
		.map((m) => {
			const parts = [`[${m.type.toUpperCase()}] ${m.subject} (importance: ${m.importance})`];
			parts.push(`  ${m.content}`);
			if (m.keywords) parts.push(`  keywords: ${m.keywords}`);
			if (m.file_refs) parts.push(`  files: ${m.file_refs}`);
			parts.push(`  updated: ${m.updated_at}`);
			return parts.join("\n");
		})
		.join("\n\n");
}

// ═══════════════════ HEURISTIC EXTRACTION ═══════════════════

interface ExtractedMemory {
	type: MemoryType;
	subject: string;
	content: string;
	importance: number;
	keywords: string;
}

function extractWithHeuristics(text: string): { memories: ExtractedMemory[]; summary: string } {
	const memories: ExtractedMemory[] = [];
	const seen = new Set<string>();

	const addMemory = (type: MemoryType, subject: string, content: string, importance: number, keywords: string) => {
		const key = `${type}:${subject.toLowerCase().slice(0, 30)}`;
		if (!seen.has(key) && subject.length > 5 && content.length > 20) {
			seen.add(key);
			memories.push({
				type,
				subject: subject.slice(0, 60).trim(),
				content: content.slice(0, 250).trim(),
				importance,
				keywords,
			});
		}
	};

	// Pattern: "X does not exist"
	for (const match of text.matchAll(
		/([a-zA-Z_][a-zA-Z0-9_.]*(?:\(\))?)\s+(?:does not exist|doesn't exist|no existe|not found|is undefined)/gi
	)) {
		if (match[1]) addMemory("error", `${match[1]} does not exist`, match[0], 4, "error,undefined,missing");
	}

	// Pattern: "use X instead of Y"
	for (const match of text.matchAll(
		/(?:use|usar)\s+([a-zA-Z_][a-zA-Z0-9_.=\s]+?)\s+(?:instead of|en lugar de|not)\s+([a-zA-Z_][a-zA-Z0-9_.()]+)/gi
	)) {
		if (match[1] && match[2])
			addMemory("api", `Use ${match[1].trim()} not ${match[2].trim()}`, match[0], 4, "api,usage,correct");
	}

	// Pattern: "the solution is" / "fixed by"
	for (const match of text.matchAll(
		/(?:the |la )?solution(?:n)?\s+(?:is|es|was|era)[:\s]+([^.]{20,150})/gi
	)) {
		if (match[1]) {
			const content = match[1].trim();
			addMemory("error", content.slice(0, 50), match[0], 4, "solution,fix,error");
		}
	}
	for (const match of text.matchAll(
		/(?:fixed|solved|resuelto|solucionado)\s+(?:by|con|usando)[:\s]+([^.]{20,150})/gi
	)) {
		if (match[1]) {
			const content = match[1].trim();
			addMemory("error", content.slice(0, 50), match[0], 4, "solution,fix,error");
		}
	}

	// Pattern: property corrections
	for (const match of text.matchAll(
		/([a-zA-Z]+(?:Style|Width|Color|Size|Type))\s+(?:instead of|not|en lugar de)\s+([a-zA-Z]+)/gi
	)) {
		if (match[1]) addMemory("api", `Property: ${match[1]}`, match[0], 3, "property,style,api");
	}

	// Pattern: decisions
	for (const match of text.matchAll(
		/(?:decided to|decision was|chose to|opted for|eleg[ií]|decid[ií])[:\s]+([^.]{20,150})/gi
	)) {
		if (match[1]) {
			const content = match[1].trim();
			addMemory("decision", content.slice(0, 50), match[0], 3, "decision,design,choice");
		}
	}

	const summary =
		memories.length > 0
			? `Session with ${memories.length} learnings: ${memories[0].subject}`
			: "Session ended (no significant learnings detected)";

	return { memories: memories.slice(0, 15), summary };
}

// ═══════════════════ LLM EXTRACTION ═══════════════════

/**
 * Sanitize text before sending to the local LLM.
 * Removes sequences that llama.cpp could interpret as special/control tokens
 * (e.g. </s>, <|endoftext|>, <|im_end|>, HTML tags, etc.)
 */
function sanitizeForLLM(text: string): string {
	return text
		// Remove common LLM control token patterns
		.replace(/<\|[^|]*\|>/g, "")       // <|endoftext|>, <|im_start|>, <|im_end|>, etc.
		.replace(/<\/s>/g, "")              // </s> end-of-sequence
		.replace(/<s>/g, "")                // <s> begin-of-sequence
		// Remove HTML/XML tags (code snippets in transcript)
		.replace(/<\/?[a-zA-Z][^>]*>/g, "")
		// Remove non-printable / control chars except newline and tab
		.replace(/[^\x20-\x7E\n\t]/g, " ")
		// Collapse multiple spaces/newlines
		.replace(/[ \t]{3,}/g, "  ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

async function extractWithLLM(
	transcript: string,
	projectDir: string
): Promise<{ memories: ExtractedMemory[]; summary: string } | null> {
	const modelPath = join(projectDir, ".opencode", "models", "qwen2.5-0.5b-instruct-q4_k_m.gguf");
	if (!existsSync(modelPath)) return null;

	try {
		// node-llama-cpp is installed via .opencode/package.json
		const { getLlama, LlamaChatSession } = await import("node-llama-cpp");

		const llama = await getLlama({ logLevel: "error", logger: () => {} });
		const model = await llama.loadModel({ modelPath });
		const context = await model.createContext();
		const session = new LlamaChatSession({
			contextSequence: context.getSequence(),
		});

		const sanitized = sanitizeForLLM(transcript.slice(0, 6000));

		const prompt = `Task: Extract technical learnings from a coding conversation.

Input: A conversation about coding
Output: JSON with memories array

Example input:
"The bug was that getData() returned null. Fixed by adding async/await."

Example output:
{"memories":[{"type":"error","subject":"getData returns null","content":"getData() returned null, fixed by adding async/await","importance":4,"keywords":"async,await,null"}],"summary":"Fixed async bug"}

Types: error (bugs), api (correct usage), decision (design choice), pattern (best practice)
Importance: 5=critical, 4=high, 3=normal

Now extract from this conversation:
${sanitized}`;

		const response = await session.prompt(prompt, {
			maxTokens: 1024,
			temperature: 0.1,
		});

		await context.dispose();
		await model.dispose();
		await llama.dispose();

		// Parse response
		const cleaned = response
			.replace(/```json\s*/gi, "")
			.replace(/```\s*/g, "")
			.trim();
		const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return null;

		const data = JSON.parse(jsonMatch[0]);
		if (!data.memories || !Array.isArray(data.memories)) return null;

		const validTypes = new Set(MEMORY_TYPES);
		data.memories = data.memories
			.filter(
				(m: any) =>
					m.type &&
					validTypes.has(m.type) &&
					m.subject?.length > 3 &&
					m.content?.length > 5 &&
					m.importance >= 1 &&
					m.importance <= 5
			)
			.map((m: any) => ({
				type: m.type,
				subject: String(m.subject).slice(0, 60),
				content: String(m.content).slice(0, 250),
				importance: m.importance,
				keywords: String(m.keywords || "").slice(0, 100),
			}));

		return data;
	} catch {
		return null;
	}
}

// ═══════════════════ PLUGIN ═══════════════════

export const MicrobrainPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
	// Resolve project directory robustly — worktree > directory > cwd > import.meta
	const resolveProjectDir = (): string => {
		// Try worktree first (git worktree path)
		if (worktree && worktree.length > 1 && worktree !== "/" && existsSync(worktree)) return worktree;
		// Then directory (project root passed by OpenCode)
		if (directory && directory.length > 1 && directory !== "/" && existsSync(directory)) return directory;
		// Fallback: walk up from this plugin file to find .opencode parent
		// Bun: import.meta.dir = directory of current file (absolute path)
		const pluginDir = (import.meta as any).dir || "";
		if (pluginDir && pluginDir.length > 1) {
			// Plugin lives at <project>/.opencode/plugins/microbrain.ts
			// So project root is 2 levels up from plugins/
			const candidate = join(pluginDir, "..", "..");
			if (existsSync(join(candidate, ".opencode"))) return candidate;
		}
		// Last resort: process.cwd() — but validate it
		const cwd = process.cwd();
		if (cwd && cwd.length > 1 && cwd !== "/") return cwd;
		throw new Error("Microbrain: cannot resolve project directory — all sources returned empty or root");
	};
	const projectDir = resolveProjectDir();

	return {
		// ─── Event: Session Created ───
		// Auto-load important memories at the start of every session
		event: async ({ event }) => {
			if (event.type === "session.created") {
				const db = openDb(projectDir);
				if (!db) return;

				try {
					// Get recent high-importance memories
					const memories = searchMemories(db, "", {
						minImportance: 4,
						limit: 8,
					});

					if (memories.length > 0) {
						const context = [
							"## Microbrain: Loaded Memories",
							"The following knowledge was loaded from the project's persistent memory:",
							"",
							formatMemories(memories),
							"",
							"Use `memory_search` to find more specific memories. Use `memory_save` to persist new learnings.",
						].join("\n");

						// Inject as context into the session
						const sessionId = (event as any).properties?.id;
						if (sessionId) {
							await client.session.prompt({
								path: { id: sessionId },
								body: {
									noReply: true,
									parts: [{ type: "text", text: context }],
								},
							});
						}
					}
				} catch {
					// Silent failure — don't disrupt session creation
				} finally {
					db.close();
				}
			}
		},

		// ─── Event: Session Compacting ───
		// Extract and save memories before context compaction
		"experimental.session.compacting": async (input, output) => {
			const db = openDb(projectDir);
			if (!db) return;

			try {
				// Get the conversation text from the compaction input
				// input contains the messages being compacted
				const transcript = JSON.stringify(input).slice(0, 10000);

				// Try LLM extraction first, fallback to heuristics
				let data = await extractWithLLM(transcript, projectDir);
				if (!data) {
					data = extractWithHeuristics(transcript);
				}

				// Save memories
				let saved = 0;
				const insertStmt = db.prepare(`
					INSERT INTO memories (type, subject, content, keywords, importance, session_id)
					VALUES (?, ?, ?, ?, ?, (SELECT MAX(id) FROM sessions))
				`);
				const existsStmt = db.prepare(
					"SELECT COUNT(*) as count FROM memories WHERE subject = ?"
				);

				for (const mem of data.memories) {
					const existing = existsStmt.get(mem.subject) as { count: number };
					if (existing && existing.count > 0) continue;

					insertStmt.run(mem.type, mem.subject, mem.content, mem.keywords, mem.importance);
					saved++;
				}

				// Update session summary
				if (data.summary) {
					db.exec(
						`UPDATE sessions SET summary = '${data.summary.replace(/'/g, "''")}', ended_at = datetime('now') WHERE id = (SELECT MAX(id) FROM sessions)`
					);
				}

				// Inject memory context into compaction
				const recentMemories = searchMemories(db, "", {
					minImportance: 4,
					limit: 5,
				});

				if (recentMemories.length > 0 || saved > 0) {
					output.context.push(
						`## Microbrain: Persistent Memory\n` +
							`${saved} new memories extracted and saved before compaction.\n\n` +
							`### Key memories to preserve:\n` +
							formatMemories(recentMemories) +
							`\n\nUse \`memory_search\` and \`memory_save\` tools to access persistent project memory.`
					);
				}
			} catch {
				// Silent failure — don't block compaction
			} finally {
				db.close();
			}
		},

		// ─── Custom Tools ───
		tool: {
			memory_search: tool({
				description:
					"Search the project's persistent memory database (SQLite + FTS5). " +
					"Use this to recall past solutions, API patterns, decisions, and errors. " +
					"Always search memory before re-investigating bugs or API usage.",
				args: {
					query: tool.schema
						.string()
						.describe("Search keywords (full-text search). Examples: 'WebGPU tile binning', 'fillStyle', 'scene render'"),
					type: tool.schema
						.string()
						.optional()
						.describe("Filter by type: error, api, decision, pattern, context, preference"),
					file: tool.schema
						.string()
						.optional()
						.describe("Filter by file reference (partial match)"),
					min_importance: tool.schema
						.number()
						.optional()
						.describe("Minimum importance level (1-5, default: 1)"),
					limit: tool.schema
						.number()
						.optional()
						.describe("Max results to return (default: 10, max: 30)"),
				},
				async execute(args) {
					const db = openDb(projectDir);
					if (!db) return "Memory database not found. It will be created when you save the first memory.";

					try {
						const memories = searchMemories(db, args.query, {
							type: args.type,
							fileRef: args.file,
							minImportance: args.min_importance || 1,
							limit: Math.min(args.limit || 10, 30),
						});

						if (memories.length === 0) {
							return `No memories found for "${args.query}". Try broader keywords or different type filter.`;
						}

						return `Found ${memories.length} memories:\n\n${formatMemories(memories)}`;
					} finally {
						db.close();
					}
				},
			}),

			memory_save: tool({
				description:
					"Save a learning to persistent memory. Use this whenever you discover a bug fix, " +
					"correct API usage, make a design decision, or learn a pattern. " +
					"Memories survive context compaction and are available in future sessions.",
				args: {
					type: tool.schema
						.string()
						.describe(
							"Memory type: error (bugs/fixes), api (correct usage), decision (design choices), pattern (best practices), context (file/module purpose), preference (user preferences)"
						),
					subject: tool.schema
						.string()
						.describe("Short subject line (max 60 chars). Example: 'fillStyle not fillColor for canvas'"),
					content: tool.schema
						.string()
						.describe(
							"Detailed description of the learning (max 250 chars). Include the problem AND solution."
						),
					keywords: tool.schema
						.string()
						.optional()
						.describe("Comma-separated keywords for search. Example: 'canvas,style,property'"),
					importance: tool.schema
						.number()
						.optional()
						.describe("Importance: 5=critical, 4=high, 3=normal (default), 2=low, 1=trivial"),
					file_refs: tool.schema
						.string()
						.optional()
						.describe("Comma-separated file paths this memory relates to"),
				},
				async execute(args) {
					const db = ensureDb(projectDir);

					try {
						// Validate type
						if (!MEMORY_TYPES.includes(args.type as MemoryType)) {
							return `Invalid type "${args.type}". Must be one of: ${MEMORY_TYPES.join(", ")}`;
						}

						// Validate lengths
						const subject = args.subject.slice(0, 60).trim();
						const content = args.content.slice(0, 250).trim();
						const keywords = (args.keywords || "").slice(0, 100);
						const importance = Math.max(1, Math.min(5, args.importance || 3));

						// Check for duplicates
						const existing = db
							.prepare("SELECT id, content FROM memories WHERE subject = ?")
							.get(subject) as { id: number; content: string } | null;

						if (existing) {
							// Update existing memory
							db.prepare(
								`UPDATE memories SET content = ?, keywords = ?, importance = ?, 
								 file_refs = ?, updated_at = datetime('now') WHERE id = ?`
							).run(content, keywords, importance, args.file_refs || null, existing.id);
							return `Updated existing memory #${existing.id}: "${subject}"`;
						}

						// Insert new memory
						const result = db
							.prepare(
								`INSERT INTO memories (type, subject, content, keywords, importance, file_refs, session_id)
								 VALUES (?, ?, ?, ?, ?, ?, (SELECT MAX(id) FROM sessions))`
							)
							.run(args.type, subject, content, keywords, importance, args.file_refs || null);

						return `Saved memory #${result.lastInsertRowid}: [${args.type.toUpperCase()}] "${subject}" (importance: ${importance})`;
					} finally {
						db.close();
					}
				},
			}),

			memory_delete: tool({
				description:
					"Delete one or more memories by ID. Use memory_search or memory_stats to find IDs first.",
				args: {
					ids: tool.schema
						.string()
						.describe("Comma-separated memory IDs to delete. Example: '329,330' or '42'"),
				},
				async execute(args) {
					const db = openDb(projectDir);
					if (!db) return "Memory database not found.";

					try {
						const idList = args.ids
							.split(",")
							.map((s: string) => parseInt(s.trim(), 10))
							.filter((n: number) => !isNaN(n) && n > 0);

						if (idList.length === 0) {
							return "No valid IDs provided. Pass comma-separated numeric IDs.";
						}

						const placeholders = idList.map(() => "?").join(",");
						const existing = db
							.prepare(`SELECT id, subject FROM memories WHERE id IN (${placeholders})`)
							.all(...idList) as { id: number; subject: string }[];

						if (existing.length === 0) {
							return `No memories found with IDs: ${idList.join(", ")}`;
						}

						db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...idList);

						const deleted = existing.map((m) => `  #${m.id}: ${m.subject}`).join("\n");
						const notFound = idList.filter((id: number) => !existing.find((m) => m.id === id));
						const notFoundMsg = notFound.length > 0 ? `\nNot found: ${notFound.join(", ")}` : "";

						return `Deleted ${existing.length} memories:\n${deleted}${notFoundMsg}`;
					} finally {
						db.close();
					}
				},
			}),

			memory_stats: tool({
				description:
					"Get statistics about the project's persistent memory. " +
					"Shows total count, breakdown by type, recent entries, and session history.",
				args: {},
				async execute() {
					const db = openDb(projectDir);
					if (!db) return "Memory database not found. Save your first memory with `memory_save`.";

					try {
						// Total count
						const total = (db.prepare("SELECT COUNT(*) as count FROM memories").get() as { count: number }).count;

						// By type
						const byType = db
							.prepare(
								"SELECT type, COUNT(*) as count FROM memories GROUP BY type ORDER BY count DESC"
							)
							.all() as { type: string; count: number }[];

						// By importance
						const byImportance = db
							.prepare(
								"SELECT importance, COUNT(*) as count FROM memories GROUP BY importance ORDER BY importance DESC"
							)
							.all() as { importance: number; count: number }[];

						// Recent sessions
						const sessions = db
							.prepare(
								"SELECT id, date, topic, summary FROM sessions ORDER BY id DESC LIMIT 5"
							)
							.all() as { id: number; date: string; topic: string; summary: string }[];

						// Most recent memories
						const recent = db
							.prepare(
								"SELECT type, subject, importance, updated_at FROM memories ORDER BY updated_at DESC LIMIT 5"
							)
							.all() as { type: string; subject: string; importance: number; updated_at: string }[];

						const lines = [
							`Microbrain Statistics`,
							`====================`,
							`Total memories: ${total}`,
							``,
							`By type:`,
							...byType.map((r) => `  ${r.type}: ${r.count}`),
							``,
							`By importance:`,
							...byImportance.map((r) => `  Level ${r.importance}: ${r.count}`),
							``,
							`Recent memories:`,
							...recent.map(
								(r) => `  [${r.type.toUpperCase()}] ${r.subject} (importance: ${r.importance}, ${r.updated_at})`
							),
							``,
							`Recent sessions:`,
							...sessions.map(
								(s) => `  #${s.id} (${s.date}): ${s.topic || "untitled"} — ${s.summary || "no summary"}`
							),
						];

						return lines.join("\n");
					} finally {
						db.close();
					}
				},
			}),
		},
	};
};
