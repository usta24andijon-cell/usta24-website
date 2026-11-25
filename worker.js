
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Telegram-Bot-Api-Secret-Token"
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });

const money = value => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
};

const normalizePhone = (phone = "") => {
  let value = String(phone).replace(/\D/g, "");

  if (value.startsWith("00")) value = value.slice(2);
  if (value.length === 9) value = "998" + value;

  return value;
};

const safeString = (value, max = 2000) =>
  String(value ?? "").trim().slice(0, max);

async function readBody(request) {
  try {
    const data = await request.json();
    return data && typeof data === "object" && !Array.isArray(data)
      ? data
      : {};
  } catch {
    return {};
  }
}

async function telegram(token, chatId, text, extra = {}) {
  if (!token || !chatId) return null;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: String(text).slice(0, 4000),
          ...extra
        })
      }
    );

    const result = await response.json();
    return result?.ok ? result : null;

  } catch (error) {
    console.error("Telegram yuborish xatosi:", error);
    return null;
  }
}

async function answerCallback(token, callbackId, text) {
  if (!token || !callbackId) return;

  try {
    await fetch(
      `https://api.telegram.org/bot${token}/answerCallbackQuery`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callbackId,
          text: safeString(text, 180)
        })
      }
    );
  } catch (error) {
    console.error("Callback xatosi:", error);
  }
}

const adminTelegram = (env, message) =>
  telegram(
    env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_CHAT_ID || env.USTA24_CHAT_ID,
    message
  );

async function notifyCustomer(env, phone, message) {
  const normalized = normalizePhone(phone);
  if (!normalized || !env.CUSTOMER_BOT_TOKEN) return false;

  try {
    const customer = await env.DB.prepare(
      "SELECT chat_id FROM customer_telegram WHERE phone = ?"
    ).bind(normalized).first();

    if (!customer?.chat_id) return false;

    return Boolean(
      await telegram(env.CUSTOMER_BOT_TOKEN, customer.chat_id, message)
    );
  } catch (error) {
    console.error("Mijozga xabar yuborish xatosi:", error);
    return false;
  }
}

async function notifyWorker(env, workerPhone, message, keyboard) {
  const normalized = normalizePhone(workerPhone);

  if (!normalized || !env.WORKER_BOT_TOKEN) return false;

  try {
    // Eski telefon raqamlari turli formatda saqlangan bo‘lishi mumkin.
    const result = await env.DB.prepare(
      "SELECT phone, telegram_chat_id FROM ustalar WHERE status = 'Faol'"
    ).all();

    const worker = (result.results || []).find(
      item => normalizePhone(item.phone) === normalized
    );

    if (!worker?.telegram_chat_id) return false;

    return Boolean(
      await telegram(
        env.WORKER_BOT_TOKEN,
        worker.telegram_chat_id,
        message,
        keyboard ? { reply_markup: keyboard } : {}
      )
    );
  } catch (error) {
    console.error("Ustaga xabar yuborish xatosi:", error);
    return false;
  }
}


// 10% KOMISSIYA
// Faqat yangi tugallangan buyurtmaga hisoblanadi.

async function createFinance(db, orderId, price) {
  const amount = money(price);

  if (amount <= 0) {
    throw new Error("Buyurtma narxi kiritilmagan.");
  }

  const commission = Math.round(amount * 0.10);

  await db.prepare(`
    INSERT OR IGNORE INTO order_finances
    (
      order_id,
      order_price,
      commission_rate,
      commission_amount,
      payment_status,
      payment_method
    )
    VALUES (?, ?, 10, ?, 'Kutilmoqda', 'Naqd')
  `).bind(orderId, amount, commission).run();
}


function checkAdmin(request, env) {
  const password = env.ADMIN_PASSWORD;
  const auth = request.headers.get("Authorization") || "";

  return Boolean(password && auth === `Bearer ${password}`);
}

async function requireAdmin(request, env) {
  if (!checkAdmin(request, env)) {
    return json({
      success: false,
      message: "Ruxsat yo‘q. Administrator parolini tekshiring."
    }, 401);
  }

  return null;
}


// TELEGRAM WEBHOOK SECRET TEKSHIRISH

function validWebhook(request, env, secretName) {
  const secret = env[secretName];

  // Eski webhook sozlamalarini buzmaslik uchun:
  // secret mavjud bo‘lsa, tekshiriladi.
  if (!secret) return true;

  return request.headers.get(
    "X-Telegram-Bot-Api-Secret-Token"
  ) === secret;
}


// USTA TELEGRAM BOTI

