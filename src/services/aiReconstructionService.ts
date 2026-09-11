/**
 * BJavaDecompiler
 * Copyright 2026 Jose Rodriguez <jrpcone@gmail.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Developer: Jose Rodriguez <jrpcone@gmail.com>
 */

/**
 * BJavaDecompiler - Stage 5: AI reconstruction pass.
 *
 * Only classes flagged by candidateScoringService (failure markers) or with obfuscated-
 * looking identifiers get sent to the AI — cleanly-decompiled, normally-named classes are
 * left untouched entirely, matching "fill gaps, not rewrite everything". Batched by package,
 * char-budget capped; a bounded worker pool processes batches concurrently via the shared
 * Ollama client (core/aiProvider.ts — Ollama Cloud or a local Ollama install, see Config.aiProvider),
 * which already carries retry/backoff. A batch that
 * exhausts retries falls back to the original decompiler output for every class in it — this
 * stage must never block the job.
 *
 * `runAiBatchReconstruction` is the generic core (just files-in, files-out) — used both here for
 * the app's own classes (via `runAiReconstruction`, which additionally tracks per-class
 * `aiStatus` on the job) and by unresolvedLibDecompiler.ts for CFR-decompiled dependency
 * sources, which aren't tracked as ClassCandidates at all.
 */

import fs from 'fs';
import path from 'path';
import { Config } from '../config/config';
import { Logger } from '../core/logger';
import { AIProvider } from '../core/aiProvider';
import { stripDuplicateJumpStatements } from './decompilerArtifactCleanup';
import { cleanSource } from './decompilerArtifactCleanup';
import { checkJavaSyntax } from '../core/javaSyntaxCheck';
import { ClassCandidate, DecompilerEngine, DependencyResolution } from '../models/job';
import { ProjectSymbolTable, privateMemberNames, nonPrivateMemberNames } from './bytecodeMetadataService';

const logger = Logger.getLogger('AIReconstructionService');

const MAX_BATCH_CHARS = 14000;
const OBFUSCATED_NAME_RE = /^[a-zA-Z]{1,2}\d*$/;

function looksObfuscated(fqcn: string): boolean {
  const simpleName = fqcn.split('/').pop() || fqcn;
  return OBFUSCATED_NAME_RE.test(simpleName);
}

/** Copies any sibling files the winning engine emitted for FQCN's nested/anonymous classes as
 * their own separate physical files (`Foo$Bar.java`, `Foo$1.java`) instead of inlining them into
 * the outer class's own file — decompilers differ on this (see candidateScoringService.ts's
 * listTopLevelClasses comment), and only the outer file itself is ever driven through the
 * fqcn-keyed copy elsewhere in this module, so a nested class an engine chose to emit separately
 * would otherwise silently never make it into the generated project at all. Carried through
 * mechanically, never separately scored or AI-reconstructed — same as before, just no longer
 * dropped on the floor. */
function copyNestedSiblingFiles(srcDir: string, fqcn: string, destDir: string): void {
  const srcParentDir = path.join(srcDir, path.dirname(fqcn));
  if (!fs.existsSync(srcParentDir)) return;
  const prefix = `${path.basename(fqcn)}$`;
  for (const entry of fs.readdirSync(srcParentDir)) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.java')) continue;
    const dest = path.join(destDir, path.dirname(fqcn), entry);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(srcParentDir, entry), dest);
  }
}

export function needsAiReconstruction(candidate: ClassCandidate, symbolTable?: ProjectSymbolTable): boolean {
  // A winner that doesn't even parse always needs AI attention, regardless of markers/naming —
  // this is the case candidateScoringService.ts's heuristics alone can miss (a mangled
  // try/catch/finally can have balanced braces and no marker comment, but it still won't parse).
  if (candidate.winnerSyntaxValid === false) return true;
  if (candidate.winningEngine && (candidate.failureMarkers[candidate.winningEngine]?.length ?? 0) > 0) return true;
  // Variable-slot-reuse corruption (variableConflictDetector.ts) is frequently syntactically
  // valid Java with no failure-marker comment — winnerSyntaxValid and failureMarkers alone would
  // miss it entirely, same gap the parse-failure check above exists to close for its own pattern.
  if (candidate.variableConflicts.length > 0) return true;
  if (looksObfuscated(candidate.fqcn)) return true;
  return hasObfuscatedMemberNames(symbolTable, candidate.fqcn);
}

