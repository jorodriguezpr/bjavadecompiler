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
 * BJavaDecompiler - job routes: upload, list, detail, pause/resume/cancel, file browsing,
 * download-as-zip.
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import yazl from 'yazl';
import { Config } from '../../config/config';
import { asyncHandler } from '../../core/asyncHandler';
import { ApiError } from '../../core/apiError';
import { DecompileJobService } from '../../services/decompileJobService';

export const jobsRouter = Router();

const upload = multer({
  dest: Config.uploadsPath,
  limits: { fileSize: Config.maxUploadMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(war|jar)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .war or .jar files are accepted') as any, ok);
  },
});

jobsRouter.post('/', upload.single('file'), asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) throw ApiError.badRequest('No file uploaded (field name must be "file").');
  // Optional per-upload override of which Java release to compile against (multer populates
  // req.body with non-file multipart fields too) — 'auto' or missing/blank means "no override",
  // same as leaving DEFAULT_TARGET_JAVA_VERSION at its default (see Config.jdkHomeForVersion for
  // what a specific value actually changes about how the build runs).
  const rawVersion = (req.body?.targetJavaVersion || '').trim();
  const targetJavaVersion = rawVersion && rawVersion !== 'auto' ? parseInt(rawVersion, 10) : null;
  if (rawVersion && rawVersion !== 'auto' && (!Number.isFinite(targetJavaVersion) || targetJavaVersion! <= 0)) {
    throw ApiError.badRequest(`Invalid targetJavaVersion: ${rawVersion}`);
  }
  const job = await DecompileJobService.startJob(req.file.path, req.file.originalname, { targetJavaVersion });
  // The temp upload copy isn't needed once the job has its own workspace copy.
  fs.unlink(req.file.path, () => {});
  res.json({ success: true, data: job });
}));

jobsRouter.get('/', (req: Request, res: Response) => {
  res.json({ success: true, data: DecompileJobService.list() });
});

// POST /jobs/clear-all — deletes every job (and its workspace directory) that's in a genuinely
// terminal state (completed/completed_with_errors/failed/cancelled). Paused or active jobs are
// left untouched — see DecompileJobService.clearTerminalJobs() for why.
jobsRouter.post('/clear-all', (req: Request, res: Response) => {
  res.json({ success: true, data: DecompileJobService.clearTerminalJobs() });
});

jobsRouter.get('/:id', (req: Request, res: Response) => {
  const job = DecompileJobService.get(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, data: job });
});

jobsRouter.post('/:id/pause', (req: Request, res: Response) => {
  DecompileJobService.requestPause(req.params.id);
  res.json({ success: true });
});

jobsRouter.post('/:id/resume', (req: Request, res: Response) => {
  DecompileJobService.resume(req.params.id);
  res.json({ success: true });
});

jobsRouter.post('/:id/cancel', (req: Request, res: Response) => {
  DecompileJobService.requestCancel(req.params.id);
  res.json({ success: true });
});

// GET /:id/dependencies/:jarName/classes — candidate class names to search Maven Central by
// (see mavenSearchService.ts) for a dependency still marked 'unresolved'.
jobsRouter.get('/:id/dependencies/:jarName/classes', (req: Request, res: Response) => {
  const classes = DecompileJobService.listDependencyClasses(req.params.id, req.params.jarName);
  res.json({ success: true, data: classes });
});

// POST /:id/dependencies/:jarName/resolve { groupId, artifactId, version } — apply a Maven
// Central search result the user picked, then regenerate the project and re-verify the build.
jobsRouter.post('/:id/dependencies/:jarName/resolve', asyncHandler(async (req: Request, res: Response) => {
  const { groupId, artifactId, version } = req.body || {};
  if (!groupId || !artifactId || !version) throw ApiError.badRequest('groupId, artifactId, and version are all required.');
  const job = await DecompileJobService.resolveDependency(req.params.id, req.params.jarName, { groupId, artifactId, version });
  res.json({ success: true, data: job });
}));

function projectDirOf(jobId: string): string {
  const job = DecompileJobService.get(jobId);
  if (!job || !job.generatedProjectDir) throw ApiError.notFound('No generated project for this job yet.');
  return path.join(Config.workspacesPath, job.workspaceDir, job.generatedProjectDir);
}

// The originally-uploaded WAR/JAR is kept indefinitely — copied into the job's own workspace
// at upload time (see decompileJobService.ts's startJob) and never deleted by anything in this
// app — so every upload is always available for later review, not just the generated output.
jobsRouter.get('/:id/original', (req: Request, res: Response) => {
  const job = DecompileJobService.get(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  const filePath = path.join(Config.workspacesPath, job.workspaceDir, `input.${job.inputType}`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'Original upload no longer on disk' });
  res.download(filePath, job.originalFilename);
});

/** Recursive file tree for the "browse generated project" view. */
function buildTree(dir: string, base: string): any {
  const stat = fs.statSync(dir);
  const name = path.basename(dir) || base;
  if (!stat.isDirectory()) {
    return { name, type: 'file', size: stat.size };
  }
  const children = fs.readdirSync(dir).sort().map(child => buildTree(path.join(dir, child), base));
  return { name, type: 'dir', children };
}

jobsRouter.get('/:id/tree', (req: Request, res: Response) => {
  const dir = projectDirOf(req.params.id);
  res.json({ success: true, data: buildTree(dir, path.basename(dir)) });
});

jobsRouter.get('/:id/file', (req: Request, res: Response) => {
  const dir = projectDirOf(req.params.id);
  const rel = String(req.query.path || '');
  const full = path.resolve(dir, rel);
  // Guard against path traversal escaping the generated project directory.
  if (!full.startsWith(path.resolve(dir))) return res.status(400).json({ success: false, error: 'Invalid path' });
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return res.status(404).json({ success: false, error: 'Not found' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(fs.readFileSync(full, 'utf8'));
});

jobsRouter.get('/:id/download', (req: Request, res: Response) => {
  const dir = projectDirOf(req.params.id);
  const job = DecompileJobService.get(req.params.id)!;
  const zipfile = new yazl.ZipFile();

  (function addDir(current: string, rel: string) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) addDir(full, relPath);
      else zipfile.addFile(full, relPath);
    }
  })(dir, '');

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${job.originalFilename.replace(/\.(war|jar)$/i, '')}-project.zip"`);
  zipfile.outputStream.pipe(res);
  zipfile.end();
});
