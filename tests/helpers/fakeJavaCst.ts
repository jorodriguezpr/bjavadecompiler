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
 * Test-only builder for minimal, structurally-real java-parser CST fragments — used by
 * tests/core/javaAnalyzer.test.ts, tests/core/javaFixer.test.ts, and (via javaParserMock.ts)
 * tests/javaSyntaxCheck.test.ts.
 *
 * Real java-parser can't load inside Jest at all (see jest.config.js's moduleNameMapper comment —
 * chevrotain has no CommonJS export condition, a hard module-resolution dead end, not a
 * transform gap), so javaAnalyzer.ts's real grammar-shape correctness is verified live outside
 * Jest instead (same pattern javaSyntaxCheck.ts's own hasRealTopLevelType() used). What these
 * fixtures test is javaAnalyzer.ts/javaFixer.ts's OWN logic on top of a given CST shape — so every
 * offset here is derived by locating real substrings in a real source string (never hand-computed
 * independently), which is what makes a javaFixer.ts test's text-splicing assertions trustworthy
 * even though the CST itself is fake.
 */

export interface FakeLoc {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** Finds `needle` in `source` starting at-or-after `fromIndex`, and computes its line/column the
 * same way java-parser's own tokens do (1-based, startColumn counted from the last newline). */
export function locate(source: string, needle: string, fromIndex = 0): FakeLoc {
  const idx = source.indexOf(needle, fromIndex);
  if (idx === -1) throw new Error(`fixture error: ${JSON.stringify(needle)} not found in source at/after index ${fromIndex}`);
  const before = source.slice(0, idx);
  const lastNl = before.lastIndexOf('\n');
  const startLine = (before.match(/\n/g)?.length ?? 0) + 1;
  const startColumn = idx - lastNl;
  return { startOffset: idx, endOffset: idx + needle.length - 1, startLine, startColumn, endLine: startLine, endColumn: startColumn + needle.length - 1 };
}

export function tok(source: string, image: string, fromIndex = 0): FakeLoc & { image: string } {
  return { image, ...locate(source, image, fromIndex) };
}

export function node(children: Record<string, any[]>, loc: FakeLoc): any {
  return { children, location: loc };
}

/** A `package a.b.c;` fragment — `Identifier` tokens for every dotted segment (java-parser puts
 * ALL of a qualified name's identifiers under the one `Identifier` key, in source order — same
 * convention deterministicRemediationService.ts's own `unannClassType.children.Identifier` check
 * already relies on for detecting a qualified vs. simple type name). */
export function fakePackageDecl(source: string, pkg: string, fromIndex = 0): any {
  const pkgTok = tok(source, 'package', fromIndex);
  let cursor = pkgTok.endOffset;
  const idTokens = pkg.split('.').map(part => {
    const t = tok(source, part, cursor);
    cursor = t.endOffset;
    return t;
  });
  const semi = tok(source, ';', cursor);
  return node({ Identifier: idTokens }, { startOffset: pkgTok.startOffset, endOffset: semi.endOffset, startLine: pkgTok.startLine, startColumn: pkgTok.startColumn, endLine: semi.endLine, endColumn: semi.endColumn });
}

export interface FakeMemberSpec {
  kind: 'method' | 'constructor';
  /** Exact substring for this member's own name — must be unique enough at its point in `source`
   * to be found via the shared cursor (searches always start from the end of the previously built
   * member/type, so reusing the same name text across two members in the SAME class is fine as
   * long as they appear in source order — the collision case tests rely on exactly this). */
  name: string;
  /** Return-type text (e.g. 'void', 'String') — methods only, ignored for constructors. */
  returnTypeText?: string;
  /** Exact parameter type substrings, in source order (e.g. ['int', 'String']). Empty/omitted
   * for a no-arg member. */
  paramTypeTexts?: string[];
}

/** Builds one `classBodyDeclaration` CST node (a `constructorDeclaration` or a `methodDeclaration`
 * wrapped in `classMemberDeclaration`), searching `source` from `fromIndex` onward — `fromIndex`
 * must point at (or before) the start of this member's OWN text, i.e. before its return-type
 * keyword for a method, or before its name for a constructor, so a name/type that recurs
 * elsewhere in the file doesn't get matched early. Returns the node plus the offset just past it,
 * so callers can build several members in source order with a running cursor. */
export function fakeMember(source: string, spec: FakeMemberSpec, fromIndex: number): { decl: any; nextIndex: number } {
  let cursor = fromIndex;
  const returnTypeText = spec.kind === 'method' ? (spec.returnTypeText ?? 'void') : undefined;
  const returnTok = returnTypeText ? tok(source, returnTypeText, cursor) : undefined;
  if (returnTok) cursor = returnTok.endOffset;

  const nameTok = tok(source, spec.name, cursor);
  cursor = nameTok.endOffset;

  const paramTypeNodes = (spec.paramTypeTexts || []).map(t => {
    const typeTok = tok(source, t, cursor);
    cursor = typeTok.endOffset;
    const unannType = node({}, typeTok);
    return node({ variableParaRegularParameter: [node({ unannType: [unannType] }, typeTok)] }, typeTok);
  });
  const formalParameterList = paramTypeNodes.length ? [node({ formalParameter: paramTypeNodes }, nameTok)] : [];
  const closeParen = tok(source, ')', cursor);
  const openBrace = tok(source, '{', closeParen.endOffset);
  const closeBrace = tok(source, '}', openBrace.endOffset);
  const bodyLoc: FakeLoc = { startOffset: (returnTok ?? nameTok).startOffset, endOffset: closeBrace.endOffset, startLine: (returnTok ?? nameTok).startLine, startColumn: (returnTok ?? nameTok).startColumn, endLine: closeBrace.endLine, endColumn: closeBrace.endColumn };

  if (spec.kind === 'constructor') {
    const declarator = node({ simpleTypeName: [node({ typeIdentifier: [node({ Identifier: [nameTok] }, nameTok)] }, nameTok)], formalParameterList }, bodyLoc);
    const ctor = node({ constructorDeclarator: [declarator] }, bodyLoc);
    return { decl: node({ constructorDeclaration: [ctor] }, bodyLoc), nextIndex: closeBrace.endOffset + 1 };
  }

  const resultNode = node(returnTypeText === 'void' ? { Void: [returnTok] } : { unannType: [node({}, returnTok!)] }, returnTok!);
  const declarator = node({ Identifier: [nameTok], formalParameterList }, bodyLoc);
  const header = node({ result: [resultNode], methodDeclarator: [declarator] }, bodyLoc);
  const method = node({ methodHeader: [header] }, bodyLoc);
  const classMemberDeclaration = node({ methodDeclaration: [method] }, bodyLoc);
  return { decl: node({ classMemberDeclaration: [classMemberDeclaration] }, bodyLoc), nextIndex: closeBrace.endOffset + 1 };
}

export interface FakeClassSpec {
  name: string;
  isPublic?: boolean;
  members?: FakeMemberSpec[];
}

/** Builds one top-level `classDeclaration` CST node for `spec`, searching `source` from
 * `fromIndex` onward (so multiple classes in one file resolve to their own, distinct occurrences
 * of a shared name like a common member name). */
export function fakeClass(source: string, spec: FakeClassSpec, fromIndex = 0): any {
  let cursor = fromIndex;
  let pubTok: (FakeLoc & { image: string }) | undefined;
  if (spec.isPublic) {
    pubTok = tok(source, 'public', cursor);
    cursor = pubTok.endOffset;
  }
  const classKw = tok(source, 'class', cursor);
  const nameTok = tok(source, spec.name, classKw.endOffset);
  const openBrace = tok(source, '{', nameTok.endOffset);

  let memberCursor = openBrace.endOffset;
  const memberDecls: any[] = [];
  for (const m of spec.members || []) {
    const { decl, nextIndex } = fakeMember(source, m, memberCursor);
    memberDecls.push(decl);
    memberCursor = nextIndex;
  }
  const closeBrace = tok(source, '}', memberCursor);

  const classBodyLoc: FakeLoc = { startOffset: openBrace.startOffset, endOffset: closeBrace.endOffset, startLine: openBrace.startLine, startColumn: openBrace.startColumn, endLine: closeBrace.endLine, endColumn: closeBrace.endColumn };
  const classBody = node({ classBodyDeclaration: memberDecls }, classBodyLoc);
  const outerLoc: FakeLoc = { startOffset: (pubTok ?? classKw).startOffset, endOffset: closeBrace.endOffset, startLine: (pubTok ?? classKw).startLine, startColumn: (pubTok ?? classKw).startColumn, endLine: closeBrace.endLine, endColumn: closeBrace.endColumn };
  const normalClassDeclaration = node({ typeIdentifier: [node({ Identifier: [nameTok] }, nameTok)], classBody: [classBody] }, outerLoc);
  const classModifier = pubTok ? [node({ Public: [pubTok] }, pubTok)] : [];
  return node({ classModifier, normalClassDeclaration: [normalClassDeclaration] }, outerLoc);
}

/** Wraps top-level `classDeclaration` nodes (+ an optional package declaration) into a full fake
 * `compilationUnit` CST — the top-level shape javaAnalyzer.ts's analyzeJavaFile() expects. */
export function fakeCompilationUnit(opts: { packageDecl?: any; classDecls: any[] }): any {
  return {
    children: {
      ordinaryCompilationUnit: [{
        children: {
          ...(opts.packageDecl ? { packageDeclaration: [opts.packageDecl] } : {}),
          typeDeclaration: opts.classDecls.map(c => node({ classDeclaration: [c] }, c.location)),
        },
      }],
    },
  };
}
