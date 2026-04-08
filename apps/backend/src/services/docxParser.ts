/**
 * docxParser — converts an uploaded `.docx` Buffer to TipTap-friendly
 * HTML using the mammoth.js library.
 *
 * Why mammoth?
 *  - Pure JavaScript, no Office/LibreOffice install required.
 *  - Produces semantic HTML (h1/h2/p/strong/em/ul/ol/table/img) that
 *    aligns 1-1 with the TipTap StarterKit + Image + Table extensions
 *    used by the editor on the frontend.
 *  - Supports a `styleMap` to teach it about Microsoft Word custom
 *    paragraph styles (e.g. "Section Title" → h1).
 *
 * The parser is intentionally tiny — it wraps mammoth, applies a
 * project-specific style map, and rethrows any failure as a typed
 * `DocxParseError` so the upload route can produce a 400 response.
 *
 * Public API:
 *  - `parseDocxToHtml(buffer)` → `Promise<{ html, messages }>`
 *  - `class DocxParseError`     — thrown on parsing failure
 *  - `defaultStyleMap`           — exported for tests / debugging
 */

// mammoth ships pure JavaScript without typings; declare a minimal
// shape for the function we use.  This avoids `any` in our public API
// and keeps the typecheck strict.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mammoth has no @types package
import mammoth from 'mammoth';

interface MammothMessage {
  type: 'warning' | 'error' | string;
  message: string;
}

interface MammothResult {
  value: string;
  messages: MammothMessage[];
}

interface MammothInput {
  buffer?: Buffer;
  path?: string;
  arrayBuffer?: ArrayBuffer;
}

interface MammothOptions {
  styleMap?: string[] | string;
  includeDefaultStyleMap?: boolean;
  ignoreEmptyParagraphs?: boolean;
  idPrefix?: string;
}

interface MammothModule {
  convertToHtml(input: MammothInput, options?: MammothOptions): Promise<MammothResult>;
}

const mammothLib = mammoth as unknown as MammothModule;

/**
 * Style map applied on top of mammoth's defaults. The list maps
 * Microsoft Word style names to HTML tags using mammoth's mini-DSL
 * (see https://github.com/mwilliamson/mammoth.js#writing-style-maps).
 *
 * The defaults already cover Heading 1..6, Normal, lists and tables;
 * we add common Russian / English style names that some templates use.
 */
export const defaultStyleMap: string[] = [
  // Headings — both Russian ("Заголовок 1") and English style names
  // appear in the wild.
  "p[style-name='Заголовок 1'] => h1:fresh",
  "p[style-name='Заголовок 2'] => h2:fresh",
  "p[style-name='Заголовок 3'] => h3:fresh",
  "p[style-name='Title']      => h1:fresh",
  "p[style-name='Subtitle']   => h2:fresh",
  // Inline emphasis — Word "Strong" / "Emphasis" character styles.
  "r[style-name='Strong']   => strong",
  "r[style-name='Emphasis'] => em",
  // Map Word's Quote / Intense Quote to <blockquote>.
  "p[style-name='Quote']         => blockquote:fresh",
  "p[style-name='Intense Quote'] => blockquote:fresh",
];

/** Result returned by `parseDocxToHtml`. */
export interface ParseDocxResult {
  /** Converted HTML, ready to feed into TipTap.setContent. */
  html: string;
  /** Mammoth diagnostic messages (warnings about unsupported styles). */
  messages: string[];
}

/**
 * Thrown when mammoth fails to read the .docx file. The route layer
 * catches this and returns a 400 with the original message.
 */
export class DocxParseError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DocxParseError';
    this.cause = cause;
  }
}

/**
 * Convert a `.docx` Buffer to HTML.
 *
 * @param buffer - The raw bytes of an uploaded `.docx` file.
 * @returns      - HTML string + collected mammoth messages.
 * @throws DocxParseError - When mammoth cannot parse the input or
 *                          when the input buffer is empty/invalid.
 */
export async function parseDocxToHtml(buffer: Buffer): Promise<ParseDocxResult> {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new DocxParseError('Empty or invalid .docx buffer');
  }

  try {
    const result = await mammothLib.convertToHtml(
      { buffer },
      {
        styleMap: defaultStyleMap,
        includeDefaultStyleMap: true,
        ignoreEmptyParagraphs: true,
      },
    );

    const messages = (result.messages ?? []).map(
      (m) => `${m.type}: ${m.message}`,
    );

    return {
      html: result.value ?? '',
      messages,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DocxParseError(`Failed to parse .docx: ${message}`, err);
  }
}
