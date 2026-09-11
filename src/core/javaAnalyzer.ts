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
 * BJavaDecompiler - Tier-1 structural analysis of a Java source file: real diagnostics (code,
 * line/column, severity) plus a lightweight structure model (package, top-level/nested types,
 * their methods/constructors), built once from a single java-parser CST walk.
 *
 * Phase one scope (see docs/java-syntax-checker-fixer-design.md §3): the JLS §7 "is this file
 * inside the right class, in the right place" structural checks (JST2xxx), plus the classic
 * CFR/Procyon constructor/method-name-confusion artifact (JMB3003). Deliberately narrower than
 * the full design doc for a first pass — no JDK feature gate, no javac oracle, no import-table
 * checks yet.
 *
 * Every check here is computed from the CST + (optionally) the file's own path — nothing needs
 * a classpath or type resolution, same constraint javaSyntaxCheck.ts's older hasRealTopLevelType
 * already operated under.
 */

import path from 'path';
import { parseJava } from './javaParser';

export type DiagnosticSeverity = 'error' | 'warning';

export type JavaDiagCode =
  | 'JP1000_PARSE_ERROR'
  | 'JST2001_MISSING_TOP_LEVEL_TYPE'
  | 'JST2002_PUBLIC_TYPE_FILENAME_MISMATCH'
  | 'JST2003_PACKAGE_DIR_MISMATCH'
  | 'JST2004_MULTIPLE_PUBLIC_TOP_LEVEL_TYPES'
  | 'JST2006_EMPTY_FILE'
  | 'JMB3003_METHOD_LOOKS_LIKE_CTOR';

export interface JavaDiagnostic {
  code: JavaDiagCode;
  severity: DiagnosticSeverity;
  message: string;
  /** 1-based, matches javac convention. */
  line: number;
  column: number;
  /** Machine-usable payload for javaFixer.ts — shape depends on `code`. Never serialized/logged
   * verbatim; carries live JavaTypeDecl/JavaMemberDecl object references, not just primitives. */
  data?: Record<string, unknown>;
}

export interface JavaMemberDecl {
  kind: 'method' | 'constructor';
  name: string;
  /** Offset range of just the member's own name identifier token. */
  nameStart: number;
  nameEnd: number;
  startLine: number;
  startColumn: number;
  /** Normalized `type1,type2,...` (parameter types only, no names) — comparable across members
   * to detect a would-be duplicate signature. Doesn't attempt full JLS erasure/resolution, just
   * enough textual normalization (whitespace-stripped) to catch the common exact-match case. */
  paramSignature: string;
  /** Methods only: offset range of the `result` grammar node (the `void`/return-type text right
   * before the method name) — this is exactly what JMB3003's fix deletes to turn a mis-decompiled
   * "void ClassName(...)" back into a real constructor. Absent for constructors (no result). */
  resultStart?: number;
  resultEnd?: number;
}

export interface JavaTypeDecl {
  name: string;
  kind: 'class' | 'interface' | 'enum' | 'record';
  isPublic: boolean;
  /** Offset range of just the type's own name identifier token. */
  nameStart: number;
  nameEnd: number;
  nameLine: number;
  nameColumn: number;
  startLine: number;
  endLine: number;
  /** Present only when isPublic — the exact span of the `public` keyword token guarding this
   * type's own modifier list, so JST2004's fix can delete precisely that token. */
  publicModifierStart?: number;
  publicModifierEnd?: number;
  /** This type's OWN direct methods/constructors only — a nested type's members live on that
   * nested type's own entry in JavaFileAnalysis.types, not here. */
  methods: JavaMemberDecl[];
}

export interface JavaFileAnalysis {
  /** No error-severity diagnostics. Mirrors what checkJavaSyntax() used to mean, extended to
   * cover every JST2xxx/JP1000 structural check, not just the old bare-top-level-type gap. */
  valid: boolean;
  packageName: string | null;
  /** All types found anywhere in the file, top-level and nested, in discovery order. Use
   * `topLevelTypeNames` (or filter by absence from another type's methods) to tell them apart
   * when that matters — most callers just want every method in the file for JMB3003-style scans. */
  types: JavaTypeDecl[];
  diagnostics: JavaDiagnostic[];
  /** Offset range of just the dotted package name in `package a.b.c;` (excluding the `package`
   * keyword and trailing `;`) — what JST2003's fix replaces. Null when the file has no package
   * declaration at all. */
  packageDeclOffsets: { nameStart: number; nameEnd: number } | null;
  /** Opaque CST, kept for javaFixer.ts (e.g. locating the package/import boundary for JST2001's
   * wrap fix). Treat as a black box outside this module and javaFixer.ts. */
  cst: unknown;
}

