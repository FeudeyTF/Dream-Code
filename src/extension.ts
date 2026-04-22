import * as vscode from "vscode";
import * as ts from "web-tree-sitter";
import { Parser } from "web-tree-sitter";

const OUTPUT_CHANNEL = vscode.window.createOutputChannel("tree-sitter-dm");

// VSCode default token types and modifiers from:
// https://code.visualstudio.com/api/language-extensions/semantic-highlight-guide#standard-token-types-and-modifiers
const TOKEN_TYPES = [
  "namespace",
  "class",
  "enum",
  "interface",
  "struct",
  "typeParameter",
  "type",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "decorator",
  "event",
  "function",
  "method",
  "macro",
  "label",
  "comment",
  "string",
  "keyword",
  "number",
  "regexp",
  "operator",
];
const TOKEN_MODIFIERS = [
  "declaration",
  "definition",
  "readonly",
  "static",
  "deprecated",
  "abstract",
  "async",
  "modification",
  "documentation",
  "defaultLibrary",
];
const LEGEND = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);

const DM_WASM_ASSET_NAME = "tree-sitter-dm.wasm";
const DEFAULT_DM_PARSER_REPOSITORY =
  "https://github.com/FeudeyTF/tree-sitter-dm";
const DEFAULT_DM_QUERIES_PATH = "queries";
const DM_INSTALL_DIR = "dm-parser";
const DM_METADATA_FILE = "install-metadata.json";

type SemanticTokenTypeMapping = {
  targetTokenType: string;
  targetTokenModifiers?: string[];
};
type Config = {
  lang: string;
  parser: string;
  highlights: string;
  injections?: string;
  folds?: string;
  injectionOnly: boolean;
  semanticTokenTypeMappings?: Record<string, SemanticTokenTypeMapping>;
};
type Language = {
  parser: Parser;
  highlightQuery: ts.Query;
  injectionQuery?: ts.Query;
  foldQuery?: ts.Query;
  semanticTokenTypeMappings?: Record<string, SemanticTokenTypeMapping>;
};
type Token = {
  range: vscode.Range;
  type: string;
  modifiers: string[];
};
type Injection = {
  range: vscode.Range;
  tokens: Token[];
};
type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
};
type GitHubRelease = {
  tag_name: string;
  assets: GitHubReleaseAsset[];
};
type GitHubRepository = {
  default_branch: string;
};
type ParserInstallMetadata = {
  repository: string;
  releaseTag: string;
  queriesPath: string;
  queriesRef: string;
  installedAt: string;
};

function log(messageOrCallback: string | (() => string), data?: unknown) {
  // Only log in debug mode
  const config = vscode.workspace.getConfiguration("tree-sitter-dm");
  const isDebugMode = config.get("debug", false);

  if (isDebugMode) {
    const timestamp = new Date().toISOString();
    const message =
      typeof messageOrCallback === "function"
        ? messageOrCallback()
        : messageOrCallback;
    OUTPUT_CHANNEL.appendLine(`[${timestamp}] ${message}`);
    if (data) {
      OUTPUT_CHANNEL.appendLine(JSON.stringify(data, null, 2));
    }
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizeGitHubRepository(repositoryInput: string): string {
  const trimmed = repositoryInput.trim();
  if (trimmed.length === 0) {
    throw new Error("The parser repository setting is empty.");
  }

  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase() !== "github.com") {
      throw new Error("Parser repository must point to github.com.");
    }
    const [owner, repoRaw] = parsed.pathname.split("/").filter(Boolean);
    const repo = repoRaw?.replace(/\.git$/i, "");
    if (!owner || !repo) {
      throw new Error(
        "Parser repository URL must be in format https://github.com/<owner>/<repo>.",
      );
    }
    return `${owner}/${repo}`;
  }

  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new Error(
      "Parser repository must be in format <owner>/<repo> or https://github.com/<owner>/<repo>.",
    );
  }

  return `${segments[0]}/${segments[1].replace(/\.git$/i, "")}`;
}

