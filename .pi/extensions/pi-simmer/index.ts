import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const SIM_RUNTIME_ROOT = join(homedir(), ".pi-simmer", "simsimmer-0.1.0");
const SIM_ENTRY = join(SIM_RUNTIME_ROOT, "autoresearch.py");
const SIM_PIN = "cdc74975f620853d76991c84f862aa90833c28a1";
const SIM_FILES = [
	{ path: "autoresearch.py", blobSha: "2eb63c58954174a8ce2a6b4972d7d57889596993" },
	{ path: "evaluator.lock.json", blobSha: "c5c1098c81eae4a922d1e144cddb537ca51ba272" },
	{ path: "sim/simulator.py", blobSha: "48cbb26065c97b472b2f133950f69394b3132d50" },
	{ path: "variants/compress.json", blobSha: "239894760f8a791463d8792dd44df58b525d8cf1" },
	{ path: "variants/exploit.json", blobSha: "1f5e255746ef813034d55cb37e3fc91bb39ef383" },
	{ path: "variants/explore.json", blobSha: "fd7022e2585548b049feb41c8c7b49f1738336af" },
	{ path: "variants/transfer.json", blobSha: "307faa3b02971aca567db6bfb9e9beea537caba8" },
] as const;
const OPTMEM_COMMIT = "1fb164cf39028047781f72ac3bb1e5a691c1dcb0";
const OPTMEM_URL = `https://raw.githubusercontent.com/VictorTaelin/OptMem/${OPTMEM_COMMIT}/memo`;
const OPTMEM_BLOB_SHA = "224409b932904a0355cd97145d17c6b28cf1213c";
const DEFAULT_MEMO = join(homedir(), ".optmem", "memo");
const MAX_OUTPUT = 8 * 1024 * 1024;
const DEFAULT_AUTO_ITERATIONS = 8;
const MAX_ITERATIONS = 64;

type SimVariant = "explore" | "exploit" | "transfer" | "compress";

interface ProcessFailure extends Error {
	stdout?: string | Buffer;
	stderr?: string | Buffer;
	status?: number | null;
}

interface CommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
}

interface SimReceipt {
	variant: SimVariant;
	iterations: number;
	keeps: number;
	evaluator_sha256: string;
	policy: Record<string, number>;
	objective_train: number;
	objective_holdout: number;
	initial_holdout_objective: number;
	canonical_holdout_fitness: number;
	trials?: unknown[];
}

let pythonCommand: string | undefined;
let wakeCache: string | undefined;

function text(value: string | Buffer | undefined): string {
	if (value === undefined) return "";
	return typeof value === "string" ? value : value.toString("utf8");
}

