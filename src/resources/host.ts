import { apiPath, type CoveHttp, type RequestOverrides } from "../http.js";
import type {
  AdmissionStatus,
  CapacityReport,
  HostTelemetrySeries,
  ImagesResponse,
  ReservationRef,
  SystemStatus,
  TelemetryParams,
  TryReserveBody,
} from "../types.js";

/** `client.host` — fleet status, capacity check, capacity, reservations, images. */
export class HostResource {
  constructor(private readonly http: CoveHttp) {}

  /**
   * Fleet status (admin only). Scope: `vms:read`.
   * Non-admin callers get a **403** with a plain-text body `admin only`
   * (not the `ApiError` JSON envelope).
   */
  systemStatus(overrides: RequestOverrides = {}): Promise<SystemStatus> {
    return this.http.request<SystemStatus>("GET", apiPath`/api/system/status`, overrides);
  }

  /** Capacity check (capacity + user quotas + recent denies). Scope: `vms:read`. */
  capacityCheck(overrides: RequestOverrides = {}): Promise<AdmissionStatus> {
    return this.http.request<AdmissionStatus>(
      "GET",
      apiPath`/api/host/capacity-check`,
      overrides,
    );
  }

  /** Capacity report. Scope: `vms:read`. */
  capacity(overrides: RequestOverrides = {}): Promise<CapacityReport> {
    return this.http.request<CapacityReport>("GET", apiPath`/api/host/capacity`, overrides);
  }

  /**
   * Try to reserve capacity for a pending action. Scope: `vms:write`.
   * On admission denial, throws `CoveAPIError` (status 409) whose `.body`
   * is a `DenyReason` object rather than an `ApiError`.
   */
  reserve(
    req: TryReserveBody,
    overrides: RequestOverrides = {},
  ): Promise<ReservationRef> {
    return this.http.request<ReservationRef>("POST", apiPath`/api/host/reservations`, {
      ...overrides,
      body: req,
    });
  }

  /** Release a reservation. Scope: `vms:write`. */
  releaseReservation(id: string, overrides: RequestOverrides = {}): Promise<void> {
    return this.http.request<void>(
      "DELETE",
      apiPath`/api/host/reservations/${id}`,
      overrides,
    );
  }

  /** Host telemetry time series. Scope: `vms:read`. */
  telemetry(
    params: TelemetryParams = {},
    overrides: RequestOverrides = {},
  ): Promise<HostTelemetrySeries> {
    return this.http.request<HostTelemetrySeries>("GET", apiPath`/api/host/telemetry`, {
      ...overrides,
      query: { from: params.from, to: params.to, step: params.step, limit: params.limit },
    });
  }

  /** Available golden images and OCI cache. Scope: `vms:read`. */
  images(overrides: RequestOverrides = {}): Promise<ImagesResponse> {
    return this.http.request<ImagesResponse>("GET", apiPath`/api/images`, overrides);
  }
}