function normalizeRepositoryPath(pathInput: string): string {
  const normalized = pathInput
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");

  if (normalized.length === 0) {
    throw new Error("The queries path setting is empty.");
  }

  const hasInvalidSegment = normalized
    .split("/")
    .some((segment) => segment === "." || segment === "..");
  if (hasInvalidSegment) {
    throw new Error("Queries path must not contain '.' or '..' segments.");
  }

  return normalized;
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function deleteIfExists(uri: vscode.Uri): Promise<void> {
  if (await fileExists(uri)) {
    await vscode.workspace.fs.delete(uri);
  }
}

async function fetchLatestRelease(repository: string): Promise<GitHubRelease> {
  const url = `https://api.github.com/repos/${repository}/releases/latest`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "dreamcode",
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `No latest release found for ${repository}. Publish a release with ${DM_WASM_ASSET_NAME}.`,
      );
    }
    throw new Error(
      `Failed to read latest release for ${repository}: ${response.status} ${response.statusText}.`,
    );
  }

  const release = (await response.json()) as GitHubRelease;
  if (typeof release.tag_name !== "string" || !Array.isArray(release.assets)) {
    throw new Error(`Unexpected latest release payload for ${repository}.`);
  }
  return release;
}

async function fetchRepositoryInfo(
  repository: string,
): Promise<GitHubRepository> {
  const url = `https://api.github.com/repos/${repository}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "dreamcode",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to read repository info for ${repository}: ${response.status} ${response.statusText}.`,
    );
  }

  const repositoryInfo = (await response.json()) as GitHubRepository;
  if (
    typeof repositoryInfo.default_branch !== "string" ||
    repositoryInfo.default_branch.length === 0
  ) {
    throw new Error(`Repository info for ${repository} has no default branch.`);
  }

  return repositoryInfo;
}

async function fetchBinary(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "dreamcode",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to download binary from ${url}: ${response.status} ${response.statusText}.`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "dreamcode",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to download text from ${url}: ${response.status} ${response.statusText}.`,
    );
  }
  return await response.text();
}

async function readParserInstallMetadata(
  metadataUri: vscode.Uri,
): Promise<ParserInstallMetadata | undefined> {
  if (!(await fileExists(metadataUri))) {
    return undefined;
  }

  try {
    const raw = await vscode.workspace.fs.readFile(metadataUri);
    const parsed = JSON.parse(
      Buffer.from(raw).toString("utf-8"),
    ) as ParserInstallMetadata;
    if (
      typeof parsed.repository === "string" &&
      typeof parsed.releaseTag === "string" &&
      typeof parsed.installedAt === "string"
    ) {
      return parsed;
    }
  } catch (error) {
    log(() => `Failed to parse parser metadata: ${stringifyError(error)}`);
  }

  return undefined;
}

async function writeParserInstallMetadata(
  metadataUri: vscode.Uri,
  metadata: ParserInstallMetadata,
): Promise<void> {
  const payload = JSON.stringify(metadata, null, 2);
  await vscode.workspace.fs.writeFile(
    metadataUri,
    new TextEncoder().encode(payload),
  );
}

async function downloadQueryFromRepositoryPath(
  repository: string,
  ref: string,
  queriesPath: string,
  queryFileName: string,
  targetUri: vscode.Uri,
  required: boolean,
): Promise<boolean> {
  const queryPath = `${queriesPath}/${queryFileName}`
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = `https://raw.githubusercontent.com/${repository}/${ref}/${queryPath}`;

  try {
    const text = await fetchText(url);
    await vscode.workspace.fs.writeFile(
      targetUri,
      new TextEncoder().encode(text),
    );
    return true;
  } catch (error) {
    log(() => `Failed to download ${queryFileName} from ${url}`, error);
  }

  if (required) {
    throw new Error(
      `Failed to download required query file ${queryFileName} from ${repository}/${ref}/${queriesPath}.`,
    );
  }

  return false;
}