async function handleWorkerWebhook(request, env) {
  if (!validWebhook(request, env, "WORKER_BOT_WEBHOOK_SECRET")) {
    return json({ success: false, message: "Webhook ruxsati yo‘q." }, 401);
  }

  const update = await readBody(request);
  const message = update.message;
  const callback = update.callback_query;
  const token = env.WORKER_BOT_TOKEN;

  if (!token) {
    console.error("WORKER_BOT_TOKEN sozlanmagan.");
    return json({ success: false }, 500);
  }

  // /start
  if (message?.text === "/start") {
    await telegram(
      token,
      message.chat.id,
      "Assalomu alaykum! USTA24 ustalar botiga xush kelibsiz.\n\n" +
      "Ro‘yxatdan o‘tish uchun telefon raqamingizni yuboring.",
      {
        reply_markup: {
          keyboard: [[{
            text: "📱 Telefon raqamni yuborish",
            request_contact: true
          }]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );

    return json({ success: true });
  }

  // Telefon raqam orqali ustani aniqlash
  if (message?.contact) {
    const contact = message.contact;
    const senderId = message.from?.id;

    if (
      contact.user_id &&
      Number(contact.user_id) !== Number(senderId)
    ) {
      await telegram(
        token,
        message.chat.id,
        "Iltimos, o‘zingizning telefon raqamingizni yuboring."
      );

      return json({ success: true });
    }

    const phone = normalizePhone(contact.phone_number);

    const result = await env.DB.prepare(
      "SELECT id, name, phone FROM ustalar WHERE status = 'Faol'"
    ).all();

    const worker = (result.results || []).find(
      item => normalizePhone(item.phone) === phone
    );

    if (!worker) {
      await telegram(
        token,
        message.chat.id,
        "Siz USTA24 tizimida faol usta sifatida topilmadingiz. Administrator bilan bog‘laning."
      );

      return json({ success: true });
    }

    await env.DB.prepare(
      "UPDATE ustalar SET telegram_chat_id = ? WHERE id = ?"
    ).bind(String(message.chat.id), worker.id).run();

    await telegram(
      token,
      message.chat.id,
      `Assalomu alaykum, ${worker.name}!\nTelegram hisobingiz USTA24 tizimiga ulandi.`
    );

    return json({ success: true });
  }

  // Buyurtma tugmalari
  if (callback?.data) {
    const parts = callback.data.split(":");
    const action = parts[1];
    const orderId = Number(parts[2]);
    const chatId = callback.message?.chat?.id;

    if (
      parts[0] !== "w" ||
      !["accept", "start", "done"].includes(action) ||
      !Number.isInteger(orderId) ||
      orderId <= 0 ||
      !chatId
    ) {
      await answerCallback(token, callback.id, "Noto‘g‘ri buyruq.");
      return json({ success: true });
    }

    const workerResult = await env.DB.prepare(
      "SELECT id, name, phone FROM ustalar WHERE telegram_chat_id = ? AND status = 'Faol'"
    ).bind(String(chatId)).first();

    if (!workerResult) {
      await answerCallback(token, callback.id, "Usta topilmadi.");
      return json({ success: true });
    }

    const order = await env.DB.prepare(
      "SELECT * FROM orders WHERE id = ?"
    ).bind(orderId).first();

    if (!order) {
      await answerCallback(token, callback.id, "Buyurtma topilmadi.");
      return json({ success: true });
    }

    if (
      normalizePhone(order.worker_phone) !==
      normalizePhone(workerResult.phone)
    ) {
      await answerCallback(
        token,
        callback.id,
        "Bu buyurtma sizga biriktirilmagan."
      );

      return json({ success: true });
    }

    const transitions = {
      accept: {
        from: "Ustaga biriktirildi",
        to: "Qabul qilindi",
        message: "Buyurtmani qabul qildingiz."
      },
      start: {
        from: "Qabul qilindi",
        to: "Bajarilmoqda",
        message: "Buyurtma bajarilishi boshlandi."
      },
      done: {
        from: "Bajarilmoqda",
        to: "Tugallandi",
        message: "Buyurtma yakunlandi."
      }
    };

    const transition = transitions[action];

    if (order.status !== transition.from) {
      await answerCallback(
        token,
        callback.id,
        `Buyurtma holati mos emas: ${order.status}`
      );

      return json({ success: true });
    }

    if (action === "done" && money(order.price) <= 0) {
      await answerCallback(
        token,
        callback.id,
        "Administrator buyurtma narxini kiritishi kerak."
      );

      return json({ success: true });
    }

    // Holatni faqat kutilgan eski holat bo‘lsa o‘zgartiramiz.
    const updateResult = await env.DB.prepare(
      "UPDATE orders SET status = ? WHERE id = ? AND status = ?"
    ).bind(transition.to, orderId, transition.from).run();

    if (!updateResult.meta?.changes) {
      await answerCallback(
        token,
        callback.id,
        "Buyurtma holati boshqa foydalanuvchi tomonidan o‘zgartirilgan."
      );

      return json({ success: true });
    }

    if (action === "done") {
      await createFinance(env.DB, orderId, order.price);
    }

    await answerCallback(token, callback.id, transition.message);

    const statusMessage =
      `USTA24 buyurtma #${orderId}\nHolati: ${transition.to}`;

    await adminTelegram(env, statusMessage);
    await notifyCustomer(env, order.phone, statusMessage);

    if (action === "accept") {
      await telegram(
        token,
        chatId,
        "Buyurtma qabul qilindi. Ishni boshlaganingizda tugmani bosing.",
        {
          reply_markup: {
            inline_keyboard: [[{
              text: "▶️ Ishni boshlash",
              callback_data: `w:start:${orderId}`
            }]]
          }
        }
      );
    } else if (action === "start") {
      await telegram(
        token,
        chatId,
        "Ish boshlandi. Tugatganingizda quyidagi tugmani bosing.",
        {
          reply_markup: {
            inline_keyboard: [[{
              text: "✅ Ishni tugatish",
              callback_data: `w:done:${orderId}`
            }]]
          }
        }
      );
    } else {
      const amount = money(order.price);
      const commission = Math.round(amount * 0.10);

      await telegram(
        token,
        chatId,
        `Buyurtma tugallandi.\n` +
        `Buyurtma narxi: ${amount.toLocaleString("uz-UZ")} so‘m\n` +
        `USTA24 komissiyasi (10%): ${commission.toLocaleString("uz-UZ")} so‘m\n` +
        `Ustaga qoladi: ${(amount - commission).toLocaleString("uz-UZ")} so‘m`
      );
    }

    return json({ success: true });
  }

  return json({ success: true });
}


// MIJOZ TELEGRAM BOTI

async function handleCustomerWebhook(request, env) {
  if (!validWebhook(request, env, "CUSTOMER_BOT_WEBHOOK_SECRET")) {
    return json({ success: false, message: "Webhook ruxsati yo‘q." }, 401);
  }

  const update = await readBody(request);
  const message = update.message;
  const token = env.CUSTOMER_BOT_TOKEN;

  if (!token) {
    console.error("CUSTOMER_BOT_TOKEN sozlanmagan.");
    return json({ success: false }, 500);
  }

  if (message?.text === "/start") {
    await telegram(
      token,
      message.chat.id,
      "Assalomu alaykum! USTA24 mijozlar botiga xush kelibsiz.\n\n" +
      "Buyurtma holati haqida xabar olish uchun telefon raqamingizni yuboring.",
      {
        reply_markup: {
          keyboard: [[{
            text: "📱 Telefon raqamni yuborish",
            request_contact: true
          }]],
          resize_keyboard: true,
          one_time_keyboard: true
        }
      }
    );

    return json({ success: true });
  }

  if (message?.contact) {
    const contact = message.contact;

    if (
      contact.user_id &&
      Number(contact.user_id) !== Number(message.from?.id)
    ) {
      await telegram(
        token,
        message.chat.id,
        "Iltimos, o‘zingizning telefon raqamingizni yuboring."
      );

      return json({ success: true });
    }

    const phone = normalizePhone(contact.phone_number);
    const name = safeString(message.from?.first_name || "Mijoz", 100);

    await env.DB.prepare(`
      INSERT INTO customer_telegram (phone, chat_id, customer_name)
      VALUES (?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        chat_id = excluded.chat_id,
        customer_name = excluded.customer_name
    `).bind(
      phone,
      String(message.chat.id),
      name
    ).run();

    await telegram(
      token,
      message.chat.id,
      "Rahmat! Telegram hisobingiz USTA24 tizimiga ulandi. Buyurtmangiz holati haqida xabar beramiz."
    );
  }

  return json({ success: true });
}


// SAYTDAN YANGI BUYURTMA

async function handleOrder(request, env) {
  const body = await readBody(request);

  const name = safeString(body.name, 100);
  const phone = safeString(body.phone, 25);
  const service = safeString(body.service, 150);
  const address = safeString(body.address, 250);
  const details = safeString(body.details, 2000);

  if (!name || !phone || !service || !address) {
    return json({
      success: false,
      message: "Ism, telefon, xizmat va manzilni kiriting."
    }, 400);
  }

  if (normalizePhone(phone).length < 9) {
    return json({
      success: false,
      message: "Telefon raqamini tekshiring."
    }, 400);
  }

  const result = await env.DB.prepare(`
    INSERT INTO orders
    (name, phone, service, address, details, status, source)
    VALUES (?, ?, ?, ?, ?, 'Yangi', 'Veb-sayt')
  `).bind(
    name,
    phone,
    service,
    address,
    details
  ).run();

  const orderId = result.meta?.last_row_id || null;

  const sent = await adminTelegram(
    env,
    `🛠 USTA24 — YANGI BUYURTMA\n\n` +
    `Buyurtma: #${orderId || "?"}\n` +
    `Ism: ${name}\n` +
    `Telefon: ${phone}\n` +
    `Xizmat: ${service}\n` +
    `Manzil: ${address}\n` +
    `Izoh: ${details || "Yo‘q"}\n` +
    `Manba: Veb-sayt`
  );

  // Buyurtma DBga saqlangan bo‘lsa, Telegram ishlamasa ham
  // mijozga buyurtma qabul qilinganini bildiramiz.
  return json({
    success: true,
    message: "Buyurtmangiz qabul qilindi.",
    order_id: orderId,
    telegramSent: Boolean(sent?.ok)
  });
}


// ADMIN BUYURTMASINI YANGILASH

async function updateAdminOrder(request, env, id) {
  const body = await readBody(request);

  const order = await env.DB.prepare(
    "SELECT * FROM orders WHERE id = ?"
  ).bind(id).first();

  if (!order) {
    return json({ success: false, message: "Buyurtma topilmadi." }, 404);
  }

  const finance = await env.DB.prepare(
    "SELECT id FROM order_finances WHERE order_id = ?"
  ).bind(id).first();

  const newPrice =
    body.price !== undefined ? money(body.price) : money(order.price);

  if (body.price !== undefined && finance) {
    return json({
      success: false,
      message: "Komissiya hisoblangan buyurtma narxini o‘zgartirib bo‘lmaydi."
    }, 400);
  }

  if (body.price !== undefined && newPrice < 0) {
    return json({
      success: false,
      message: "Narx manfiy bo‘lishi mumkin emas."
    }, 400);
  }

  const allowed = [
    "Yangi",
    "Qabul qilindi",
    "Ustaga biriktirildi",
    "Bajarilmoqda",
    "Tugallandi",
    "Bekor qilindi"
  ];

  const newStatus = body.status ?? order.status;

  if (!allowed.includes(newStatus)) {
    return json({ success: false, message: "Noto‘g‘ri buyurtma holati." }, 400);
  }

  // Eski tugallangan buyurtmaga keyinchalik narx kiritish
  // avtomatik komissiya yaratmaydi.
  if (
    newStatus === "Tugallandi" &&
    order.status !== "Tugallandi" &&
    newPrice <= 0
  ) {
    return json({
      success: false,
      message: "Buyurtmani tugallashdan oldin narxni kiriting."
    }, 400);
  }

  const workerName =
    body.worker_name !== undefined
      ? safeString(body.worker_name, 100)
      : order.worker_name;

  const workerPhone =
    body.worker_phone !== undefined
      ? safeString(body.worker_phone, 25)
      : order.worker_phone;

  let finalStatus = newStatus;

  // Usta yangi biriktirilgan bo‘lsa, status biriktirildi bo‘ladi.
  const workerChanged =
    body.worker_name !== undefined ||
    body.worker_phone !== undefined;

  if (workerChanged && workerPhone) {
    finalStatus = "Ustaga biriktirildi";
  }

  await env.DB.prepare(`
    UPDATE orders
    SET price = ?,
        status = ?,
        worker_name = ?,
        worker_phone = ?
    WHERE id = ?
  `).bind(
    newPrice,
    finalStatus,
    workerName || null,
    workerPhone || null,
    id
  ).run();

  // Faqat hozir birinchi marta tugallangan buyurtmaga komissiya.
  if (
    finalStatus === "Tugallandi" &&
    order.status !== "Tugallandi" &&
    !finance
  ) {
    await createFinance(env.DB, id, newPrice);
  }

  if (body.status !== undefined || workerChanged) {
    await notifyCustomer(
      env,
      order.phone,
      `USTA24 buyurtma #${id}\nYangi holat: ${finalStatus}`
    );
  }

  if (workerChanged && workerPhone) {
    const sent = await notifyWorker(
      env,
      workerPhone,
      `🛠 Yangi buyurtma #${id}\n` +
      `Mijoz: ${order.name}\n` +
      `Telefon: ${order.phone}\n` +
      `Xizmat: ${order.service}\n` +
      `Manzil: ${order.address}\n` +
      `Izoh: ${order.details || "Yo‘q"}\n` +
      `Buyurtmani qabul qilish uchun tugmani bosing.`,
      {
        inline_keyboard: [[{
          text: "✅ Buyurtmani qabul qilish",
          callback_data: `w:accept:${id}`
        }]]
      }
    );

    if (!sent) {
      console.error("Ustaga Telegram xabari yuborilmadi. Buyurtma:", id);
    }
  }

  await adminTelegram(env, `Buyurtma #${id} yangilandi.`);

  return json({
    success: true,
    message: "Buyurtma yangilandi.",
    status: finalStatus
  });
}


// ASOSIY WORKER

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = request.method;

      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: CORS_HEADERS
        });
      }

      // SAYT FAYLLARI
      // DB xatosi oddiy sayt sahifalarini to‘sib qo‘ymasligi kerak.
      if (
        path === "/" ||
        path === "/admin" ||
        path === "/admin.html"
      ) {
        if (!env.ASSETS) {
          return json({
            success: false,
            message: "ASSETS binding topilmadi."
          }, 500);
        }

        const assetPath = path === "/" ? "/index.html" : "/admin.html";
        const assetUrl = new URL(assetPath, url.origin);

        return env.ASSETS.fetch(
          new Request(assetUrl.toString(), request)
        );
      }

      // BOSHQA API VA WEBHOOKLAR UCHUN DB TALAB QILINADI
      if (!env.DB) {
        return json({
          success: false,
          message: "DB binding topilmadi."
        }, 500);
      }

      // TELEGRAM WEBHOOKLAR
      if (
        path === "/api/worker-telegram-webhook" &&
        method === "POST"
      ) {
        return await handleWorkerWebhook(request, env);
      }

      if (
        path === "/api/customer-telegram-webhook" &&
        method === "POST"
      ) {
        return await handleCustomerWebhook(request, env);
      }

      // MIJOZ BUYURTMASI
      if (path === "/api/order" && method === "POST") {
        return await handleOrder(request, env);
      }

      // FAOL USTALAR
      if (path === "/api/ustalar" && method === "GET") {
        const result = await env.DB.prepare(`
          SELECT id, name, phone, specialty
          FROM ustalar
          WHERE status = 'Faol'
          ORDER BY name
        `).all();

        return json({
          success: true,
          ustalar: result.results || []
        });
      }

      // ADMIN API HIMOYASI
      if (path.startsWith("/api/admin")) {
        const denied = await requireAdmin(request, env);
        if (denied) return denied;
      }

      // STATISTIKA
      if (path === "/api/admin/stats" && method === "GET") {
        const stats = await env.DB.prepare(`
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'Yangi' THEN 1 ELSE 0 END) AS new_orders,
            SUM(CASE WHEN status IN (
              'Qabul qilindi',
              'Bajarilmoqda',
              'Ustaga biriktirildi'
            ) THEN 1 ELSE 0 END) AS in_progress,
            SUM(CASE WHEN status = 'Tugallandi' THEN 1 ELSE 0 END) AS completed
          FROM orders
        `).first();

        const finance = await env.DB.prepare(`
          SELECT
            COALESCE(SUM(commission_amount), 0) AS commission,
            COALESCE(SUM(
              CASE WHEN payment_status = 'To''landi'
              THEN commission_amount ELSE 0 END
            ), 0) AS paid,
            COALESCE(SUM(
              CASE WHEN payment_status = 'Kutilmoqda'
              THEN commission_amount ELSE 0 END
            ), 0) AS pending
          FROM order_finances
        `).first();

        const expenses = await env.DB.prepare(
          "SELECT COALESCE(SUM(amount), 0) AS total FROM expenses"
        ).first();

        return json({
          success: true,
          stats: {
            total: stats?.total || 0,
            new_orders: stats?.new_orders || 0,
            in_progress: stats?.in_progress || 0,
            completed: stats?.completed || 0,
            commission: finance?.commission || 0,
            paid_commission: finance?.paid || 0,
            pending_commission: finance?.pending || 0,
            expenses: expenses?.total || 0,
            profit: (finance?.paid || 0) - (expenses?.total || 0)
          }
        });
      }

      // BUYURTMALAR
      if (path === "/api/admin/orders" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT * FROM orders ORDER BY id DESC"
        ).all();

        return json({
          success: true,
          orders: result.results || []
        });
      }

      // ADMIN YANGI BUYURTMA
      if (path === "/api/admin/orders" && method === "POST") {
        const body = await readBody(request);

        const name = safeString(body.name, 100);
        const phone = safeString(body.phone, 25);
        const service = safeString(body.service, 150);
        const address = safeString(body.address, 250);
        const details = safeString(body.details, 2000);
        const source = safeString(body.source || "Boshqa", 50);
        const price = money(body.price);

        if (!name || !phone || !service || !address) {
          return json({
            success: false,
            message: "Majburiy maydonlarni to‘ldiring."
          }, 400);
        }

        if (price < 0) {
          return json({
            success: false,
            message: "Narx manfiy bo‘lishi mumkin emas."
          }, 400);
        }

        const result = await env.DB.prepare(`
          INSERT INTO orders
          (name, phone, service, address, details, status, source, price)
          VALUES (?, ?, ?, ?, ?, 'Yangi', ?, ?)
        `).bind(
          name, phone, service, address, details, source, price
        ).run();

        const id = result.meta?.last_row_id || null;

        await adminTelegram(
          env,
          `🛠 YANGI BUYURTMA #${id}\n` +
          `${name}\n${phone}\n${service}\n${address}\nManba: ${source}`
        );

        return json({ success: true, id });
      }

      const orderMatch = path.match(/^\/api\/admin\/orders\/(\d+)$/);

      if (orderMatch && method === "PATCH") {
        return await updateAdminOrder(
          request,
          env,
          Number(orderMatch[1])
        );
      }

      // USTALAR
      if (path === "/api/admin/ustalar" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT * FROM ustalar ORDER BY id DESC"
        ).all();

        return json({
          success: true,
          ustalar: result.results || []
        });
      }

      if (path === "/api/admin/ustalar" && method === "POST") {
        const body = await readBody(request);

        const name = safeString(body.name, 100);
        const phone = normalizePhone(body.phone);
        const specialty = safeString(body.specialty, 200);
        const status = body.status === "Faol" ? "Faol" : "Faol";

        if (!name || phone.length < 9) {
          return json({
            success: false,
            message: "Usta ismi va to‘g‘ri telefon raqami kerak."
          }, 400);
        }

        await env.DB.prepare(`
          INSERT INTO ustalar (name, phone, specialty, status)
          VALUES (?, ?, ?, ?)
        `).bind(name, phone, specialty, status).run();

        return json({
          success: true,
          message: "Usta qo‘shildi."
        });
      }

      const workerMatch = path.match(/^\/api\/admin\/ustalar\/(\d+)$/);

      if (workerMatch && method === "PATCH") {
        const id = Number(workerMatch[1]);
        const body = await readBody(request);

        const worker = await env.DB.prepare(
          "SELECT * FROM ustalar WHERE id = ?"
        ).bind(id).first();

        if (!worker) {
          return json({ success: false, message: "Usta topilmadi." }, 404);
        }

        await env.DB.prepare(`
          UPDATE ustalar
          SET name = ?, phone = ?, specialty = ?, status = ?
          WHERE id = ?
        `).bind(
          body.name !== undefined ? safeString(body.name, 100) : worker.name,
          body.phone ? normalizePhone(body.phone) : worker.phone,
          body.specialty !== undefined
            ? safeString(body.specialty, 200)
            : worker.specialty,
          body.status ?? worker.status,
          id
        ).run();

        return json({ success: true, message: "Usta yangilandi." });
      }

      if (workerMatch && method === "DELETE") {
        await env.DB.prepare(
          "DELETE FROM ustalar WHERE id = ?"
        ).bind(Number(workerMatch[1])).run();

        return json({ success: true });
      }

      // MIJOZLAR
      if (path === "/api/admin/customers" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT * FROM customers ORDER BY id DESC"
        ).all();

        const customers = result.results || [];

        for (const customer of customers) {
          const count = await env.DB.prepare(`
            SELECT COUNT(*) AS total
            FROM orders
            WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone, '+', ''), ' ', ''), '-', ''), '(', '') = ?
          `).bind(normalizePhone(customer.phone)).first();

          customer.order_count = count?.total || 0;
        }

        return json({ success: true, customers });
      }

      const customerMatch = path.match(/^\/api\/admin\/customers\/(\d+)$/);

      if (customerMatch && method === "GET") {
        const id = Number(customerMatch[1]);

        const customer = await env.DB.prepare(
          "SELECT * FROM customers WHERE id = ?"
        ).bind(id).first();

        if (!customer) {
          return json({ success: false, message: "Mijoz topilmadi." }, 404);
        }

        const result = await env.DB.prepare(
          "SELECT * FROM orders ORDER BY id DESC"
        ).all();

        const history = (result.results || []).filter(
          order => normalizePhone(order.phone) === normalizePhone(customer.phone)
        );

        return json({
          success: true,
          customer,
          orders: history
        });
      }

      if (customerMatch && method === "PATCH") {
        const id = Number(customerMatch[1]);
        const body = await readBody(request);

        await env.DB.prepare(`
          UPDATE customers
          SET name = COALESCE(?, name),
              address = COALESCE(?, address),
              notes = COALESCE(?, notes)
          WHERE id = ?
        `).bind(
          body.name !== undefined ? safeString(body.name, 100) : null,
          body.address !== undefined ? safeString(body.address, 250) : null,
          body.notes !== undefined ? safeString(body.notes, 2000) : null,
          id
        ).run();

        return json({ success: true });
      }

      // XIZMATLAR
      if (path === "/api/admin/services" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT * FROM services ORDER BY id DESC"
        ).all();

        return json({
          success: true,
          services: result.results || []
        });
      }

      if (path === "/api/admin/services" && method === "POST") {
        const body = await readBody(request);
        const name = safeString(body.name, 150);

        if (!name) {
          return json({
            success: false,
            message: "Xizmat nomini kiriting."
          }, 400);
        }

        try {
          await env.DB.prepare(`
            INSERT INTO services (name, description, status)
            VALUES (?, ?, ?)
          `).bind(
            name,
            safeString(body.description, 1000),
            body.status || "Faol"
          ).run();
        } catch (error) {
          if (String(error.message).includes("UNIQUE")) {
            return json({
              success: false,
              message: "Bu xizmat avval qo‘shilgan."
            }, 409);
          }
          throw error;
        }

        return json({ success: true });
      }

      const serviceMatch = path.match(/^\/api\/admin\/services\/(\d+)$/);

      if (serviceMatch && method === "PATCH") {
        const id = Number(serviceMatch[1]);
        const body = await readBody(request);

        const current = await env.DB.prepare(
          "SELECT * FROM services WHERE id = ?"
        ).bind(id).first();

        if (!current) {
          return json({ success: false, message: "Xizmat topilmadi." }, 404);
        }

        await env.DB.prepare(`
          UPDATE services
          SET name = ?, description = ?, status = ?
          WHERE id = ?
        `).bind(
          body.name !== undefined ? safeString(body.name, 150) : current.name,
          body.description !== undefined
            ? safeString(body.description, 1000)
            : current.description,
          body.status ?? current.status,
          id
        ).run();

        return json({ success: true });
      }

      if (serviceMatch && method === "DELETE") {
        await env.DB.prepare(
          "DELETE FROM services WHERE id = ?"
        ).bind(Number(serviceMatch[1])).run();

        return json({ success: true });
      }

      // XARAJATLAR
      if (path === "/api/admin/expenses" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT * FROM expenses ORDER BY expense_date DESC, id DESC"
        ).all();

        return json({
          success: true,
          expenses: result.results || []
        });
      }

      if (path === "/api/admin/expenses" && method === "POST") {
        const body = await readBody(request);
        const title = safeString(body.title, 200);
        const amount = money(body.amount);

        if (!title || amount <= 0) {
          return json({
            success: false,
            message: "Xarajat nomi va musbat summasini kiriting."
          }, 400);
        }

        await env.DB.prepare(`
          INSERT INTO expenses
          (title, category, amount, expense_date, notes)
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          title,
          safeString(body.category, 100),
          amount,
          body.expense_date || null,
          safeString(body.notes, 1000)
        ).run();

        return json({ success: true });
      }

      // MOLIYA
      if (path === "/api/admin/finance" && method === "GET") {
        const result = await env.DB.prepare(`
          SELECT
            f.*,
            o.name AS customer_name,
            o.phone,
            o.service,
            o.worker_name,
            o.status AS order_status
          FROM order_finances f
          LEFT JOIN orders o ON o.id = f.order_id
          ORDER BY f.id DESC
        `).all();

        const totals = await env.DB.prepare(`
          SELECT
            COALESCE(SUM(commission_amount), 0) AS total_commission,
            COALESCE(SUM(
              CASE WHEN payment_status = 'To''landi'
              THEN commission_amount ELSE 0 END
            ), 0) AS paid,
            COALESCE(SUM(
              CASE WHEN payment_status = 'Kutilmoqda'
              THEN commission_amount ELSE 0 END
            ), 0) AS pending
          FROM order_finances
        `).first();

        return json({
          success: true,
          finances: result.results || [],
          totals: totals || {}
        });
      }

      const financeMatch = path.match(/^\/api\/admin\/finance\/(\d+)$/);

      if (financeMatch && method === "PATCH") {
        const body = await readBody(request);
        const paymentStatus = body.payment_status;

        if (!["Kutilmoqda", "To'landi"].includes(paymentStatus)) {
          return json({
            success: false,
            message: "To‘lov holati noto‘g‘ri."
          }, 400);
        }

        const paymentMethod = safeString(body.payment_method || "Naqd", 50);

        await env.DB.prepare(`
          UPDATE order_finances
          SET payment_status = ?,
              payment_method = ?,
              paid_at = CASE
                WHEN ? = 'To''landi' THEN CURRENT_TIMESTAMP
                ELSE NULL
              END
          WHERE id = ?
        `).bind(
          paymentStatus,
          paymentMethod,
          paymentStatus,
          Number(financeMatch[1])
        ).run();

        return json({ success: true });
      }

      // SHARHLAR
      if (path === "/api/admin/reviews" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT * FROM reviews ORDER BY id DESC"
        ).all();

        return json({
          success: true,
          reviews: result.results || []
        });
      }

      if (path === "/api/admin/reviews" && method === "POST") {
        const body = await readBody(request);
        const rating = Number(body.rating);
        const customerName = safeString(body.customer_name, 100);

        if (
          !customerName ||
          !Number.isInteger(rating) ||
          rating < 1 ||
          rating > 5
        ) {
          return json({
            success: false,
            message: "Ism va 1–5 oralig‘idagi baho kerak."
          }, 400);
        }

        await env.DB.prepare(`
          INSERT INTO reviews
          (customer_name, phone, rating, comment, status)
          VALUES (?, ?, ?, ?, 'Kutilmoqda')
        `).bind(
          customerName,
          safeString(body.phone, 25),
          rating,
          safeString(body.comment, 2000)
        ).run();

        return json({ success: true });
      }

      const reviewMatch = path.match(/^\/api\/admin\/reviews\/(\d+)$/);

      if (reviewMatch && method === "PATCH") {
        const body = await readBody(request);
        const status = safeString(body.status || "Tasdiqlandi", 50);

        await env.DB.prepare(
          "UPDATE reviews SET status = ? WHERE id = ?"
        ).bind(status, Number(reviewMatch[1])).run();

        return json({ success: true });
      }

      // REKLAMA
      if (path === "/api/admin/advertising" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT * FROM ad_campaigns ORDER BY campaign_date DESC, id DESC"
        ).all();

        return json({
          success: true,
          campaigns: result.results || []
        });
      }

      if (path === "/api/admin/advertising" && method === "POST") {
        const body = await readBody(request);
        const platform = safeString(body.platform, 100);
        const campaignName = safeString(body.campaign_name, 200);

        if (!platform || !campaignName) {
          return json({
            success: false,
            message: "Platforma va kampaniya nomini kiriting."
          }, 400);
        }

        await env.DB.prepare(`
          INSERT INTO ad_campaigns
          (
            platform, campaign_name, spend, impressions,
            clicks, leads, campaign_date, notes
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          platform,
          campaignName,
          Math.max(0, money(body.spend)),
          Math.max(0, money(body.impressions)),
          Math.max(0, money(body.clicks)),
          Math.max(0, money(body.leads)),
          body.campaign_date || null,
          safeString(body.notes, 1000)
        ).run();

        return json({ success: true });
      }

      const adMatch = path.match(/^\/api\/admin\/advertising\/(\d+)$/);

      if (adMatch && method === "PATCH") {
        const id = Number(adMatch[1]);
        const body = await readBody(request);

        const current = await env.DB.prepare(
          "SELECT * FROM ad_campaigns WHERE id = ?"
        ).bind(id).first();

        if (!current) {
          return json({
            success: false,
            message: "Kampaniya topilmadi."
          }, 404);
        }

        await env.DB.prepare(`
          UPDATE ad_campaigns
          SET platform = ?,
              campaign_name = ?,
              spend = ?,
              impressions = ?,
              clicks = ?,
              leads = ?,
              campaign_date = ?,
              notes = ?
          WHERE id = ?
        `).bind(
          body.platform !== undefined
            ? safeString(body.platform, 100)
            : current.platform,
          body.campaign_name !== undefined
            ? safeString(body.campaign_name, 200)
            : current.campaign_name,
          body.spend !== undefined ? Math.max(0, money(body.spend)) : current.spend,
          body.impressions !== undefined ? Math.max(0, money(body.impressions)) : current.impressions,
          body.clicks !== undefined ? Math.max(0, money(body.clicks)) : current.clicks,
          body.leads !== undefined ? Math.max(0, money(body.leads)) : current.leads,
          body.campaign_date ?? current.campaign_date,
          body.notes !== undefined ? safeString(body.notes, 1000) : current.notes,
          id
        ).run();

        return json({ success: true });
      }

      // SOZLAMALAR
      if (path === "/api/admin/settings" && method === "GET") {
        const result = await env.DB.prepare(
          "SELECT setting_key, setting_value FROM app_settings"
        ).all();

        const settings = {};

        for (const row of result.results || []) {
          settings[row.setting_key] = row.setting_value;
        }

        return json({ success: true, settings });
      }

      if (path === "/api/admin/settings" && method === "POST") {
        const body = await readBody(request);
        const settings = body.settings || body;

        if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
          return json({
            success: false,
            message: "Sozlamalar formati noto‘g‘ri."
          }, 400);
        }

        for (const [key, value] of Object.entries(settings)) {
          if (typeof value === "object" && value !== null) continue;

          await env.DB.prepare(`
            INSERT INTO app_settings
            (setting_key, setting_value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(setting_key) DO UPDATE SET
              setting_value = excluded.setting_value,
              updated_at = CURRENT_TIMESTAMP
          `).bind(
            safeString(key, 100),
            safeString(value, 2000)
          ).run();
        }

        return json({
          success: true,
          message: "Sozlamalar saqlandi."
        });
      }

      // NOMA'LUM API
      if (path.startsWith("/api/")) {
        return json({
          success: false,
          message: "API manzili topilmadi."
        }, 404);
      }

      // QOLGAN STATIK FAYLLAR
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return json({
        success: false,
        message: "Sahifa topilmadi."
      }, 404);

    } catch (error) {
      console.error("SERVER ERROR:", error);

      return json({
        success: false,
        message: "Serverda xatolik yuz berdi.",
        error: error?.message || "Noma’lum xatolik"
      }, 500);
    }
  }
};