/** Broader obfuscation signal than looksObfuscated() (which only ever looks at the class's OWN
 * simple name): flags a class whose MEMBERS — from the original bytecode via
 * bytecodeMetadataService.ts, not the decompiled source — are mostly short/meaningless names,
 * even when the class's own name looks perfectly normal (some obfuscators rename members
 * aggressively while leaving reflection-sensitive class names alone). Deliberately statistical
 * (needs a MAJORITY of a class's members, not a single match) to avoid the false-positive risk a
 * single-name regex check has on legitimate short identifiers (get/set/id/ok) — real code very
 * rarely has most of a class's members matching this pattern at once. Classes with full debug
 * info are skipped entirely: their names came from the original source, not synthesized, so this
 * signal would be meaningless noise for them. */
function hasObfuscatedMemberNames(symbolTable: ProjectSymbolTable | undefined, fqcn: string): boolean {
  const meta = symbolTable?.classes[fqcn];
  if (!meta || meta.hasFullDebugInfo || meta.members.length < 3) return false;
  const obfuscatedCount = meta.members.filter(m => OBFUSCATED_NAME_RE.test(m.name)).length;
  return obfuscatedCount / meta.members.length >= 0.5;
}

export interface ReconstructionItem {
  fqcn: string;
  source: string;
  /** Notes from variableConflictDetector.ts for this specific file, surfaced to the AI as
   * explicit diagnostics instead of leaving it to infer the corruption from the generic
   * instructions alone. Empty/omitted when the detector found nothing. */
  diagnostics?: string[];
  /** Private field/method names for this class (bytecodeMetadataService.ts) — safe to rename
   * freely, since nothing outside this file can reference a private member. Undefined when no
   * bytecode metadata was available for this class (javap missing/failed). */
  privateMembers?: string[];
  /** Field/method names visible from OTHER compilation units (public/protected/package) —
   * renaming any of these here would silently desync every other file that references it, since
   * AI reconstruction only ever sees one batch of files at a time. Only enforced when bytecode
   * metadata was available; see privateMembers. */
  nonPrivateMembers?: string[];
}

function packageOf(fqcn: string): string {
  const parts = fqcn.split('/');
  parts.pop();
  return parts.join('/');
}

function buildBatches(items: ReconstructionItem[]): ReconstructionItem[][] {
  const byPackage = new Map<string, ReconstructionItem[]>();
  for (const item of items) {
    const pkg = packageOf(item.fqcn);
    if (!byPackage.has(pkg)) byPackage.set(pkg, []);
    byPackage.get(pkg)!.push(item);
  }

  const batches: ReconstructionItem[][] = [];
  for (const items of byPackage.values()) {
    let current: ReconstructionItem[] = [];
    let currentChars = 0;
    for (const item of items) {
      if (item.source.length > MAX_BATCH_CHARS) {
        if (current.length) { batches.push(current); current = []; currentChars = 0; }
        batches.push([item]); // oversized class gets its own call
        continue;
      }
      if (currentChars + item.source.length > MAX_BATCH_CHARS && current.length) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(item);
      currentChars += item.source.length;
    }
    if (current.length) batches.push(current);
  }
  return batches;
}

const DELIM_START = '=== FILE: ';
const DELIM_END = ' ===';