async function prepareDmLanguageConfig(
  context: vscode.ExtensionContext,
): Promise<Config> {
  const settings = vscode.workspace.getConfiguration("tree-sitter-dm");
  const repositoryInput = settings.get<string>(
    "dmParserRepository",
    DEFAULT_DM_PARSER_REPOSITORY,
  );
  const repository = normalizeGitHubRepository(repositoryInput);
  const queriesPathInput = settings.get<string>(
    "dmQueriesPath",
    DEFAULT_DM_QUERIES_PATH,
  );
  const queriesPath = normalizeRepositoryPath(queriesPathInput);

  const installDirUri = vscode.Uri.joinPath(
    context.globalStorageUri,
    DM_INSTALL_DIR,
  );
  await vscode.workspace.fs.createDirectory(installDirUri);

  const parserUri = vscode.Uri.joinPath(installDirUri, DM_WASM_ASSET_NAME);
  const highlightsUri = vscode.Uri.joinPath(installDirUri, "highlights.scm");
  const injectionsUri = vscode.Uri.joinPath(installDirUri, "injections.scm");
  const foldsUri = vscode.Uri.joinPath(installDirUri, "folds.scm");
  const metadataUri = vscode.Uri.joinPath(installDirUri, DM_METADATA_FILE);

  try {
    const release = await fetchLatestRelease(repository);
    const repositoryInfo = await fetchRepositoryInfo(repository);
    const queriesRef = repositoryInfo.default_branch;
    const wasmAsset = release.assets.find(
      (asset) => asset.name === DM_WASM_ASSET_NAME,
    );

    if (!wasmAsset) {
      throw new Error(
        `Latest release ${release.tag_name} of ${repository} does not contain ${DM_WASM_ASSET_NAME}.`,
      );
    }

    const metadata = await readParserInstallMetadata(metadataUri);
    const parserAlreadyInstalled = await fileExists(parserUri);
    const highlightsAlreadyInstalled = await fileExists(highlightsUri);
    const needsInstall =
      !parserAlreadyInstalled ||
      !highlightsAlreadyInstalled ||
      metadata?.repository !== repository ||
      metadata?.releaseTag !== release.tag_name ||
      metadata?.queriesPath !== queriesPath ||
      metadata?.queriesRef !== queriesRef;

    if (needsInstall) {
      log(
        () =>
          `Installing DM parser from ${repository} release ${release.tag_name} and queries from ${queriesPath} (${queriesRef}).`,
      );

      const wasm = await fetchBinary(wasmAsset.browser_download_url);
      await vscode.workspace.fs.writeFile(parserUri, wasm);

      await downloadQueryFromRepositoryPath(
        repository,
        queriesRef,
        queriesPath,
        "highlights.scm",
        highlightsUri,
        true,
      );

      const hasInjectionQuery = await downloadQueryFromRepositoryPath(
        repository,
        queriesRef,
        queriesPath,
        "injections.scm",
        injectionsUri,
        false,
      );
      if (!hasInjectionQuery) {
        await deleteIfExists(injectionsUri);
      }

      const hasFoldsQuery = await downloadQueryFromRepositoryPath(
        repository,
        queriesRef,
        queriesPath,
        "folds.scm",
        foldsUri,
        false,
      );
      if (!hasFoldsQuery) {
        await deleteIfExists(foldsUri);
      }

      await writeParserInstallMetadata(metadataUri, {
        repository,
        releaseTag: release.tag_name,
        queriesPath,
        queriesRef,
        installedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    const parserExists = await fileExists(parserUri);
    const highlightsExists = await fileExists(highlightsUri);

    if (!parserExists || !highlightsExists) {
      throw error;
    }

    const warning =
      "Failed to update tree-sitter-dm from latest release. Using cached parser files.";
    log(() => `${warning} ${stringifyError(error)}`);
    void vscode.window.showWarningMessage(warning);
  }

  return {
    lang: "dm",
    parser: parserUri.fsPath,
    highlights: highlightsUri.fsPath,
    injections: (await fileExists(injectionsUri))
      ? injectionsUri.fsPath
      : undefined,
    folds: (await fileExists(foldsUri)) ? foldsUri.fsPath : undefined,
    injectionOnly: false,
  };
}

async function readUtf8File(filePath: string): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
  return Buffer.from(bytes).toString("utf-8");
}

/**
 * Called once on extension initialization and again if the reload command is triggered.
 * It reads the configuration and registers the semantic tokens provider.
 */
export async function activate(context: vscode.ExtensionContext) {
  log("Extension activated");

  const configs: Config[] = [];
  try {
    const dmConfig = await prepareDmLanguageConfig(context);
    configs.push(dmConfig);
  } catch (error) {
    const message = `Failed to initialize DM parser: ${stringifyError(error)}`;
    log(message);
    void vscode.window.showErrorMessage(message);
    return;
  }
  log(() => {
    return `Configured languages: ${configs.map((c) => c.lang).join(", ")}`;
  });
  const cache = new LanguageCache(configs);
  const languageMap = configs
    .filter((config) => !config.injectionOnly)
    .map((config) => {
      return { language: config.lang };
    });
  const provider = vscode.languages.registerDocumentSemanticTokensProvider(
    languageMap,
    new SemanticTokensProvider(cache),
    LEGEND,
  );
  context.subscriptions.push(provider);

  // setup the selection range provider
  const selectionProvider = vscode.languages.registerSelectionRangeProvider(
    languageMap,
    new SelectionRangeProvider(cache),
  );
  context.subscriptions.push(selectionProvider);

  // setup the folding range provider
  let foldProvider: vscode.Disposable | undefined;
  const foldConfigs = configs.filter(
    (config) => !config.injectionOnly && config.folds !== undefined,
  );
  if (foldConfigs.length > 0) {
    const foldLanguageMap = foldConfigs.map((config) => {
      return { language: config.lang };
    });
    foldProvider = vscode.languages.registerFoldingRangeProvider(
      foldLanguageMap,
      new FoldingRangeProvider(cache),
    );
    context.subscriptions.push(foldProvider);
  }

  // setup incremental parsing listeners
  const onDidChange = vscode.workspace.onDidChangeTextDocument((event) => {
    cache.applyEdits(event);
  });
  context.subscriptions.push(onDidChange);
  const onDidClose = vscode.workspace.onDidCloseTextDocument((document) => {
    cache.removeDocument(document.uri);
  });
  context.subscriptions.push(onDidClose);

  // setup the reload command
  const reload = vscode.commands.registerCommand(
    "tree-sitter-vscode.reload",
    () => {
      // dispose of the old providers and clear the list of subscriptions
      reload.dispose();
      provider.dispose();
      selectionProvider.dispose();
      foldProvider?.dispose();
      onDidChange.dispose();
      onDidClose.dispose();
      context.subscriptions.length = 0;
      // reinitialize the extension
      void activate(context);
    },
  );
  context.subscriptions.push(reload);
}

/**
 * Called when the extension is deactivated.
 */
export function deactivate() {
  /* empty */
}

class LanguageCache {
  readonly configs: Config[];
  private tsLangs: Record<string, Language> = {};
  private trees = new Map<string, ts.Tree>();

  constructor(configs: Config[]) {
    this.configs = configs;
  }

  async getLanguage(lang: string): Promise<Language | undefined> {
    if (!(lang in this.tsLangs)) {
      const config = this.configs.find((config) => config.lang === lang);
      if (config === undefined) {
        return undefined;
      }
      this.tsLangs[lang] = await initLanguage(config);
    }
    return this.tsLangs[lang];
  }

  /**
   * Returns a syntax tree for the document, using incremental parsing when possible.
   * The returned tree is a copy safe for the caller to use without interference
   * from subsequent edits.
   */
  getTree(document: vscode.TextDocument): ts.Tree | null {
    const lang = this.tsLangs[document.languageId];
    if (!lang) {
      return null;
    }

    const uri = document.uri.toString();
    const cached = this.trees.get(uri);
    if (cached) {
      return cached.copy();
    }

    const tree = lang.parser.parse(document.getText());
    if (tree) {
      this.trees.set(uri, tree);
    }
    return tree;
  }

  /**
   * Applies document edits to the cached tree and re-parses incrementally.
   * Changes are applied in reverse document order so positions remain valid.
   */
  applyEdits(event: vscode.TextDocumentChangeEvent): void {
    const uri = event.document.uri.toString();
    const tree = this.trees.get(uri);
    if (!tree) {
      return;
    }

    const lang = this.tsLangs[event.document.languageId];
    if (!lang) {
      return;
    }

    const changes = [...event.contentChanges].sort(
      (a, b) => b.rangeOffset - a.rangeOffset,
    );

    for (const change of changes) {
      const startPosition: ts.Point = {
        row: change.range.start.line,
        column: change.range.start.character,
      };
      const oldEndPosition: ts.Point = {
        row: change.range.end.line,
        column: change.range.end.character,
      };
      const newLines = change.text.split("\n");
      const newEndPosition: ts.Point = {
        row: startPosition.row + newLines.length - 1,
        column:
          newLines.length === 1
            ? startPosition.column + newLines[0].length
            : newLines[newLines.length - 1].length,
      };

      tree.edit(
        new ts.Edit({
          startIndex: change.rangeOffset,
          oldEndIndex: change.rangeOffset + change.rangeLength,
          newEndIndex: change.rangeOffset + change.text.length,
          startPosition,
          oldEndPosition,
          newEndPosition,
        }),
      );
    }

    const newTree = lang.parser.parse(event.document.getText(), tree);
    if (newTree) {
      this.trees.set(uri, newTree);
    }
  }

  removeDocument(uri: vscode.Uri): void {
    this.trees.delete(uri.toString());
  }
}

async function initLanguage(config: Config): Promise<Language> {
  log(() => {
    return `Initializing language: ${config.lang}`;
  });
  await Parser.init().catch();
  const parser = new Parser();
  const lang = await ts.Language.load(config.parser);
  log(`Tree-Sitter ABI version for ${config.lang} is ${lang.abiVersion}.`);
  parser.setLanguage(lang);
  const queryText = await readUtf8File(config.highlights);
  const highlightQuery = new ts.Query(lang, queryText);
  let injectionQuery = undefined;
  if (config.injections !== undefined) {
    const injectionText = await readUtf8File(config.injections);
    injectionQuery = new ts.Query(lang, injectionText);
  }
  let foldQuery = undefined;
  if (config.folds !== undefined) {
    const foldText = await readUtf8File(config.folds);
    foldQuery = new ts.Query(lang, foldText);
  }
  return {
    parser,
    highlightQuery,
    injectionQuery,
    foldQuery,
    semanticTokenTypeMappings: config.semanticTokenTypeMappings,
  };
}

function convertPosition(pos: ts.Point): vscode.Position {
  return new vscode.Position(pos.row, pos.column);
}

function addPosition(range: vscode.Range, pos: vscode.Position): vscode.Range {
  const start =
    range.start.line === 0
      ? new vscode.Position(
          range.start.line + pos.line,
          range.start.character + pos.character,
        )
      : new vscode.Position(range.start.line + pos.line, range.start.character);
  const end =
    range.end.line === 0
      ? new vscode.Position(
          range.end.line + pos.line,
          range.end.character + pos.character,
        )
      : new vscode.Position(range.end.line + pos.line, range.end.character);
  return new vscode.Range(start, end);
}

function parseCaptureName(name: string): { type: string; modifiers: string[] } {
  const parts = name.split(".");
  if (parts.length === 0) {
    throw new Error("Capture name is empty.");
  } else if (parts.length === 1) {
    return { type: parts[0], modifiers: [] };
  } else {
    return { type: parts[0], modifiers: parts.slice(1) };
  }
}

/**
 * Semantic tokens cannot span multiple lines,
 * so if the range doesn't end in the same line,
 * one token for each line is created.
 */
function splitToken(token: Token): Token[] {
  const start = token.range.start;
  const end = token.range.end;
  if (start.line !== end.line) {
    // 100_0000 is chosen as the arbitrary length, since the actual line length is unknown.
    // Choosing a big number works, while `Number.MAX_VALUE` seems to confuse VSCode.
    const maxLineLength = 100_000;
    const lineDiff = end.line - start.line;
    if (lineDiff < 0) {
      throw new RangeError("Invalid token range");
    }
    const tokens: Token[] = [];
    // token for the first line, beginning at the start char
    tokens.push({
      range: new vscode.Range(
        start,
        new vscode.Position(start.line, maxLineLength),
      ),
      type: token.type,
      modifiers: token.modifiers,
    });
    // tokens for intermediate lines, spanning from 0 to maxLineLength
    for (let i = 1; i < lineDiff; i++) {
      const middleToken: Token = {
        range: new vscode.Range(
          new vscode.Position(start.line + i, 0),
          new vscode.Position(start.line + i, maxLineLength),
        ),
        type: token.type,
        modifiers: token.modifiers,
      };
      tokens.push(middleToken);
    }
    // token for the last line, ending at the end char
    tokens.push({
      range: new vscode.Range(new vscode.Position(end.line, 0), end),
      type: token.type,
      modifiers: token.modifiers,
    });
    return tokens;
  } else {
    return [token];
  }
}

class SemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  private readonly cache: LanguageCache;

  constructor(cache: LanguageCache) {
    this.cache = cache;
  }

  /**
   * Called regularly by VSCode to provide semantic tokens for the given document.
   * It parses the document with the corresponding language parser and returns the tokens.
   */
  async provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ) {
    const tsLang = await this.cache.getLanguage(document.languageId);
    if (tsLang === undefined) {
      throw new Error("No config for lang provided.");
    }
    const tree = this.cache.getTree(document);
    if (tree === null) {
      throw new Error("Failed to parse document.");
    }
    const tokens = await this.parseToTokens(tsLang, tree, {
      row: 0,
      column: 0,
    });
    const builder = new vscode.SemanticTokensBuilder(LEGEND);
    tokens.forEach((token) =>
      builder.push(token.range, token.type, token.modifiers),
    );
    return builder.build();
  }

  /**
   * Returns the highlighting tokens for the given syntax tree.
   * Calls `getInjections` for nested injections.
   */
  async parseToTokens(
    lang: Language,
    tree: ts.Tree,
    startPosition: ts.Point,
  ): Promise<Token[]> {
    const { highlightQuery, injectionQuery } = lang;
    const matches = highlightQuery.matches(tree.rootNode);
    let tokens = this.matchesToTokens(lang, matches);
    if (injectionQuery !== undefined) {
      const injections = await this.getInjections(
        injectionQuery,
        tree.rootNode,
      );
      // merge the injection tokens with the main tokens
      for (const injection of injections) {
        if (injection.tokens.length > 0) {
          const range = injection.range;
          tokens = tokens
            // remove all tokens that are contained in an injection
            .filter((token) => !range.contains(token.range))
            // split tokens that are partially contained in an injection
            .flatMap((token) => {
              if (token.range.intersection(range) !== undefined) {
                const newTokens: Token[] = [];
                if (token.range.start.isBefore(range.start)) {
                  const before = new vscode.Range(
                    token.range.start,
                    range.start,
                  );
                  newTokens.push({ ...token, range: before });
                }
                if (token.range.end.isAfter(range.end)) {
                  const after = new vscode.Range(range.end, token.range.end);
                  newTokens.push({ ...token, range: after });
                }
                return newTokens;
              } else {
                return [token];
              }
            });
        }
      }
      tokens = tokens.concat(
        injections.map((injection) => injection.tokens).flat(),
      );
    }
    tokens = tokens.map((token) => {
      return {
        ...token,
        range: addPosition(token.range, convertPosition(startPosition)),
      };
    });
    return tokens;
  }

  matchesToTokens(lang: Language, matches: ts.QueryMatch[]): Token[] {
    const unsplitTokens: Token[] = matches
      .flatMap((match) => match.captures)
      .flatMap((capture) => {
        // Store the original capture name before splitting
        const originalCaptureName = capture.name;
        let { type, modifiers: modifiers } = parseCaptureName(capture.name);
        const start = convertPosition(capture.node.startPosition);
        const end = convertPosition(capture.node.endPosition);

        // First check if we have a mapping for the original unsplit name
        if (
          lang.semanticTokenTypeMappings &&
          Object.prototype.hasOwnProperty.call(
            lang.semanticTokenTypeMappings,
            originalCaptureName,
          )
        ) {
          const mapping = lang.semanticTokenTypeMappings[originalCaptureName];

          type = mapping.targetTokenType;
          modifiers = mapping.targetTokenModifiers ?? [];

          log(() => {
            return `Applied type mapping for original name: ${originalCaptureName} → ${mapping.targetTokenType}${
              mapping.targetTokenModifiers &&
              mapping.targetTokenModifiers.length > 0
                ? ` with modifiers: ${mapping.targetTokenModifiers.join(", ")}`
                : ""
            }`;
          });
        }
        // If no mapping for the full name, check for just the type
        else if (
          lang.semanticTokenTypeMappings &&
          Object.prototype.hasOwnProperty.call(
            lang.semanticTokenTypeMappings,
            type,
          )
        ) {
          const mapping = lang.semanticTokenTypeMappings[type];

          type = mapping.targetTokenType;
          modifiers = mapping.targetTokenModifiers ?? [];

          log(() => {
            return `Applied type mapping for base type: ${type} → ${mapping.targetTokenType}${
              mapping.targetTokenModifiers &&
              mapping.targetTokenModifiers.length > 0
                ? ` with modifiers: ${mapping.targetTokenModifiers.join(", ")}`
                : ""
            }`;
          });
        }

        if (TOKEN_TYPES.includes(type)) {
          const validModifiers = modifiers.filter((modifier) =>
            TOKEN_MODIFIERS.includes(modifier),
          );
          const token: Token = {
            range: new vscode.Range(start, end),
            type: type,
            modifiers: validModifiers,
          };
          return token;
        } else {
          return [];
        }
      });

    return unsplitTokens
      .flatMap((token) => {
        // Get all tokens contained within this token
        const contained = unsplitTokens.filter(
          (t) => !token.range.isEqual(t.range) && token.range.contains(t.range),
        );

        if (contained.length > 0) {
          // Sort contained tokens by their start position
          const sortedContained = contained.sort((a, b) =>
            a.range.start.compareTo(b.range.start),
          );

          const resultTokens = [];
          let currentPos = token.range.start;

          // Create tokens for the gaps between contained tokens
          for (const containedToken of sortedContained) {
            // If there's a gap before this contained token, create a token for it
            if (currentPos.compareTo(containedToken.range.start) < 0) {
              resultTokens.push({
                ...token,
                range: new vscode.Range(currentPos, containedToken.range.start),
              });
            }
            currentPos = containedToken.range.end;
          }

          // Add token for the gap after the last contained token if needed
          if (currentPos.compareTo(token.range.end) < 0) {
            resultTokens.push({
              ...token,
              range: new vscode.Range(currentPos, token.range.end),
            });
          }

          return resultTokens;
        } else {
          return token;
        }
      })
      .flatMap(splitToken);
  }

  /**
   * Get the injection range and tokens for a specific match.
   */
  async getInjection(match: ts.QueryMatch): Promise<Injection | null> {
    // determine language
    const {
      "injection.language": injectionLanguage,
      // TODO: add support for self and parent injections
      // "injection.self": injectionSelf,
      // "injection.parent": injectionParent
    } = match.setProperties || {};
    // the language is hard coded by "set!"
    const hardCoded =
      typeof injectionLanguage === "string" ? injectionLanguage : undefined;
    // dynamically determined language
    const dynamic = match.captures.find(
      (capture) => capture.name === "injection.language",
    )?.node.text;
    // custom language determination by capture name
    const name = match.captures.find((capture) =>
      this.cache.configs.map((config) => config.lang).includes(capture.name),
    )?.name;

    const lang = hardCoded || dynamic || name;
    if (lang === undefined) {
      return null;
    }

    // determine capture
    let capture = undefined;
    if (hardCoded !== undefined) {
      if (match.captures.length === 0) {
        return null;
      }
      // use first capture (there should only be one)
      capture = match.captures[0];
    } else if (dynamic !== undefined) {
      capture = match.captures.find(
        (capture) => capture.name === "injection.content",
      );
    } else if (name !== undefined) {
      capture = match.captures.find((capture) => capture.name === name);
    }
    if (capture === undefined) {
      return null;
    }

    // get language config
    const langConfig = await this.cache.getLanguage(lang);
    if (langConfig === undefined) {
      return null;
    }

    const injectionTree = langConfig.parser.parse(capture.node.text);
    if (injectionTree === null) {
      return null;
    }
    const tokens = await this.parseToTokens(
      langConfig,
      injectionTree,
      capture.node.startPosition,
    );
    const range = new vscode.Range(
      convertPosition(capture.node.startPosition),
      convertPosition(capture.node.endPosition),
    );
    return { range, tokens };
  }

  /**
   * Matches the given injection query against the given node and returns the highlighting tokens.
   * This also works for nested injections.
   */
  async getInjections(
    injectionQuery: ts.Query,
    node: ts.Node,
  ): Promise<Injection[]> {
    const matches = injectionQuery.matches(node);
    const injections = matches.map(
      async (match) => await this.getInjection(match),
    );
    return (await Promise.all(injections)).filter(
      (injection): injection is Injection => injection !== null,
    );
  }
}

