import { apiPath, type CoveHttp, type RequestOverrides } from "../http.js";
import type {
  ListWebhookDeliveriesParams,
  ListWebhooksParams,
  ReplayWebhookDeliveryResponse,
  RotateWebhookSecretResponse,
  TestDeliveryResult,
  WebhookCreateInput,
  WebhookDelivery,
  WebhookDeliveryPage,
  WebhookSubscription,
  WebhookUpdateInput,
} from "../types.js";

/**
 * `client.webhooks` — lifecycle webhook subscriptions and deliveries.
 * All mutations return **503 `feature_disabled`** when `[webhooks] enabled
 * = false`.
 */
export class WebhooksResource {
  constructor(private readonly http: CoveHttp) {}

  /** List webhook subscriptions (secret always null). Scope: `admin`. */
  list(
    params: ListWebhooksParams = {},
    overrides: RequestOverrides = {},
  ): Promise<WebhookSubscription[]> {
    return this.http.request<WebhookSubscription[]>("GET", apiPath`/api/webhooks`, {
      ...overrides,
      query: { scope: params.scope, vm_id: params.vm_id },
    });
  }

  /**
   * Create a webhook subscription. Scope: `admin`.
   * The `secret` (`whsec_<64 hex>`) is returned exactly once here (and on
   * `rotateSecret`). 503 `feature_disabled` when disabled.
   */
  create(
    req: WebhookCreateInput,
    overrides: RequestOverrides = {},
  ): Promise<WebhookSubscription> {
    return this.http.request<WebhookSubscription>("POST", apiPath`/api/webhooks`, {
      ...overrides,
      body: req,
    });
  }

  /** Get a webhook subscription (secret null). Scope: `admin`. */
  get(id: string, overrides: RequestOverrides = {}): Promise<WebhookSubscription> {
    return this.http.request<WebhookSubscription>(
      "GET",
      apiPath`/api/webhooks/${id}`,
      overrides,
    );
  }

  /**
   * Update a webhook subscription (partial). Scope: `admin`.
   * Omitted fields are left unchanged. For `tag_filter`, `allowed_subnets`
   * and `description`, an explicit JSON `null` is indistinguishable from
   * omission — there is no wire-level way to clear these fields.
   */
  update(
    id: string,
    req: WebhookUpdateInput,
    overrides: RequestOverrides = {},
  ): Promise<WebhookSubscription> {
    return this.http.request<WebhookSubscription>("PUT", apiPath`/api/webhooks/${id}`, {
      ...overrides,
      body: req,
    });
  }

  /** Delete a webhook subscription (cascades outbox rows). Scope: `admin`. */
  delete(id: string, overrides: RequestOverrides = {}): Promise<void> {
    return this.http.request<void>("DELETE", apiPath`/api/webhooks/${id}`, overrides);
  }

  /**
   * Rotate the signing secret. Scope: `admin`.
   * The old secret stays valid for the configured dual-signing grace
   * window.
   */
  rotateSecret(
    id: string,
    overrides: RequestOverrides = {},
  ): Promise<RotateWebhookSecretResponse> {
    return this.http.request<RotateWebhookSecretResponse>(
      "POST",
      apiPath`/api/webhooks/${id}/rotate`,
      overrides,
    );
  }

  /** Fire a test delivery. Scope: `admin`. */
  test(id: string, overrides: RequestOverrides = {}): Promise<TestDeliveryResult> {
    return this.http.request<TestDeliveryResult>(
      "POST",
      apiPath`/api/webhooks/${id}/test`,
      overrides,
    );
  }

  /** Disable a subscription. Scope: `admin`. */
  disable(id: string, overrides: RequestOverrides = {}): Promise<WebhookSubscription> {
    return this.http.request<WebhookSubscription>(
      "POST",
      apiPath`/api/webhooks/${id}/disable`,
      overrides,
    );
  }

  /** Re-enable a subscription (resets failure count). Scope: `admin`. */
  enable(id: string, overrides: RequestOverrides = {}): Promise<WebhookSubscription> {
    return this.http.request<WebhookSubscription>(
      "POST",
      apiPath`/api/webhooks/${id}/enable`,
      overrides,
    );
  }

  /** List deliveries (cursor-paginated). Scope: `admin`. */
  listDeliveries(
    id: string,
    params: ListWebhookDeliveriesParams = {},
    overrides: RequestOverrides = {},
  ): Promise<WebhookDeliveryPage> {
    return this.http.request<WebhookDeliveryPage>(
      "GET",
      apiPath`/api/webhooks/${id}/deliveries`,
      {
        ...overrides,
        query: { cursor: params.cursor, limit: params.limit, state: params.state },
      },
    );
  }

  /**
   * Iterate every delivery matching `params`, transparently following
   * `next_cursor` across pages. Scope: `admin`.
   */
  async *iterDeliveries(
    id: string,
    params: ListWebhookDeliveriesParams = {},
    overrides: RequestOverrides = {},
  ): AsyncGenerator<WebhookDelivery> {
    let cursor = params.cursor;
    for (;;) {
      const page = await this.listDeliveries(id, { ...params, cursor }, overrides);
      for (const delivery of page.deliveries) yield delivery;
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  /** Get one delivery. Scope: `admin`. */
  getDelivery(
    id: string,
    deliveryId: string,
    overrides: RequestOverrides = {},
  ): Promise<WebhookDelivery> {
    return this.http.request<WebhookDelivery>(
      "GET",
      apiPath`/api/webhooks/${id}/deliveries/${deliveryId}`,
      overrides,
    );
  }

  /**
   * Replay a delivery (fresh delivery id, same `ce_id`). Scope: `admin`.
   * Returns 202 — the replay is enqueued, not delivered synchronously.
   */
  replayDelivery(
    id: string,
    deliveryId: string,
    overrides: RequestOverrides = {},
  ): Promise<ReplayWebhookDeliveryResponse> {
    return this.http.request<ReplayWebhookDeliveryResponse>(
      "POST",
      apiPath`/api/webhooks/${id}/deliveries/${deliveryId}/replay`,
      overrides,
    );
  }
}