function buildPrompt(batch: ReconstructionItem[], relevantDeps: DependencyResolution[]): string {
  const depList = relevantDeps
    .filter(d => d.confidence !== 'unresolved')
    .map(d => `${d.groupId}:${d.artifactId}:${d.version}`)
    .join(', ') || '(none resolved)';

  const files = batch.map(item => {
    const diagnosticsBlock = item.diagnostics?.length
      ? `Known issues detected in this file (fix these specifically):\n${item.diagnostics.map(d => `- ${d}`).join('\n')}\n\n`
      : '';
    const renameNotes = [
      item.privateMembers?.length ? `Private members, safe to rename freely (nothing outside this file can reference them): ${item.privateMembers.join(', ')}.` : null,
      item.nonPrivateMembers?.length ? `Do NOT rename these — they are public/protected/package-visible and other files not shown in this batch may reference them by their current name: ${item.nonPrivateMembers.join(', ')}.` : null,
    ].filter(Boolean);
    const renameBlock = renameNotes.length ? `${renameNotes.join('\n')}\n\n` : '';
    return `${DELIM_START}${item.fqcn}${DELIM_END}\n${diagnosticsBlock}${renameBlock}\`\`\`java\n${item.source}\n\`\`\``;
  }).join('\n\n');

  return [
    'You are reconstructing Java source that was produced by an automated decompiler and needs',
    'to become a clean, compilable, readable file in a real Maven project.',
    '',
    'For each file below:',
    '1. Rename obfuscated/meaningless identifiers (single/double letters, "var3", "a", "b") to',
    '   clear, contextually appropriate names. Apply each rename consistently to every reference',
    '   within the file. NEVER rename a top-level (outer) class\'s simple name — only members,',
    '   locals, and parameters — renaming a top-level class would break its filename and every',
    '   other file\'s references to it.',
    '2. Fix any decompiler artifacts so the file is syntactically valid Java — e.g. resolve',
    '   marked "unable to decompile" sections, malformed control flow, stray labels/gotos,',
    '   leftover bytecode dumps — while preserving the original runtime behavior as closely as',
    '   the decompiled logic allows.',
    '3. Watch for a single identifier standing in for MULTIPLE real variables (the decompiler',
    '   reused one JVM local-variable slot for several unrelated variables with different',
    '   types/roles, since debug info was stripped) — this shows up as one name reassigned',
    '   incompatible-looking values (e.g. `this`, then a boolean, then an int literal, then a',
    '   field reference), a `synchronized` block on something that is really just `this`, or a',
    '   `throw` of something that is not actually the caught exception. When you see this, split',
    '   the single identifier back into separate, correctly-typed, clearly-named variables — one',
    '   per real role — rather than forcing one type onto all of them. A file-specific "Known',
    '   issues" list below (when present) already points at exactly which identifiers to split.',
    '4. Add brief comments only where they genuinely clarify non-obvious logic — not filler.',
    '',
    'When a file below lists "Private members"/"Do NOT rename" lines, that list is authoritative —',
    'it comes directly from the original bytecode, not a guess, so never rename a name in the',
    '"Do NOT rename" list even if it looks obfuscated, and treat every other member as fair game.',
    'Locals and parameters are always safe to rename regardless — nothing outside a method can ever',
    'reference them.',
    '',
    `Resolved Maven dependencies available on the classpath: ${depList}`,
    '',
    'Respond with each file in the exact same order, each preceded by its own',
    `"${DELIM_START}<fqcn>${DELIM_END}" line followed by a \`\`\`java code block — nothing else.`,
    '',
    files,
  ].join('\n');
}

