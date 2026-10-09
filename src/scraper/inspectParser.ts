/**
 * Parser for the subset of Node's `util.inspect` / `console.dir` output that
 * SimpleNotesScraper prints (arrays of plain objects holding strings, numbers,
 * dates, null/undefined). JSON is a subset of that grammar, so a scraper that
 * prints `JSON.stringify(notes)` instead is understood as well.
 *
 * This is a small recursive-descent parser, deliberately *not* `eval`: the input
 * contains user-authored note text and must never be executed.
 *
 * `util.inspect` truncates long values. Those are surfaced explicitly:
 *   'abc'... 2875 more characters  -> TruncatedString
 *   ... 3 more items               -> TruncatedItems (inside arrays)
 */

export class TruncatedString {
  constructor(
    readonly prefix: string,
    readonly remaining: number,
  ) {}
  get fullLength(): number {
    return this.prefix.length + this.remaining;
  }
}

export class TruncatedItems {
  constructor(readonly remaining: number) {}
}

export class InspectParseError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(`${message} at offset ${position}`);
  }
}

const ISO_DATE = /^-?\d{4,6}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;
const NUMBER = /^-?(?:\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)n?/i;
const IDENTIFIER = /^[A-Za-z_$][\w$]*/;
const MORE_CHARACTERS = /^\.\.\. (\d+) more characters?/;
const MORE_ITEMS = /^\.\.\. (\d+) more items?/;

const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0",
};

class Parser {
  pos = 0;
  constructor(private readonly text: string) {}

  private fail(message: string): never {
    throw new InspectParseError(message, this.pos);
  }

  private rest(): string {
    return this.text.slice(this.pos, this.pos + 64);
  }

  skipWhitespace(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos] as string)) this.pos++;
  }

  private expect(char: string): void {
    if (this.text[this.pos] !== char) this.fail(`Expected "${char}"`);
    this.pos++;
  }

  parseValue(): unknown {
    this.skipWhitespace();
    const ch = this.text[this.pos];
    if (ch === undefined) this.fail("Unexpected end of input");
    if (ch === "[") return this.parseArray();
    if (ch === "{") return this.parseObject();
    if (ch === "'" || ch === '"' || ch === "`") return this.parseStringExpression();

    const rest = this.rest();
    const date = ISO_DATE.exec(rest);
    if (date) {
      this.pos += date[0].length;
      return new Date(date[0]);
    }
    const number = NUMBER.exec(rest);
    if (number) {
      this.pos += number[0].length;
      return number[0].endsWith("n") ? number[0].slice(0, -1) : Number(number[0]);
    }
    if (rest.startsWith("Invalid Date")) {
      this.pos += "Invalid Date".length;
      return null;
    }
    const ident = IDENTIFIER.exec(rest);
    if (ident) {
      const word = ident[0];
      const known: Record<string, unknown> = {
        null: null,
        undefined: undefined,
        true: true,
        false: false,
        NaN: Number.NaN,
        Infinity: Number.POSITIVE_INFINITY,
      };
      if (word in known) {
        this.pos += word.length;
        return known[word];
      }
    }
    return this.fail(`Unexpected token "${rest.slice(0, 20)}"`);
  }

  private parseArray(): unknown[] {
    this.expect("[");
    const items: unknown[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return items;
    }
    for (;;) {
      this.skipWhitespace();
      const more = MORE_ITEMS.exec(this.rest());
      if (more) {
        this.pos += more[0].length;
        items.push(new TruncatedItems(Number(more[1])));
      } else {
        items.push(this.parseValue());
      }
      this.skipWhitespace();
      const ch = this.text[this.pos];
      if (ch === ",") {
        this.pos++;
        this.skipWhitespace();
        if (this.text[this.pos] === "]") {
          this.pos++;
          return items;
        }
        continue;
      }
      if (ch === "]") {
        this.pos++;
        return items;
      }
      this.fail('Expected "," or "]" in array');
    }
  }

  private parseObject(): Record<string, unknown> {
    this.expect("{");
    const object: Record<string, unknown> = Object.create(null);
    this.skipWhitespace();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return object;
    }
    for (;;) {
      this.skipWhitespace();
      const ch = this.text[this.pos];
      let key: string;
      if (ch === "'" || ch === '"' || ch === "`") {
        key = this.parseStringLiteral();
      } else {
        const ident = IDENTIFIER.exec(this.rest());
        if (!ident) this.fail("Expected an object key");
        key = ident[0];
        this.pos += key.length;
      }
      this.skipWhitespace();
      this.expect(":");
      object[key] = this.parseValue();
      this.skipWhitespace();
      const next = this.text[this.pos];
      if (next === ",") {
        this.pos++;
        this.skipWhitespace();
        if (this.text[this.pos] === "}") {
          this.pos++;
          return object;
        }
        continue;
      }
      if (next === "}") {
        this.pos++;
        return object;
      }
      this.fail('Expected "," or "}" in object');
    }
  }

  /** A string possibly split across lines with `+`, possibly followed by a truncation marker. */
  private parseStringExpression(): string | TruncatedString {
    let value = this.parseStringLiteral();
    for (;;) {
      const save = this.pos;
      this.skipWhitespace();
      if (this.text[this.pos] === "+") {
        this.pos++;
        this.skipWhitespace();
        value += this.parseStringLiteral();
        continue;
      }
      const more = MORE_CHARACTERS.exec(this.rest());
      if (more) {
        this.pos += more[0].length;
        return new TruncatedString(value, Number(more[1]));
      }
      this.pos = save;
      return value;
    }
  }

  private parseStringLiteral(): string {
    const quote = this.text[this.pos];
    if (quote !== "'" && quote !== '"' && quote !== "`") this.fail("Expected a string literal");
    this.pos++;
    let out = "";
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined) this.fail("Unterminated string literal");
      if (ch === quote) {
        this.pos++;
        return out;
      }
      if (ch !== "\\") {
        out += ch;
        this.pos++;
        continue;
      }
      const esc = this.text[this.pos + 1];
      if (esc === undefined) this.fail("Unterminated escape sequence");
      if (esc in SIMPLE_ESCAPES) {
        out += SIMPLE_ESCAPES[esc];
        this.pos += 2;
      } else if (esc === "x") {
        const hex = this.text.slice(this.pos + 2, this.pos + 4);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) this.fail("Invalid \\x escape");
        out += String.fromCharCode(Number.parseInt(hex, 16));
        this.pos += 4;
      } else if (esc === "u") {
        if (this.text[this.pos + 2] === "{") {
          const close = this.text.indexOf("}", this.pos + 3);
          const hex = this.text.slice(this.pos + 3, close);
          if (close < 0 || !/^[0-9a-fA-F]{1,6}$/.test(hex)) this.fail("Invalid \\u{} escape");
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          this.pos = close + 1;
        } else {
          const hex = this.text.slice(this.pos + 2, this.pos + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("Invalid \\u escape");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.pos += 6;
        }
      } else {
        // \\ \' \" \` \/ and any other escaped literal character.
        out += esc;
        this.pos += 2;
      }
    }
  }
}

/** Parses one inspect-formatted value starting at `start`. Returns the value and the offset after it. */
export function parseInspectValue(text: string, start = 0): { value: unknown; end: number } {
  const parser = new Parser(text);
  parser.pos = start;
  const value = parser.parseValue();
  return { value, end: parser.pos };
}