export interface AnalyzeContext {
  /** Absolute path of the file being analyzed. Enables JST2002 (filename check) and, combined
   * with projectSourceRoot, JST2003 (package/directory check). Omit for a fragment that isn't a
   * real file yet (matches checkJavaSyntax's original single-argument contract). */
  filePath?: string;
  /** e.g. `<generatedProjectDir>/src/main/java` or a lib-src module root — the directory whose
   * subtree layout is expected to mirror the package structure. */
  projectSourceRoot?: string;
}

function truncate(message: string): string {
  return message.slice(0, 400);
}

/** `path.relative` returns a `..`-prefixed path when `filePath` isn't under `sourceRoot` at all
 * (e.g. a caller passed the wrong root) — treated as "can't tell", not "package should be empty". */
function expectedPackageFromPath(filePath: string, sourceRoot: string): string | null {
  const rel = path.relative(sourceRoot, path.dirname(filePath));
  if (rel.startsWith('..')) return null;
  if (rel === '' || rel === '.') return '';
  return rel.split(path.sep).join('.');
}

function paramSignatureOf(declarator: any, source: string): string {
  const list = declarator?.children?.formalParameterList?.[0];
  if (!list) return '';
  const params: any[] = list.children?.formalParameter || [];
  return params
    .map(p => {
      const reg = p.children?.variableParaRegularParameter?.[0];
      if (reg?.children?.unannType?.[0]?.location) {
        const t = reg.children.unannType[0];
        return source.slice(t.location.startOffset, t.location.endOffset + 1).replace(/\s+/g, '');
      }
      const variadic = p.children?.variableArityParameter?.[0];
      if (variadic?.children?.unannType?.[0]?.location) {
        const t = variadic.children.unannType[0];
        return `${source.slice(t.location.startOffset, t.location.endOffset + 1).replace(/\s+/g, '')}...`;
      }
      return '?';
    })
    .join(',');
}

/** One classBodyDeclaration (or enumBodyDeclarations' own classBodyDeclaration) — either a
 * constructor, a plain method, a nested type to recurse into later, or something phase one
 * doesn't model (a field, an initializer block) and simply ignores. */
function extractMember(decl: any, source: string): { member?: JavaMemberDecl; nestedType?: any } {
  const ctor = decl?.children?.constructorDeclaration?.[0];
  if (ctor) {
    const declarator = ctor.children?.constructorDeclarator?.[0];
    const nameTok = declarator?.children?.simpleTypeName?.[0]?.children?.typeIdentifier?.[0]?.children?.Identifier?.[0];
    if (nameTok) {
      return {
        member: {
          kind: 'constructor',
          name: nameTok.image,
          nameStart: nameTok.startOffset,
          nameEnd: nameTok.endOffset,
          startLine: ctor.location?.startLine ?? nameTok.startLine,
          startColumn: ctor.location?.startColumn ?? nameTok.startColumn,
          paramSignature: paramSignatureOf(declarator, source),
        },
      };
    }
  }

  const cmd = decl?.children?.classMemberDeclaration?.[0];
  if (!cmd) return {};

  const method = cmd.children?.methodDeclaration?.[0];
  if (method) {
    const header = method.children?.methodHeader?.[0];
    const declarator = header?.children?.methodDeclarator?.[0];
    const nameTok = declarator?.children?.Identifier?.[0];
    const result = header?.children?.result?.[0];
    if (nameTok && result?.location) {
      return {
        member: {
          kind: 'method',
          name: nameTok.image,
          nameStart: nameTok.startOffset,
          nameEnd: nameTok.endOffset,
          startLine: method.location?.startLine ?? nameTok.startLine,
          startColumn: method.location?.startColumn ?? nameTok.startColumn,
          paramSignature: paramSignatureOf(declarator, source),
          resultStart: result.location.startOffset,
          resultEnd: result.location.endOffset,
        },
      };
    }
  }

  if (cmd.children?.classDeclaration?.[0]) return { nestedType: cmd.children.classDeclaration[0] };
  if (cmd.children?.interfaceDeclaration?.[0]) return { nestedType: cmd.children.interfaceDeclaration[0] };
  return {};
}

