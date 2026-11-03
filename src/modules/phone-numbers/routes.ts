import type { FastifyInstance } from "fastify";

import {
  phoneListParamSchema,
  phoneProfileParamSchema,
  updateProfileBodySchema,
} from "./schemas.js";
import { listPhoneNumbers, updatePhoneProfile } from "./service.js";

export async function phoneNumbersRoutes(app: FastifyInstance): Promise<void> {
  // ----- GET /v1/tenants/:tenant_id/wabas/:waba_id/phone-numbers -----
  app.get(
    "/v1/tenants/:tenant_id/wabas/:waba_id/phone-numbers",
    {
      preHandler: [app.requireAuth({ scopes: ["phone-numbers:read"] }), app.requireRateLimit()],
    },
    async (req) => {
      const { tenant_id, waba_id } = phoneListParamSchema.parse(req.params);
      const items = await listPhoneNumbers(req.auth!.appId, tenant_id, waba_id);
      return { data: items };
    },
  );

  // ----- POST /v1/tenants/:tenant_id/wabas/:waba_id/phone-numbers/:phone_id/profile -----
  app.post(
    "/v1/tenants/:tenant_id/wabas/:waba_id/phone-numbers/:phone_id/profile",
    {
      preHandler: [
        app.requireAuth({ scopes: ["phone-numbers:write"] }),
        app.requireRateLimit(),
        app.requireIdempotency(),
      ],
    },
    async (req) => {
      const { tenant_id, waba_id, phone_id } = phoneProfileParamSchema.parse(req.params);
      const body = updateProfileBodySchema.parse(req.body);
      return updatePhoneProfile({
        appId: req.auth!.appId,
        tenantId: tenant_id,
        wabaId: waba_id,
        metaPhoneId: phone_id,
        patch: body,
      });
    },
  );
}