class SelectionRangeProvider implements vscode.SelectionRangeProvider {
  private readonly cache: LanguageCache;

  constructor(cache: LanguageCache) {
    this.cache = cache;
  }

  async provideSelectionRanges(
    document: vscode.TextDocument,
    positions: vscode.Position[],
    token: vscode.CancellationToken,
  ): Promise<vscode.SelectionRange[]> {
    await this.cache.getLanguage(document.languageId);
    const tree = this.cache.getTree(document);
    if (tree === null) {
      return [];
    }

    return positions
      .map((position) => {
        const tsPoint: ts.Point = {
          row: position.line,
          column: position.character,
        };
        let node: ts.Node | null = tree.rootNode.descendantForPosition(tsPoint);

        // Collect ranges from innermost to outermost, skipping duplicates
        const ranges: vscode.Range[] = [];
        while (node !== null) {
          const range = new vscode.Range(
            convertPosition(node.startPosition),
            convertPosition(node.endPosition),
          );
          if (
            ranges.length === 0 ||
            !range.isEqual(ranges[ranges.length - 1])
          ) {
            ranges.push(range);
          }
          node = node.parent;
        }

        // Build the chain from outermost to innermost so that
        // each SelectionRange's parent is the next larger range
        let selectionRange: vscode.SelectionRange | undefined;
        for (let i = ranges.length - 1; i >= 0; i--) {
          selectionRange = new vscode.SelectionRange(ranges[i], selectionRange);
        }

        return selectionRange;
      })
      .filter((selectionRange) => selectionRange !== undefined);
  }
}

