/**
 * Fixtures de payloads Meta — capturados de docs oficiais e da própria
 * sandbox. Usados em E2E e em unit tests do inbound webhook.
 *
 * NOTA: nenhum payload aqui contém dados pessoais reais; tudo é dummy.
 */

export const whatsappTextMessageReceived = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA-FIXTURE-1",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "+5511999990000",
              phone_number_id: "PHONE-FIXTURE-1",
            },
            contacts: [{ profile: { name: "Fixture User" }, wa_id: "5511988887777" }],
            messages: [
              {
                from: "5511988887777",
                id: "wamid.FIXTURE-001",
                timestamp: "1714003200",
                type: "text",
                text: { body: "Olá fixture" },
              },
            ],
          },
        },
      ],
    },
  ],
};

export const whatsappStatusUpdated = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA-FIXTURE-1",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "+5511999990000",
              phone_number_id: "PHONE-FIXTURE-1",
            },
            statuses: [
              {
                id: "wamid.FIXTURE-001",
                status: "delivered",
                timestamp: "1714003205",
                recipient_id: "5511988887777",
              },
            ],
          },
        },
      ],
    },
  ],
};

export const templateStatusUpdate = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA-FIXTURE-1",
      changes: [
        {
          field: "message_template_status_update",
          value: {
            event: "APPROVED",
            message_template_id: "tpl-FIXTURE-1",
            message_template_name: "welcome_message",
            message_template_language: "pt_BR",
          },
        },
      ],
    },
  ],
};

export const instagramMessageReceived = {
  object: "instagram",
  entry: [
    {
      id: "IG-FIXTURE-1",
      time: 1714003200,
      messaging: [
        {
          sender: { id: "ig-user-1" },
          recipient: { id: "IG-FIXTURE-1" },
          timestamp: 1714003200,
          message: { mid: "ig-mid-FIXTURE-001", text: "olá ig fixture" },
        },
      ],
    },
  ],
};
