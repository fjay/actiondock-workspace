export class WorkspaceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number = 400) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.status = status;
  }
}
