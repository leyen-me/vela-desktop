import type {
    SuggestedAction,
    ToolErrorCode,
    ToolErrorPayload,
    ToolFailure,
    ToolMeta,
    ToolResult,
    ToolSuccess,
} from './types.ts';

export class DomainError extends Error {
    readonly code: ToolErrorCode;
    readonly retryable: boolean;
    readonly details?: Record<string, unknown>;
    readonly suggestedAction?: SuggestedAction;

    constructor(
        code: ToolErrorCode,
        message: string,
        options: {
            retryable?: boolean;
            details?: Record<string, unknown>;
            suggestedAction?: SuggestedAction;
            cause?: unknown;
        } = {},
    ) {
        super(message, { cause: options.cause });
        this.name = 'DomainError';
        this.code = code;
        this.retryable = options.retryable ?? false;
        this.details = options.details;
        this.suggestedAction = options.suggestedAction;
    }

    toPayload(): ToolErrorPayload {
        return {
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            ...(this.details ? { details: this.details } : {}),
            ...(this.suggestedAction ? { suggestedAction: this.suggestedAction } : {}),
        };
    }
}

export function success<T>(tool: string, data: T, meta: ToolMeta = {}, warnings: string[] = []): ToolSuccess<T> {
    return { version: 1, ok: true, tool, data, warnings, meta };
}

export function failure(tool: string, error: ToolErrorPayload, meta: ToolMeta = {}): ToolFailure {
    return { version: 1, ok: false, tool, error, meta };
}

export function fromError(tool: string, error: unknown, meta: ToolMeta = {}): ToolFailure {
    if (error instanceof DomainError) return failure(tool, error.toPayload(), meta);
    const message = error instanceof Error ? error.message : String(error);
    return failure(
        tool,
        {
            code: 'INTERNAL',
            message,
            retryable: false,
            suggestedAction: 'stop',
        },
        meta,
    );
}

export function result<T>(tool: string, fn: () => T, meta: ToolMeta = {}): ToolResult<T> {
    try {
        return success(tool, fn(), meta);
    } catch (error) {
        return fromError(tool, error, meta);
    }
}

export async function asyncResult<T>(
    tool: string,
    fn: () => Promise<T>,
    meta: ToolMeta = {},
): Promise<ToolResult<T>> {
    try {
        return success(tool, await fn(), meta);
    } catch (error) {
        return fromError(tool, error, meta);
    }
}

export function unwrap<T>(toolResult: ToolResult<T>): T {
    if (!toolResult.ok) {
        throw new DomainError(toolResult.error.code, toolResult.error.message, {
            retryable: toolResult.error.retryable,
            details: toolResult.error.details,
            suggestedAction: toolResult.error.suggestedAction,
        });
    }
    return toolResult.data;
}