function run(command: string, args: string[], timeoutMs = 30_000): CommandResult {
	try {
		const stdout = execFileSync(command, args, {
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer: MAX_OUTPUT,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, stdout, stderr: "", exitCode: 0 };
	} catch (error: unknown) {
		const failure = error as ProcessFailure;
		return {
			ok: false,
			stdout: text(failure.stdout),
			stderr: text(failure.stderr) || (error instanceof Error ? error.message : String(error)),
			exitCode: typeof failure.status === "number" ? failure.status : 1,
		};
	}
}

function resolvePython(): string | undefined {
	if (pythonCommand !== undefined) return pythonCommand || undefined;
	const candidates = [process.env.PI_SIMMER_PYTHON, "python3", "python"].filter(
		(candidate): candidate is string => Boolean(candidate),
	);
	for (const candidate of candidates) {
		if (run(candidate, ["--version"], 5_000).ok) {
			pythonCommand = candidate;
			return candidate;
		}
	}
	pythonCommand = "";
	return undefined;
}

function memoPath(): string {
	return process.env.PI_SIMMER_MEMO_PATH || DEFAULT_MEMO;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function gitBlobSha(source: Buffer): string {
	return createHash("sha1")
		.update(`blob ${source.length}\0`)
		.update(source)
		.digest("hex");
}

function simRuntimeIntegrityError(): string | undefined {
	for (const file of SIM_FILES) {
		const path = join(SIM_RUNTIME_ROOT, file.path);
		if (!existsSync(path)) return `Simsimmer runtime missing ${file.path}. Run /simmer-setup.`;
		const got = gitBlobSha(readFileSync(path));
		if (got !== file.blobSha) {
			return `Simsimmer runtime mismatch at ${file.path} (blob ${got}). Run /simmer-setup to repair it.`;
		}
	}
	return undefined;
}

async function installSimsimmer(): Promise<string> {
	const payloads: Array<{ path: string; bytes: Buffer }> = [];
	for (const file of SIM_FILES) {
		const url = `https://raw.githubusercontent.com/rfreel/Simsimmer/${SIM_PIN}/${file.path}`;
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Simsimmer download failed for ${file.path}: HTTP ${response.status}`);
		const bytes = Buffer.from(await response.arrayBuffer());
		const got = gitBlobSha(bytes);
		if (got !== file.blobSha) {
			throw new Error(`Simsimmer integrity mismatch for ${file.path}: expected ${file.blobSha}, got ${got}`);
		}
		payloads.push({ path: file.path, bytes });
	}

	for (const payload of payloads) {
		const path = join(SIM_RUNTIME_ROOT, payload.path);
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.tmp-${process.pid}`;
		await writeFile(tmp, payload.bytes);
		await rename(tmp, path);
	}

	const check = simRuntimeIntegrityError();
	if (check) throw new Error(check);
	return `Installed pinned Simsimmer 0.1.0 (${SIM_PIN}) at ${SIM_RUNTIME_ROOT}.`;
}

function optMemIntegrityError(path: string): string | undefined {
	if (!existsSync(path)) return `OptMem unavailable at ${path}. Run /simmer-setup.`;
	const got = gitBlobSha(readFileSync(path));
	if (got !== OPTMEM_BLOB_SHA) {
		return `OptMem at ${path} is not the pinned ${OPTMEM_COMMIT} payload (blob ${got}).`;
	}
	return undefined;
}

function runMemo(args: string[]): CommandResult {
	const integrityError = optMemIntegrityError(memoPath());
	if (integrityError) return { ok: false, stdout: "", stderr: integrityError, exitCode: 78 };
	const python = resolvePython();
	if (!python) {
		return { ok: false, stdout: "", stderr: "Python 3 is required for OptMem.", exitCode: 127 };
	}
	return run(python, [memoPath(), ...args]);
}

function verifyExistingOptMem(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	const got = gitBlobSha(readFileSync(path));
	if (got !== OPTMEM_BLOB_SHA) {
		throw new Error(
			`Existing OptMem at ${path} does not match the pinned commit (${got}). ` +
				"It was left unchanged. Set PI_SIMMER_MEMO_PATH to use a separate pinned install.",
		);
	}
	return `Pinned OptMem ${OPTMEM_COMMIT} already present at ${path}.`;
}

async function installOptMem(): Promise<string> {
	const existing = verifyExistingOptMem(memoPath());
	if (existing) return existing;
	const response = await fetch(OPTMEM_URL);
	if (!response.ok) {
		throw new Error(`OptMem download failed: HTTP ${response.status}`);
	}
	const source = await response.text();
	const bytes = Buffer.from(source, "utf8");
	const blobSha = gitBlobSha(bytes);
	if (blobSha !== OPTMEM_BLOB_SHA) {
		throw new Error(`OptMem integrity mismatch: expected ${OPTMEM_BLOB_SHA}, got ${blobSha}`);
	}
	if (!source.includes("def cmd_wake") || !source.includes("def cmd_note")) {
		throw new Error("Downloaded OptMem payload failed structural validation.");
	}
	await mkdir(dirname(memoPath()), { recursive: true });
	const tmp = `${memoPath()}.tmp-${process.pid}`;
	await writeFile(tmp, source, { encoding: "utf8", mode: 0o755 });
	await chmod(tmp, 0o755);
	await rename(tmp, memoPath());
	const init = runMemo(["init"]);
	if (!init.ok && !`${init.stdout}\n${init.stderr}`.toLowerCase().includes("already")) {
		throw new Error(`OptMem init failed: ${init.stderr || init.stdout}`);
	}
	wakeCache = undefined;
	return `Installed pinned OptMem ${OPTMEM_COMMIT} at ${memoPath()}.`;
}

function wakeAll(): string {
	const chunks: string[] = [];
	let args = ["wake"];
	for (let i = 0; i < 32; i += 1) {
		const result = runMemo(args);
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		if (output) chunks.push(output);
		if (!result.ok) break;
		if (result.stdout.includes("You are awake.")) break;

		const next = result.stdout.match(/Not awake yet\. Run: .*? wake (\d+) (\d+)/);
		if (!next) break;
		args = ["wake", next[1], next[2]];
	}
	return chunks.join("\n\n") || `OptMem returned no wake output from ${memoPath()}.`;
}

function classifyVariant(prompt: string): SimVariant {
	const p = prompt.toLowerCase();
	if (/\b(compress|distill|minimi[sz]e|simplif|ablat|prune|shrink)\b/.test(p)) return "compress";
	if (/\b(port|transfer|reuse|generaliz|adapt|migrat)\b/.test(p)) return "transfer";
	if (/\b(add|build|code|debug|execute|fix|implement|integrat|patch|refactor|test|update)\b/.test(p)) return "exploit";
	return "explore";
}

function promptSeed(prompt: string): number {
	const digest = createHash("sha256").update(prompt).digest();
	return digest.readUInt32BE(0) || 1;
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function memoryInput(value: string): string | undefined {
	if (value.includes("\n") || value.includes("\r")) return "OptMem entries must be one line.";
	const size = utf8Bytes(value);
	if (size > 280) return `OptMem entry is ${size} bytes; maximum is 280.`;
	return undefined;
}

function autoIterations(): number {
	const raw = Number.parseInt(process.env.PI_SIMMER_AUTO_ITERATIONS || "", 10);
	if (!Number.isFinite(raw)) return DEFAULT_AUTO_ITERATIONS;
	return Math.max(1, Math.min(MAX_ITERATIONS, raw));
}

function runSimulation(variant: SimVariant, iterations: number, seed: number, promote = false): CommandResult {
	const python = resolvePython();
	if (!python) {
		return { ok: false, stdout: "", stderr: "Python 3 is required for Simsimmer.", exitCode: 127 };
	}
	const integrityError = simRuntimeIntegrityError();
	if (integrityError) return { ok: false, stdout: "", stderr: integrityError, exitCode: 78 };
	const args = [SIM_ENTRY, "--variant", variant, "--iterations", String(iterations), "--seed", String(seed)];
	if (promote) args.push("--write");
	return run(python, args, 60_000);
}

function parseReceipt(result: CommandResult): SimReceipt | undefined {
	if (!result.ok) return undefined;
	try {
		return JSON.parse(result.stdout) as SimReceipt;
	} catch {
		return undefined;
	}
}

function compactReceipt(receipt: SimReceipt): string {
	const policy = Object.entries(receipt.policy)
		.map(([key, value]) => `${key}=${value}`)
		.join(", ");
	return [
		`variant=${receipt.variant}; iterations=${receipt.iterations}; keeps=${receipt.keeps}`,
		`objective_holdout=${receipt.objective_holdout}; canonical_fitness=${receipt.canonical_holdout_fitness}`,
		`evaluator_sha256=${receipt.evaluator_sha256}`,
		`policy: ${policy}`,
	].join("\n");
}

function toolText(message: string, isError = false) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: {},
		...(isError ? { isError: true } : {}),
	};
}

function simmerContract(memory: string, simulation: string): string {
	return [
		"## Pi Simmer runtime",
		"OptMem is the persistent memory layer. Record only durable, non-redundant decisions/facts with optmem_note.",
		"If OptMem asks for a compression, complete it with optmem_nap before further state-changing work.",
		"Simsimmer is a synthetic search-policy simulator. Use its policy to shape breadth/depth/verification, never as proof that a task or implementation is correct.",
		"Implementation claims still require direct repository/runtime evidence.",
		"",
		"### Simsimmer policy simulation",
		simulation,
		"",
		"### OptMem wake",
		memory,
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		wakeCache = wakeAll();
	});

	pi.on("before_agent_start", async (event) => {
		const memory = wakeCache ?? wakeAll();
		wakeCache = memory;

		let simulation = "auto simulation disabled";
		if (process.env.PI_SIMMER_AUTO_SIM !== "0") {
			const variant = classifyVariant(event.prompt);
			const result = runSimulation(variant, autoIterations(), promptSeed(event.prompt), false);
			const receipt = parseReceipt(result);
			simulation = receipt ? compactReceipt(receipt) : `unavailable: ${result.stderr || result.stdout}`;
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n${simmerContract(memory, simulation)}`,
		};
	});

	pi.registerCommand("simmer-setup", {
		description: "Install the pinned OptMem dependency used by Pi Simmer",
		handler: async (_args, ctx) => {
			try {
				const optmem = await installOptMem();
				const simsimmer = await installSimsimmer();
				wakeCache = wakeAll();
				ctx.ui.notify(`${optmem}\n${simsimmer}`, "info");
			} catch (error: unknown) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("simmer-status", {
		description: "Show Pi Simmer component status",
		handler: async (_args, ctx) => {
			const optmemError = optMemIntegrityError(memoPath());
			const optmem = optmemError ? (existsSync(memoPath()) ? "mismatch" : "missing") : "pinned";
			const python = resolvePython() || "missing";
			const simulator = simRuntimeIntegrityError() ? "missing-or-mismatch" : "ready";
			const champion = existsSync(join(SIM_RUNTIME_ROOT, "state", "champion.json")) ? "present" : "none";
			ctx.ui.notify(
				`Pi Simmer: python=${python}; optmem=${optmem}; simsimmer=0.1.0(${simulator}); champion=${champion}; evaluator=be6a39b09e52…`,
				"info",
			);
		},
	});

	pi.registerTool({
		name: "optmem_wake",
		label: "OptMem Wake",
		description: "Read all OptMem wake pages for the current memory snapshot.",
		parameters: Type.Object({}),
		execute: async () => {
			const output = wakeAll();
			wakeCache = output;
			return toolText(output, output.includes("OptMem unavailable"));
		},
	});

	pi.registerTool({
		name: "optmem_note",
		label: "OptMem Note",
		description: "Persist one durable, non-redundant memory line in OptMem (maximum 280 bytes).",
		parameters: Type.Object({
			text: Type.String({ maxLength: 280, description: "One durable memory line." }),
		}),
		execute: async (_toolCallId, params) => {
			const invalid = memoryInput(params.text);
			if (invalid) return toolText(invalid, true);
			const result = runMemo(["note", params.text]);
			wakeCache = undefined;
			return toolText([result.stdout, result.stderr].filter(Boolean).join("\n").trim(), !result.ok);
		},
	});

	pi.registerTool({
		name: "optmem_recall",
		label: "OptMem Recall",
		description: "Regex-search the complete OptMem append-only memory log.",
		parameters: Type.Object({
			regex: Type.String({ description: "Case-insensitive regular expression." }),
		}),
		execute: async (_toolCallId, params) => {
			const result = runMemo(["recall", params.regex]);
			return toolText([result.stdout, result.stderr].filter(Boolean).join("\n").trim(), !result.ok);
		},
	});

	pi.registerTool({
		name: "optmem_nap",
		label: "OptMem Nap",
		description: "Submit one requested OptMem compression summary for a specific memory block.",
		parameters: Type.Object({
			block: Type.String({ description: "Block id exactly as requested, for example 0-1." }),
			summary: Type.String({ maxLength: 280, description: "One-line compression, maximum 280 bytes." }),
		}),
		execute: async (_toolCallId, params) => {
			const invalid = memoryInput(params.summary);
			if (invalid) return toolText(invalid, true);
			const result = runMemo(["nap", params.block, params.summary]);
			wakeCache = undefined;
			return toolText([result.stdout, result.stderr].filter(Boolean).join("\n").trim(), !result.ok);
		},
	});

	pi.registerTool({
		name: "simsimmer_policy_sim",
		label: "Simsimmer Policy Sim",
		description:
			"Run the pinned Simsimmer 0.1.0 synthetic policy evaluator. This selects search-policy evidence; it does not verify the user's task.",
		parameters: Type.Object({
			variant: Type.Union([
				Type.Literal("explore"),
				Type.Literal("exploit"),
				Type.Literal("transfer"),
				Type.Literal("compress"),
			]),
			iterations: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ITERATIONS, default: 24 })),
			seed: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
			full: Type.Optional(Type.Boolean({ default: false })),
			promote: Type.Optional(
				Type.Boolean({
					default: false,
					description: "Persist this run as Simsimmer research state and update the champion only if canonical gating wins.",
				}),
			),
		}),
		execute: async (_toolCallId, params) => {
			const iterations = params.iterations ?? 24;
			const seed = params.seed ?? 1;
			const result = runSimulation(params.variant, iterations, seed, params.promote ?? false);
			const receipt = parseReceipt(result);
			if (!receipt) {
				return toolText(`Simsimmer failed: ${result.stderr || result.stdout}`, true);
			}
			return toolText(params.full ? JSON.stringify(receipt, null, 2) : compactReceipt(receipt));
		},
	});
}