function parseResponse(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const parts = content.split(new RegExp(`${DELIM_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(.+?)${DELIM_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  // parts[0] is preamble (discarded); then alternating [fqcn, body, fqcn, body, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const fqcn = parts[i].trim();
    const body = parts[i + 1] || '';
    const codeMatch = body.match(/```(?:java)?\s*\n([\s\S]*?)```/);
    result.set(fqcn, codeMatch ? codeMatch[1] : body.trim());
  }
  return result;
}

export type ReconstructionOutcome = 'reconstructed' | 'failed_fallback';

/**
 * The generic core: batches `items`, sends each batch to the AI, returns a per-fqcn outcome —
 * 'reconstructed' means `onReconstructed` was called with the new source, 'failed_fallback'
 * means the caller should keep whatever it already had for that file. Callers own all file I/O
 * (where the "original" lives, what "fallback" means) — this function only ever reads
 * `item.source` and calls `onReconstructed`.
 */
export async function runAiBatchReconstruction(
  items: ReconstructionItem[],
  dependencies: DependencyResolution[],
  onReconstructed: (fqcn: string, source: string) => void,
  onBatchProgress?: (done: number, total: number) => void,
): Promise<Map<string, ReconstructionOutcome>> {
  const outcomes = new Map<string, ReconstructionOutcome>();
  if (!items.length) return outcomes;

  if (!AIProvider.isConfigured()) {
    logger.warn('No AI provider configured (set OLLAMA_CLOUD_API_KEY, or AI_PROVIDER=ollama-local/lm-studio for a local install) — skipping AI reconstruction entirely, keeping decompiler output as-is.');
    for (const item of items) outcomes.set(item.fqcn, 'failed_fallback');
    return outcomes;
  }

  const batches = buildBatches(items);
  let batchIndex = 0;
  let completedBatches = 0;

  async function worker() {
    while (batchIndex < batches.length) {
      const batch = batches[batchIndex++];
      const batchNum = batchIndex;
      try {
        const prompt = buildPrompt(batch, dependencies);
        logger.info(`AI batch ${batchNum}/${batches.length}: ${batch.map(b => b.fqcn).join(', ')}`);
        const response = await AIProvider.chatCompletion([
          { role: 'system', content: 'You are an expert Java engineer specializing in decompiled-code reconstruction.' },
          { role: 'user', content: prompt },
        ]);
        const parsed = parseResponse(response.content);

        for (const item of batch) {
          const reconstructed = parsed.get(item.fqcn);
          if (reconstructed && reconstructed.trim().length > 0) {
            // LLM output can duplicate a line the same way a decompiler can (confirmed live,
            // same 'unreachable statement' javac error) — same free, no-AI fixup applies here.
            const { fixed } = stripDuplicateJumpStatements(reconstructed);
            // Never blindly trust AI output — verify it's at least syntactically valid before
            // accepting it over whatever's already there. A fix that doesn't parse is strictly
            // worse than the fallback (a known, previously-scored candidate), not a genuine fix.
            const { valid, error } = await checkJavaSyntax(fixed);
            if (valid) {
              onReconstructed(item.fqcn, fixed);
              outcomes.set(item.fqcn, 'reconstructed');
            } else {
              outcomes.set(item.fqcn, 'failed_fallback');
              logger.warn(`AI response for ${item.fqcn} doesn't parse as valid Java (${error}) — keeping fallback output instead.`);
            }
          } else {
            outcomes.set(item.fqcn, 'failed_fallback');
            logger.warn(`AI response for ${item.fqcn} was empty/unparseable — keeping decompiler output.`);
          }
        }
      } catch (err: any) {
        logger.error(`AI batch ${batchNum}/${batches.length} failed entirely: ${err.message}`);
        for (const item of batch) outcomes.set(item.fqcn, 'failed_fallback');
      }
      completedBatches++;
      onBatchProgress?.(completedBatches, batches.length);
    }
  }

  const poolSize = Math.min(Config.aiConcurrency, batches.length) || 1;
  await Promise.all(Array.from({ length: poolSize }, worker));

  return outcomes;
}

export interface AiReconstructionResult {
  reconstructedCount: number;
  fallbackCount: number;
  skippedCount: number;
}