/** Recursively extracts `typeNode` (a `classDeclaration` or `interfaceDeclaration` CST node) plus
 * every type nested inside it, appending each as a flat JavaTypeDecl into `out` — the outer type
 * is always pushed before any of its nested types, so a caller who captures `out.length` before
 * calling can always find "the type just added" at that index afterward. Interfaces are recorded
 * (name/visibility only) but never recursed into — phase one doesn't model interface members. */
function processTypeDeclNode(typeNode: any, source: string, out: JavaTypeDecl[]): void {
  if (typeNode?.name === 'interfaceDeclaration') {
    const modifiers: any[] = typeNode.children?.interfaceModifier || [];
    const pubMod = modifiers.find(m => m.children?.Public?.[0]);
    const normal = typeNode.children?.normalInterfaceDeclaration?.[0];
    const nameTok = normal?.children?.typeIdentifier?.[0]?.children?.Identifier?.[0];
    if (!nameTok || !typeNode.location) return; // annotation-interface or malformed — skip
    out.push({
      name: nameTok.image,
      kind: 'interface',
      isPublic: !!pubMod,
      nameStart: nameTok.startOffset,
      nameEnd: nameTok.endOffset,
      nameLine: nameTok.startLine,
      nameColumn: nameTok.startColumn,
      startLine: typeNode.location.startLine,
      endLine: typeNode.location.endLine,
      publicModifierStart: pubMod?.children.Public[0].startOffset,
      publicModifierEnd: pubMod?.children.Public[0].endOffset,
      methods: [],
    });
    return;
  }

  const modifiers: any[] = typeNode?.children?.classModifier || [];
  const pubMod = modifiers.find(m => m.children?.Public?.[0]);
  const normal = typeNode?.children?.normalClassDeclaration?.[0];
  const enumDecl = typeNode?.children?.enumDeclaration?.[0];
  const recordDecl = typeNode?.children?.recordDeclaration?.[0];

  let nameTok: any;
  let kind: JavaTypeDecl['kind'] = 'class';
  let declList: any[] = [];
  if (normal) {
    nameTok = normal.children?.typeIdentifier?.[0]?.children?.Identifier?.[0];
    declList = normal.children?.classBody?.[0]?.children?.classBodyDeclaration || [];
  } else if (enumDecl) {
    kind = 'enum';
    nameTok = enumDecl.children?.typeIdentifier?.[0]?.children?.Identifier?.[0];
    declList = enumDecl.children?.enumBody?.[0]?.children?.enumBodyDeclarations?.[0]?.children?.classBodyDeclaration || [];
  } else if (recordDecl) {
    kind = 'record';
    nameTok = recordDecl.children?.typeIdentifier?.[0]?.children?.Identifier?.[0];
    // Member extraction intentionally skipped for records in phase one (records never appear in
    // this project's real decompiled input — pre-Java-16 enterprise bytecode).
  }
  if (!nameTok || !typeNode.location) return;

  const methods: JavaMemberDecl[] = [];
  const nestedNodes: any[] = [];
  for (const decl of declList) {
    const { member, nestedType } = extractMember(decl, source);
    if (member) methods.push(member);
    if (nestedType) nestedNodes.push(nestedType);
  }

  out.push({
    name: nameTok.image,
    kind,
    isPublic: !!pubMod,
    nameStart: nameTok.startOffset,
    nameEnd: nameTok.endOffset,
    nameLine: nameTok.startLine,
    nameColumn: nameTok.startColumn,
    startLine: typeNode.location.startLine,
    endLine: typeNode.location.endLine,
    publicModifierStart: pubMod?.children.Public[0].startOffset,
    publicModifierEnd: pubMod?.children.Public[0].endOffset,
    methods,
  });

  for (const nested of nestedNodes) processTypeDeclNode(nested, source, out);
}

