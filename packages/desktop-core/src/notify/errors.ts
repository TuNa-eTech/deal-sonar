// Port of `NotifyError` (crates/notify/src/types.rs). Tokens and signing secrets are never stored
// unredacted in error messages.

import { CoreError } from "../backend/wire";

export type NotifyErrorKind =
  | "invalid_permalink"
  | "invalid_callback_data"
  | "telegram_http"
  | "telegram_api"
  | "insecure_webhook_url"
  | "webhook_http"
  | "serialization"
  | "xlsx";

export class NotifyError extends Error {
  readonly kind: NotifyErrorKind;
  readonly errorCode: number | null;
  readonly retryAfterS: number | null;

  constructor(kind: NotifyErrorKind, message: string, errorCode: number | null = null, retryAfterS: number | null = null) {
    super(message);
    this.name = "NotifyError";
    this.kind = kind;
    this.errorCode = errorCode;
    this.retryAfterS = retryAfterS;
  }

  static invalidPermalink(raw: string): NotifyError {
    return new NotifyError("invalid_permalink", `invalid permalink (must be a valid https:// URL): ${raw}`);
  }
  static invalidCallbackData(len: number): NotifyError {
    return new NotifyError(
      "invalid_callback_data",
      `telegram callback_data exceeds <64 byte limit (${len} bytes) or is invalid`,
    );
  }
  static telegramHttp(reason: string): NotifyError {
    return new NotifyError("telegram_http", `telegram HTTP failure: ${reason}`);
  }
  static telegramApi(errorCode: number, description: string, retryAfterS: number | null): NotifyError {
    return new NotifyError(
      "telegram_api",
      `telegram API error (code ${errorCode}): ${description}`,
      errorCode,
      retryAfterS,
    );
  }
  static insecureWebhookUrl(raw: string): NotifyError {
    return new NotifyError(
      "insecure_webhook_url",
      `insecure or invalid webhook URL (must be https:// or http://localhost / http://127.0.0.1): ${raw}`,
    );
  }
  static webhookHttp(reason: string): NotifyError {
    return new NotifyError("webhook_http", `webhook delivery failed: ${reason}`);
  }
  static serialization(reason: string): NotifyError {
    return new NotifyError("serialization", `serialization error: ${reason}`);
  }
  static xlsx(reason: string): NotifyError {
    return new NotifyError("xlsx", `xlsx export error: ${reason}`);
  }
}

/** `CoreError::Notify` (`lỗi thông báo / xuất dữ liệu: ...`, code `notify_error`). */
export function notifyToCoreError(err: NotifyError): CoreError {
  return new CoreError("notify", `lỗi thông báo / xuất dữ liệu: ${err.message}`);
}

/** `CoreError::Ai` (`lỗi AI Bridge: ...`, code `ai_error`). */
export function aiToCoreError(message: string): CoreError {
  return new CoreError("ai", `lỗi AI Bridge: ${message}`);
}