export async function runAiReconstruction(
  candidates: ClassCandidate[],
  engineDirs: Partial<Record<DecompilerEngine, string>>,
  dependencies: DependencyResolution[],
  outputDir: string,
  symbolTable?: ProjectSymbolTable,
): Promise<AiReconstructionResult> {
  const items: ReconstructionItem[] = [];
  let skippedCount = 0;

  for (const candidate of candidates) {
    if (!candidate.winningEngine) { skippedCount++; continue; }
    if (!needsAiReconstruction(candidate, symbolTable)) { candidate.aiStatus = 'skipped_clean'; skippedCount++; continue; }

    const dir = engineDirs[candidate.winningEngine];
    if (!dir) { skippedCount++; continue; }
    const sourcePath = path.join(dir, `${candidate.fqcn}.java`);
    if (!fs.existsSync(sourcePath)) { skippedCount++; continue; }

    items.push({
      fqcn: candidate.fqcn,
      source: fs.readFileSync(sourcePath, 'utf8'),
      diagnostics: candidate.variableConflicts,
      privateMembers: privateMemberNames(symbolTable, candidate.fqcn) || undefined,
      nonPrivateMembers: nonPrivateMemberNames(symbolTable, candidate.fqcn) || undefined,
    });
  }

  // Always write the winner unmodified first, for every class — AI reconstruction then
  // overwrites just the files it successfully reconstructs. This means a mid-run crash never
  // leaves a class with no output at all.
  for (const candidate of candidates) {
    if (!candidate.winningEngine) continue;
    const dir = engineDirs[candidate.winningEngine];
    if (!dir) continue;
    const src = path.join(dir, `${candidate.fqcn}.java`);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(outputDir, `${candidate.fqcn}.java`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copyNestedSiblingFiles(dir, candidate.fqcn, outputDir);
  }

  // ─── Deterministic fallback when AI is not configured ──────────────
  // When AI is unavailable, don't just leave the winner as-is for classes that need
  // reconstruction — try the next-best candidate (the one with the second-lowest score) if
  // the winner doesn't parse, and always run the deterministic cleanup passes. This can fix
  // a meaningful fraction of broken classes without any AI calls at all.
  if (!AIProvider.isConfigured() && items.length > 0) {
    let deterministicFixes = 0;

    for (const item of items) {
      const candidate = candidates.find(c => c.fqcn === item.fqcn);
      if (!candidate || !candidate.winningEngine) continue;

      const dest = path.join(outputDir, `${item.fqcn}.java`);

      // If the winner doesn't parse, try the next-best candidate that DOES parse
      const winnerValid = candidate.winnerSyntaxValid;
      if (!winnerValid) {
        // Find the next-best engine (lowest score among engines that aren't the winner)
        let nextBestEngine: DecompilerEngine | null = null;
        let nextBestScore = Infinity;
        for (const [engine, score] of Object.entries(candidate.scores)) {
          if (engine === candidate.winningEngine) continue;
          if (score !== undefined && score < nextBestScore) {
            nextBestScore = score;
            nextBestEngine = engine as DecompilerEngine;
          }
        }

        if (nextBestEngine) {
          const nextDir = engineDirs[nextBestEngine];
          if (nextDir) {
            const nextPath = path.join(nextDir, `${candidate.fqcn}.java`);
            if (fs.existsSync(nextPath)) {
              const nextSource = fs.readFileSync(nextPath, 'utf8');
              const { valid: nextValid } = await checkJavaSyntax(nextSource);
              if (nextValid) {
                // The next-best candidate parses — use it instead of the broken winner
                fs.writeFileSync(dest, nextSource, 'utf8');
                candidate.winningEngine = nextBestEngine;
                candidate.winnerSyntaxValid = true;
                copyNestedSiblingFiles(nextDir, candidate.fqcn, outputDir);
                deterministicFixes++;
                continue;
              }
            }
          }
        }
      }

      // Run deterministic cleanup on whatever we have (winner or next-best)
      try {
        const currentSource = fs.readFileSync(dest, 'utf8');
        const { fixed, totalFixes } = cleanSource(currentSource);
        if (totalFixes > 0) {
          fs.writeFileSync(dest, fixed, 'utf8');
          // Re-check if the cleanup made it parse
          const { valid } = await checkJavaSyntax(fixed);
          if (valid && !candidate.winnerSyntaxValid) {
            candidate.winnerSyntaxValid = true;
            deterministicFixes++;
          }
        }
      } catch {
        // best-effort
      }
    }

    if (deterministicFixes > 0) {
      logger.info(`Deterministic fallback (no AI): fixed ${deterministicFixes} class(es) via next-best candidate + cleanup passes.`);
    }
  }

  const outcomes = await runAiBatchReconstruction(items, dependencies, (fqcn, source) => {
    const dest = path.join(outputDir, `${fqcn}.java`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, source, 'utf8');
  });

  let reconstructedCount = 0;
  let fallbackCount = 0;
  for (const item of items) {
    const candidate = candidates.find(c => c.fqcn === item.fqcn)!;
    const outcome = outcomes.get(item.fqcn);
    candidate.aiStatus = outcome === 'reconstructed' ? 'reconstructed' : 'failed_fallback';
    if (outcome === 'reconstructed') reconstructedCount++; else fallbackCount++;
  }

  return { reconstructedCount, fallbackCount, skippedCount };
}