class FoldingRangeProvider implements vscode.FoldingRangeProvider {
  private readonly cache: LanguageCache;

  constructor(cache: LanguageCache) {
    this.cache = cache;
  }

  async provideFoldingRanges(
    document: vscode.TextDocument,
    context: vscode.FoldingContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.FoldingRange[]> {
    const tsLang = await this.cache.getLanguage(document.languageId);
    if (tsLang === undefined) {
      return [];
    }
    if (tsLang.foldQuery === undefined) {
      return [];
    }

    const tree = this.cache.getTree(document);
    if (tree === null) {
      return [];
    }

    const matches = tsLang.foldQuery.matches(tree.rootNode);
    const foldingRanges: vscode.FoldingRange[] = [];

    for (const match of matches) {
      if (match.captures.length <= 0) {
        continue;
      }
      const firstCapture = match.captures[0];
      const lastCapture = match.captures[match.captures.length - 1];
      const startLine = firstCapture.node.startPosition.row;
      const endLine = lastCapture.node.endPosition.row;

      // Only create a fold if it spans at least 2 lines
      if (endLine > startLine) {
        const kind = this.captureNameToFoldKind(firstCapture.name);
        foldingRanges.push(new vscode.FoldingRange(startLine, endLine, kind));
      }
    }

    log(
      () =>
        `Provided ${foldingRanges.length} folding ranges for ${document.languageId}`,
    );
    return foldingRanges;
  }

  private captureNameToFoldKind(
    name: string,
  ): vscode.FoldingRangeKind | undefined {
    switch (name) {
      case "fold.comment":
        return vscode.FoldingRangeKind.Comment;
      case "fold.imports":
        return vscode.FoldingRangeKind.Imports;
      case "fold":
        return vscode.FoldingRangeKind.Region;
      default:
        if (name.startsWith("fold")) {
          return vscode.FoldingRangeKind.Region;
        }
        return undefined;
    }
  }
}
