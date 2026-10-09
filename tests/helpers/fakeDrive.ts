import type { Readable } from "node:stream";
import type { drive_v3 } from "@googleapis/drive";

/**
 * In-memory stand-in for the Drive v3 `files`/`about` API, understanding exactly
 * the query shapes GoogleDriveStore issues. Supports failure injection so retry,
 * rate-limit and auth handling can be tested deterministically.
 */
export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  appProperties: Record<string, string>;
  content?: Buffer;
  modifiedTime: string;
  createdTime: string;
}

export type FailureSpec = { status?: number; reason?: string; code?: string; message?: string; retryAfter?: string };

const FOLDER = "application/vnd.google-apps.folder";

function httpError(spec: FailureSpec): Error {
  const error = new Error(spec.message ?? `HTTP ${spec.status ?? "network"}`) as Error & Record<string, unknown>;
  if (spec.code) error.code = spec.code;
  if (spec.status) {
    error.status = spec.status;
    error.response = {
      status: spec.status,
      headers: spec.retryAfter ? { "retry-after": spec.retryAfter } : {},
      data: spec.reason === "invalid_grant" ? { error: "invalid_grant" } : { error: { errors: spec.reason ? [{ reason: spec.reason }] : [] } },
    };
  }
  return error;
}

async function readBody(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export class FakeDrive {
  files = new Map<string, FakeFile>();
  calls: { method: string; params: Record<string, unknown> }[] = [];
  /** Queue of failures per method name, consumed one per call. */
  failures = new Map<string, FailureSpec[]>();
  /** Persistent, predicate-based failure (e.g. "always reject this file name"). */
  failWhen?: (method: string, params: Record<string, unknown>) => FailureSpec | undefined;
  /** When set, `create` stores the file and *then* throws, simulating a lost response. */
  loseNextCreateResponse = false;
  private seq = 0;
  private clock = Date.parse("2026-01-01T00:00:00Z");

  constructor() {
    this.files.set("root", this.make({ id: "root", name: "My Drive", mimeType: FOLDER, parents: [] }));
  }

  private make(partial: Partial<FakeFile> & { id: string; name: string }): FakeFile {
    const time = new Date((this.clock += 1000)).toISOString();
    return {
      mimeType: "application/octet-stream",
      parents: [],
      trashed: false,
      appProperties: {},
      modifiedTime: time,
      createdTime: time,
      ...partial,
    };
  }

  failNext(method: string, ...specs: FailureSpec[]): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), ...specs]);
  }

  private maybeFail(method: string, params: Record<string, unknown> = {}): void {
    const persistent = this.failWhen?.(method, params);
    if (persistent) throw httpError(persistent);
    const queue = this.failures.get(method);
    const next = queue?.shift();
    if (next) throw httpError(next);
  }

  addFolder(name: string, parent = "root"): string {
    const id = `folder-${++this.seq}`;
    this.files.set(id, this.make({ id, name, mimeType: FOLDER, parents: [parent] }));
    return id;
  }

  addFile(partial: Partial<FakeFile> & { name: string }): string {
    const id = partial.id ?? `file-${++this.seq}`;
    this.files.set(id, this.make({ ...partial, id }));
    return id;
  }

  /** Non-folder files in a folder (default: all non-trashed files). */
  filesIn(folderId: string, includeTrashed = false): FakeFile[] {
    return [...this.files.values()].filter(
      (f) => f.mimeType !== FOLDER && f.parents.includes(folderId) && (includeTrashed || !f.trashed),
    );
  }

  folderByName(name: string): FakeFile | undefined {
    return [...this.files.values()].find((f) => f.mimeType === FOLDER && f.name === name && !f.trashed);
  }

  private matches(file: FakeFile, q: string): boolean {
    for (const clause of q.split(" and ")) {
      const c = clause.trim();
      let m: RegExpExecArray | null;
      if ((m = /^'(.+)' in parents$/.exec(c))) {
        if (!file.parents.includes(m[1] as string)) return false;
      } else if (c === "trashed = false") {
        if (file.trashed) return false;
      } else if ((m = /^name = '(.+)'$/.exec(c))) {
        if (file.name !== (m[1] as string).replace(/\\'/g, "'").replace(/\\\\/g, "\\")) return false;
      } else if ((m = /^mimeType = '(.+)'$/.exec(c))) {
        if (file.mimeType !== m[1]) return false;
      } else if ((m = /^mimeType != '(.+)'$/.exec(c))) {
        if (file.mimeType === m[1]) return false;
      } else if ((m = /^appProperties has \{ key='(.+)'$/.exec(c))) {
        // handled together with the following "value=" clause
        const key = m[1] as string;
        const value = /value='([^']*)' \}/.exec(q)?.[1];
        if (file.appProperties[key] !== value) return false;
      } else if (/^value='/.test(c)) {
        // consumed above
      } else {
        throw new Error(`FakeDrive: unsupported query clause: ${c}`);
      }
    }
    return true;
  }

  private view(file: FakeFile): drive_v3.Schema$File {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      parents: [...file.parents],
      trashed: file.trashed,
      modifiedTime: file.modifiedTime,
      createdTime: file.createdTime,
      appProperties: { ...file.appProperties },
    };
  }

  private touch(file: FakeFile): void {
    file.modifiedTime = new Date((this.clock += 1000)).toISOString();
  }

  /** The object handed to GoogleDriveStore in place of the real client. */
  api(): drive_v3.Drive {
    const files = {
      list: async (params: drive_v3.Params$Resource$Files$List) => {
        this.calls.push({ method: "list", params: { ...params } });
        this.maybeFail("list");
        let matched = [...this.files.values()].filter((f) => f.id !== "root" && this.matches(f, params.q ?? ""));
        if (params.orderBy === "createdTime") matched.sort((a, b) => a.createdTime.localeCompare(b.createdTime));
        const pageSize = params.pageSize ?? 100;
        const offset = params.pageToken ? Number(params.pageToken) : 0;
        const page = matched.slice(offset, offset + pageSize);
        matched = page;
        const next = offset + pageSize < [...this.files.values()].filter((f) => f.id !== "root" && this.matches(f, params.q ?? "")).length
          ? String(offset + pageSize)
          : undefined;
        return { data: { files: matched.map((f) => this.view(f)), nextPageToken: next } };
      },
      get: async (params: drive_v3.Params$Resource$Files$Get) => {
        this.calls.push({ method: "get", params: { ...params } });
        this.maybeFail("get");
        const file = this.files.get(params.fileId as string);
        if (!file) throw httpError({ status: 404, reason: "notFound" });
        return { data: this.view(file) };
      },
      create: async (params: drive_v3.Params$Resource$Files$Create) => {
        this.calls.push({ method: "create", params: { ...params } });
        this.maybeFail("create", { ...params });
        const body = params.requestBody ?? {};
        const id = `file-${++this.seq}`;
        const file = this.make({
          id,
          name: body.name ?? "",
          mimeType: body.mimeType ?? "application/octet-stream",
          parents: body.parents ?? [],
          appProperties: { ...((body.appProperties ?? {}) as Record<string, string>) },
          content: params.media?.body ? await readBody(params.media.body) : undefined,
        });
        this.files.set(id, file);
        if (this.loseNextCreateResponse) {
          this.loseNextCreateResponse = false;
          throw httpError({ code: "ECONNRESET", message: "socket hang up" });
        }
        return { data: this.view(file) };
      },
      update: async (params: drive_v3.Params$Resource$Files$Update) => {
        this.calls.push({ method: "update", params: { ...params } });
        this.maybeFail("update");
        const file = this.files.get(params.fileId as string);
        if (!file) throw httpError({ status: 404, reason: "notFound" });
        const body = params.requestBody ?? {};
        if (body.name) file.name = body.name;
        if (body.appProperties) file.appProperties = { ...file.appProperties, ...(body.appProperties as Record<string, string>) };
        if (body.trashed !== undefined && body.trashed !== null) file.trashed = body.trashed;
        if (params.media?.body) file.content = await readBody(params.media.body);
        if (params.removeParents) file.parents = file.parents.filter((p) => !params.removeParents!.split(",").includes(p));
        if (params.addParents) file.parents.push(...params.addParents.split(","));
        this.touch(file);
        return { data: this.view(file) };
      },
      delete: async (params: drive_v3.Params$Resource$Files$Delete) => {
        this.calls.push({ method: "delete", params: { ...params } });
        this.maybeFail("delete");
        if (!this.files.delete(params.fileId as string)) throw httpError({ status: 404, reason: "notFound" });
        return { data: {} };
      },
    };
    const about = {
      get: async () => {
        this.maybeFail("about");
        return { data: { user: { emailAddress: "tester@example.com" } } };
      },
    };
    return { files, about } as unknown as drive_v3.Drive;
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}