export async function analyzeJavaFile(source: string, ctx: AnalyzeContext = {}): Promise<JavaFileAnalysis> {
  let cst: any;
  try {
    cst = await parseJava(source);
  } catch (err: any) {
    return {
      valid: false,
      packageName: null,
      types: [],
      diagnostics: [{
        code: 'JP1000_PARSE_ERROR',
        severity: 'error',
        message: truncate(String(err?.message || err)),
        line: 1,
        column: 1,
      }],
      packageDeclOffsets: null,
      cst: null,
    };
  }

  const diagnostics: JavaDiagnostic[] = [];
  const ordinary = cst?.children?.ordinaryCompilationUnit?.[0];
  const packageDeclNode = ordinary?.children?.packageDeclaration?.[0];
  const packageIdTokens: any[] = packageDeclNode?.children?.Identifier || [];
  const packageName = packageIdTokens.length ? packageIdTokens.map(t => t.image).join('.') : null;

  const typeDeclNodes: any[] = ordinary?.children?.typeDeclaration || [];
  const topLevelTypeNodes: any[] = [];
  let hasBareDeclaration = false;
  for (const td of typeDeclNodes) {
    if (td.children?.classDeclaration?.[0]) topLevelTypeNodes.push(td.children.classDeclaration[0]);
    else if (td.children?.interfaceDeclaration?.[0]) topLevelTypeNodes.push(td.children.interfaceDeclaration[0]);
    else if (td.children?.methodDeclaration || td.children?.fieldDeclaration) hasBareDeclaration = true;
  }

  const types: JavaTypeDecl[] = [];
  const topLevelTypes: JavaTypeDecl[] = [];
  for (const node of topLevelTypeNodes) {
    const before = types.length;
    processTypeDeclNode(node, source, types);
    if (types.length > before) topLevelTypes.push(types[before]);
  }

  if (!types.length) {
    if (!source.trim() || !hasBareDeclaration) {
      diagnostics.push({
        code: 'JST2006_EMPTY_FILE',
        severity: 'error',
        message: 'File has no package/import/type content',
        line: 1,
        column: 1,
      });
    } else {
      diagnostics.push({
        code: 'JST2001_MISSING_TOP_LEVEL_TYPE',
        severity: 'error',
        message: 'No top-level class/interface/enum/record declaration found — parsed only via a bare top-level member (JEP 445 implicit-class grammar)',
        line: 1,
        column: 1,
      });
    }
  } else {
    const publicTypes = topLevelTypes.filter(t => t.isPublic);
    if (ctx.filePath && publicTypes.length === 1) {
      const stem = path.basename(ctx.filePath, '.java');
      const only = publicTypes[0];
      if (only.name !== stem) {
        diagnostics.push({
          code: 'JST2002_PUBLIC_TYPE_FILENAME_MISMATCH',
          severity: 'error',
          message: `public type '${only.name}' does not match filename '${stem}.java'`,
          line: only.nameLine,
          column: only.nameColumn,
          data: { type: only, expectedName: stem },
        });
      }
    } else if (publicTypes.length > 1) {
      const stem = ctx.filePath ? path.basename(ctx.filePath, '.java') : null;
      const keep = (stem && publicTypes.find(t => t.name === stem)) || publicTypes[0];
      for (const t of publicTypes) {
        if (t === keep) continue;
        diagnostics.push({
          code: 'JST2004_MULTIPLE_PUBLIC_TOP_LEVEL_TYPES',
          severity: 'error',
          message: `multiple public top-level types in one file — '${t.name}' should not be public here (only one public top-level type is allowed per file)`,
          line: t.nameLine,
          column: t.nameColumn,
          data: { type: t },
        });
      }
    }

    if (ctx.filePath && ctx.projectSourceRoot) {
      const expected = expectedPackageFromPath(ctx.filePath, ctx.projectSourceRoot);
      if (expected !== null && (packageName || '') !== expected) {
        diagnostics.push({
          code: 'JST2003_PACKAGE_DIR_MISMATCH',
          severity: 'error',
          message: `package '${packageName || '(none)'}' does not match the directory-derived package '${expected || '(default package)'}'`,
          line: packageIdTokens[0]?.startLine ?? 1,
          column: packageIdTokens[0]?.startColumn ?? 1,
          data: { actual: packageName, expected },
        });
      }
    }

    for (const t of types) {
      for (const m of t.methods) {
        if (m.kind === 'method' && m.name === t.name) {
          diagnostics.push({
            code: 'JMB3003_METHOD_LOOKS_LIKE_CTOR',
            severity: 'warning',
            message: `method '${m.name}' has the same name as its enclosing type '${t.name}' but declares a return type — likely a mis-decompiled constructor`,
            line: m.startLine,
            column: m.startColumn,
            data: { type: t, member: m },
          });
        }
      }
    }
  }

  const packageDeclOffsets = packageIdTokens.length
    ? { nameStart: packageIdTokens[0].startOffset, nameEnd: packageIdTokens[packageIdTokens.length - 1].endOffset }
    : null;

  return {
    valid: !diagnostics.some(d => d.severity === 'error'),
    packageName,
    types,
    diagnostics,
    packageDeclOffsets,
    cst,
  };
}
